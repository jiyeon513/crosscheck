// The Moderator agent. Owner: Jeehye.
//
// The moderator reads ONLY the group chat and the anonymous labels that personal agents send back.
// Nothing in this file takes private text as input. Keep it that way.
//
// One function = one prompt in prompts/moderator/. Timing (when each is called) lives in meeting.ts.

import { callJSON, type LLMRecord } from "./llm";
import { formatChat, formatList, isUnsure, norm, str, strList } from "./format";
import type { ChatLine, Comparison, DecisionDetection, MissingAngle } from "./protocol";

type Log = (record: LLMRecord) => void;

// ---------- 1. Is the brainstorm missing an angle? (called after the chat goes quiet) ----------

export type MissingAngleInput = { goal: string; group: ChatLine[]; anglesAsked: string[] };

export async function findMissingAngle(input: MissingAngleInput, log?: Log): Promise<MissingAngle> {
  const data = await callJSON<MissingAngle>(
    "moderator/find_missing_angle",
    {
      goal: input.goal,
      anglesAsked: formatList(input.anglesAsked),
      groupChat: formatChat(input.group),
    },
    input, log,
  );
  const angle = str(data.angle);
  const ask = data.action === "ask_angle" && angle.length > 0;
  return {
    action: ask ? "ask_angle" : "none",
    angle: ask ? angle : "",
    group_prompt: ask ? str(data.group_prompt) : "",
    reason: str(data.reason),
  };
}

// ---------- 2. Is the team settling on a decision? (called on each new group message) ----------

export type DetectDecisionInput = {
  goal: string;
  group: ChatLine[];
  trigger: "new_message" | "host_request";
  /** The proposal of the agreement check that is collecting answers now, if any. */
  openProposal?: string | null;
  /** Decisions this meeting already agreed on. Re-confirming one of them is not a new decision. */
  agreed?: string[];
};

export async function detectDecision(input: DetectDecisionInput, log?: Log): Promise<DecisionDetection> {
  const newest = input.group[input.group.length - 1];
  const data = await callJSON<DecisionDetection>(
    "moderator/detect_decision",
    {
      goal: input.goal,
      trigger: input.trigger,
      earlierChat: formatChat(input.group.slice(0, -1)),
      newestMessage: newest ? `[${newest.author}] ${newest.text}` : "(none)",
      openProposal: input.openProposal?.trim() || "(none)",
      agreedDecisions: formatList(input.agreed ?? []),
    },
    input, log,
  );
  const options = strList(data.options).slice(0, 4);
  const ok = Boolean(data.is_decision) && str(data.decision).length > 0;
  if (ok && !options.some(isUnsure)) options.push("Not sure yet");
  return {
    is_decision: ok,
    decision: ok ? str(data.decision) : "",
    ambiguity: str(data.ambiguity),
    question: ok ? str(data.question) || "Is this how you understood the decision?" : "",
    options: ok ? (options.length >= 2 ? options : ["Yes, as stated", "I understood it differently", "Not sure yet"]) : [],
    reason: str(data.reason),
  };
}

// ---------- 3. Did everyone understand the decision the same way? (called when the answers are in) ----------

export type CompareInput = {
  decision: string;
  question: string;
  /** Anonymous, already shuffled. The moderator never learns who said what. */
  labels: string[];
  concerns: string[];
};

export async function compareUnderstanding(input: CompareInput, log?: Log): Promise<Comparison> {
  const data = await callJSON<Comparison>(
    "moderator/compare_understanding",
    {
      decision: input.decision,
      question: input.question,
      answers: formatList(input.labels),
      concerns: formatList(input.concerns),
    },
    input, log,
  );

  // Counting is done here, not by the model. The model only groups answers by meaning.
  const groups = validPartition(data.groups, input.labels.length) ? data.groups : groupByText(input.labels);
  const aligned = groups.length === 1 && Boolean(data.aligned) && !input.labels.every(isUnsure);
  const readings = groups.map((g) => input.labels[g[0] - 1]);
  return {
    groups,
    aligned,
    final_statement: aligned ? str(data.final_statement) || input.decision : "",
    anonymous_question: aligned
      ? ""
      : str(data.anonymous_question) || `Quick check before we move on. ${input.question} (${readings.join(" / ")})`,
    reason: str(data.reason),
  };
}

function validPartition(groups: unknown, n: number): groups is number[][] {
  if (!Array.isArray(groups) || groups.length === 0) return false;
  const seen = new Set<number>();
  for (const g of groups) {
    if (!Array.isArray(g) || g.length === 0) return false;
    for (const i of g) {
      if (!Number.isInteger(i) || i < 1 || i > n || seen.has(i)) return false;
      seen.add(i);
    }
  }
  return seen.size === n;
}

export function groupByText(labels: string[]): number[][] {
  const byKey = new Map<string, number[]>();
  labels.forEach((label, i) => {
    const key = isUnsure(label) ? "__unsure__" : norm(label);
    byKey.set(key, [...(byKey.get(key) ?? []), i + 1]);
  });
  return [...byKey.values()];
}
