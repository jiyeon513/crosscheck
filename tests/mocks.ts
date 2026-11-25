// Deterministic model fixtures, registered exclusively by test entry points.
// They are keyword rules tuned to the demo scenario in tests/scenarios/project_topic.json.
// Use them to build the UI and to check the flow for free. They say nothing about prompt quality.

import { isUnsure, norm } from "../agents/format";
import type { CompareInput, DetectDecisionInput, MissingAngleInput } from "../agents/moderator";
import type { AngleReplyInput, ChatInput, CheckSuggestInput, ReactInput } from "../agents/personal";
import type { AngleReply, ChatResult, CheckSuggestion, Comparison, DecisionDetection, MissingAngle, PrivateTurn, ReactResult } from "../agents/protocol";
import { useFixtureGenerator } from "../agents/llm";
import { tableFixture } from "./table-mocks";
import { criticFixture } from "./critic-mocks";

const userTexts = (turns: PrivateTurn[]) => turns.filter((t) => t.role === "user").map((t) => t.text);

// These fixtures exercise the same response validation as live calls.
// delays: milliseconds per prompt, to test what happens while a model call is still running.
export function enableFixtureModels(delays: Record<string, number> = {}) {
  useFixtureGenerator(async (prompt, context) => {
    if (delays[prompt]) await new Promise((resolve) => setTimeout(resolve, delays[prompt]));
    return fixtureResponse(prompt, context);
  });
}

/** The fixture answer for one prompt. Tests can wrap it to override a single prompt. */
export function fixtureResponse(prompt: string, context: object): unknown {
  if (prompt.startsWith("personal/table_") || prompt === "moderator/propose_bridge") return tableFixture(prompt, context);
  if (prompt.startsWith("moderator/critic_")) return criticFixture(prompt, context);
  switch (prompt) {
    case "moderator/find_missing_angle": return findMissingAngle(context as MissingAngleInput);
    case "moderator/detect_decision": return detectDecision(context as DetectDecisionInput);
    case "moderator/compare_understanding": return compareUnderstanding(context as CompareInput);
    case "personal/chat": return chat(context as ChatInput);
    case "personal/angle_reply":
    case "personal/react": {
      const input = context as AngleReplyInput & ReactInput;
      const value = prompt === "personal/react" ? react(input) : angleReply(input);
      const offered = "has_view" in value ? value.has_view : value.suggest;
      const note = input.privateHistory.filter(turn => turn.role === "user").at(-1);
      return offered && note
        ? { kind: "grounded", draft: value.draft, nudge: value.nudge, evidence: [{ id: note.id, quote: note.text }] }
        : { kind: "none", draft: "", nudge: "", evidence: [] };
    }
    case "personal/suggest_check_answer": {
      const input = context as CheckSuggestInput;
      const out = suggestCheckAnswer(input);
      const note = input.privateHistory.filter(turn => turn.role === "user").at(-1);
      return { ...out, why: out.why || input.question, evidence: out.suggested_option && note ? [{ id: note.id, quote: note.text }] : [] };
    }
    case "personal/topic_labels": {
      const mine = userTexts((context as { privateHistory: PrivateTurn[] }).privateHistory).join(" ");
      const labels = [/wi-?fi|data/i.test(mine) && "campus data sources", /crowd/i.test(mine) && "campus crowding"];
      return { labels: labels.filter(Boolean) };
    }
    default: throw new Error("Unregistered test prompt: " + prompt);
  }
}

// ---------- moderator ----------

export function findMissingAngle(input: MissingAngleInput): MissingAngle {
  const ideas = input.group.filter((m) => m.kind !== "moderator");
  const all = ideas.map((m) => m.text).join(" ");
  const angle = "using real campus data";
  if (ideas.length < 2 || /data|wi-?fi|sensor|crowd/i.test(all) || input.anglesAsked.includes(angle)) {
    return { action: "none", angle: "", group_prompt: "", reason: "mock: ideas already cover the data angle, or too few ideas" };
  }
  return {
    action: "ask_angle",
    angle,
    group_prompt: "One angle we have not touched yet: using real campus data. Any thoughts on that?",
    reason: "mock: no idea mentions data",
  };
}

