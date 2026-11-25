// Task 2: before the Moderator looks for a missing angle, each personal agent reports short topic
// labels for what its member has thought about privately but not posted.
//
// Labels are the only thing that leaves the member's window here: 2 to 4 words each, never a sentence.
// The Moderator gets them merged and shuffled (agents/meeting.ts), without names.

import { callPersonalJSON, type LLMRecord } from "./llm";
import { norm } from "./format";
import type { ChatLine, PrivateTurn } from "./protocol";

type Log = (record: LLMRecord) => void;
type Generate = (prompt: string, context: object, schema: object, log?: Log) => Promise<unknown>;

export type TopicInput = { user: string; goal: string; group: ChatLine[]; privateHistory: PrivateTurn[] };

const schema = {
  type: "object",
  properties: { labels: { type: "array", items: { type: "string" } } },
  required: ["labels"],
  additionalProperties: false,
};

export const MAX_LABELS = 3;
export const MAX_LABEL_WORDS = 4;
export const MAX_LABEL_CHARS = 40;

export async function topicLabels(input: TopicInput, log?: Log, generate: Generate = callPersonalJSON): Promise<string[]> {
  const notes = input.privateHistory.filter((turn) => turn.role === "user").map((turn) => norm(turn.text));
  if (!notes.length) return []; // nothing private to report, so no model call
  const data = await generate("personal/topic_labels", {
    user: input.user, goal: input.goal,
    group: input.group.map(({ author, kind, text }) => ({ author, kind, text })),
    privateHistory: input.privateHistory.map(({ role, text }) => ({ role, text })),
  }, schema, log) as { labels?: unknown };
  if (!Array.isArray(data?.labels)) return [];
  const labels = data.labels
    .filter((label): label is string => typeof label === "string" && label.trim().length > 0)
    .map((label) => label.trim())
    // A label names a topic. Anything long enough to carry a private sentence is dropped.
    .filter((label) => label.split(/\s+/).length <= MAX_LABEL_WORDS && label.length <= MAX_LABEL_CHARS)
    .filter((label) => !notes.some((note) => note.length >= 15 && norm(label).includes(note)));
  return [...new Set(labels)].slice(0, MAX_LABELS);
}
