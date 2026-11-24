// One meeting room: its state, and the rules for when each agent runs and what it may see.
//
// The prompts decide WHAT an agent says. This file decides WHEN an agent is called, WHO receives the
// result, and WHAT crosses the privacy boundary. Those three things are never left to a prompt.
//
//   group message ──► personal agents of the others: "does this connect to my user's notes?"   (ideation)
//                 └─► moderator: "is the team settling on a decision?"  ──► agreement check
//   silence 60 s  ──► moderator: "is an angle missing?" ──► every personal agent ──► private nudge  (ideation)
//   private message ► that user's personal agent only
//   all answers in ─► moderator compares anonymous labels ──► "Agreed n/n" or one anonymous question
//   private question ► every personal agent pre-fills its member's answer ► member sends it ► moderator combines
//                      the anonymous answers ──► only the result is posted (back room)
//   member quiet while the team talks ► their own agent only, and only from their own notes (facilitation)
//   two agents both have something on the same angle or message ► each member is offered, privately and without
//                      names, to combine ideas ► only if both say yes: names, one joint draft, posted together
//   check opens     ► each agent reads its member's stance ► the member may share it, without a name ► the board
//                      shows the mix (once at least two shared)

import { randomUUID } from "node:crypto";
import { llmInfo, type LLMRecord } from "./llm";
import * as moderator from "./moderator";
import * as personal from "./personal";
import { DEFAULT_RULES, type Rules } from "./rules";
import { isUnsure, norm } from "./format";
import type {
  AgentToModerator,
  Attachment,
  Card,
  ChatLine,
  Check,
  ConcernCard,
  DecisionDetection,
  DecisionRecord,
  Board,
  BoardTopic,
  BoardVersion,
  Discussion,
  GroupMessage,
  JointCard,
  MemoryCard,
  MemoryItem,
  ModeratorNote,
  ModeratorToAgent,
  PairCard,
  Pairing,
  Phase,
  Poll,
  PollCard,
  PrivateItem,
  PrivateTurn,
  Quote,
  ShareSuggestionCard,
  Stage,
  Stance,
  TraceEvent,
  UnderstandingCheckCard,
  UserView,
} from "./protocol";

export type MeetingOptions = {
  id?: string;
  goal: string;
  host: string;
  rules?: Partial<Rules>;
  /** Injectable clock, so tests can fast-forward the silence timer. */
  now?: () => number;
  /** Opt in only for local diagnostic fixtures that explicitly inspect prompt isolation. */
  tracePrompts?: boolean;
};

export class PersonalAgentUnavailable extends Error {}

export class Meeting {
  readonly id: string;
  readonly goal: string;
  readonly host: string;
  readonly rules: Rules;

  stage: Stage = "ideation";
  participants: string[] = [];
  group: GroupMessage[] = [];
  check: Check | null = null;
  decisions: DecisionRecord[] = [];
  /** Private questions the Moderator asked everyone (back room). */
  polls: Poll[] = [];
  /** Offers to combine two members' ideas (member-to-member, through their agents). */
  pairings: Pairing[] = [];
  trace: TraceEvent[] = [];

  private windows = new Map<string, PrivateItem[]>();
  private typing = new Map<string, number>();
  private chatJobs = new Map<string, Promise<void>>();
  private lastProactiveAt = new Map<string, number>();
  private anglesAsked: string[] = [];
  private userMsgsAtLastAngleRun = 0;
  private angleBusy = false;
  /** A decision the team is talking about again (after a split check, or a questioned agreed decision). */
  private discussing: Discussion | null = null;
  /** Agreed decisions the team chose to keep when asked, and the group length at that moment. */
  private kept = new Map<string, number>();
  private detection?: Promise<void>;
  private pendingDetection?: "new_message" | "host_request";
  private comparison?: { check: Check; inputs: string };
  private lastCompared = "";
  private seq = 0;
  private now: () => number;
  private tracePrompts: boolean;
  /** Every check of this meeting, in order, and the board topics they belong to. */
  private checks: Check[] = [];
  private topics: { id: string; checkIds: string[] }[] = [];
  /** Concerns told to the Moderator only while no check was open; they join the next check. */
  private heldConcerns: string[] = [];
  /** Each member's notes from earlier meetings of the group. Only that member's agent reads them. */
  private memory = new Map<string, MemoryItem[]>();
  /** Group length after each member's own last post (or when they joined), and when they were last nudged. */
  private lastOwnPost = new Map<string, number>();
  private quietNudgedAt = new Map<string, number>();
  /** Lines before this index are earlier meetings' chat, loaded as context. */
  private historyLength = 0;

  constructor(opts: MeetingOptions) {
    this.id = opts.id ?? randomUUID().slice(0, 8);
    this.goal = opts.goal.trim() || "Untitled meeting";
    this.host = opts.host.trim();
    this.rules = { ...DEFAULT_RULES, ...opts.rules };
    this.now = opts.now ?? Date.now;
    this.tracePrompts = opts.tracePrompts === true;
    this.join(this.host);
  }

  // =====================================================================
  // Actions. The web server calls these. Each one returns when all the agent work it triggered is done;
  // the server does not wait for that (the UI polls), the tests do.
  // =====================================================================

  join(name: string): void {
    const user = name.trim();
    if (!user) throw new Error("Name is required");
    if (["moderator", "anonymous"].includes(user.toLowerCase())) throw new Error("That display name is reserved");
    if (this.participants.includes(user)) return;
    this.participants.push(user);
    this.windows.set(user, []);
    this.lastOwnPost.set(user, this.group.length);
    const poll = this.openPoll();
    if (poll) {
      poll.askedOf.push(user);
      this.addPollCard(user, poll);
      void this.draftPollAnswer(user, poll).catch(() => console.error("[CrossCheck] private poll draft failed"));
    }
    if (this.check?.status === "collecting") {
      this.check.askedOf.push(user);
      this.addCheckCard(user, this.check);
      void this.reviewCheck(user, this.check).catch(() => console.error("[CrossCheck] private proposal review failed"));
    }
  }

  /** The room loaded earlier meetings' chat as context: quiet counts and the silence rule start from here. */
  markHistoryLoaded(): void {
    this.historyLength = this.group.length;
    for (const user of this.participants) this.lastOwnPost.set(user, this.group.length);
  }

  /** The server hands each member's saved notes to the meeting. Only that member's agent will read them. */
  setMemory(user: string, items: MemoryItem[]): void {
    this.memory.set(user, items.slice(-this.rules.memoryLimit));
  }

  /** A participant posts in the group chat, optionally replying to (quoting) an earlier message. */
  async postGroupMessage(
    user: string, text: string, options: { quote?: Quote; attachments?: Attachment[] } = {},
  ): Promise<void> {
    this.requireUser(user);
    if (!text.trim() && !options.attachments?.length) throw new Error("Empty message");
    await this.publish(user, text, false, options.quote, options.attachments);
  }

  private async publish(
    user: string, body: string, anonymous: boolean, quote?: Quote, attachments?: Attachment[],
  ): Promise<void> {
    const msg = this.addGroup(anonymous ? "Anonymous" : user, "user", body);
    if (anonymous) msg.anonymous = true;
    if (quote?.text?.trim()) msg.quote = { author: quote.author || "Someone", text: quote.text.trim() };
    if (attachments?.length) msg.attachments = attachments;
    this.log("user_to_group", anonymous ? "anonymous" : `user:${user}`, "group", {});
    // Any post counts as taking part, named or not. Kept on the server only.
    this.lastOwnPost.set(user, this.group.length);

    // While members are answering a check, unprompted suggestion cards only distract; concerns still go through chat.
    // After the reactions, a member who has stayed quiet may get one private nudge from their own agent.
    const jobs = this.checkOpen() ? [] : [this.runReactions(msg, user).then(() => this.runQuietNudges(user))];
    // Detection also runs while a check is open, so a real decision can replace a false alarm.
    jobs.push(this.runDetect("new_message"));
    await Promise.all(jobs);
  }

