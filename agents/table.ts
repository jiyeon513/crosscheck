// The agents' table: after a split check, the Moderator and the Personal Agents look for one wording everyone can accept.
//
//   check splits ─► offered; any member starts it
//   position (private) ─► the Moderator asks each agent alone why its member answered that way; only the Moderator reads it
//   respond  (table)   ─► the Moderator puts a wording on the table; each agent accepts it, proposes a change, or rejects it
//   react    (table)   ─► each agent supports or objects to the other agents' changes
//                      ─► every agent accepts a wording, or the agents back one change ─► a new check; members confirm it
//                      ─► otherwise the Moderator words the next one, at most `bridgeRounds` times
//
// What can cross between agents is fixed by the message types, not by a prompt: a wording, an act, and the change it is
// about. Reasons stay between one agent and the Moderator. Members see the table without code names, one finished step at a
// time, so the wording and the timing do not tell who said what. Text that draws on a member's private notes waits for that
// member's approval (membrane.ts); a Moderator wording that quotes a reason or repeats something never shared is re-asked or dropped.
// Meeting (meeting.ts) owns the room; it reaches the table only through the hooks in TableHost.

import { callJSON, callPersonalJSON, type LLMRecord } from "./llm";
import { isUnsure, norm, str } from "./format";
import { approvalReason } from "./membrane";
import { replyLanguage } from "./personal";
import type { Check, ChatLine, PrivateTurn, TraceEvent } from "./protocol";
import type { Bridge, SpeechAct, TableDraft, TableMessage, TableRound, TableStep, TableThread, ThreadView } from "./table-protocol";

type Log = (record: LLMRecord) => void;

export type TableRules = {
  /** How many wordings the Moderator may put on the table (0 turns the table off). */
  bridgeRounds: number;
  /** An agent that has not finished a step by then is skipped for that step. */
  roundMs: number;
};

export const DEFAULT_TABLE_RULES: TableRules = { bridgeRounds: 2, roundMs: 120_000 };

/** What the table needs from the meeting. */
export type TableHost = {
  goal: string;
  participants(): string[];
  now(): number;
  nextId(prefix: string): string;
  ownerContext(user: string): { user: string; goal: string; group: ChatLine[]; privateHistory: PrivateTurn[] };
  /** What the member said only to their agent. */
  privateNotes(user: string): { id: string; text: string }[];
  /** The team chat. */
  publicTexts(): string[];
  /** The Moderator posts in the team chat; returns the message id. */
  say(text: string): string;
  checkOpen(): boolean;
  /** Open an agreement check on the bridge, as the next version of the split one (or next in line, if a check is open). */
  openBridgeCheck(thread: TableThread): Promise<void>;
  log(type: TraceEvent["type"], from: string, to: string, data: Record<string, unknown>): void;
  llmLog(who: string): Log;
};

type Line = Pick<TableMessage, "scope" | "from" | "to" | "act" | "text" | "wording" | "target" | "reading" | "condition" | "approved">;

export class AgentsTable {
  threads: TableThread[] = [];
  rules: TableRules = { ...DEFAULT_TABLE_RULES };
  private busy = new Set<string>();

  constructor(private host: () => TableHost) {}

  /** A check split: offer the table. Nothing is said and no model is called until a member starts it. */
  offer(check: Check): void {
    const h = this.host();
    const answered = check.askedOf.filter((p) => check.answers[p] !== undefined && h.participants().includes(p));
    if (this.rules.bridgeRounds <= 0 || answered.length < 2) return;
    this.closeOpen();
    this.threads.push({
      id: h.nextId("table"), protocol: "shuttle", checkId: check.id, ...(check.replaces ? { replaces: check.replaces } : {}),
      decision: check.decision, question: check.question, options: [...check.options], answers: { ...check.answers },
      aliases: Object.create(null), waiting: [], drafts: Object.create(null), round: 0, step: "position", done: [],
      status: "offered", messages: [], wordings: [], createdAt: h.now(), roundStartedAt: h.now(),
    });
  }

