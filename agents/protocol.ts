// The contract between the moderator, the personal agents, and the web UI.
// If you change a type here, tell the other team first (docs/api.md mirrors this file).

export type Stage = "ideation" | "agreement" | "done";

/** Derived from the meeting state by agents/meeting.ts, never set by a prompt. */
export type Phase = "explore" | "converge" | "confirm";

export type Stance = "support" | "hesitant" | "unsure";

// ---------- group chat ----------

/** One line of the group chat, as the agents read it. */
export type ChatLine = { id?: string; author: string; text: string; kind?: "user" | "moderator" };

/** Extra structured info on a moderator message, so the UI can render it without parsing text. */
export type ModeratorNote =
  | { type: "angle_prompt"; angle: string }
  | { type: "angle_requested" }
  | { type: "check_opened"; version: number }
  | { type: "check_closed" }
  /** The Moderator asks whether to revisit an agreed decision. Members answer with buttons. */
  | { type: "reopen_prompt"; recordId: string; decision: string }
  | { type: "reopen_result"; reopened: boolean }
  | { type: "agreement_count"; agreed: number; total: number }
  | { type: "agreed"; agreed: number; total: number; statement: string }
  | { type: "concern" }
  | { type: "poll_opened"; pollId: string; round: number }
  | { type: "poll_result"; pollId: string; fitsAll: boolean }
  | { type: "private_concern"; label: string };

export type GroupMessage = {
  id: string;
  author: string; // participant name, or "Moderator"
  kind: "user" | "moderator";
  text: string;
  at: number;
  note?: ModeratorNote;
  anonymous?: boolean;
  /** The message this one replies to. The agents read it as part of the message. */
  quote?: Quote;
  attachments?: Attachment[];
  /** Co-authors of a joint post. */
  joint?: string[];
};

export type Quote = { author: string; text: string };

/** A file or picture attached to a message. Agents only see its name and kind, never its contents. */
export type Attachment = { id: string; name: string; type: string; size: number; url: string };

// ---------- private window (one per participant) ----------

export type PrivateTurn = { id?: string; role: "user" | "agent"; text: string };

/** The agent offers a message the user could post in the group chat. Nothing is posted until the user shares it. */
export type ShareSuggestionCard = {
  kind: "share_suggestion";
  id: string;
  source: "chat" | "missing_angle" | "react" | "quiet";
  nudge: string;
  draft: string;
  evidenceIds?: string[];
  checkId?: string;
  status: "open" | "shared" | "dismissed" | "superseded";
};

/** The moderator's agreement check, shown privately to each member. */
export type UnderstandingCheckCard = {
  kind: "understanding_check";
  id: string;
  checkId: string;
  decision: string;
  question: string;
  options: string[];
  suggested?: string; // the personal agent's guess, from this user's own words
  why?: string;
  version: number;
  evidenceIds?: string[];
  approved?: boolean;
  status: "open" | "answered" | "closed";
  answer?: string;
  suggestedStance?: Stance | null;
  stance?: Stance;
};

/** The agent helped the user pin down a concern. The user chooses how to raise it. */
export type ConcernCard = {
  kind: "concern";
  id: string;
  label: string;
  draft: string;
  checkId?: string;
  status: "open" | "raised_named" | "raised_anonymous" | "told_moderator" | "dismissed" | "superseded";
};

/** A private question from the Moderator. The agent pre-fills an answer; only the member sends it. */
export type PollCard = {
  kind: "poll";
  id: string;
  pollId: string;
  question: string;
  round: number;
  draft: string;
  why?: string;
  status: "open" | "answered" | "skipped" | "closed";
  answer?: string;
};

/** Saved only if the member says so. */
export type MemoryCard = {
  kind: "memory";
  id: string;
  text: string;
  status: "open" | "saved" | "dismissed";
};

/** Nobody is named until both members accept. */
export type PairCard = {
  kind: "pair";
  id: string;
  pairingId: string;
  topic: string;
  status: "open" | "accepted" | "declined" | "matched" | "closed";
};

export type JointCard = {
  kind: "joint";
  id: string;
  pairingId: string;
  partner: string;
  draft: string;
  status: "open" | "posted" | "dismissed";
};

export type Card = ShareSuggestionCard | UnderstandingCheckCard | ConcernCard | PollCard | MemoryCard | PairCard | JointCard;

/** Read only by its owner's agent. */
export type MemoryItem = { id: string; text: string; at: number };

export type PrivateItem =
  | { id: string; at: number; type: "user" | "agent"; text: string; attachments?: Attachment[] }
  | { id: string; at: number; type: "card"; card: Card };

// ---------- messages between the moderator and the personal agents ----------
// These are the ONLY things that cross the privacy boundary. Labels only, never private text.

export type ModeratorToAgent =
  | { type: "angle_query"; angle: string; intent?: "find_contribution" | "invite_brainstorm" }
  | { type: "check_request"; checkId: string; decision: string; question: string; options: string[] }
  | { type: "poll_request"; pollId: string; question: string }
  | { type: "pair_offer"; pairingId: string; topic: string };

export type AgentToModerator =
  | { type: "angle_reply"; hasView: boolean; label: string }
  | { type: "check_reply"; checkId: string; label: string }
  | { type: "poll_reply"; pollId: string; label: string }
  | { type: "stance"; checkId: string; stance: Stance }
  | { type: "pair_reply"; pairingId: string; accept: boolean }
  | { type: "concern"; label: string };