  /** A participant talks to their own agent (Task 1). Only that agent is called. */
  async sendPrivateMessage(user: string, text: string, options: {
    cardId?: string; groupMessageId?: string; intent?: "invite_brainstorm"; attachments?: Attachment[];
  } = {}): Promise<void> {
    this.requireUser(user);
    const body = text.trim();
    const attachments = options.attachments?.length ? options.attachments : undefined;
    if (!body && !attachments) throw new Error("Empty message");
    if (options.cardId && options.groupMessageId) throw new Error("Choose one reference");
    const card = options.cardId ? this.findCard(user, options.cardId) : undefined;
    const groupMessage = options.groupMessageId ? this.group.find(m => m.id === options.groupMessageId) : undefined;
    if (options.groupMessageId && !groupMessage) throw new Error("Referenced group message not found");
    if (options.intent && groupMessage?.note?.type !== "angle_prompt") throw new Error("Choose a public moderator angle");
    const reference = card ?? groupMessage;
    // Serialize only direct turns from the same member. Passive model calls use independent promises.
    const previous = this.chatJobs.get(user);
    this.typing.set(user, (this.typing.get(user) ?? 0) + 1);
    const job = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
      const check = this.checkOpen() ? this.check : null;
      const proposal = check ? { id: check.id, version: check.version, decision: check.decision } : undefined;
      const res = await personal.chat({
        ...this.ownerContext(user), stage: this.stage, message: (body + describeAttachments(attachments)).trim(),
        reference, proposal, intent: options.intent,
      }, this.llmLog(`agent:${user}`)).catch((error: unknown) => {
        console.warn(`[CrossCheck] personal agent for ${user} failed:`, error instanceof Error ? error.message : error);
        throw new PersonalAgentUnavailable("Your agent could not answer just now. Please try again.");
      });
      // Keep the exchange even if a new version opened meanwhile; a concern then belongs to the current check.
      const current = this.checkOpen() ? this.check!.id : undefined;
      this.addPrivate(user, { type: "user", text: body, ...(attachments ? { attachments } : {}) });
      this.addPrivate(user, { type: "agent", text: res.reply });
      this.log("user_to_agent", `user:${user}`, `agent:${user}`, {});
      if (res.share_draft) this.addSuggestion(user, "chat", "Draft for the team.", res.share_draft, [], current);
      if (res.concern) this.addCard(user, { kind: "concern", id: this.nextId("card"), label: res.concern.label,
        draft: res.concern.draft, status: "open", checkId: current });
      if (res.remember) this.offerMemory(user, res.remember);
    });
    this.chatJobs.set(user, job);
    try {
      await job;
    } finally {
      if (this.chatJobs.get(user) === job) this.chatJobs.delete(user);
      this.typing.set(user, Math.max(0, (this.typing.get(user) ?? 1) - 1));
    }
  }

  /** The user presses [Share to chat] on a suggestion. This is the only way private content reaches the group. */
  async shareCard(user: string, cardId: string, finalText: string, mode: "named" | "anonymous" = "named"): Promise<void> {
    const card = this.findCard(user, cardId);
    if (card.kind !== "share_suggestion" || card.status !== "open") throw new Error("This suggestion is not open");
    this.validateShare(card, finalText);
    card.status = "shared";
    await this.publish(user, finalText, mode === "anonymous");
  }

  dismissCard(user: string, cardId: string): void {
    const card = this.findCard(user, cardId);
    if (card.kind === "understanding_check") throw new Error("A check cannot be dismissed");
    if (card.kind === "poll") throw new Error("Use Skip to leave a private question unanswered");
    if (card.kind === "pair") throw new Error("Answer the offer with Yes or No thanks");
    if (card.status === "open") card.status = "dismissed";
  }

  /** The user raises a concern their agent helped them pin down (Task 3). */
  async raiseConcern(user: string, cardId: string, mode: "named" | "anonymous", finalText: string): Promise<void> {
    const card = this.findCard(user, cardId);
    if (card.kind !== "concern" || card.status !== "open") throw new Error("This concern is not open");
    this.validateShare(card, finalText);
    card.status = mode === "named" ? "raised_named" : "raised_anonymous";
    if (this.checkOpen()) this.check!.concerns.push(finalText);
    await this.publish(user, finalText, mode === "anonymous");
  }

  /**
   * The member tells the Moderator a concern privately (back room). The team sees only its neutral label,
   * never the text or who sent it. The text joins the open check (or the next one) for the comparison.
   */
  async tellModerator(user: string, cardId: string, finalText: string): Promise<void> {
    const card = this.findCard(user, cardId);
    if (card.kind !== "concern" || card.status !== "open") throw new Error("This concern is not open");
    this.validateShare(card, finalText);
    card.status = "told_moderator";
    this.toModerator(user, { type: "concern", label: card.label });
    if (this.checkOpen()) this.check!.concerns.push(finalText.trim());
    else this.heldConcerns.push(finalText.trim());
    this.moderatorSays(
      `Someone shared a concern with me privately: ${card.label}. Worth a word before the team decides.`,
      { type: "private_concern", label: card.label },
    );
  }

  /** The member keeps what their agent suggested remembering. Returns the text, for the server to store. */
  saveMemoryCard(user: string, cardId: string): string {
    const card = this.findCard(user, cardId);
    if (card.kind !== "memory" || card.status !== "open") throw new Error("This note is not open");
    card.status = "saved";
    return card.text;
  }

  // ---------- back room: stances ----------

  /** The member shares how they feel about the proposal being checked. The Moderator gets it without a name. */
  shareStance(user: string, checkId: string, stance: Stance): void {
    this.requireUser(user);
    const check = this.check;
    if (!check || check.id !== checkId || check.status !== "collecting") throw new Error("This check is closed");
    if (!check.askedOf.includes(user)) throw new Error("This participant was not asked");
    if (!["support", "hesitant", "unsure"].includes(stance)) throw new Error("Choose support, hesitant or unsure");
    (check.stances ??= Object.create(null) as Record<string, Stance>)[user] = stance;
    const card = this.checkCard(user, checkId);
    if (card) card.stance = stance;
    this.toModerator(user, { type: "stance", checkId, stance });
  }

  // ---------- member to member, through the agents: combining two ideas ----------

  /**
   * Two members' agents both had something on the same public angle or message. Each member is asked, privately
   * and without names, whether to combine. Drafts and names are shared only between the two, and only if both agree.
   */
  private offerPairing(members: string[], topic: string): void {
    const busy = (p: string) => this.pairings.some((x) => (x.status === "offered" || x.status === "matched") && x.members.includes(p));
    const withDraft = members.filter((p) => !busy(p) && this.latestDraft(p));
    if (withDraft.length < 2) return;
    const [a, b] = withDraft;
    const pairing: Pairing = {
      id: this.nextId("pair"), topic, members: [a, b], answers: Object.create(null), status: "offered",
      drafts: { [a]: this.latestDraft(a)!, [b]: this.latestDraft(b)! },
    };
    this.pairings.push(pairing);
    this.toAgents({ type: "pair_offer", pairingId: pairing.id, topic });
    for (const p of pairing.members) {
      this.addCard(p, { kind: "pair", id: this.nextId("card"), pairingId: pairing.id, topic, status: "open" } satisfies PairCard);
    }
  }

  /** The member answers the offer. One "no" ends it with nothing revealed; two "yes" reveal names and a joint draft. */
  async answerPairing(user: string, pairingId: string, accept: boolean): Promise<void> {
    this.requireUser(user);
    const pairing = this.pairings.find((x) => x.id === pairingId);
    if (!pairing || pairing.status !== "offered") throw new Error("This offer is closed");
    if (!pairing.members.includes(user)) throw new Error("This offer is not for you");
    pairing.answers[user] = accept;
    this.toModerator(user, { type: "pair_reply", pairingId, accept });
    if (!accept) {
      pairing.status = "declined";
      for (const p of pairing.members) {
        const card = this.pairCard(p, pairingId);
        if (card) card.status = p === user ? "declined" : "closed";
      }
      return;
    }
    const mine = this.pairCard(user, pairingId);
    if (mine) mine.status = "accepted";
    if (!pairing.members.every((p) => pairing.answers[p] === true)) return;
    pairing.status = "matched";
    for (const p of pairing.members) {
      const card = this.pairCard(p, pairingId);
      if (card) card.status = "matched";
    }
    const [a, b] = pairing.members;
    // Both agreed: their two drafts are combined (the only call that sees them, and only with consent).
    const res = await moderator.combinePieces(
      { goal: this.goal, topic: pairing.topic, pieces: [pairing.drafts[a], pairing.drafts[b]] }, this.llmLog("moderator:consented"),
    );
    for (const p of pairing.members) {
      this.addCard(p, {
        kind: "joint", id: this.nextId("card"), pairingId, partner: p === a ? b : a, draft: res.draft, status: "open",
      } satisfies JointCard);
    }
  }

  /** Either member posts the joint draft; it appears in the team chat under both names. */
  async postJoint(user: string, cardId: string, finalText: string): Promise<void> {
    const card = this.findCard(user, cardId);
    if (card.kind !== "joint" || card.status !== "open") throw new Error("This joint draft is not open");
    const text = finalText?.trim();
    if (!text) throw new Error("Confirm the final text to share");
    const pairing = this.pairings.find((x) => x.id === card.pairingId);
    if (!pairing || pairing.status !== "matched") throw new Error("This offer is closed");
    pairing.status = "posted";
    for (const p of pairing.members) {
      const joint = this.cards(p).find((c): c is JointCard => c.kind === "joint" && c.pairingId === pairing.id);
      if (joint) joint.status = "posted";
      // Each member's own card for the same piece is now covered by the joint post.
      for (const c of this.cards(p)) {
        if (c.kind === "share_suggestion" && c.status === "open" && c.draft === pairing.drafts[p]) c.status = "superseded";
      }
    }
    const [a, b] = pairing.members;
    const msg = this.addGroup(`${a} & ${b}`, "user", text);
    msg.joint = [a, b];
    this.log("user_to_group", `user:${user}`, "group", { joint: true });
    for (const p of pairing.members) this.lastOwnPost.set(p, this.group.length);
    const jobs = this.checkOpen() ? [] : [this.runReactions(msg, user, pairing.members)];
    jobs.push(this.runDetect("new_message"));
    await Promise.all(jobs);
  }

  private latestDraft(user: string): string | undefined {
    return [...this.cards(user)].reverse()
      .find((c): c is ShareSuggestionCard => c.kind === "share_suggestion" && c.source !== "chat" && c.status === "open")?.draft;
  }

  private pairCard(user: string, pairingId: string): PairCard | undefined {
    return this.cards(user).find((c): c is PairCard => c.kind === "pair" && c.pairingId === pairingId);
  }

  // ---------- back room: a private question to everyone ----------

  /**
   * Any member asks the Moderator to collect something privately (for example when everyone can meet).
   * Each personal agent pre-fills its own member's answer; the member edits and sends it, or skips.
   */
  async requestPoll(user: string, question: string): Promise<void> {
    this.requireUser(user);
    await this.openPollRound(question, 1);
  }

  private async openPollRound(question: string, round: number, followUpOf?: string): Promise<void> {
    const q = question.trim().slice(0, 300);
    if (!q) throw new Error("A question is required");
    if (this.openPoll()) throw new Error("A private question is already open");
    const poll: Poll = {
      id: this.nextId("poll"), question: q, round, askedOf: [...this.participants], answers: Object.create(null),
      skipped: [], status: "collecting", createdAt: this.now(), ...(followUpOf ? { followUpOf } : {}),
    };
    this.polls.push(poll);
    this.toAgents({ type: "poll_request", pollId: poll.id, question: q });
    this.moderatorSays(
      round > 1
        ? `Follow-up, asked privately: “${q}” Only the combined result will be shown.`
        : `I asked everyone privately: “${q}” Answer in your own window. Only the combined result will be shown.`,
      { type: "poll_opened", pollId: poll.id, round },
    );
    for (const p of poll.askedOf) this.addPollCard(p, poll);
    await Promise.all(poll.askedOf.map((p) => this.draftPollAnswer(p, poll).catch(() => undefined)));
  }

  /** The member sends their answer to the Moderator only, or skips. */
  async answerPoll(user: string, pollId: string, answer: string | null): Promise<void> {
    this.requireUser(user);
    const poll = this.polls.find((item) => item.id === pollId);
    if (!poll || poll.status !== "collecting") throw new Error("This question is closed");
    if (!poll.askedOf.includes(user)) throw new Error("This participant was not asked");
    const text = answer?.trim().slice(0, 300) ?? "";
    if (answer !== null && !text) throw new Error("Write an answer, or skip");
    const card = this.pollCard(user, pollId);
    if (answer === null) {
      delete poll.answers[user];
      if (!poll.skipped.includes(user)) poll.skipped.push(user);
      if (card) card.status = "skipped";
    } else {
      poll.answers[user] = text;
      poll.skipped = poll.skipped.filter((p) => p !== user);
      if (card) {
        card.status = "answered";
        card.answer = text;
      }
      this.toModerator(user, { type: "poll_reply", pollId, label: text });
    }
    if (poll.askedOf.every((p) => poll.answers[p] !== undefined || poll.skipped.includes(p))) await this.runPollCombine(poll);
  }

  /** Any member: combine the answers so far without waiting for everyone. */
  async combinePollNow(user: string, pollId: string): Promise<void> {
    this.requireUser(user);
    const poll = this.polls.find((item) => item.id === pollId);
    if (!poll || poll.status !== "collecting") throw new Error("This question is closed");
    if (Object.keys(poll.answers).length < 1) throw new Error("Nobody has answered yet");
    await this.runPollCombine(poll);
  }

  private async runPollCombine(poll: Poll): Promise<void> {
    if (poll.status !== "collecting") return;
    poll.status = "done";
    for (const p of poll.askedOf) {
      const card = this.pollCard(p, poll.id);
      if (card && card.status === "open") card.status = "closed";
      else if (card) card.status = card.status === "skipped" ? "skipped" : "closed";
    }
    // The Moderator gets the answers without names, in random order.
    const answers = shuffle(Object.values(poll.answers));
    const res = await moderator.combinePoll({
      goal: this.goal, question: poll.question, answers, lastRound: poll.round >= this.rules.maxPollRounds,
    }, this.llmLog("moderator"));
    poll.result = res.result;
    poll.fitsAll = res.fits_all;
    const next = res.fits_all ? " I will check it with everyone privately."
      : res.follow_up ? " I will ask one follow-up privately." : " Nothing fits everyone yet; keep talking here.";
    this.moderatorSays(`Combined result: ${res.result}${next}`, { type: "poll_result", pollId: poll.id, fitsAll: res.fits_all });
    if (res.fits_all) {
      // Confirm it like any decision: everyone answers privately, and the team sees one count.
      if (!this.checkOpen()) {
        await this.openCheck({
          decision: res.result, question: "Does this work for you?",
          options: ["Yes, this works for me", "It does not work for me", "Not sure yet"],
        });
      }
    } else if (res.follow_up) {
      await this.openPollRound(res.follow_up, poll.round + 1, poll.followUpOf ?? poll.id);
    }
  }

  private async draftPollAnswer(user: string, poll: Poll): Promise<void> {
    const res = await personal.pollReply({ ...this.ownerContext(user), question: poll.question }, this.llmLog(`agent:${user}`));
    const card = this.pollCard(user, poll.id);
    if (card && card.status === "open" && poll.status === "collecting") {
      card.draft = res.draft ?? "";
      card.why = res.why;
    }
  }

  private addPollCard(user: string, poll: Poll): void {
    this.addCard(user, { kind: "poll", id: this.nextId("card"), pollId: poll.id, question: poll.question,
      round: poll.round, draft: "", status: "open" });
  }

  private pollCard(user: string, pollId: string): PollCard | undefined {
    return this.cards(user).find((c): c is PollCard => c.kind === "poll" && c.pollId === pollId);
  }

  private openPoll(): Poll | undefined {
    return this.polls.find((poll) => poll.status === "collecting");
  }

  /** The agent noticed a lasting fact. It becomes a card; nothing is kept unless the member saves it. */
  private offerMemory(user: string, text: string): void {
    const key = norm(text);
    const known = (this.memory.get(user) ?? []).some((item) => norm(item.text) === key) ||
      this.cards(user).some((c) => c.kind === "memory" && c.status !== "dismissed" && norm(c.text) === key);
    if (!known) this.addCard(user, { kind: "memory", id: this.nextId("card"), text, status: "open" } satisfies MemoryCard);
  }

  private validateShare(card: ShareSuggestionCard | ConcernCard, finalText: string): void {
    if (!finalText?.trim()) throw new Error("Confirm the final text to share");
    if (card.kind === "concern" && card.checkId && card.checkId !== this.check?.id && this.checkOpen()) {
      throw new Error("The proposal changed; review the current check");
    }
  }

  /** The user answers the agreement check in their private window. */
  async answerCheck(user: string, checkId: string, label: string, approve: boolean): Promise<void> {
    this.requireUser(user);
    const check = this.check;
    if (!check || check.id !== checkId || check.status !== "collecting") throw new Error("This check is closed");
    const answer = label.trim();
    if (!answer) throw new Error("Answer is required");
    if (typeof approve !== "boolean") throw new Error("Choose whether to approve this proposal");
    if (!check.askedOf.includes(user)) throw new Error("This participant was not asked");
    check.answers[user] = answer;
    check.approvals[user] = approve;
    const card = this.checkCard(user, checkId);
    if (card) {
      card.status = "answered";
      card.answer = answer;
      card.approved = approve;
    }
    this.toModerator(user, { type: "check_reply", checkId, label: answer });
    if (check.askedOf.every((p) => check.answers[p])) await this.runCompare();
  }

  /** Any member: check agreement now, without waiting for the moderator to spot a decision. */
  async startCheck(user: string): Promise<void> {
    this.requireUser(user);
    if (this.checkOpen()) throw new Error("A check is already open");
    await this.runDetect("host_request");
  }

  async reviseCheck(user: string, checkId: string, decision: string): Promise<void> {
    this.requireHost(user);
    if (!this.check || this.check.id !== checkId) throw new Error("The proposal changed; refresh before revising");
    const revised = decision.trim();
    if (!revised || revised === this.check.decision) throw new Error("Enter a revised proposal");
    const previous = this.decisions.find(record => record.checkId === checkId);
    if (previous) previous.supersededBy = this.check.version + 1;
    await this.openCheck({ decision: revised, ...(await this.frame(user, revised)) }, previous?.id ?? this.check.replaces, this.check.topicId);
  }

  /** Host only: close the open check without a result (for example a false alarm). */
  cancelCheck(user: string, checkId: string): void {
    this.requireHost(user);
    const check = this.check;
    if (!check || check.id !== checkId || check.status !== "collecting") throw new Error("This check is not open");
    check.status = "cancelled";
    this.closeCheckCards(check);
    this.stage = "ideation";
    this.discussing = null;
    this.moderatorSays("The host closed this agreement check. Carry on.", { type: "check_closed" });
  }

  /** Any member: put a proposal to the team. The Moderator opens an agreement check on exactly this text. */
  async proposeDecision(user: string, text: string): Promise<void> {
    this.requireUser(user);
    const proposal = text.trim();
    if (!proposal) throw new Error("Empty proposal");
    if (this.alreadyAgreed(proposal)) throw new Error("The team already agreed on this");
    this.addGroup(user, "user", `Proposal for the team: "${proposal}"`);
    this.log("user_to_group", `user:${user}`, "group", { proposal: true });
    await this.openCheck({ decision: proposal, ...(await this.frame(user, proposal)) }, this.discussing?.recordId, this.discussing?.topicId);
  }

  /** Ask the Moderator how members might read a given proposal (question + options). */
  private async frame(author: string, proposal: string): Promise<{ question: string; options: string[] }> {
    const fallback = {
      question: "Is this how you understood the proposal?",
      options: ["Yes, as stated", "I understood it differently", "Not sure yet"],
    };
    try {
      const d = await moderator.detectDecision({
        goal: this.goal,
        group: [...this.groupContext(), { author, text: proposal, kind: "user" }],
        trigger: "host_request",
        openProposal: null,
        agreed: this.agreedStatements(),
        underDiscussion: this.discussing?.decision ?? null,
      }, this.llmLog("moderator"));
      return d.is_decision && d.options.length >= 2 ? { question: d.question, options: d.options } : fallback;
    } catch (error) {
      console.warn("[CrossCheck] could not frame the proposal:", error instanceof Error ? error.message : error);
      return fallback;
    }
  }

  /** Any member: ask every personal agent, privately, about an angle the team has not covered. */
  async requestAngle(user: string, angle: string, intent: "find_contribution" | "invite_brainstorm"): Promise<void> {
    this.requireUser(user);
    const question = angle.trim();
    if (!question) throw new Error("An angle is required");
    this.moderatorSays(`I asked everyone’s Personal Agent about “${question}”`, { type: "angle_requested" });
    await this.askAboutAngle(question, intent).catch(() => { throw new PersonalAgentUnavailable("Unable to complete the private angle checks. Please retry."); });
  }

  /** Host only: stop waiting and compare the answers so far. */
  async compareNow(user: string): Promise<void> {
    this.requireHost(user);
    if (!this.checkOpen()) throw new Error("No open check");
    if (Object.keys(this.check!.answers).length < 2) throw new Error("Need at least two answers");
    await this.runCompare();
  }

  /** Call every few seconds. Handles the rules that depend on time. */
  async tick(): Promise<void> {
    const t = this.now();
    const check = this.check;
    if (check?.status === "collecting" && t - check.createdAt >= this.rules.checkTimeoutMs && Object.keys(check.answers).length >= 2) {
      await this.runCompare();
    }
    const poll = this.openPoll();
    if (poll && t - poll.createdAt >= this.rules.checkTimeoutMs && Object.keys(poll.answers).length >= 2) {
      await this.runPollCombine(poll);
    }
    if (this.stage !== "ideation" || this.angleBusy || this.anglesAsked.length >= this.rules.maxAngleQueries) return;
    const userMsgs = this.group.filter((m) => m.kind === "user").length;
    const last = this.group[this.group.length - 1];
    const quiet = last !== undefined && t - last.at >= this.rules.silenceMs;
    if (quiet && userMsgs >= this.rules.minIdeasBeforeAngle && userMsgs > this.userMsgsAtLastAngleRun) {
      await this.runMissingAngle(userMsgs);
    }
  }

  // =====================================================================
  // Views. What one participant is allowed to see.
  // =====================================================================

  view(user: string): UserView {
    this.requireUser(user);
    const c = this.check;
    return {
      roomId: this.id,
      me: user,
      isHost: user === this.host,
      goal: this.goal,
      stage: this.stage,
      participants: [...this.participants],
      group: this.group,
      private: this.windows.get(user) ?? [],
      agentTyping: (this.typing.get(user) ?? 0) > 0,
      agreement: c
        ? {
            checkId: c.id,
            version: c.version,
            approvedCount: Object.values(c.approvals).filter(Boolean).length,
            status: c.status,
            decision: c.decision,
            question: c.question,
            answered: Object.keys(c.answers).length,
            askedOf: c.askedOf.length,
            agreed: c.agreed,
            total: c.total,
            statement: c.statement,
          }
        : null,
      decisions: this.decisions,
      // The board topic id stays internal; the public shape of `discussing` is unchanged.
      discussing: this.discussing ? (({ topicId: _topic, ...rest }) => rest)(this.discussing) : null,
      phase: this.phase(),
      board: this.board(),
      memory: [...(this.memory.get(user) ?? [])],
      llm: llmInfo(),
    };
  }

  /** The facilitation phase. Derived from the state, so it can never disagree with it. */
  phase(): Phase {
    if (this.checkOpen() || this.openPoll()) return "confirm";
    if (this.discussing) return "converge";
    return "explore";
  }

  /** Everything on the table, as the Moderator tracks it. Public: no names, no private text, no counts per reading. */
  board(): Board {
    const topics: BoardTopic[] = [];
    for (const topic of this.topics) {
      const checks = topic.checkIds.map((id) => this.checks.find((c) => c.id === id)).filter((c): c is Check => Boolean(c));
      if (checks.length === 0 || checks.every((c) => c.status === "cancelled")) continue;
      const last = checks[checks.length - 1];
      const versions: BoardVersion[] = checks.map((c, i) => {
        const record = this.decisions.find((d) => d.checkId === c.id);
        const status: BoardVersion["status"] =
          c.status === "collecting" ? "checking"
            : c.status === "mismatch" ? "split"
              : c.status === "aligned" ? (record?.replacedBy ? "replaced" : "agreed")
                : i < checks.length - 1 ? "replaced" : "cancelled";
        return { version: c.version, text: c.decision, status, ...(c.readings?.length ? { readings: c.readings } : {}) };
      });
      const lastRecord = this.decisions.find((d) => d.checkId === last.id);
      const status: BoardTopic["status"] =
        last.status === "collecting" ? "checking"
          : last.status === "mismatch" ? (this.discussing?.topicId === topic.id ? "discussing" : "split")
            : last.status === "aligned" ? (this.discussing?.topicId === topic.id && this.discussing.status === "open" ? "discussing" : "agreed")
              : "closed";
      topics.push({
        id: topic.id, statement: lastRecord?.statement ?? last.decision, status, versions,
        ...(last.ambiguity ? { ambiguity: last.ambiguity } : {}),
        ...(last.question ? { question: last.question } : {}),
        ...(last.status === "collecting" ? { answered: Object.keys(last.answers).length, askedOf: last.askedOf.length } : {}),
        ...(last.status === "collecting" ? stanceMix(last) : {}),
      });
    }
    return {
      phase: this.phase(),
      topics,
      polls: this.polls.map((poll) => ({
        id: poll.id, question: poll.question, round: poll.round, status: poll.status,
        answered: Object.keys(poll.answers).length + poll.skipped.length, askedOf: poll.askedOf.length,
        ...(poll.result ? { result: poll.result } : {}),
        ...(poll.fitsAll !== undefined ? { fitsAll: poll.fitsAll } : {}),
      })),
    };
  }

  /** What each user typed in private. Used by the privacy check in tests. */
  privateUserTexts(user: string): string[] {
    return [
      ...(this.windows.get(user) ?? []).flatMap((i) => (i.type === "user" ? [i.text] : [])),
      ...(this.memory.get(user) ?? []).map((item) => item.text),
    ];
  }

  // =====================================================================
  // Pipelines
  // =====================================================================

  /** A teammate posted. Each other member’s agent checks that member’s own statements for a connection. */
  private async runReactions(msg: GroupMessage, author: string, coAuthors: string[] = []): Promise<void> {
    const others = this.participants.filter(
      (p) => p !== author && !coAuthors.includes(p) && this.hasOwnerMessages(p) && this.cooledDown(p) && !this.hasOpenProactiveCard(p),
    );
    const shown = await Promise.all(others.map(p => this.offerCurrent(p, "react", true, async context => {
      const res = await personal.react({ ...context, newMessage: msg }, this.llmLog(`agent:${p}`));
      return res.suggest ? res : null;
    })));
    // Two members both have something to add to the same message: offer them to combine (no names yet).
    const withCards = others.filter((_, i) => shown[i]);
    if (withCards.length >= 2) {
      this.offerPairing(withCards, msg.anonymous ? "an anonymous message in the team chat" : `${msg.author}'s message: “${clip(msg.text, 80)}”`);
    }
  }

  /**
   * Facilitation: a member has not posted while teammates kept talking. Their own agent looks at what they said
   * privately; only if it fits the current discussion does the member get one private nudge. Nothing is public.
   */
  private async runQuietNudges(author: string): Promise<void> {
    if (this.checkOpen()) return;
    const quiet = this.participants.filter((p) =>
      p !== author && this.isQuiet(p) && this.windows.get(p)!.some((i) => i.type === "user") &&
      this.cooledDown(p) && !this.hasOpenProactiveCard(p));
    await Promise.all(quiet.map(async (p) => {
      this.quietNudgedAt.set(p, this.group.length);
      const recent = this.groupContext(this.group.slice(this.historyLength)).slice(-8);
      await this.offerCurrent(p, "quiet", true, async (context) => {
        const res = await personal.quietNudge({ ...context, recent }, this.llmLog(`agent:${p}`));
        return res.suggest ? res : null;
      });
    }));
  }

  private isQuiet(user: string): boolean {
    const since = Math.max(this.lastOwnPost.get(user) ?? this.historyLength, this.quietNudgedAt.get(user) ?? 0, this.historyLength);
    return this.group.slice(since).filter((m) => m.kind === "user").length >= this.rules.quietAfterMessages;
  }

  /** Ideation: the chat went quiet. The moderator looks for a missing angle and asks the personal agents. */
  private async runMissingAngle(userMsgs: number): Promise<void> {
    this.angleBusy = true;
    this.userMsgsAtLastAngleRun = userMsgs;
    try {
      const res = await moderator.findMissingAngle(
        { goal: this.goal, group: this.groupContext(), anglesAsked: this.anglesAsked },
        this.llmLog("moderator"),
      );
      if (res.action !== "ask_angle" || this.stage !== "ideation") return;
      this.anglesAsked.push(res.angle);
      const found = await this.askAboutAngle(res.angle, "find_contribution");
      // Nobody has a private thought on it: the moderator offers the angle to the whole group instead.
      if (!found && res.group_prompt && this.stage === "ideation") {
        this.moderatorSays(res.group_prompt, { type: "angle_prompt", angle: res.angle });
      }
    } finally {
      this.angleBusy = false;
    }
  }

  private async askAboutAngle(angle: string, intent: "find_contribution" | "invite_brainstorm"): Promise<boolean> {
    this.toAgents({ type: "angle_query", angle, intent });
    const found = await Promise.all(this.participants.map(async (p) => {
      if (intent === "find_contribution" && !this.hasOwnerMessages(p)) return false;
      const shown = await this.offerCurrent(p, "missing_angle", intent === "find_contribution", async context => {
        const reply = await personal.angleReply({ ...context, angle, intent }, this.llmLog(`agent:${p}`));
        return reply.has_view ? reply : null;
      });
      this.toModerator(p, { type: "angle_reply", hasView: shown, label: shown ? angle : "" });
      return shown;
    }));
    // Two members both have something on this angle: offer them to combine (no names yet).
    const withCards = this.participants.filter((_, i) => found[i]);
    if (withCards.length >= 2) this.offerPairing(withCards, `the angle “${angle}”`);
    return found.some(Boolean);
  }

  private async offerCurrent(user: string, source: "react" | "missing_angle" | "quiet", evidenceRequired: boolean,
    decide: (context: ReturnType<Meeting["ownerContext"]>) => Promise<{
      nudge: string; draft: string; evidenceIds: string[];
    } | null>): Promise<boolean> {
    const initial = this.ownerContext(user);
    const eligible = new Set([
      ...initial.privateHistory.filter(m => m.role === "user").map(m => m.id),
      ...initial.group.filter(m => m.kind === "user" && m.author === user).map(m => m.id),
    ]);
    let context = initial;
    // Recheck a positive result once if the room moved on during inference. Use the newer
    // public discussion for novelty, but keep the owner's evidence anchored to the original event.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await decide(context);
      if (!result || (evidenceRequired && !result.evidenceIds.length) ||
          result.evidenceIds.some(id => !eligible.has(id))) return false;
      if (source === "react" && !this.cooledDown(user)) return false;
      if (this.group.length === context.group.length) {
        return this.addSuggestion(user, source, result.nudge, result.draft, result.evidenceIds);
      }
      context = { ...this.ownerContext(user), privateHistory: initial.privateHistory };
    }
    return false;
  }

  /** Any stage: is the newest group message a decision? If yes, open an agreement check. */
  private async runDetect(trigger: "new_message" | "host_request"): Promise<void> {
    if (!this.pendingDetection || trigger === "host_request") this.pendingDetection = trigger;
    if (!this.detection) {
      this.detection = this.detectLatest().finally(() => { this.detection = undefined; });
    }
    await this.detection;
  }

  private async detectLatest(): Promise<void> {
    while (this.pendingDetection) {
      const trigger = this.pendingDetection;
      this.pendingDetection = undefined;
      const previous = this.check;
      const open = this.checkOpen() ? this.check : null;
      const historyLength = this.group.length;
      const group = this.groupContext(this.group.filter(isDecisionContext));
      const agreed = this.agreedRecords();
      const d = await moderator.detectDecision(
        {
          goal: this.goal, group, trigger, openProposal: open?.decision ?? null,
          agreed: agreed.map((record) => record.statement), underDiscussion: this.discussing?.decision ?? null,
        },
        this.llmLog("moderator"),
      );
      if (this.check !== previous || this.group.slice(historyLength).some(isDecisionContext)) continue;
      if (!d.is_decision) {
        // Someone questions an agreed decision: ask the team first instead of reopening it.
        if (d.challenged && !open) this.askToRevisit(agreed[d.challenged - 1]);
        continue;
      }
      if (this.alreadyAgreed(d.decision)) {
        // The team talked it over and kept the agreed wording: nothing left to revisit.
        if (this.discussing?.recordId) this.discussing = null;
        continue;
      }
      if (open) {
        if (sameText(open.decision, d.decision)) continue;
        // Replace the open check only while few have answered; otherwise let it finish first.
        const answered = Object.keys(open.answers).length;
        if (trigger !== "host_request" && answered / open.askedOf.length >= this.rules.supersedeBelowAnswered) continue;
      }
      // A new version of a decision the team is revisiting replaces the agreed one once everyone agrees.
      await this.openCheck(d, this.discussing?.recordId);
      this.pendingDetection = undefined;
    }
  }

  /** The Moderator asks, without naming anyone, whether the team wants to revisit an agreed decision. */
  private askToRevisit(record: DecisionRecord | undefined): void {
    if (!record || this.discussing?.recordId === record.id) return;
    const keptAt = this.kept.get(record.id);
    if (keptAt !== undefined && this.group.length - keptAt < 5) return; // just chose to keep it
    const topicId = this.checks.find((c) => c.id === record.checkId)?.topicId;
    this.discussing = { decision: record.statement, status: "asking", recordId: record.id, ...(topicId ? { topicId } : {}) };
    this.moderatorSays(
      `It sounds like the team may want to revisit an agreed decision: "${record.statement}". Should we discuss it again?`,
      { type: "reopen_prompt", recordId: record.id, decision: record.statement },
    );
  }

  /** Any member answers the Moderator's "revisit this decision?" question. */
  answerRevisit(user: string, recordId: string, reopen: boolean): void {
    this.requireUser(user);
    const asking = this.discussing;
    if (!asking || asking.status !== "asking" || asking.recordId !== recordId) {
      throw new Error("This question was already answered");
    }
    if (reopen) {
      asking.status = "open";
      this.moderatorSays(
        `OK, let's revisit "${asking.decision}". When the team settles on a new version, say it here and I will check it with everyone. Until then the agreed version stands.`,
        { type: "reopen_result", reopened: true },
      );
    } else {
      this.kept.set(recordId, this.group.length);
      this.discussing = null;
      this.moderatorSays(`OK, "${asking.decision}" stays as agreed.`, { type: "reopen_result", reopened: false });
    }
  }

  private async openCheck(
    d: Pick<DecisionDetection, "decision" | "question" | "options"> & { ambiguity?: string }, replaces?: string, topicId?: string,
  ): Promise<void> {
    const previous = this.check;
    // Which board topic this is a version of: an explicit one, the one under discussion, or a new topic.
    const recordTopic = replaces ? this.checks.find((c) => c.id === this.decisions.find((r) => r.id === replaces)?.checkId)?.topicId : undefined;
    // A check that replaces one still collecting answers is a new version of the same topic.
    const replacedTopic = previous?.status === "collecting" ? previous.topicId : undefined;
    const topic = topicId ?? this.discussing?.topicId ?? recordTopic ?? replacedTopic ?? this.newTopic();
    // Versions count within a topic: a brand-new decision is version 1 again.
    const version = (this.topics.find((t) => t.id === topic)?.checkIds.length ?? 0) + 1;
    const replacing = previous?.status === "collecting";
    if (previous && replacing) previous.status = "cancelled";
    // Old private cards remain readable, but cannot share or approve an obsolete proposal.
    if (previous) for (const user of this.participants) {
      for (const card of this.cards(user)) {
        if (card.kind === "poll" || card.kind === "memory" || card.kind === "pair" || card.kind === "joint" || card.checkId !== previous.id) continue;
        if (card.kind === "understanding_check") card.status = "closed";
        else if (card.status === "open") card.status = "superseded";
      }
    }
    const check: Check = {
      id: this.nextId("check"),
      version,
      approvals: Object.create(null),
      decision: d.decision,
      question: d.question,
      options: d.options,
      status: "collecting",
      askedOf: [...this.participants],
      answers: Object.create(null),
      concerns: this.heldConcerns.splice(0),
      createdAt: this.now(),
      ...(replaces ? { replaces } : {}),
      ...(d.ambiguity?.trim() ? { ambiguity: d.ambiguity.trim() } : {}),
      topicId: topic,
    };
    this.check = check;
    this.checks.push(check);
    this.topics.find((t) => t.id === topic)?.checkIds.push(check.id);
    this.discussing = null;
    this.lastCompared = "";
    this.stage = "agreement";
    this.toAgents({ type: "check_request", checkId: check.id, decision: d.decision, question: d.question, options: d.options });
    this.moderatorSays(
      `${replacing ? "Replacing the earlier check. " : ""}${replaces ? "New version of an agreed decision. " : ""}` +
        `Agreement check${check.version > 1 ? ` (version ${check.version})` : ""}: ` +
        `"${d.decision}" Please answer privately in your own window.`,
      { type: "check_opened", version: check.version },
    );

    for (const p of check.askedOf) this.addCheckCard(p, check);
    // Each agent pre-selects the option its own user most likely means. It arrives a moment after the card.
    await Promise.all(check.askedOf.map(p => this.reviewCheck(p, check)));
  }

  private async reviewCheck(user: string, check: Check): Promise<void> {
    const response = await personal.suggestCheckAnswer(
      { ...this.ownerContext(user), decision: check.decision, question: check.question, options: check.options,
        proposal: { id: check.id, version: check.version, decision: check.decision } }, this.llmLog(`agent:${user}`),
    );
    const card = this.checkCard(user, check.id);
    if (card && card.status === "open" && this.check === check) {
      if (response.suggested_option) card.suggested = response.suggested_option;
      card.suggestedStance = response.stance ?? null;
      card.why = response.why;
      card.evidenceIds = response.evidenceIds;
    }
  }

  private addCheckCard(user: string, check: Check): void {
    this.addCard(user, { kind: "understanding_check", id: this.nextId("card"), checkId: check.id,
      version: check.version, decision: check.decision, question: check.question, options: check.options, status: "open" });
  }

  /** The answers are in. The moderator sees shuffled labels without names. */
  private async runCompare(): Promise<void> {
    const check = this.check;
    if (!check || check.status !== "collecting") return;
    const signature = () => JSON.stringify([check.answers, check.approvals, check.askedOf, check.concerns]);
    const inputs = signature();
    if (inputs === this.lastCompared ||
        (this.comparison?.check === check && this.comparison.inputs === inputs)) return;
    const job = { check, inputs };
    this.comparison = job;
    try {
      const labels = shuffle(Object.values(check.answers));
      const res = await moderator.compareUnderstanding(
        { decision: check.decision, question: check.question, labels, concerns: [...check.concerns] },
        this.llmLog("moderator"),
      );
      // Check revisions and follow-up answers can arrive while the comparison runs.
      if (this.check !== check || this.comparison !== job || check.status !== "collecting" || signature() !== inputs) return;
      this.lastCompared = inputs;
      const total = check.askedOf.length;
      const approved = Object.values(check.approvals).filter(Boolean).length;
      check.agreed = approved;
      check.total = total;
      if (approved === total && res.aligned) {
        check.status = "aligned";
        // Record the exact proposal the users approved, never a model-generated paraphrase.
        check.statement = check.decision;
        const record: DecisionRecord = {
          id: this.nextId("decision"), checkId: check.id, version: check.version, statement: check.decision, at: this.now(),
          ...(check.replaces ? { replaces: check.replaces } : {}),
        };
        const earlier = check.replaces ? this.decisions.find((item) => item.id === check.replaces) : undefined;
        if (earlier) {
          earlier.replacedBy = record.id;
          earlier.supersededBy ??= check.version;
        }
        this.decisions.push(record);
        this.closeCheckCards(check); // answers can no longer change once it is agreed
        this.discussing = null;
        // Back to ideas: the next topic can be brainstormed and decided in the same meeting.
        this.stage = "ideation";
        this.moderatorSays(`Agreed ${approved}/${total}. ${check.decision}${earlier ? " This replaces the earlier decision." : ""}`, {
          type: "agreed", agreed: approved, total, statement: check.decision,
        });
      } else {
        // Not agreed: close this version and say what happens next.
        // The count is the largest group of members who read it the same way (never who they are).
        const sameReading = Math.max(0, ...res.groups
          .filter((group) => !isUnsure(labels[group[0] - 1] ?? ""))
          .map((group) => group.filter((i) => labels[i - 1] !== undefined).length));
        check.status = "mismatch";
        check.agreed = Math.min(sameReading, approved);
        // For the board: the readings found. An answer in someone's own words is never shown verbatim.
        check.readings = [...new Set(res.groups
          .map((group) => labels[group[0] - 1] ?? "")
          .filter((label) => label && !isUnsure(label))
          .map((label) => (check.options.includes(label) ? label : "another reading, in someone’s own words")))];
        this.closeCheckCards(check);
        // Keep the proposal in mind: the next messages are about it, even when they do not repeat it.
        this.discussing = {
          decision: check.decision, status: "open", ...(check.replaces ? { recordId: check.replaces } : {}),
          ...(check.topicId ? { topicId: check.topicId } : {}),
        };
        const message = [
          `Agreement ${check.agreed}/${total}.`,
          res.anonymous_question,
          "Keep talking here. When the team settles on a version, say it in the chat and I will check it again. The host can also revise the proposal.",
        ].filter(Boolean).join(" ");
        this.moderatorSays(message, { type: "agreement_count", agreed: check.agreed, total });
      }
    } finally {
      if (this.comparison === job) this.comparison = undefined;
    }
  }

  // =====================================================================
  // Helpers
  // =====================================================================

  private checkOpen(): boolean {
    return this.check?.status === "collecting";
  }


  /** Decisions the team agreed on in this meeting and that were not replaced or revised later. */
  private agreedRecords(): DecisionRecord[] {
    return this.decisions.filter((record) => record.supersededBy === undefined && record.replacedBy === undefined);
  }

  private agreedStatements(): string[] {
    return this.agreedRecords().map((record) => record.statement);
  }

  private alreadyAgreed(text: string): boolean {
    return this.agreedStatements().some((statement) => sameText(statement, text));
  }

  private closeCheckCards(check: Check): void {
    for (const user of this.participants) {
      const card = this.checkCard(user, check.id);
      if (card) card.status = "closed";
    }
  }

  /** A share suggestion the member has not acted on yet. One is enough; more only add noise. */
  private hasOpenProactiveCard(user: string): boolean {
    return this.cards(user).some((c) => c.kind === "share_suggestion" && c.source !== "chat" && c.status === "open");
  }

  private requireUser(user: string): void {
    if (!this.participants.includes(user)) throw new Error(`${user} has not joined this meeting`);
  }

  private requireHost(user: string): void {
    this.requireUser(user);
    if (user !== this.host) throw new Error("Only the host can do this");
  }

  private nextId(prefix: string): string {
    return `${prefix}_${++this.seq}`;
  }

  /** The group chat as the agents read it. This is ALL the moderator ever gets, plus labels. */
  private groupContext(messages = this.group): ChatLine[] {
    return messages.map(({ id, author, text, kind, quote, attachments }) => ({
      id, author, kind,
      text: ((quote ? `(replying to ${quote.author}: "${clip(quote.text)}") ` : "") + text + describeAttachments(attachments)).trim(),
    }));
  }

  private privateTurns(user: string): PrivateTurn[] {
    const turns: PrivateTurn[] = [];
    for (const item of this.windows.get(user) ?? []) {
      if (item.type !== "card") {
        turns.push({ id: item.id, role: item.type, text: (item.text + describeAttachments(item.attachments)).trim() });
      }
    }
    return turns;
  }

  private ownerContext(user: string) {
    return {
      user, goal: this.goal, group: this.groupContext(), privateHistory: this.privateTurns(user),
      recentSuggestions: this.cards(user).filter((c): c is ShareSuggestionCard => c.kind === "share_suggestion" && c.source !== "chat"),
      memory: (this.memory.get(user) ?? []).map((item) => item.text),
    };
  }

  private newTopic(): string {
    const id = this.nextId("topic");
    this.topics.push({ id, checkIds: [] });
    return id;
  }

  private hasOwnerMessages(user: string): boolean {
    return this.windows.get(user)!.some(i => i.type === "user") ||
      this.group.some(m => m.kind === "user" && m.author === user && !m.anonymous);
  }

  private cooledDown(user: string): boolean {
    const last = this.lastProactiveAt.get(user);
    return last === undefined || this.now() - last >= this.rules.suggestionCooldownMs;
  }

  private addGroup(author: string, kind: "user" | "moderator", text: string, note?: ModeratorNote): GroupMessage {
    const msg: GroupMessage = { id: this.nextId("msg"), author, kind, text, at: this.now(), ...(note ? { note } : {}) };
    this.group.push(msg);
    return msg;
  }

  private moderatorSays(text: string, note: ModeratorNote): void {
    this.addGroup("Moderator", "moderator", text, note);
    this.log("mod_to_group", "moderator", "group", { text, note });
  }

  private addPrivate(user: string, item: { type: "user" | "agent"; text: string; attachments?: Attachment[] }): void {
    this.windows.get(user)!.push({ id: this.nextId("p"), at: this.now(), ...item });
  }

  private addCard(user: string, card: Card): void {
    this.windows.get(user)!.push({ id: this.nextId("p"), at: this.now(), type: "card", card });
  }

  /** Commit a private draft after checking the latest group and private history for concurrent duplicates. */
  private addSuggestion(user: string, source: ShareSuggestionCard["source"], nudge: string, draft: string,
                        evidenceIds: string[], checkId?: string): boolean {
    if (source !== "chat") {
      const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]+/gu, "");
      const equivalent = (s: string) => normalize(s) === normalize(draft);
      if (this.group.some(m => equivalent(m.text)) ||
          this.cards(user).some(c => c.kind === "share_suggestion" && c.source !== "chat" &&
            (equivalent(c.draft) || (evidenceIds.length > 0 && c.evidenceIds?.length === evidenceIds.length &&
             evidenceIds.every(id => c.evidenceIds!.includes(id)))))) return false;
      this.lastProactiveAt.set(user, this.now());
    }
    this.addCard(user, { kind: "share_suggestion", id: this.nextId("card"), source, nudge, draft, status: "open", evidenceIds, checkId });
    return true;
  }

  private cards(user: string): Card[] {
    return (this.windows.get(user) ?? []).flatMap((i) => (i.type === "card" ? [i.card] : []));
  }

  private findCard(user: string, cardId: string): Card {
    this.requireUser(user);
    const card = this.cards(user).find((c) => c.id === cardId);
    if (!card) throw new Error("Card not found");
    return card;
  }

  private checkCard(user: string, checkId: string): UnderstandingCheckCard | undefined {
    return this.cards(user).find((c): c is UnderstandingCheckCard => c.kind === "understanding_check" && c.checkId === checkId);
  }

  // ---------- trace ----------

  private log(type: TraceEvent["type"], from: string, to: string, data: Record<string, unknown>): void {
    this.trace.push({ at: this.now(), type, from, to, data });
  }

  private toAgents(message: ModeratorToAgent): void {
    this.log("mod_to_agents", "moderator", "agents", message);
  }

  private toModerator(user: string, message: AgentToModerator): void {
    this.log("agent_to_mod", `agent:${user}`, "moderator", message);
  }

  private llmLog(who: string): (record: LLMRecord) => void {
    return (r) => this.log("llm_call", who, "llm", this.tracePrompts
      ? { prompt: r.prompt, input: r.user, output: r.raw, mocked: r.mocked, ms: r.ms }
      : { prompt: r.prompt, mocked: r.mocked, ms: r.ms });
  }
}

