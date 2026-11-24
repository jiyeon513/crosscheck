// The critic: a stronger model reviews what the Moderator is about to show the team, and only then.
//
//   Moderator draft (a check to open, or the follow-up after a split)
//     ─► code checks (free): one reading only, "not specified", duplicates, wrong language, counts or names in a follow-up...
//     ─► risk signals: the generic question with a real discussion behind it, a decision that resolves "like that"...
//     ─► problems or risk (or CRITIC_MODE=always) ─► the critic model reviews it ─► "ok", or a corrected draft
//     ─► a correction is used only if it passes the same code checks; otherwise the draft stands
//
// Off unless CRITIC_LLM_MODEL is set. CRITIC_MODE: "risk" (default when a model is set), "always" or "off".
// The critic reads the same public chat as the Moderator and nothing else.

import { callJSON, type LLMRecord } from "./llm";
import { formatChat, formatList, isUnsure, norm, str, strList } from "./format";
import * as moderator from "./moderator";
import type { CompareInput, DetectDecisionInput } from "./moderator";
import type { Comparison, DecisionDetection } from "./protocol";

type Log = (record: LLMRecord) => void;

export function criticSettings(): { model: string | null; mode: "off" | "risk" | "always" } {
  const model = process.env.CRITIC_LLM_MODEL?.trim() || null;
  const mode = process.env.CRITIC_MODE;
  return { model, mode: !model ? "off" : mode === "always" || mode === "off" ? mode : "risk" };
}

const GENERIC = /as stated|understood it differently/i;
const hangul = (text: string) => /[가-힣]/.test(text);

// ---------- a check about to open ----------

/** Problems code can see in a drafted check. */
export function checkProblems(input: DetectDecisionInput, d: DecisionDetection): string[] {
  if (!d.is_decision) return [];
  const problems: string[] = [];
  const real = d.options.filter((o) => !isUnsure(o));
  const generic = d.options.some((o) => GENERIC.test(o));
  if (!generic && real.length < 2) problems.push("fewer than two readings to choose from");
  if (real.some((o) => /not (specified|stated|mentioned|said)|unspecified|unclear|undecided/i.test(o))) problems.push("an option is not a reading");
  if (new Set(real.map(norm)).size < real.length) problems.push("two options say the same thing");
  if (/part of the decision|commit(ted)? to|was it decided/i.test(d.question)) problems.push("asks whether something is part of the decision instead of what it means");
  const chat = input.group.map((m) => m.text).join(" ");
  if (hangul(chat) !== hangul(`${d.question} ${real.join(" ")}`) && !generic) problems.push("question or options not in the chat's language");
  const numbers = d.decision.match(/\d+(?::\d+)?/g) ?? [];
  if (numbers.some((n) => !chat.includes(n))) problems.push("the decision has a number nobody said");
  return problems;
}

/** Signals that a draft may be wrong even though code sees no problem. */
export function checkRisks(input: DetectDecisionInput, d: DecisionDetection): string[] {
  if (!d.is_decision) return [];
  const risks: string[] = [];
  const newest = input.group[input.group.length - 1]?.text ?? "";
  const userMessages = input.group.filter((m) => m.kind !== "moderator").length;
  if (d.options.some((o) => GENERIC.test(o)) && userMessages >= 3) risks.push("the generic question after a real discussion");
  if (/\blike that\b|\bthat one\b|\bas (we )?said\b|\bthe same\b|그렇게|그걸로|그대로/i.test(newest)) risks.push("the newest message refers back to earlier suggestions");
  return risks;
}

type CheckReview = { verdict: "ok" | "revise" | "not_decision"; problems: string[]; decision: string; ambiguity: string; question: string; options: string[] };

/** Review a drafted check before it opens. Returns the draft, or a correction that passes the code checks. */
export async function reviewCheck(input: DetectDecisionInput, d: DecisionDetection, log?: Log): Promise<DecisionDetection> {
  const { model, mode } = criticSettings();
  if (!model || mode === "off" || !d.is_decision) return d;
  const problems = checkProblems(input, d);
  const risks = checkRisks(input, d);
  if (mode === "risk" && !problems.length && !risks.length) return d;
  const newest = input.group[input.group.length - 1];
  const data = await callJSON<CheckReview>("moderator/critic_check", {
    goal: input.goal,
    earlierChat: formatChat(input.group.slice(0, -1)),
    newestMessage: newest ? `[${newest.author}] ${newest.text}` : "(none)",
    openProposal: input.openProposal?.trim() || "(none)",
    decision: d.decision, ambiguity: d.ambiguity || "(none)", question: d.question, options: formatList(d.options),
    found: formatList([...problems, ...risks]),
  }, input, log, model).catch((error: unknown) => {
    console.warn("[CrossCheck] critic unavailable, the draft stands:", error instanceof Error ? error.message : error);
    return null;
  });
  if (!data) return d;
  if (data.verdict === "not_decision" && input.trigger !== "host_request") {
    return { ...d, is_decision: false, decision: "", ambiguity: "", question: "", options: [], revision_quote: "" };
  }
  if (data.verdict !== "revise") return d;
  const options = strList(data.options).slice(0, 4);
  if (!options.some(isUnsure)) options.push(hangul(options.join(" ")) ? "아직 잘 모르겠어요" : "Not sure yet");
  const revised: DecisionDetection = {
    ...d,
    // A member's own proposal and a revision of the open check keep their exact wording; only the question and options are reviewed.
    decision: (input.trigger === "host_request" || d.revision_quote) && d.decision ? d.decision : str(data.decision) || d.decision,
    ambiguity: str(data.ambiguity), question: str(data.question) || d.question, options,
  };
  return checkProblems(input, revised).length ? d : revised;
}

