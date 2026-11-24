// The agents' table: how the Moderator and the Personal Agents look for one wording after a split check.
// Its own contract, next to protocol.ts, so the table can change without touching the shared one.

/** What a message does in the conversation. */
export type SpeechAct = "ask" | "inform" | "propose" | "counter" | "accept" | "reject" | "justify" | "concede";

/**
 * position: the Moderator and one agent alone. respond: each agent answers the wording on the table.
 * react: each agent supports (accept) or objects to (reject) the changes the other agents proposed.
 */
export type TableStep = "position" | "respond" | "react";

/**
 * private: between the Moderator and one agent; only that agent's member sees it.
 * table: seen by every agent; members see it without code names once the step is over.
 * Only a wording, an act and the change it is about can be on the table. Reasons never are.
 */
export type TableScope = "private" | "table";

export type TableMessage = {
  id: string;
  threadId: string;
  at: number;
  round: number;
  step: TableStep;
  scope: TableScope;
  /** "Moderator" or a code name. Code names never leave the server. */
  from: string;
  /** "Moderator", "all" or a code name. */
  to: string;
  act: SpeechAct;
  /** Private messages and the Moderator's notes only. */
  text: string;
  /** A wording: the Moderator's proposal, an agent's change, or the change a reaction is about. */
  wording?: string;
  /** The change a reaction is about. */
  target?: string;
  /** Private: the member's answer to the split check, when it is one of the options. */
  reading?: string;
  /** Private: what would make another reading acceptable to the member. */
  condition?: string;
  /** The member approved this text first. */
  approved?: boolean;
};

/** What a member's agent would say or do for them. It waits for the member only if it draws on their private notes. */
export type TableDraft = {
  id: string;
  threadId: string;
  round: number;
  step: TableStep;
  /** What the agent answers. */
  prompt: string;
  act: SpeechAct;
  /** position: the reason for the Moderator. respond: the changed wording, if the act is counter. */
  text: string;
  condition?: string;
  /** react: the agent's support (accept) or objection (reject) to each of the other agents' changes. */
  reactions?: { target: string; wording: string; act: "accept" | "reject" }[];
  /** For the member only: what the agent based this on. */
  note?: string;
  /** Why the member is asked first. */
  why?: string;
  status: "waiting" | "sent" | "declined" | "closed";
  /** Sent without asking, because it used nothing private. */
  auto?: boolean;
};

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
  /** Members whose agent has not finished the current step. */
  waiting: string[];
  /** Member -> what their agent drafted. Each member sees only their own. */
  drafts: Record<string, TableDraft[]>;
  round: number;
  step: TableStep;
  /** Steps that are over ("2:respond"); only these are shown to members. */
  done: string[];
  /** offered: the check split and any member can start the table; nothing has been said yet. */
  status: "offered" | "talking" | "bridged" | "no_bridge" | "closed";
  messages: TableMessage[];
  /** The wording on the table now. */
  wording?: string;
  /** The Moderator's wordings, one per round from round 2. */
  wordings: { round: number; text: string; note: string }[];
  bridge?: string;
  /** Who settled it: every agent accepted the Moderator's wording, or the agents backed one agent's change. */
  bridgedBy?: "moderator" | "agents";
  /** The Moderator's team chat message that opened the table. */
  messageId?: string;
  createdAt: number;
  roundStartedAt: number;
};

/** One wording round as members and agents see it: no code names, no reasons, only finished steps. */
export type TableRound = {
  round: number;
  wording: string;
  note: string;
  /** False until every agent answered the wording. */
  answered: boolean;
  accepted: number;
  changed: number;
  rejected: number;
  silent: number;
  /** False until every agent reacted to the changes. */
  reacted: boolean;
  changes: { id: string; wording: string; support: number; object: number }[];
};

/** What one member sees of a thread: the table without code names, plus their own agent's thread. */
export type ThreadView = {
  id: string;
  protocol: TableThread["protocol"];
  status: TableThread["status"];
  step: TableStep;
  round: number;
  decision: string;
  question: string;
  bridge?: string;
  bridgedBy?: TableThread["bridgedBy"];
  messageId?: string;
  agents: number;
  waitingFor: number;
  rounds: TableRound[];
  /** Only this member's agent: the Moderator's questions to it, its replies and its moves ("Your agent"). */
  mine: TableMessage[];
  drafts: TableDraft[];
};

// ---------- model outputs ----------

export type Bridge = { action: "bridge" | "none"; bridge: string; message: string; reason: string };