  /** Any member starts an offered table, with every member who answered the split check. */
  async start(user: string, threadId: string): Promise<void> {
    const h = this.host();
    if (!h.participants().includes(user)) throw new Error(`${user} has not joined this meeting`);
    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread || thread.status !== "offered") throw new Error("This is no longer on offer");
    const members = Object.keys(thread.answers).filter((p) => h.participants().includes(p));
    // Code names are drawn per thread and used only between the Moderator and the agents.
    shuffle(members).forEach((p, i) => { thread.aliases[p] = `Agent ${String.fromCharCode(65 + i)}`; });
    thread.status = "talking";
    thread.round = 1;
    thread.messageId = h.say(
      "I’ll talk it over with your Personal Agents: first with each one alone, then all of them together on one wording, without names. You can follow it below the chat. If they find a wording that could work for everyone, I’ll bring it here.",
    );
    await this.startStep(thread, "position");
  }

  /** The member answers their agent's draft: send it (as edited), or send nothing. */
  async answer(user: string, draftId: string, send: boolean, finalText?: string): Promise<void> {
    const thread = this.threads.find((t) => t.drafts[user]?.some((d) => d.id === draftId));
    const draft = thread?.drafts[user].find((d) => d.id === draftId);
    if (!thread || !draft || draft.status !== "waiting") throw new Error("This message is not waiting for you");
    if (thread.status !== "talking" || thread.round !== draft.round || thread.step !== draft.step || !thread.waiting.includes(user)) {
      draft.status = "closed";
      throw new Error("This round is over");
    }
    if (!send) {
      draft.status = "declined";
      // Nothing is said for the member: the step counts them as silent.
      this.say(thread, { scope: draft.step === "position" ? "private" : "table", from: thread.aliases[user], to: "Moderator", act: "inform", text: "" }, `agent:${user}`);
      await this.leaveStep(thread, user);
      return;
    }
    const text = finalText?.trim();
    if (!text) throw new Error("Confirm the text to send");
    draft.text = text.slice(0, 300);
    draft.status = "sent";
    await this.post(thread, user, draft, true);
  }

  /** The team moved on to a new check: an offer or an unfinished thread ends. */
  closeOpen(): void {
    for (const thread of this.threads) if (thread.status === "offered" || thread.status === "talking") this.end(thread, "closed");
  }

  talking(): boolean {
    return this.threads.some((t) => t.status === "talking");
  }

  async tick(t: number): Promise<void> {
    for (const thread of this.threads) {
      if (thread.status !== "talking" || !thread.waiting.length || t - thread.roundStartedAt < this.rules.roundMs) continue;
      for (const p of thread.waiting) {
        for (const d of thread.drafts[p] ?? []) if (d.status === "waiting") d.status = "closed";
      }
      thread.waiting = [];
      await this.advance(thread);
    }
  }

  view(user: string): ThreadView[] {
    return this.threads.map((t) => ({
      id: t.id, protocol: t.protocol, status: t.status, step: t.step, round: t.round, decision: t.decision, question: t.question,
      ...(t.bridge ? { bridge: t.bridge, bridgedBy: t.bridgedBy } : {}), ...(t.messageId ? { messageId: t.messageId } : {}),
      agents: Object.keys(t.aliases).length || Object.keys(t.answers).length, waitingFor: t.waiting.length,
      rounds: publicRounds(t), mine: mine(t, user), drafts: [...(t.drafts[user] ?? [])],
    }));
  }

  /**
   * Texts the member approved, by who may read them: a reason went to the Moderator only, a change to everyone.
   * The privacy check (findPrivacyLeaks) uses this; everything else the member said privately must reach nobody.
   */
  consented(user: string, reader: string): string[] {
    const out: string[] = [];
    for (const t of this.threads) {
      const alias = t.aliases[user];
      for (const m of t.messages) {
        if (m.from !== alias || !m.approved) continue;
        if (m.scope === "table") out.push(m.wording ?? "");
        else if (reader === "moderator") out.push(`${m.text} ${m.condition ?? ""}`);
      }
    }
    return out;
  }

  // ---------- steps ----------

  private async startStep(thread: TableThread, step: TableStep): Promise<void> {
    const h = this.host();
    thread.step = step;
    thread.roundStartedAt = h.now();
    const present = Object.keys(thread.aliases).filter((p) => h.participants().includes(p));
    // In the react step, only agents that answered the wording and have someone else's change to react to.
    thread.waiting = step === "react"
      ? present.filter((p) => this.moves(thread, "respond").some((m) => m.from === thread.aliases[p] && m.act !== "inform") &&
          this.changes(thread).some((c) => c.from !== thread.aliases[p]))
      : present;
    if (step === "position") {
      for (const p of thread.waiting) this.say(thread, { scope: "private", from: "Moderator", to: thread.aliases[p], act: "ask", text: positionAsk(thread, p) });
    }
    const round = thread.round;
    if (!thread.waiting.length) return this.advance(thread);
    await Promise.all(thread.waiting.map((p) => this.agentTurn(thread, p).catch((error: unknown) => {
      console.warn(`[CrossCheck] table ${step} for ${thread.aliases[p]} failed:`, error instanceof Error ? error.message : error);
      if (thread.round !== round || thread.step !== step || !thread.waiting.includes(p)) return;
      return this.leaveStep(thread, p);
    })));
  }

  /** The member's agent drafts its move. It goes out straight away only if it uses nothing private. */
  private async agentTurn(thread: TableThread, user: string): Promise<void> {
    const h = this.host();
    const { round, step } = thread;
    const alias = thread.aliases[user];
    const base = {
      ...h.ownerContext(user), decision: thread.decision, question: thread.question, options: thread.options,
      ownAnswer: thread.answers[user] ?? null,
    };
    const log = h.llmLog(`agent:${user}`);
    let draft: Omit<TableDraft, "id" | "threadId" | "round" | "step" | "status">;
    let shareable = "";
    let evidence: string[] = [];
    if (step === "position") {
      const ask = positionAsk(thread, user);
      const res = await tablePosition({ ...base, ask }, log);
      draft = { prompt: ask, act: res.act, text: res.text, ...(res.condition ? { condition: res.condition } : {}) };
      shareable = `${res.text} ${res.condition ?? ""}`;
      evidence = res.evidenceIds;
    } else if (step === "respond") {
      const res = await tableRespond({ ...base, wording: thread.wording!, table: publicRounds(thread), yourThread: mine(thread, user) }, log);
      draft = { prompt: `The wording on the table: “${thread.wording}”`, act: res.act, text: res.wording ?? "", note: res.note };
      shareable = res.wording ?? "";
      evidence = res.act === "counter" ? res.evidenceIds : [];
    } else {
      const changes = this.changes(thread).filter((c) => c.from !== alias).map((c) => ({ id: c.id, wording: c.wording! }));
      const res = await tableReact({ ...base, wording: thread.wording!, changes, yourThread: mine(thread, user) }, log);
      draft = {
        prompt: "The other agents proposed changes to the wording.", act: "inform", text: "", note: res.note,
        reactions: res.reactions.map((r) => ({ ...r, wording: changes.find((c) => c.id === r.target)!.wording })),
      };
    }
    if (thread.status !== "talking" || thread.round !== round || thread.step !== step || !thread.waiting.includes(user)) return;
    // Reactions carry no text, so nothing private can cross; everything else passes the membrane.
    const why = shareable.trim() ? approvalReason({
      text: shareable, evidenceIds: evidence,
      privateNotes: [
        ...h.privateNotes(user),
        // An answer in the member's own words is private too; only the option labels are shared.
        ...(base.ownAnswer && !thread.options.includes(base.ownAnswer) ? [{ id: "own-answer", text: base.ownAnswer }] : []),
      ],
      publicTexts: this.publicTexts(),
      names: h.participants(),
    }) : null;
    const full: TableDraft = {
      id: h.nextId("draft"), threadId: thread.id, round, step, ...draft,
      ...(why ? { why, status: "waiting" } : { status: "sent", auto: true }),
    };
    (thread.drafts[user] ??= []).push(full);
    if (!why) await this.post(thread, user, full, false);
  }

  private async post(thread: TableThread, user: string, draft: TableDraft, approved: boolean): Promise<void> {
    const alias = thread.aliases[user];
    const ok = approved ? { approved } : {};
    if (draft.step === "position") {
      const answer = thread.answers[user];
      const reading = answer && thread.options.includes(answer) && !isUnsure(answer) ? answer : undefined;
      this.say(thread, {
        scope: "private", from: alias, to: "Moderator", act: draft.act, text: draft.text,
        ...(reading ? { reading } : {}), ...(draft.condition ? { condition: draft.condition } : {}), ...ok,
      }, `agent:${user}`);
    } else if (draft.step === "respond") {
      this.say(thread, {
        scope: "table", from: alias, to: "all", act: draft.act, text: "", ...(draft.act === "counter" ? { wording: draft.text } : {}), ...ok,
      }, `agent:${user}`);
    } else {
      for (const r of draft.reactions ?? []) {
        const change = thread.messages.find((m) => m.id === r.target);
        this.say(thread, { scope: "table", from: alias, to: change?.from ?? "all", act: r.act, text: "", target: r.target, wording: r.wording }, `agent:${user}`);
      }
    }
    await this.leaveStep(thread, user);
  }

  private async leaveStep(thread: TableThread, user: string): Promise<void> {
    thread.waiting = thread.waiting.filter((p) => p !== user);
    await this.advance(thread);
  }

  /** A step is over. The referee (this code) decides what happens next; prompts only word things. */
  private async advance(thread: TableThread): Promise<void> {
    if (thread.status !== "talking" || thread.waiting.length || this.busy.has(thread.id)) return;
    this.busy.add(thread.id);
    let next: (() => Promise<void>) | undefined;
    try {
      thread.done.push(`${thread.round}:${thread.step}`);
      if (thread.step === "position") {
        next = () => this.nextWording(thread);
      } else if (thread.step === "respond") {
        const moves = this.moves(thread, "respond").filter((m) => m.act !== "inform");
        if (moves.length && moves.every((m) => m.act === "accept")) next = () => this.settle(thread, thread.wording, "moderator");
        else if (moves.some((m) => m.act === "counter")) next = () => this.startStep(thread, "react");
        else next = () => this.nextWording(thread);
      } else {
        // A change every other answering agent supports, with no objection, is the agents' own bridge.
        const answering = this.moves(thread, "respond").filter((m) => m.act !== "inform").map((m) => m.from);
        const backed = this.changes(thread).find((c) => {
          const reactions = this.moves(thread, "react").filter((m) => m.target === c.id);
          const others = answering.filter((a) => a !== c.from);
          return others.length > 0 && !reactions.some((m) => m.act === "reject") &&
            others.every((a) => reactions.some((m) => m.from === a && m.act === "accept"));
        });
        next = backed ? () => this.settle(thread, backed.wording, "agents") : () => this.nextWording(thread);
      }
    } finally {
      this.busy.delete(thread.id);
    }
    await next?.();
  }

  /** The Moderator words the next proposal from the private positions and what happened on the table. */
  private async nextWording(thread: TableThread): Promise<void> {
    if (thread.wordings.length >= this.rules.bridgeRounds) return this.settle(thread, undefined);
    const h = this.host();
    const input = {
      goal: h.goal, decision: thread.decision, question: thread.question, options: thread.options,
      positions: this.positions(thread), rounds: publicRounds(thread), lastRound: thread.wordings.length + 1 >= this.rules.bridgeRounds,
    };
    let res = await proposeBridge(input, h.llmLog("moderator"));
    // The wording goes to everyone: it may not repeat what a member said only privately, even to the Moderator.
    if (res.action === "bridge" && this.leaksPrivate(thread, res.bridge)) {
      console.warn("[CrossCheck] table: a wording quoted a reason or a private detail; asking once more");
      res = await proposeBridge({ ...input, retry: true }, h.llmLog("moderator"));
      if (res.action === "bridge" && this.leaksPrivate(thread, res.bridge)) {
        console.warn("[CrossCheck] table: the wording still quoted a reason or a private detail; none is put on the table");
        res = { ...res, action: "none" };
      }
    }
    if (thread.status !== "talking") return;
    if (res.action !== "bridge") return this.settle(thread, undefined);
    thread.round++;
    thread.wording = res.bridge;
    thread.wordings.push({ round: thread.round, text: res.bridge, note: res.message });
    this.say(thread, { scope: "table", from: "Moderator", to: "all", act: "propose", text: res.message, wording: res.bridge });
    await this.startStep(thread, "respond");
  }

  private async settle(thread: TableThread, wording: string | undefined, by?: "moderator" | "agents"): Promise<void> {
    const h = this.host();
    if (!wording) {
      this.end(thread, "no_bridge");
      h.say(`The agents could not find one wording that works for everyone yet.${thread.wording ? ` The last one on the table was “${thread.wording}”.` : ""} Keep talking here; when the team settles on a version, I will check it again.`);
      return;
    }
    thread.bridge = wording;
    thread.bridgedBy = by;
    this.end(thread, "bridged");
    h.say(by === "agents"
      ? `From the agents’ table: the agents settled on a change one of them proposed, “${wording}”. Each of you now confirms it privately.`
      : `From the agents’ table: every agent that answered could accept “${wording}”. Each of you now confirms it privately.`);
    await h.openBridgeCheck(thread);
  }

  private end(thread: TableThread, status: TableThread["status"]): void {
    thread.status = status;
    thread.waiting = [];
    if (status !== "closed") thread.done.push(`${thread.round}:${thread.step}`);
    for (const list of Object.values(thread.drafts)) for (const d of list) if (d.status === "waiting") d.status = "closed";
  }

  // ---------- reading the thread ----------

  private moves(thread: TableThread, step: TableStep, round = thread.round): TableMessage[] {
    return thread.messages.filter((m) => m.round === round && m.step === step && m.scope === "table" && m.from !== "Moderator");
  }

  private changes(thread: TableThread): TableMessage[] {
    return this.moves(thread, "respond").filter((m) => m.act === "counter" && m.wording);
  }

  /** For the Moderator only: each agent's private reason, under its code name. */
  private positions(thread: TableThread) {
    return thread.messages.filter((m) => m.step === "position" && m.from !== "Moderator" && m.act !== "inform").map((m) => ({
      agent: m.from, reading: m.reading ?? "", text: m.text, condition: m.condition ?? "",
    }));
  }

  private publicTexts(): string[] {
    return [...this.host().publicTexts(), ...this.threads.flatMap((t) => t.messages.filter((m) => m.scope === "table").map((m) => m.wording ?? ""))];
  }

  /**
   * A wording for everyone may use what members chose to tell the Moderator (that is what it is for), and freely the
   * conditions they offered; it may not quote a reason, and may not repeat anything a member never shared at all.
   */
  private leaksPrivate(thread: TableThread, text: string): boolean {
    const h = this.host();
    const told = thread.messages.filter((m) => m.scope === "private" && m.from !== "Moderator");
    const reasons = told.map((m) => ({ id: m.id, text: m.text }));
    const conditions = told.map((m) => m.condition ?? "");
    const neverShared = Object.keys(thread.aliases).flatMap((p) => h.privateNotes(p));
    const publicTexts = this.publicTexts();
    const sharedTexts = [...publicTexts, ...reasons.map((r) => r.text), ...conditions];
    return approvalReason({ text, evidenceIds: [], privateNotes: neverShared, publicTexts: sharedTexts, names: h.participants(), newWordsOnly: true }) !== null ||
      approvalReason({ text, evidenceIds: [], privateNotes: reasons, publicTexts: [...publicTexts, ...conditions], names: [], run: 8 }) !== null;
  }

  private say(thread: TableThread, line: Line, who = "moderator"): void {
    const h = this.host();
    thread.messages.push({ id: h.nextId("tm"), threadId: thread.id, at: h.now(), round: thread.round, step: thread.step, ...line });
    h.log(who === "moderator" ? "mod_to_agents" : "agent_to_mod", who, line.to, { table: thread.id, step: thread.step, act: line.act });
  }
}

