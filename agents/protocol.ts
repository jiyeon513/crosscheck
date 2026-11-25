// The contract between the moderator, the personal agents, and the web UI.
// If you change a type here, tell the other team first (docs/api.md mirrors this file).

import type { ThreadView } from "./table-protocol";

export type Stage = "ideation" | "agreement" | "done";

// ---------- group chat ----------

export const TEAM_QUESTION_NOTICE =
  "Let’s see what we might be missing. I’m asking your Personal Agents to look for ideas you’ve had but haven’t shared with the group yet.";

/** One line of the group chat, as the agents read it. */
export type ChatLine = { id?: string; author: string; text: string; kind?: "user" | "moderator" };

/** Extra structured info on a moderator message, so the UI can render it without parsing text. */
export type ModeratorNote =
  | { type: "angle_prompt"; angle: string }
  | { type: "angle_requested" }
  | { type: "check_opened"; version: number }
  | { type: "check_closed" }
  | { type: "no_proposal" }
  | { type: "check_queued" }
  /** The Moderator asks whether to revisit an agreed decision. Members answer with buttons. */
  | { type: "reopen_prompt"; recordId: string; decision: string }
  | { type: "reopen_result"; reopened: boolean }
  | { type: "agreement_count"; agreed: number; total: number }
  | { type: "agreed"; agreed: number; total: number; statement: string }
  | { type: "concern" };

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
  source: "chat" | "missing_angle" | "react" | "group_question";
  relayedQuestion?: Quote;
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
};

/** The agent helped the user pin down a concern. The user chooses how to raise it. */
export type ConcernCard = {
  kind: "concern";
  id: string;
  label: string;
  draft: string;
  checkId?: string;
  status: "open" | "raised_named" | "raised_anonymous" | "dismissed" | "superseded";
};

export type Card = ShareSuggestionCard | UnderstandingCheckCard | ConcernCard;

export type PrivateItem =
  | { id: string; at: number; type: "user" | "agent"; text: string; attachments?: Attachment[] }
  | { id: string; at: number; type: "card"; card: Card };

// ---------- messages between the moderator and the personal agents ----------
// These are the ONLY things that cross the privacy boundary. Labels only, never private text.

export type ModeratorToAgent =
  | { type: "angle_query"; angle: string; intent?: "find_contribution" | "invite_brainstorm" }
  | { type: "check_request"; checkId: string; decision: string; question: string; options: string[] };

export type AgentToModerator =
  | { type: "angle_reply"; hasView: boolean; label: string }
  | { type: "check_reply"; checkId: string; label: string }
  | { type: "concern"; label: string };

// ---------- LLM outputs (field names match the JSON each prompt asks for) ----------

export type MissingAngle = { action: "none" | "ask_angle"; angle: string; group_prompt: string; reason: string };

export type DecisionDetection = {
  /** The exact clause in the new public message asking teammates to contribute ideas. */
  invitation_quote?: string;
  /** Words in the newest post adopting a concrete change to the open proposal. */
  revision_quote?: string;
  is_decision: boolean;
  decision: string;
  ambiguity: string;
  question: string;
  options: string[];
  reason: string;
  /** 1-based number of an already agreed decision that the newest message questions or wants to change; 0 if none. */
  challenged?: number;
  /** The newest message questions or wants to change the proposal that is being checked now, without settling a new version. */
  open_challenged?: boolean;
  /** While a check is open: this decision is about the same question as the open proposal (not something separate). */
  replaces_open?: boolean;
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
};

export type AngleReply = { has_view: boolean; label: string; nudge: string; draft: string; evidenceIds?: string[] };

export type ReactResult = { suggest: boolean; nudge: string; draft: string; evidenceIds?: string[] };

export type CheckSuggestion = { suggested_option: string | null; why: string; evidenceIds?: string[] };

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
};

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
  /** The agents' table, under code names (agents/table-protocol.ts). */
  table: ThreadView[];
  llm: { mode: "mock" | "live" | "unconfigured"; model: string };
};

// ---------- trace (for debugging, the privacy check, and the report) ----------

export type TraceEvent = {
  at: number;
  type: "llm_call" | "mod_to_agents" | "agent_to_mod" | "mod_to_group" | "user_to_group" | "user_to_agent";
  from: string; // "moderator" | "agent:<name>" | "user:<name>"
  to: string;
  data: Record<string, unknown>;
};