/** Shared stances on a check, counted without names, and only once at least two members shared one. */
function stanceMix(check: Check): { stances?: Record<Stance, number> } {
  const shared = Object.values(check.stances ?? {});
  if (shared.length < 2) return {};
  const mix: Record<Stance, number> = { support: 0, hesitant: 0, unsure: 0 };
  for (const stance of shared) mix[stance]++;
  return { stances: mix };
}

// A receipt can arrive while the Moderator is deciding whether a team message needs a check.
function isDecisionContext(message: GroupMessage): boolean {
  return message.note?.type !== "angle_requested";
}

/** How agents see attachments: names and kinds only, never the file contents. */
function describeAttachments(list?: Attachment[]): string {
  if (!list?.length) return "";
  const kind = (a: Attachment) => (a.type.startsWith("image/") ? "image" : a.type === "application/pdf" ? "PDF" : "file");
  return ` [attached: ${list.map((a) => `${a.name} (${kind(a)})`).join(", ")}]`;
}

function sameText(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  return x === y || (x.length > 12 && y.length > 12 && (x.includes(y) || y.includes(x)));
}

function clip(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Privacy check used by the tests: no agent other than a user's own may ever receive that user's private text.
 * Returns a list of problems. Empty list = the boundary held.
 */
export function findPrivacyLeaks(meeting: Meeting): string[] {
  const leaks: string[] = [];
  const groupTexts = meeting.group.map((m) => m.text);
  for (const user of meeting.participants) {
    const secrets = meeting
      .privateUserTexts(user)
      .filter((t) => t.length >= 15 && !groupTexts.some((g) => g.includes(t)));
    for (const ev of meeting.trace) {
      // Combining two members' drafts happens only after both agreed; that call is marked consented.
      if (ev.type !== "llm_call" || ev.from === `agent:${user}` || ev.from.endsWith(":consented")) continue;
      const input = String(ev.data.input ?? "");
      for (const s of secrets) {
        if (input.includes(s)) leaks.push(`${ev.from} (${String(ev.data.prompt)}) received ${user}'s private text: "${s.slice(0, 50)}"`);
      }
    }
  }
  return leaks;
}