/** Position step: the Moderator asks one agent, privately, why its member answered that way. */
function positionAsk(thread: TableThread, user: string): string {
  const answer = thread.answers[user] ?? "";
  if (isUnsure(answer)) return "Your member is not sure yet. What would help them decide?";
  // The generic check ("Yes, as stated" / "I understood it differently") has no readings to offer.
  if (/differently/i.test(answer)) return "Your member understood the proposal differently. How do they understand it, and what would make it work for them?";
  if (/as stated/i.test(answer)) return "Your member read the proposal as stated. What matters most to them in it, and what change could they accept?";
  const others = [...new Set(Object.entries(thread.answers)
    .filter(([p, a]) => p !== user && a !== answer && thread.options.includes(a) && !isUnsure(a))
    .map(([, a]) => `“${a}”`))];
  const read = thread.options.includes(answer) ? `answered “${answer}”` : "answered in their own words";
  return `Your member ${read}. Why do they read it that way? Could they accept ${others.length ? others.join(" or ") : "another reading"}, and on what condition?`;
}

/** The table as everyone sees it: finished steps only, counts instead of code names, no reasons. */
function publicRounds(thread: TableThread): TableRound[] {
  return thread.wordings.map(({ round, text, note }) => {
    const answered = thread.done.includes(`${round}:respond`);
    const reacted = thread.done.includes(`${round}:react`);
    const moves = thread.messages.filter((m) => m.round === round && m.scope === "table" && m.from !== "Moderator");
    const respond = answered ? moves.filter((m) => m.step === "respond") : [];
    const count = (act: SpeechAct) => respond.filter((m) => m.act === act).length;
    const agents = Object.keys(thread.aliases).length;
    return {
      round, wording: text, note, answered, reacted,
      accepted: count("accept"), changed: count("counter"), rejected: count("reject"),
      silent: answered ? agents - count("accept") - count("counter") - count("reject") : 0,
      changes: respond.filter((m) => m.act === "counter" && m.wording).map((c) => {
        const reactions = reacted ? moves.filter((m) => m.step === "react" && m.target === c.id) : [];
        return {
          id: c.id, wording: c.wording!,
          support: reactions.filter((m) => m.act === "accept").length, object: reactions.filter((m) => m.act === "reject").length,
        };
      }),
    };
  });
}

