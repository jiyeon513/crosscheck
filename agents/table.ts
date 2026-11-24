// The agents' table: after a split check, the Moderator talks it over with each Personal Agent under code names.
//
//   check splits ─► the table is offered; any member starts it
//                ─► round 1: each agent gives its member's reading and reason (justify / inform)
//                ─► Moderator proposes a bridge wording (propose)
//                ─► each agent accepts, counters with a condition, or rejects ─► next bridge, at most `bridgeRounds`
//                ─► every agent that answered accepts ─► a new check on the bridge; members still confirm it themselves
//
// The prompts only word the messages. This file is the referee: who speaks when, what counts as agreement,
// and what reaches the table. Anything that draws on a member's private notes waits for that member (membrane.ts).
// Meeting (meeting.ts) owns the room; it reaches the table only through the hooks in TableHost.

import { callJSON, callPersonalJSON, type LLMRecord } from "./llm";
import { isUnsure, norm, str } from "./format";
import { approvalReason } from "./membrane";
import { replyLanguage } from "./personal";
import type { Check, ChatLine, PrivateTurn, TraceEvent } from "./protocol";
import type { Bridge, SpeechAct, TableDraft, TableMessage, TableThread, TableTurn, ThreadView } from "./table-protocol";

type Log = (record: LLMRecord) => void;