/** Detection, then the critic before a check opens. */
export async function detectDecisionReviewed(input: DetectDecisionInput, log?: Log): Promise<DecisionDetection> {
  return reviewCheck(input, await moderator.detectDecision(input, log), log);
}

// ---------- the follow-up after a split ----------

export function comparisonProblems(input: CompareInput, res: Comparison): string[] {
  if (res.aligned) return [];
  const problems: string[] = [];
  const q = res.anonymous_question;
  if (/\b(two|three|four|\d+) of\b|\bmajority\b|\bmost of\b|\bhalf\b|\bone of you\b|\bsomeone\b/i.test(q)) problems.push("the follow-up hints at who or how many");
  if (input.labels.some((l) => GENERIC.test(l)) && GENERIC.test(q)) problems.push("the follow-up offers 'as stated' again instead of asking what is different");
  if (hangul(input.labels.join(" ")) !== hangul(q)) problems.push("the follow-up is not in the answers' language");
  if (input.concerns.length && !/concern|우려|걱정/i.test(q)) problems.push("a concern was raised but the follow-up leaves it out");
  return problems;
}

export function comparisonRisks(input: CompareInput, res: Comparison): string[] {
  const risks: string[] = [];
  const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 2));
  const first = res.groups.map((g) => input.labels[g[0] - 1] ?? "");
  // Two groups whose answers share most words may be one reading split in two; one group of different words, two merged.
  for (let i = 0; i < first.length; i++) for (let j = i + 1; j < first.length; j++) {
    const a = words(first[i]), b = words(first[j]);
    const shared = [...a].filter((w) => b.has(w)).length;
    if (!isUnsure(first[i]) && !isUnsure(first[j]) && shared / Math.max(1, Math.min(a.size, b.size)) >= 0.6) risks.push("two groups may be the same reading");
  }
  if (res.groups.length === 1 && new Set(input.labels.map(norm)).size > 1) risks.push("different wordings were put in one group");
  return risks;
}

type CompareReview = { verdict: "ok" | "revise"; problems: string[]; groups: number[][]; anonymous_question: string };

export async function reviewComparison(input: CompareInput, res: Comparison, log?: Log): Promise<Comparison> {
  const { model, mode } = criticSettings();
  if (!model || mode === "off") return res;
  const problems = comparisonProblems(input, res);
  const risks = comparisonRisks(input, res);
  if (mode === "risk" && !problems.length && !risks.length) return res;
  const data = await callJSON<CompareReview>("moderator/critic_compare", {
    decision: input.decision, question: input.question, answers: formatList(input.labels), concerns: formatList(input.concerns),
    groups: JSON.stringify(res.groups), aligned: res.aligned ? "yes" : "no", followUp: res.anonymous_question || "(none)",
    found: formatList([...problems, ...risks]),
  }, input, log, model).catch((error: unknown) => {
    console.warn("[CrossCheck] critic unavailable, the comparison stands:", error instanceof Error ? error.message : error);
    return null;
  });
  if (!data || data.verdict !== "revise") return res;
  const groups = partition(data.groups, input.labels.length) ? data.groups : res.groups;
  // Counting stays in code: aligned follows from the groups.
  const aligned = groups.length === 1 && !input.labels.every(isUnsure);
  const revised: Comparison = {
    ...res, groups, aligned,
    final_statement: aligned ? res.final_statement || input.decision : "",
    anonymous_question: aligned ? "" : str(data.anonymous_question) || res.anonymous_question,
  };
  if (!revised.aligned && !revised.anonymous_question) return res;
  return comparisonProblems(input, revised).length ? res : revised;
}

export async function compareUnderstandingReviewed(input: CompareInput, log?: Log): Promise<Comparison> {
  return reviewComparison(input, await moderator.compareUnderstanding(input, log), log);
}

function partition(groups: unknown, n: number): groups is number[][] {
  if (!Array.isArray(groups) || !groups.length) return false;
  const seen = new Set<number>();
  for (const g of groups) {
    if (!Array.isArray(g) || !g.length) return false;
    for (const i of g) {
      if (!Number.isInteger(i) || i < 1 || i > n || seen.has(i)) return false;
      seen.add(i);
    }
  }
  return seen.size === n;
}