/** One member's own agent: the Moderator's private questions to it, its replies, and its moves on the table. */
function mine(thread: TableThread, user: string): TableMessage[] {
  const alias = thread.aliases[user];
  if (!alias) return [];
  const label = (who: string) => (who === alias ? "Your agent" : who === "Moderator" || who === "all" ? who : "another agent");
  return thread.messages
    .filter((m) => (m.scope === "private" && (m.from === alias || m.to === alias)) || (m.scope === "table" && m.from === alias))
    .map((m) => ({ ...m, from: label(m.from), to: label(m.to) }));
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// =====================================================================
// Model calls: prompts/personal/table_*.md and prompts/moderator/propose_bridge.md
// =====================================================================

type Owner = { user: string; goal: string; group: ChatLine[]; privateHistory: PrivateTurn[] };
type Base = Owner & { decision: string; question: string; options: string[]; ownAnswer: string | null };
type Generate = (prompt: string, context: object, schema: object, log?: Log) => Promise<unknown>;

const string = { type: "string" };
const nullable = { type: ["string", "null"] };
function record(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
const evidence = { type: "array", items: record({ id: string, quote: string }) };
const positionSchema = record({ act: { type: "string", enum: ["justify", "inform"] }, text: string, condition: nullable, evidence });
const respondSchema = record({ act: { type: "string", enum: ["accept", "counter", "reject"] }, wording: nullable, note: string, evidence });
const reactSchema = record({
  reactions: { type: "array", items: record({ id: string, act: { type: "string", enum: ["support", "object"] } }) }, note: string, evidence,
});

function payload(input: Base) {
  return {
    reply_language: replyLanguage(input), user: input.user, goal: input.goal,
    group: input.group.map(({ id, author, kind, text }) => ({ id, author, kind, text })),
    privateHistory: input.privateHistory.map(({ id, role, text }) => ({ id, role, text })),
    decision: input.decision, question: input.question, options: input.options, own_answer: input.ownAnswer,
  };
}

/** Run one agent call; invalid output is asked for once more, then fails. */
async function agentCall<T>(prompt: string, input: Base, context: object, schema: object, log: Log | undefined, generate: Generate,
  check: (data: Record<string, unknown>) => T | string): Promise<T> {
  const ids = [...input.group, ...input.privateHistory].map((m) => m.id).filter((id): id is string => Boolean(id));
  for (let attempt = 0; ; attempt++) {
    const data = await generate(prompt, { ...payload(input), ...context }, schema, log);
    let result: T | string;
    if (!data || typeof data !== "object") {
      result = "invalid response";
    } else {
      const { evidence: cited, reactions: _ids, ...said } = data as Record<string, unknown>;
      const text = Object.values(said).filter((v) => typeof v === "string").join(" ");
      result = badEvidence(cited, ownMessages(input)) ??
        (ids.some((id) => text.includes(id)) ? "internal id in text" : check(data as Record<string, unknown>));
    }
    if (typeof result !== "string") return result;
    console.warn(`[${prompt}] rejected model output (${result})${attempt ? "" : "; retrying once"}`);
    if (attempt) throw new Error("The personal agent returned an invalid response. Please retry.");
  }
}

function ownMessages(input: Owner): Map<string, string> {
  const own = new Map<string, string>();
  for (const m of input.group) if (m.id && m.kind !== "moderator" && m.author === input.user) own.set(m.id, m.text);
  for (const m of input.privateHistory) if (m.id && m.role === "user") own.set(m.id, m.text);
  return own;
}

/** Evidence must quote the owner's own private turns or named posts exactly. */
function badEvidence(raw: unknown, own: Map<string, string>): string | undefined {
  if (!Array.isArray(raw)) return "unverifiable evidence";
  for (const e of raw as { id?: unknown; quote?: unknown }[]) {
    if (typeof e?.id !== "string" || typeof e.quote !== "string" || !e.quote.trim() || !own.get(e.id)?.includes(e.quote.trim())) return "unverifiable evidence";
  }
  return undefined;
}

const evidenceIds = (data: Record<string, unknown>) => (data.evidence as { id: string }[]).map((e) => e.id);
const clean = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

export type PositionInput = Base & { ask: string };
/** Step 1, private: the owner's reason, for the Moderator only. */
export function tablePosition(input: PositionInput, log?: Log, generate: Generate = callPersonalJSON) {
  return agentCall("personal/table_position", input, { moderator_message: input.ask }, positionSchema, log, generate, (data) => {
    const text = clean(data.text, 300);
    if (!text || (data.act !== "justify" && data.act !== "inform")) return "empty or unknown act";
    return { act: data.act as SpeechAct, text, condition: clean(data.condition, 200), evidenceIds: evidenceIds(data) };
  });
}

export type RespondInput = Base & { wording: string; table: TableRound[]; yourThread: TableMessage[] };
/** Step 2, on the table: accept the wording, propose a changed wording, or reject it. No reasons cross. */
export function tableRespond(input: RespondInput, log?: Log, generate: Generate = callPersonalJSON) {
  return agentCall("personal/table_respond", input, {
    wording: input.wording, table: input.table, your_thread: input.yourThread.map(({ from, to, act, text, wording }) => ({ from, to, act, text, wording })),
  }, respondSchema, log, generate, (data) => {
    const wording = clean(data.wording, 300);
    const note = clean(data.note, 300) ?? "";
    if (!["accept", "counter", "reject"].includes(String(data.act))) return "unknown act";
    // A change must actually change the wording.
    const act: SpeechAct = data.act === "counter" && (!wording || norm(wording) === norm(input.wording)) ? "reject" : data.act as SpeechAct;
    return { act, wording: act === "counter" ? wording : null, note, evidenceIds: evidenceIds(data) };
  });
}

export type ReactInput = Base & { wording: string; changes: { id: string; wording: string }[]; yourThread: TableMessage[] };
/** Step 3, on the table: support or object to each change the other agents proposed. Only the act crosses. */
export function tableReact(input: ReactInput, log?: Log, generate: Generate = callPersonalJSON) {
  return agentCall("personal/table_react", input, {
    wording: input.wording, changes: input.changes, your_thread: input.yourThread.map(({ from, to, act, text, wording }) => ({ from, to, act, text, wording })),
  }, reactSchema, log, generate, (data) => {
    if (!Array.isArray(data.reactions)) return "no reactions";
    const ids = new Set(input.changes.map((c) => c.id));
    const reactions: { target: string; act: "accept" | "reject" }[] = [];
    for (const r of data.reactions as { id?: unknown; act?: unknown }[]) {
      if (typeof r?.id !== "string" || !ids.has(r.id) || reactions.some((x) => x.target === r.id)) continue;
      if (r.act === "support" || r.act === "object") reactions.push({ target: r.id, act: r.act === "support" ? "accept" : "reject" });
    }
    return { reactions, note: clean(data.note, 300) ?? "" };
  });
}

export type ProposeBridgeInput = {
  goal: string; decision: string; question: string; options: string[];
  /** Private, for the Moderator only: each agent's reason under its code name. */
  positions: { agent: string; reading: string; text: string; condition: string }[];
  rounds: TableRound[];
  lastRound: boolean;
  /** The last wording repeated something a member said only privately. */
  retry?: boolean;
};

export function formatPositions(positions: ProposeBridgeInput["positions"]): string {
  if (!positions.length) return "(none)";
  return positions.map((p) => `[${p.agent}]${p.reading ? ` answered “${p.reading}”.` : ""} ${p.text}${p.condition ? ` (condition: ${p.condition})` : ""}`).join("\n");
}

export function formatRounds(rounds: TableRound[]): string {
  if (!rounds.length) return "(no wording yet)";
  return rounds.map((r, i) => [
    `Wording ${i + 1}: “${r.wording}”`,
    r.answered ? `  ${r.accepted} accepted, ${r.changed} proposed a change, ${r.rejected} rejected, ${r.silent} did not answer.` : "  (agents still answering)",
    ...r.changes.map((c) => `  Change proposed by an agent: “${c.wording}”${r.reacted ? ` (${c.support} other agents support it, ${c.object} object)` : ""}`),
  ].join("\n")).join("\n");
}

/** The Facilitator: the next wording, or none. It sees code names and private reasons, never member names. */
export async function proposeBridge(input: ProposeBridgeInput, log?: Log): Promise<Bridge> {
  const data = await callJSON<Bridge>(
    "moderator/propose_bridge",
    {
      goal: input.goal, decision: input.decision, question: input.question, options: input.options.join(" / "),
      positions: formatPositions(input.positions), table: formatRounds(input.rounds), lastRound: input.lastRound ? "yes" : "no",
      retryNote: input.retry
        ? "Your last wording quoted a member’s private reason or a personal detail. Write it again: keep what each member needs, in your own general words."
        : "",
    },
    input, log,
  );
  const bridge = str(data.bridge);
  const ok = data.action === "bridge" && bridge.length > 0 && norm(bridge) !== norm(input.decision) &&
    !input.rounds.some((r) => norm(r.wording) === norm(bridge));
  return { action: ok ? "bridge" : "none", bridge: ok ? bridge : "", message: ok ? str(data.message) : "", reason: str(data.reason) };
}
