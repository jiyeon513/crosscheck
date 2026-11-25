// The agents' table: the types shared by agents/table.ts and the UI.

export type SpeechAct = "ask" | "inform" | "propose" | "counter" | "accept" | "reject" | "justify" | "concede";

/** position: the Moderator and one agent alone. respond and react: every agent, on the table. */
export type TableStep = "position" | "respond" | "react";

/** private: one agent and the Moderator. table: every agent; members see it without code names. Reasons are never on the table. */
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
  to: string;
  act: SpeechAct;
  text: string;
  /** A wording: the Moderator's proposal, an agent's change, or the change a reaction is about. */
  wording?: string;
  target?: string;
  reading?: string;
  condition?: string;
  approved?: boolean;
};

/** What a member's agent would say or do for them. It waits for the member only if it draws on their private notes. */
export type TableDraft = {
  id: string;
  threadId: string;
  round: number;
  step: TableStep;
  prompt: string;
  act: SpeechAct;
  /** position: the reason for the Moderator. respond: the changed wording, if the act is counter. */
  text: string;
  condition?: string;
  reactions?: { target: string; wording: string; act: "accept" | "reject" }[];
  note?: string;
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
  wording?: string;
  wordings: { round: number; text: string; note: string }[];
  bridge?: string;
  bridgedBy?: "moderator" | "agents";
  messageId?: string;
  createdAt: number;
  roundStartedAt: number;
};

/** One wording round as members and agents see it: no code names, no reasons, only finished steps. */
export type TableRound = {
  round: number;
  wording: string;
  note: string;
  answered: boolean;
  accepted: number;
  changed: number;
  rejected: number;
  silent: number;
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