export type TableRules = {
  /** How many bridge wordings the Moderator may try (0 turns the table off). */
  bridgeRounds: number;
  /** An agent that has not answered a round by then is skipped for that round. */
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
  /** Open an agreement check on the bridge, as the next version of the split one. */
  openBridgeCheck(thread: TableThread): Promise<void>;
  log(type: TraceEvent["type"], from: string, to: string, data: Record<string, unknown>): void;
  llmLog(who: string): Log;
};

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
      aliases: Object.create(null), waiting: [], drafts: Object.create(null), round: 0, status: "offered", messages: [],
      createdAt: h.now(), roundStartedAt: h.now(),
    });
  }

  /** Any member starts an offered table, with every member who answered the split check. */
  async start(user: string, threadId: string): Promise<void> {
    const h = this.host();
    if (!h.participants().includes(user)) throw new Error(`${user} has not joined this meeting`);
    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread || thread.status !== "offered") throw new Error("This is no longer on offer");
    const members = Object.keys(thread.answers).filter((p) => h.participants().includes(p));
    // Code names are drawn per thread, so they cannot be linked across threads.
    shuffle(members).forEach((p, i) => { thread.aliases[p] = `Agent ${String.fromCharCode(65 + i)}`; });
    thread.status = "talking";
    thread.messageId = h.say(
      "I’ll talk it over with each Personal Agent, under code names. You can follow it below the chat. If I find a wording that could work for everyone, I’ll bring it here.",
    );
    await this.startRound(thread, ["justify", "inform"], (p) => ({ text: positionAsk(thread, p) }));
  }

  /** The member answers their agent's draft: send it (as edited) under the code name, or send nothing. */
  async answer(user: string, draftId: string, send: boolean, finalText?: string): Promise<void> {
    const thread = this.threads.find((t) => t.drafts[user]?.some((d) => d.id === draftId));
    const draft = thread?.drafts[user].find((d) => d.id === draftId);
    if (!thread || !draft || draft.status !== "waiting") throw new Error("This message is not waiting for you");
    if (thread.status !== "talking" || thread.round !== draft.round || !thread.waiting.includes(user)) {
      draft.status = "closed";
      throw new Error("This round is over");
    }
    if (!send) {
      draft.status = "declined";
      this.say(thread, { from: draft.alias, to: "Moderator", act: "inform", text: "My member has nothing to add this round." }, `agent:${user}`);
      await this.leaveRound(thread, user);
      return;
    }
    const text = finalText?.trim();
    if (!text) throw new Error("Confirm the text to send");
    draft.text = text.slice(0, 300);
    draft.status = "sent";
    await this.agentSays(thread, user, draft, true);
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
      if (thread.status === "talking" && thread.waiting.length && t - thread.roundStartedAt >= this.rules.roundMs) {
        for (const p of thread.waiting) {
          for (const d of thread.drafts[p] ?? []) if (d.status === "waiting") d.status = "closed";
          this.say(thread, { from: "Moderator", to: "all", act: "inform", text: `No answer from ${thread.aliases[p]} this round.` });
        }
        thread.waiting = [];
        await this.advance(thread);
      }
    }
  }

  view(user: string): ThreadView[] {
    return this.threads.map((t) => ({
      id: t.id, protocol: t.protocol, status: t.status, round: t.round, decision: t.decision, question: t.question,
      ...(t.bridge ? { bridge: t.bridge } : {}), ...(t.messageId ? { messageId: t.messageId } : {}),
      messages: [...t.messages], agents: Object.keys(t.aliases).length, waitingFor: t.waiting.length,
      ...(t.aliases[user] ? { yours: t.aliases[user] } : {}), drafts: [...(t.drafts[user] ?? [])],
    }));
  }

  /** Texts members approved for the table: shared on purpose, like a team chat post. */
  approvedTexts(): string[] {
    return this.threads.flatMap((t) => t.messages.filter((m) => m.approved).map((m) => `${m.text} ${m.condition ?? ""}`));
  }

  // ---------- rounds ----------

  private async startRound(thread: TableThread, allowed: SpeechAct[], ask: (user: string) => { text: string; bridge?: string },
    proposal?: { bridge: string; message: string }): Promise<void> {
    const h = this.host();
    thread.round++;
    thread.roundStartedAt = h.now();
    thread.waiting = Object.keys(thread.aliases).filter((p) => h.participants().includes(p));
    if (proposal) {
      this.say(thread, { from: "Moderator", to: "all", act: "propose", text: proposal.message || "Here is a wording that might work for everyone.", reading: proposal.bridge });
    } else {
      for (const p of thread.waiting) this.say(thread, { from: "Moderator", to: thread.aliases[p], act: "ask", text: ask(p).text });
    }
    const round = thread.round;
    await Promise.all(thread.waiting.map((p) => this.agentTurn(thread, p, ask(p), allowed).catch((error: unknown) => {
      console.warn(`[CrossCheck] table turn for ${thread.aliases[p]} failed:`, error instanceof Error ? error.message : error);
      if (thread.round !== round || !thread.waiting.includes(p)) return;
      this.say(thread, { from: "Moderator", to: "all", act: "inform", text: `No answer from ${thread.aliases[p]} this round.` });
      return this.leaveRound(thread, p);
    })));
  }

  /** The member's agent drafts its message. It goes straight to the table only if it uses nothing private. */
  private async agentTurn(thread: TableThread, user: string, ask: { text: string; bridge?: string }, allowed: SpeechAct[]): Promise<void> {
    const h = this.host();
    const round = thread.round;
    const alias = thread.aliases[user];
    const answer = thread.answers[user] ?? null;
    const res = await tableTurn({
      ...h.ownerContext(user), alias, decision: thread.decision, question: thread.question, options: thread.options,
      ownAnswer: answer, table: lines(thread), ask, allowed,
    }, h.llmLog(`agent:${user}`));
    if (thread.status !== "talking" || thread.round !== round || !thread.waiting.includes(user)) return;
    const why = approvalReason({
      text: [res.text, res.condition ?? ""].join(" "),
      evidenceIds: res.evidenceIds,
      privateNotes: [
        ...h.privateNotes(user),
        // An answer in the member's own words is private too; only the option labels are shown on the table.
        ...(answer && !thread.options.includes(answer) ? [{ id: "own-answer", text: answer }] : []),
      ],
      publicTexts: [...h.publicTexts(), ...this.threads.flatMap((t) => t.messages.map((m) => m.text))],
      names: h.participants(),
    });
    const draft: TableDraft = {
      id: h.nextId("draft"), threadId: thread.id, round, alias, prompt: ask.text, act: res.act, text: res.text,
      ...(res.condition ? { condition: res.condition } : {}), ...(why ? { why, status: "waiting" } : { status: "sent", auto: true }),
    };
    (thread.drafts[user] ??= []).push(draft);
    if (!why) await this.agentSays(thread, user, draft, false);
  }

  private async agentSays(thread: TableThread, user: string, draft: TableDraft, approved: boolean): Promise<void> {
    const answer = thread.answers[user];
    // A round-1 reading is shown only when it is one of the options.
    const reading = draft.round === 1 && answer && thread.options.includes(answer) && !isUnsure(answer) ? answer : undefined;
    this.say(thread, {
      from: draft.alias, to: "Moderator", act: draft.act, text: draft.text,
      ...(reading ? { reading } : {}), ...(draft.condition ? { condition: draft.condition } : {}), ...(approved ? { approved } : {}),
    }, `agent:${user}`);
    await this.leaveRound(thread, user);
  }

  private async leaveRound(thread: TableThread, user: string): Promise<void> {
    thread.waiting = thread.waiting.filter((p) => p !== user);
    await this.advance(thread);
  }

  /** Everyone answered this round: settle, or ask the Facilitator (a prompt) for the next wording. */
  private async advance(thread: TableThread): Promise<void> {
    if (thread.status !== "talking" || thread.waiting.length || this.busy.has(thread.id)) return;
    this.busy.add(thread.id);
    let next: { bridge: string; message: string } | undefined;
    try {
      if (thread.round > 1) {
        // Silence and "nothing to add" do not block a bridge; members still confirm it in the next check.
        const replies = thread.messages.filter((m) => m.round === thread.round && m.from !== "Moderator" && m.act !== "inform");
        const accepted = replies.filter((m) => m.act === "accept").length;
        if (accepted > 0 && accepted === replies.length) return await this.settle(thread, true);
        if (thread.round - 1 >= this.rules.bridgeRounds) return await this.settle(thread, false);
      }
      const h = this.host();
      const res = await proposeBridge({
        goal: h.goal, decision: thread.decision, question: thread.question, options: thread.options,
        table: lines(thread), lastRound: thread.round >= this.rules.bridgeRounds,
      }, h.llmLog("moderator"));
      if (thread.status !== "talking") return;
      if (res.action !== "bridge") return await this.settle(thread, false);
      thread.bridge = res.bridge;
      next = { bridge: res.bridge, message: res.message };
    } finally {
      this.busy.delete(thread.id);
    }
    if (!next) return;
    const proposal = next;
    await this.startRound(thread, ["accept", "counter", "reject"],
      () => ({ text: proposal.message || "Could your member accept this wording?", bridge: proposal.bridge }), proposal);
  }

  private async settle(thread: TableThread, bridged: boolean): Promise<void> {
    const h = this.host();
    this.end(thread, bridged ? "bridged" : "no_bridge");
    if (!bridged) {
      h.say("The agents could not find one wording that works for everyone yet. Keep talking here; when the team settles on a version, I will check it again.");
      return;
    }
    h.say(`From the agents’ table: every agent that answered could accept “${thread.bridge}”. Each of you now confirms it privately.`);
    if (!h.checkOpen()) await h.openBridgeCheck(thread);
  }

  private end(thread: TableThread, status: TableThread["status"]): void {
    thread.status = status;
    thread.waiting = [];
    for (const list of Object.values(thread.drafts)) for (const d of list) if (d.status === "waiting") d.status = "closed";
  }

  private say(thread: TableThread, line: Pick<TableMessage, "from" | "to" | "act" | "text" | "reading" | "condition" | "approved">,
    who = "moderator"): void {
    const h = this.host();
    thread.messages.push({ id: h.nextId("tm"), threadId: thread.id, at: h.now(), round: thread.round, ...line });
    h.log(who === "moderator" ? "mod_to_agents" : "agent_to_mod", who, line.to, { table: thread.id, act: line.act });
  }
}

