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

import { randomUUID } from "node:crypto";
import { llmInfo, type LLMRecord } from "./llm";
import * as moderator from "./moderator";
import * as personal from "./personal";
import { DEFAULT_RULES, type Rules } from "./rules";
import { isUnsure, norm } from "./format";
import type {
  AgentToModerator,
  Card,
  ChatLine,
  Check,
  ConcernCard,
  DecisionDetection,
  DecisionRecord,
  Discussion,
  GroupMessage,
  ModeratorNote,
  ModeratorToAgent,
  PrivateItem,
  PrivateTurn,
  Quote,
  ShareSuggestionCard,
  Stage,
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
    if (this.check?.status === "collecting") {
      this.check.askedOf.push(user);
      this.addCheckCard(user, this.check);
      void this.reviewCheck(user, this.check).catch(() => console.error("[CrossCheck] private proposal review failed"));
    }
  }

  /** A participant posts in the group chat, optionally replying to (quoting) an earlier message. */
  async postGroupMessage(user: string, text: string, options: { quote?: Quote } = {}): Promise<void> {
    this.requireUser(user);
    if (!text.trim()) throw new Error("Empty message");
    await this.publish(user, text, false, options.quote);
  }

  private async publish(user: string, body: string, anonymous: boolean, quote?: Quote): Promise<void> {
    const msg = this.addGroup(anonymous ? "Anonymous" : user, "user", body);
    if (anonymous) msg.anonymous = true;
    if (quote?.text?.trim()) msg.quote = { author: quote.author || "Someone", text: quote.text.trim() };
    this.log("user_to_group", anonymous ? "anonymous" : `user:${user}`, "group", {});

    // While members are answering a check, unprompted suggestion cards only distract; concerns still go through chat.
    const jobs = this.checkOpen() ? [] : [this.runReactions(msg, user)];
    // Detection also runs while a check is open, so a real decision can replace a false alarm.
    jobs.push(this.runDetect("new_message"));
    await Promise.all(jobs);
  }

  /** A participant talks to their own agent (Task 1). Only that agent is called. */
  async sendPrivateMessage(user: string, text: string, options: {
    cardId?: string; groupMessageId?: string; intent?: "invite_brainstorm";
  } = {}): Promise<void> {
    this.requireUser(user);
    const body = text.trim();
    if (!body) throw new Error("Empty message");
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
        ...this.ownerContext(user), stage: this.stage, message: body, reference, proposal, intent: options.intent,
      }, this.llmLog(`agent:${user}`)).catch((error: unknown) => {
        console.warn(`[CrossCheck] personal agent for ${user} failed:`, error instanceof Error ? error.message : error);
        throw new PersonalAgentUnavailable("Your agent could not answer just now. Please try again.");
      });
      // Keep the exchange even if a new version opened meanwhile; a concern then belongs to the current check.
      const current = this.checkOpen() ? this.check!.id : undefined;
      this.addPrivate(user, { type: "user", text: body });
      this.addPrivate(user, { type: "agent", text: res.reply });
      this.log("user_to_agent", `user:${user}`, `agent:${user}`, {});
      if (res.share_draft) this.addSuggestion(user, "chat", "Draft for the team.", res.share_draft, [], current);
      if (res.concern) this.addCard(user, { kind: "concern", id: this.nextId("card"), label: res.concern.label,
        draft: res.concern.draft, status: "open", checkId: current });
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
    await this.openCheck({ decision: revised, ...(await this.frame(user, revised)) }, previous?.id ?? this.check.replaces);
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
    await this.openCheck({ decision: proposal, ...(await this.frame(user, proposal)) }, this.discussing?.recordId);
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
    if (!angle.trim()) throw new Error("An angle is required");
    await this.askAboutAngle(angle.trim(), intent).catch(() => { throw new PersonalAgentUnavailable("Unable to complete the private angle checks. Please retry."); });
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
      discussing: this.discussing ? { ...this.discussing } : null,
      llm: llmInfo(),
    };
  }

  /** What each user typed in private. Used by the privacy check in tests. */
  privateUserTexts(user: string): string[] {
    return (this.windows.get(user) ?? []).flatMap((i) => (i.type === "user" ? [i.text] : []));
  }

  // =====================================================================
  // Pipelines
  // =====================================================================

  /** A teammate posted. Each other member’s agent checks that member’s own statements for a connection. */
  private async runReactions(msg: GroupMessage, author: string): Promise<void> {
    const others = this.participants.filter(
      (p) => p !== author && this.hasOwnerMessages(p) && this.cooledDown(p) && !this.hasOpenProactiveCard(p),
    );
    await Promise.all(others.map(p => this.offerCurrent(p, "react", true, async context => {
      const res = await personal.react({ ...context, newMessage: msg }, this.llmLog(`agent:${p}`));
      return res.suggest ? res : null;
    })));
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
    return found.some(Boolean);
  }

  private async offerCurrent(user: string, source: "react" | "missing_angle", evidenceRequired: boolean,
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
      const group = this.groupContext();
      const agreed = this.agreedRecords();
      const d = await moderator.detectDecision(
        {
          goal: this.goal, group, trigger, openProposal: open?.decision ?? null,
          agreed: agreed.map((record) => record.statement), underDiscussion: this.discussing?.decision ?? null,
        },
        this.llmLog("moderator"),
      );
      if (this.check !== previous || this.group.length !== group.length) continue;
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
    this.discussing = { decision: record.statement, status: "asking", recordId: record.id };
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

  private async openCheck(d: Pick<DecisionDetection, "decision" | "question" | "options">, replaces?: string): Promise<void> {
    const previous = this.check;
    const replacing = previous?.status === "collecting";
    if (previous && replacing) previous.status = "cancelled";
    // Old private cards remain readable, but cannot share or approve an obsolete proposal.
    if (previous) for (const user of this.participants) {
      for (const card of this.cards(user)) {
        if (card.checkId !== previous.id) continue;
        if (card.kind === "understanding_check") card.status = "closed";
        else if (card.status === "open") card.status = "superseded";
      }
    }
    const check: Check = {
      id: this.nextId("check"),
      version: (previous?.version ?? 0) + 1,
      approvals: Object.create(null),
      decision: d.decision,
      question: d.question,
      options: d.options,
      status: "collecting",
      askedOf: [...this.participants],
      answers: Object.create(null),
      concerns: [],
      createdAt: this.now(),
      ...(replaces ? { replaces } : {}),
    };
    this.check = check;
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
        this.closeCheckCards(check);
        // Keep the proposal in mind: the next messages are about it, even when they do not repeat it.
        this.discussing = { decision: check.decision, status: "open", ...(check.replaces ? { recordId: check.replaces } : {}) };
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
  private groupContext(): ChatLine[] {
    return this.group.map(({ id, author, text, kind, quote }) => ({
      id, author, kind,
      text: quote ? `(replying to ${quote.author}: "${clip(quote.text)}") ${text}` : text,
    }));
  }

  private privateTurns(user: string): PrivateTurn[] {
    const turns: PrivateTurn[] = [];
    for (const item of this.windows.get(user) ?? []) {
      if (item.type !== "card") turns.push({ id: item.id, role: item.type, text: item.text });
    }
    return turns;
  }

  private ownerContext(user: string) {
    return {
      user, goal: this.goal, group: this.groupContext(), privateHistory: this.privateTurns(user),
      recentSuggestions: this.cards(user).filter((c): c is ShareSuggestionCard => c.kind === "share_suggestion" && c.source !== "chat"),
    };
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

  private addPrivate(user: string, item: { type: "user" | "agent"; text: string }): void {
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

  private findCard(user: string, cardId: string): ShareSuggestionCard | ConcernCard | UnderstandingCheckCard {
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
      if (ev.type !== "llm_call" || ev.from === `agent:${user}`) continue;
      const input = String(ev.data.input ?? "");
      for (const s of secrets) {
        if (input.includes(s)) leaks.push(`${ev.from} (${String(ev.data.prompt)}) received ${user}'s private text: "${s.slice(0, 50)}"`);
      }
    }
  }
  return leaks;
}