// ---------- LLM outputs (field names match the JSON each prompt asks for) ----------

export type MissingAngle = { action: "none" | "ask_angle"; angle: string; group_prompt: string; reason: string };

export type DecisionDetection = {
  is_decision: boolean;
  decision: string;
  ambiguity: string;
  question: string;
  options: string[];
  reason: string;
  /** 1-based number of an already agreed decision that the newest message questions or wants to change; 0 if none. */
  challenged?: number;
};

export type Comparison = {
  groups: number[][]; // answer numbers (1-based) grouped by meaning
  aligned: boolean;
  final_statement: string;
  anonymous_question: string;
  reason: string;
};

export type ChatResult = {
  reply: string;
  share_draft: string | null;
  concern: { label: string; draft: string } | null;
  remember: string | null;
};

export type PollReply = { draft: string | null; why: string };

export type PollCombination = {
  result: string;
  fits_all: boolean;
  follow_up: string;
  reason: string;
};

export type AngleReply = { has_view: boolean; label: string; nudge: string; draft: string; evidenceIds?: string[] };

export type ReactResult = { suggest: boolean; nudge: string; draft: string; evidenceIds?: string[] };

export type CheckSuggestion = { suggested_option: string | null; why: string; evidenceIds?: string[]; stance?: Stance | null };

export type PieceCombination = { draft: string; reason: string };

// ---------- meeting state ----------

export type Check = {
  id: string;
  version: number;
  approvals: Record<string, boolean>;
  decision: string;
  question: string;
  options: string[];
  status: "collecting" | "aligned" | "mismatch" | "cancelled";
  askedOf: string[]; // participants when the check started
  answers: Record<string, string>; // participant -> label. Names never reach the moderator LLM.
  concerns: string[]; // anonymous labels
  createdAt: number;
  agreed?: number;
  total?: number;
  statement?: string;
  /** Id of the agreed decision this check would replace if it is agreed. */
  replaces?: string;
  ambiguity?: string;
  topicId?: string;
  /** After a split. Own-words answers are never shown verbatim. */
  readings?: string[];
  stances?: Record<string, Stance>;
};

export type Pairing = {
  id: string;
  topic: string;
  members: [string, string];
  answers: Record<string, boolean>;
  status: "offered" | "matched" | "declined" | "posted";
  /** Shared with the other member only if both accept. */
  drafts: Record<string, string>;
};

export type Poll = {
  id: string;
  question: string;
  round: number;
  askedOf: string[];
  answers: Record<string, string>;
  skipped: string[];
  status: "collecting" | "done";
  createdAt: number;
  result?: string;
  fitsAll?: boolean;
  followUpOf?: string;
};

// ---------- meeting board ----------

export type BoardVersion = {
  version: number;
  text: string;
  status: "checking" | "split" | "agreed" | "replaced" | "cancelled";
  readings?: string[];
};

export type BoardTopic = {
  id: string;
  statement: string;
  status: "checking" | "split" | "discussing" | "agreed" | "closed";
  ambiguity?: string;
  question?: string;
  versions: BoardVersion[];
  answered?: number;
  askedOf?: number;
  /** Counted without names, and only once two or more were shared. */
  stances?: Record<Stance, number>;
};

export type BoardPoll = {
  id: string;
  question: string;
  round: number;
  status: Poll["status"];
  answered: number;
  askedOf: number;
  result?: string;
  fitsAll?: boolean;
};

export type Board = { phase: Phase; topics: BoardTopic[]; polls: BoardPoll[] };

export type DecisionRecord = {
  id: string;
  checkId: string;
  version: number;
  supersededBy?: number;
  statement: string;
  at: number;
  /** Id of the earlier agreed decision this one replaces (after the team revisited it). */
  replaces?: string;
  /** Id of the later decision that replaced this one. */
  replacedBy?: string;
};

/** A decision the team is talking about again: after a split check, or an agreed one someone questioned. */
export type Discussion = {
  decision: string;
  /** "asking": the Moderator asked whether to revisit it. "open": the team is revisiting it. */
  status: "asking" | "open";
  /** The agreed decision being revisited, if any. */
  recordId?: string;
  topicId?: string;
};

/** Everything one participant is allowed to see. This is what GET /rooms/:id/view returns. */
export type UserView = {
  roomId: string;
  me: string;
  isHost: boolean;
  goal: string;
  stage: Stage;
  participants: string[];
  group: GroupMessage[];
  private: PrivateItem[];
  agentTyping: boolean;
  agreement: null | {
    checkId: string;
    version: number;
    approvedCount: number;
    status: Check["status"];
    decision: string;
    question: string;
    answered: number;
    askedOf: number;
    agreed?: number;
    total?: number;
    statement?: string;
  };
  decisions: DecisionRecord[];
  /** A decision the team is talking about again, if any. */
  discussing: Discussion | null;
  /** Public: no names, no private text. */
  phase: Phase;
  board: Board;
  memory: MemoryItem[];
  llm: { mode: "mock" | "live" | "unconfigured"; model: string; moderatorModel?: string };
};

// ---------- trace (for debugging, the privacy check, and the report) ----------

export type TraceEvent = {
  at: number;
  type: "llm_call" | "mod_to_agents" | "agent_to_mod" | "mod_to_group" | "user_to_group" | "user_to_agent";
  from: string; // "moderator" | "agent:<name>" | "user:<name>"
  to: string;
  data: Record<string, unknown>;
};