const DECISION_RE =
  /\b(let'?s (go with|just do|do|pick|choose)|we('ll| will) go with|so we('re| are) (doing|going with)|we decided|it'?s decided)\b|로 가자|로 하자|로 정하자|으로 결정/i;

const CHANGE_RE = /\b(could we|can we|maybe we should)\b.*\b(instead|move|push|change)\b|미뤄도|바꿀 수/i;

export function detectDecision(input: DetectDecisionInput): DecisionDetection {
  const users = input.group.filter((m) => m.kind !== "moderator");
  const newest = users[users.length - 1];
  const none: DecisionDetection = { is_decision: false, decision: "", ambiguity: "", question: "", options: [], reason: "mock: no decision phrase" };
  if (!newest) return none;
  // Someone wants to change the proposal being checked, without settling a new version.
  if (input.openProposal && input.trigger !== "host_request" && !DECISION_RE.test(newest.text) && CHANGE_RE.test(newest.text)) {
    return { ...none, open_challenged: true, reason: "mock: wants to change the open proposal" };
  }
  if (input.trigger !== "host_request" && !DECISION_RE.test(newest.text)) {
    return { ...none, invitation_quote: newest.text.match(/what (else|other) (could|can|campus).*$/i)?.[0] ?? "" };
  }
  const aboutScope = /crowd|campus|library|cafeteria/i.test(users.map((m) => m.text).join(" "));
  return {
    is_decision: true,
    decision: `Proposed in the chat: "${newest.text}"`,
    ambiguity: aboutScope ? "scope" : "what exactly was decided",
    question: aboutScope ? "What scope do you have in mind for this?" : "Is this how you understood the decision?",
    options: aboutScope
      ? ["Library and cafeteria only", "The whole campus", "Not sure yet"]
      : ["Yes, as stated", "I understood it differently", "Not sure yet"],
    replaces_open: Boolean(input.openProposal) && aboutSameQuestion(input.openProposal!, newest.text),
    reason: "mock: decision phrase found",
  };
}

// "instead", or a content word shared with the open proposal, means the same question.
const COMMON = new Set(["let's", "lets", "going", "proposed", "chat", "with", "then", "this", "that", "there"]);
function aboutSameQuestion(open: string, text: string): boolean {
  if (/\binstead\b|말고/i.test(text)) return true;
  const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w.length >= 5 && !COMMON.has(w)));
  const a = words(open);
  return [...words(text)].some((w) => a.has(w));
}

export function compareUnderstanding(input: CompareInput): Comparison {
  const byKey = new Map<string, number[]>();
  input.labels.forEach((label, i) => {
    const key = isUnsure(label) ? "__unsure__" : norm(label);
    byKey.set(key, [...(byKey.get(key) ?? []), i + 1]);
  });
  const groups = [...byKey.values()];
  const readings = groups.map((g) => input.labels[g[0] - 1]);
  const aligned = groups.length === 1 && !isUnsure(readings[0]);
  const concern = input.concerns[0] ? ` One concern was raised: ${input.concerns[0]}.` : "";
  return {
    groups,
    aligned,
    final_statement: aligned ? `${input.decision} Everyone means: ${readings[0]}.` : "",
    anonymous_question: aligned ? "" : `Quick check before we move on. ${input.question} ${readings.join(", or ")}?${concern}`,
    reason: "mock: grouped by exact text",
  };
}

// ---------- personal ----------

