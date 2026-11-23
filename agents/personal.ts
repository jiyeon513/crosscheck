// Personal-agent decisions. Meeting supplies the complete public room plus only this member's window.
// These functions return private UI data and have no capability to post, vote or edit room state.
import { callPersonalJSON, type LLMRecord } from "./llm";
import { norm } from "./format";
import type { AngleReply, Card, ChatLine, ChatResult, CheckSuggestion, GroupMessage, PrivateTurn, ReactResult, Stage } from "./protocol";

type Log = (record: LLMRecord) => void;
export type Generate = (prompt: string, context: object, schema: object, log?: Log) => Promise<unknown>;
type Evidence = { id: string; quote: string };
type RecentSuggestion = { nudge: string; draft: string; status?: string; evidenceIds?: string[] };
type Base = {
  user: string; goal: string; group: ChatLine[]; privateHistory: PrivateTurn[];
  proposal?: { id: string; version: number; decision: string } | null;
  recentSuggestions?: RecentSuggestion[];
};
export type ChatInput = Base & { stage: Stage; message: string; reference?: Card | GroupMessage | null; intent?: "invite_brainstorm" };
export type ReactInput = Base & { newMessage: ChatLine };
export type AngleReplyInput = Base & { angle: string; intent?: "find_contribution" | "invite_brainstorm" };
export type CheckSuggestInput = Base & { decision: string; question: string; options: string[] };

const string = { type: "string" };
const nullableString = { type: ["string", "null"] };
function record(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
const evidenceSchema = { type: "array", items: record({ id: string, quote: string }) };
const chatSchema = record({
  reply: string, share_draft: nullableString,
  concern: { anyOf: [record({ label: string, draft: string }), { type: "null" }] },
});
const suggestionSchema = record({
  kind: { type: "string", enum: ["none", "grounded", "brainstorm"] },
  nudge: string, draft: string, evidence: evidenceSchema,
});
const checkSchema = record({ suggested_option: nullableString, why: string, evidence: evidenceSchema });

function context(input: Base) {
  return {
    user: input.user, goal: input.goal,
    group: input.group.map(({ id, author, kind, text }) => ({ id, author, kind, text })),
    privateHistory: input.privateHistory.map(({ id, role, text }) => ({ id, role, text })),
    proposal: input.proposal ?? null,
    recentSuggestions: input.recentSuggestions?.map(({ nudge, draft, status }) => ({ nudge, draft, status })) ?? [],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
class InvalidAgentOutput extends Error {}

function requireFormat(valid: unknown, reason = "invalid response"): asserts valid {
  if (!valid) throw new InvalidAgentOutput(reason);
}

/** Run a model call and its validation; on invalid output, log why and ask the model once more. */
async function withRetry<T>(label: string, attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof InvalidAgentOutput)) throw error;
    console.warn(`[personal/${label}] rejected model output (${error.message}); retrying once`);
    try {
      return await attempt();
    } catch (again) {
      if (again instanceof InvalidAgentOutput) {
        console.warn(`[personal/${label}] rejected model output again (${again.message})`);
        throw new Error("The personal agent returned an invalid response. Please retry.");
      }
      throw again;
    }
  }
}
function ownMessages(input: Base): Map<string, string> {
  const notes = new Map<string, string>();
  for (const m of input.group) {
    if (m.id && m.kind !== "moderator" && m.author === input.user) notes.set(m.id, m.text);
  }
  for (const m of input.privateHistory) {
    if (m.id && m.role === "user") notes.set(m.id, m.text);
  }
  return notes;
}

// Never use a draft, an earlier assistant turn, or a peer's message as evidence of the owner's view.
function verifyEvidence(raw: unknown, notes: Map<string, string>): Evidence[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const verified: Evidence[] = [];
  for (const item of raw) {
    if (!isObject(item) || !nonblank(item.id) || !nonblank(item.quote) || seen.has(item.id)) return null;
    const quote = item.quote.trim();
    if (!/[\p{L}\p{N}]/u.test(quote) || !notes.get(item.id)?.includes(quote)) return null;
    seen.add(item.id);
    verified.push({ id: item.id, quote });
  }
  return verified;
}

function cardContext(reference: ChatInput["reference"]) {
  if (!reference) return null;
  if ("text" in reference) {
    const angle = reference.note?.type === "angle_prompt" ? reference.note.angle : undefined;
    return { kind: reference.kind, author: reference.author, text: reference.text, angle };
  }
  switch (reference.kind) {
    case "share_suggestion": return { kind: reference.kind, nudge: reference.nudge, draft: reference.draft };
    case "concern": return { kind: reference.kind, label: reference.label, draft: reference.draft };
    case "understanding_check": return {
      kind: reference.kind, version: reference.version, decision: reference.decision, question: reference.question, options: reference.options,
      suggested: reference.suggested, why: reference.why, answer: reference.answer,
    };
  }
}

function containsInternalId(input: Base, text: string, reference?: ChatInput["reference"]): boolean {
  const ids = new Set([...input.privateHistory, ...input.group].map(m => m.id).filter(Boolean));
  for (const id of input.recentSuggestions?.flatMap(s => s.evidenceIds ?? []) ?? []) ids.add(id);
  if (input.proposal) ids.add(input.proposal.id);
  if (reference) {
    ids.add(reference.id);
    if ("checkId" in reference && reference.checkId) ids.add(reference.checkId);
    if ("evidenceIds" in reference && Array.isArray(reference.evidenceIds)) {
      for (const id of reference.evidenceIds) ids.add(id);
    }
  }
  return [...ids].some(id => id && text.includes(id));
}