/** Round 1: the Moderator asks one agent why its member read the decision that way. */
function positionAsk(thread: TableThread, user: string): string {
  const alias = thread.aliases[user];
  const answer = thread.answers[user] ?? "";
  if (isUnsure(answer)) return `${alias}, your member is not sure yet. What would help them decide?`;
  // The generic check ("Yes, as stated" / "I understood it differently") has no readings to offer.
  if (/differently/i.test(answer)) return `${alias}, your member understood the proposal differently. How do they understand it, and what would make it work for them?`;
  if (/as stated/i.test(answer)) return `${alias}, your member read the proposal as stated. What matters most to them in it, and what change could they accept?`;
  const others = [...new Set(Object.entries(thread.answers)
    .filter(([p, a]) => p !== user && a !== answer && thread.options.includes(a) && !isUnsure(a))
    .map(([, a]) => `“${a}”`))];
  const read = thread.options.includes(answer) ? `answered “${answer}”` : "answered in their own words";
  return `${alias}, your member ${read}. Why do they read it that way? Could they accept ${others.length ? others.join(" or ") : "another reading"}, and on what condition?`;
}

type TableLine = Pick<TableMessage, "from" | "to" | "act" | "text" | "reading" | "condition">;

function lines(thread: TableThread): TableLine[] {
  return thread.messages.map(({ from, to, act, text, reading, condition }) => ({
    from, to, act, text, ...(reading ? { reading } : {}), ...(condition ? { condition } : {}),
  }));
}