export function chat(input: ChatInput): ChatResult {
  const m = input.message;
  const mine = [...userTexts(input.privateHistory), m].join(" ");
  const base: ChatResult = { reply: "", share_draft: null, concern: null };

  if (/what.*(talking|going on|happening|discuss)|summar|catch me up/i.test(m)) {
    const recent = input.group.filter((g) => g.kind !== "moderator").slice(-3);
    const lines = recent.map((g) => `${g.author} said "${g.text}"`).join("; ");
    return { ...base, reply: recent.length ? `So far: ${lines}.` : "Nothing has been posted in the group chat yet." };
  }
  if (/too big|too much|too hard|too broad|not realistic/i.test(m)) {
    const scope = /scope|whole campus/i.test(mine);
    return {
      ...base,
      reply: "That sounds like a clear concern. Do you want to raise it with the team? You can post it yourself or send it without your name.",
      concern: {
        label: scope ? "the scope may be too big for one semester" : "the plan may be too much for the time we have",
        draft: scope
          ? "I am a little worried the whole campus is too big for one semester. Could we narrow the scope?"
          : "I am a little worried this is too much for the time we have. Could we narrow it down?",
      },
    };
  }
  if (/bother|worr|concern|not sure about this|don'?t agree|disagree|uneasy/i.test(m)) {
    return { ...base, reply: "Let's pin it down. Is it the scope, the data, or the timeline that worries you?" };
  }
  if (/keep (it|that|this) in mind|remember|note (it|that|this)/i.test(m)) {
    return { ...base, reply: "Noted. It stays between us, and I will only draft it for the group if you ask." };
  }
  if (/draft|post (it|this)|share (it|this)|how (should|do) i say/i.test(m)) {
    const last = userTexts(input.privateHistory).slice(-1)[0] ?? m;
    return { ...base, reply: "Here is a draft you can post.", share_draft: last };
  }
  if (/idea|think|help|topic|brainstorm/i.test(m)) {
    return {
      ...base,
      reply: `For "${input.goal}", a few directions: (1) crowding in the cafeteria and library, (2) lost and found, (3) booking study rooms. Which one feels closest to you?`,
    };
  }
  return { ...base, reply: "Got it. Tell me more, or ask me what the team is discussing." };
}

export function angleReply(input: AngleReplyInput): AngleReply {
  const mine = userTexts(input.privateHistory).join(" ");
  const none: AngleReply = { has_view: false, label: "", nudge: "", draft: "" };
  if (!/data/i.test(input.angle)) return none;
  const nudge = `Nobody has brought up "${input.angle}" in the group yet, and you mentioned something that fits. Want to share it?`;
  if (/wi-?fi/i.test(mine)) {
    return { has_view: true, label: "public Wi-Fi data", nudge, draft: "We could use the public Wi-Fi access counts from the campus portal." };
  }
  if (/crowd/i.test(mine)) {
    return {
      has_view: true,
      label: "campus crowding",
      nudge,
      draft: "What about predicting how crowded the cafeteria and library are, so people can avoid peak times?",
    };
  }
  return none;
}

const STOP = new Set(["about", "should", "could", "would", "there", "their", "because", "really", "something", "anything", "project", "people"]);
const longWords = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length >= 6 && !STOP.has(w)));

export function react(input: ReactInput): ReactResult {
  const mineTexts = userTexts(input.privateHistory);
  const mine = mineTexts.join(" ");
  const msg = input.newMessage.text;
  if (/crowd/i.test(msg) && /wi-?fi/i.test(mine)) {
    return {
      suggest: true,
      nudge: `${input.newMessage.author}'s idea connects to the Wi-Fi data you found. Want to add it?`,
      draft: "Wi-Fi access counts could measure how crowded a place is. I heard they are public on the campus portal.",
    };
  }
  const msgWords = longWords(msg);
  const hit = mineTexts.find((t) => [...longWords(t)].filter((w) => msgWords.has(w)).length >= 2);
  if (hit) {
    return {
      suggest: true,
      nudge: `${input.newMessage.author}'s message connects to something you told me. Want to add it?`,
      draft: `That connects to something I was thinking about: ${hit}`,
    };
  }
  return { suggest: false, nudge: "", draft: "" };
}

export function suggestCheckAnswer(input: CheckSuggestInput): CheckSuggestion {
  const mine = userTexts(input.privateHistory).join(" ");
  const pick = (re: RegExp) => input.options.find((o) => re.test(o) && !isUnsure(o)) ?? null;
  if (/too big|too much|narrow/i.test(mine)) {
    const o = pick(/only|library|narrow/i);
    if (o) return { suggested_option: o, why: "You told me the wider scope felt too big." };
  }
  if (/every building|whole campus|all buildings/i.test(mine)) {
    const o = pick(/whole|all|every/i);
    if (o) return { suggested_option: o, why: "You mentioned data that covers every building." };
  }
  if (/library|cafeteria/i.test(mine)) {
    const o = pick(/library|cafeteria/i);
    if (o) return { suggested_option: o, why: "You talked about the cafeteria and the library." };
  }
  return { suggested_option: null, why: "" };
}
