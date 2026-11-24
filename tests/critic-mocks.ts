// Deterministic critic fixtures (tests/mocks.ts hands the critic prompts here). A goal with "BAD" makes the critic
// return a correction that fails the code checks; "NOT" makes it say the message is not a decision.

import type { DetectDecisionInput } from "../agents/moderator";

export function criticFixture(prompt: string, context: object): unknown {
  if (prompt === "moderator/critic_check") {
    const input = context as DetectDecisionInput;
    if (input.goal.includes("NOT")) return { verdict: "not_decision", problems: ["mock"], decision: "", ambiguity: "", question: "", options: [] };
    const options = input.goal.includes("BAD") ? ["Only one reading"] : ["Taeho does the slides", "Soyeon does the slides"];
    return { verdict: "revise", problems: ["mock: resolved 'like that'"], decision: "Split the slides and the video as discussed.", ambiguity: "owner", question: "Who does the slides?", options };
  }
  return { verdict: "revise", problems: ["mock"], groups: [[1, 2, 3]], anonymous_question: "" };
}