export function formatTable(table: TableLine[]): string {
  if (table.length === 0) return "(empty)";
  return table.map((l) => `[${l.from} → ${l.to}] ${l.act}: ${l.text}` +
    (l.reading ? ` (reading: ${l.reading})` : "") + (l.condition ? ` (condition: ${l.condition})` : "")).join("\n");
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
// Model calls: prompts/personal/table_turn.md and prompts/moderator/propose_bridge.md
// =====================================================================

export type TableTurnInput = {
  user: string; goal: string; group: ChatLine[]; privateHistory: PrivateTurn[];
  alias: string; decision: string; question: string; options: string[];
  /** The owner's own answer to the split check. */
  ownAnswer: string | null;
  table: TableLine[];
  /** The Moderator's message this turn answers, and the wording in bridge rounds. */
  ask: { text: string; bridge?: string };
  allowed: SpeechAct[];
};

const ACTS: SpeechAct[] = ["ask", "inform", "propose", "counter", "accept", "reject", "justify", "concede"];
const string = { type: "string" };
function record(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
const turnSchema = record({
  act: { type: "string", enum: ACTS }, text: string, condition: { type: ["string", "null"] },
  evidence: { type: "array", items: record({ id: string, quote: string }) },
});

type Generate = (prompt: string, context: object, schema: object, log?: Log) => Promise<unknown>;

/** One message for the owner, under the owner's code name. The table decides whether the owner approves it first. */
export async function tableTurn(input: TableTurnInput, log?: Log, generate: Generate = callPersonalJSON): Promise<TableTurn> {
  for (let attempt = 0; ; attempt++) {
    const data = await generate("personal/table_turn", {
      reply_language: replyLanguage(input), user: input.user, goal: input.goal,
      group: input.group.map(({ id, author, kind, text }) => ({ id, author, kind, text })),
      privateHistory: input.privateHistory.map(({ id, role, text }) => ({ id, role, text })),
      alias: input.alias, decision: input.decision, question: input.question, options: input.options,
      own_answer: input.ownAnswer, table: input.table, moderator_message: input.ask.text, bridge: input.ask.bridge ?? null,
      allowed_acts: input.allowed,
    }, turnSchema, log) as Record<string, unknown> | null;
    const problem = checkTurn(input, data);
    if (!problem) {
      const d = data as { act: SpeechAct; text: string; condition: string | null; evidence: { id: string }[] };
      const condition = d.condition?.trim() ? d.condition.trim().slice(0, 200) : null;
      // A counter needs the change it asks for.
      return {
        act: d.act === "counter" && !condition ? "reject" : d.act, text: d.text.trim().slice(0, 300), condition,
        evidenceIds: d.evidence.map((e) => e.id),
      };
    }
    console.warn(`[personal/table_turn] rejected model output (${problem})${attempt ? "" : "; retrying once"}`);
    if (attempt) throw new Error("The personal agent returned an invalid response. Please retry.");
  }
}

function checkTurn(input: TableTurnInput, data: Record<string, unknown> | null): string | null {
  if (!data || typeof data !== "object") return "invalid response";
  if (!input.allowed.includes(data.act as SpeechAct) || typeof data.text !== "string" || !data.text.trim()) return "act not allowed or empty text";
  // Evidence must quote the owner's own private turns or named posts exactly.
  const own = new Map<string, string>();
  for (const m of input.group) if (m.id && m.kind !== "moderator" && m.author === input.user) own.set(m.id, m.text);
  for (const m of input.privateHistory) if (m.id && m.role === "user") own.set(m.id, m.text);
  if (!Array.isArray(data.evidence)) return "unverifiable evidence";
  for (const e of data.evidence as { id?: unknown; quote?: unknown }[]) {
    if (typeof e?.id !== "string" || typeof e.quote !== "string" || !e.quote.trim() || !own.get(e.id)?.includes(e.quote.trim())) {
      return "unverifiable evidence";
    }
  }
  const ids = [...input.group, ...input.privateHistory].map((m) => m.id).filter((id): id is string => Boolean(id));
  const said = `${data.text} ${typeof data.condition === "string" ? data.condition : ""}`;
  if (ids.some((id) => said.includes(id))) return "internal id in text";
  return null;
}

export type ProposeBridgeInput = {
  goal: string; decision: string; question: string; options: string[];
  table: TableLine[];
  lastRound: boolean;
};

/** The Facilitator: one wording every agent's member could accept, or none. It sees code names only. */
export async function proposeBridge(input: ProposeBridgeInput, log?: Log): Promise<Bridge> {
  const data = await callJSON<Bridge>(
    "moderator/propose_bridge",
    {
      goal: input.goal, decision: input.decision, question: input.question, options: input.options.join(" / "),
      table: formatTable(input.table), lastRound: input.lastRound ? "yes" : "no",
    },
    input, log,
  );
  const bridge = str(data.bridge);
  const ok = data.action === "bridge" && bridge.length > 0 && norm(bridge) !== norm(input.decision);
  return { action: ok ? "bridge" : "none", bridge: ok ? bridge : "", message: ok ? str(data.message) : "", reason: str(data.reason) };
}
