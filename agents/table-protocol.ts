// The agents' table: typed messages between the Moderator and the Personal Agents, under code names.
// Its own contract, next to protocol.ts, so the table can change without touching the shared one.

/** What a message does in the conversation. */
export type SpeechAct = "ask" | "inform" | "propose" | "counter" | "accept" | "reject" | "justify" | "concede";

/** One message on the table. Agents speak under a code name (Agent A, B, ...), never a member's name. */
export type TableMessage = {
  id: string;
  threadId: string;
  at: number;
  round: number;
  /** "Moderator" or a code name. */
  from: string;
  /** "all", "Moderator" or a code name. */
  to: string;
  act: SpeechAct;
  text: string;
  /** The reading this message is about; for a proposal, the wording on the table. */
  reading?: string;
  /** What would make it acceptable. */
  condition?: string;
  /** The member approved this text first. */
  approved?: boolean;
};

/**
 * What a member's agent would say for them. It goes to the table straight away only when it uses
 * nothing the member said in private (agents/membrane.ts); otherwise it waits for the member.
 */
export type TableDraft = {
  id: string;
  threadId: string;
  round: number;
  alias: string;
  /** The Moderator's message this answers. */
  prompt: string;
  act: SpeechAct;
  text: string;
  condition?: string;
  /** Why the member is asked first. */
  why?: string;
  status: "waiting" | "sent" | "declined" | "closed";
  /** Sent without asking, because it used nothing private. */
  auto?: boolean;
};

/**
 * Shuttle diplomacy after a split check. Round 1: each agent gives its member's reading and reason.
 * Later rounds: the Moderator proposes a bridge wording and each agent accepts, counters or rejects it.
 */
export type TableThread = {
  id: string;
  protocol: "shuttle";
  checkId: string;
  /** The agreed decision the split check would replace, if any; the bridge check replaces it too. */
  replaces?: string;
  decision: string;
  question: string;
  options: string[];
  /** Member -> their answer to the split check. Never leaves the server. */
  answers: Record<string, string>;
  /** Member -> code name. Never leaves the server. */
  aliases: Record<string, string>;
  /** Members whose agent has not answered this round. */
  waiting: string[];
  /** Member -> what their agent drafted. Each member sees only their own. */
  drafts: Record<string, TableDraft[]>;
  round: number;
  /** offered: the check split and any member can start the table; nothing has been said yet. */
  status: "offered" | "talking" | "bridged" | "no_bridge" | "closed";
  messages: TableMessage[];
  bridge?: string;
  /** The Moderator's team chat message that opened the table. */
  messageId?: string;
  createdAt: number;
  roundStartedAt: number;
};

/** What one member sees of a thread: code names only, which one is theirs, and their own drafts. */
export type ThreadView = {
  id: string;
  protocol: TableThread["protocol"];
  status: TableThread["status"];
  round: number;
  decision: string;
  question: string;
  bridge?: string;
  messageId?: string;
  messages: TableMessage[];
  agents: number;
  waitingFor: number;
  yours?: string;
  drafts: TableDraft[];
};

// ---------- model outputs ----------

export type TableTurn = { act: SpeechAct; text: string; condition: string | null; evidenceIds: string[] };

export type Bridge = { action: "bridge" | "none"; bridge: string; message: string; reason: string };