export async function chat(input: ChatInput, log?: Log, generate: Generate = callPersonalJSON): Promise<ChatResult> {
  return withRetry("chat", async () => {
    const data = await generate("personal/chat", {
      ...context(input), stage: input.stage, message: input.message, reference: cardContext(input.reference), intent: input.intent ?? null,
    }, chatSchema, log);
    requireFormat(isObject(data) && nonblank(data.reply), "empty reply");
    requireFormat(data.share_draft === null || nonblank(data.share_draft), "blank share_draft");
    let concern: ChatResult["concern"] = null;
    if (data.concern !== null) {
      requireFormat(isObject(data.concern) && nonblank(data.concern.label) && nonblank(data.concern.draft), "incomplete concern");
      concern = { label: data.concern.label.trim(), draft: data.concern.draft.trim() };
    }
    // At most one draft: when the model offers both, the concern is the one that matters to the decision.
    const draft = concern ? null : data.share_draft?.trim() ?? null;
    requireFormat(
      !containsInternalId(input, [data.reply, draft, concern?.draft, concern?.label].join(" "), input.reference),
      "internal id in text",
    );
    return { reply: data.reply.trim(), share_draft: draft, concern };
  });
}

type Suggestion = { nudge: string; draft: string; evidenceIds: string[] };
function comparable(text: string) {
  return norm(text.normalize("NFKC"));
}
async function suggest(input: Base, prompt: string, trigger: object, brainstorm: boolean, generate: Generate, log?: Log): Promise<Suggestion | null> {
  const notes = ownMessages(input);
  if (!brainstorm && !notes.size) return null;
  const data = await generate(prompt, { ...context(input), ...trigger }, suggestionSchema, log);
  requireFormat(isObject(data) && ["none", "grounded", "brainstorm"].includes(String(data.kind)), "unknown kind");
  if (data.kind === "none") return null;
  requireFormat(nonblank(data.nudge) && nonblank(data.draft), "empty suggestion");
  const evidence = verifyEvidence(data.evidence, notes);
  if (!evidence || (data.kind === "grounded" ? !evidence.length : !brainstorm || evidence.length > 0)) return null;
  if (containsInternalId(input, data.nudge + " " + data.draft)) return null;

  // The prompt checks semantic novelty; these comparisons also catch verbatim public or previously shown text.
  const nudge = comparable(data.nudge), draft = comparable(data.draft);
  const publicTexts = new Set(input.group.map(m => comparable(m.text)));
  if (!draft || publicTexts.has(draft)) return null;
  // If every cited private contribution is already a public post, rephrasing it is not a new contribution.
  const privateIds = new Set(input.privateHistory.filter(m => m.role === "user").map(m => m.id));
  if (evidence.length && evidence.every(e => privateIds.has(e.id) && publicTexts.has(comparable(e.quote)))) return null;
  if (input.recentSuggestions?.some(s => comparable(s.nudge) === nudge || comparable(s.draft) === draft)) return null;
  return { nudge: data.nudge.trim(), draft: data.draft.trim(), evidenceIds: evidence.map(e => e.id) };
}

export async function react(input: ReactInput, log?: Log, generate: Generate = callPersonalJSON): Promise<ReactResult & { evidenceIds: string[] }> {
  const item = input.newMessage.author === input.user ? null
    : await suggest(input, "personal/react", { newMessage: input.newMessage }, false, generate, log);
  return item ? { suggest: true, ...item } : { suggest: false, nudge: "", draft: "", evidenceIds: [] };
}

export async function angleReply(input: AngleReplyInput, log?: Log, generate: Generate = callPersonalJSON): Promise<AngleReply & { evidenceIds: string[] }> {
  const intent = input.intent ?? "find_contribution";
  const item = await suggest(input, "personal/angle_reply", { intent, angle: input.angle }, intent === "invite_brainstorm", generate, log);
  // The only label eligible to travel back to the Moderator is the Moderator's own public angle.
  return item ? { has_view: true, label: input.angle, ...item }
    : { has_view: false, label: "", nudge: "", draft: "", evidenceIds: [] };
}

export async function suggestCheckAnswer(input: CheckSuggestInput, log?: Log, generate: Generate = callPersonalJSON): Promise<CheckSuggestion & { evidenceIds: string[] }> {
  return withRetry("suggest_check_answer", async () => {
    const data = await generate("personal/suggest_check_answer", {
      ...context(input), decision: input.decision, question: input.question, options: input.options,
    }, checkSchema, log);
    requireFormat(isObject(data) && nonblank(data.why), "empty why");
    const evidence = verifyEvidence(data.evidence, ownMessages(input));
    requireFormat(evidence !== null && !containsInternalId(input, data.why), "unverifiable evidence");
    // An unsupported guess is dropped, not fatal: the member still gets the question.
    const choice = data.suggested_option;
    const supported = nonblank(choice) && input.options.includes(choice) && evidence.length > 0;
    return { suggested_option: supported ? choice : null, why: data.why.trim(), evidenceIds: supported ? evidence.map(e => e.id) : [] };
  });
}
