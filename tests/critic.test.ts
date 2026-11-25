// The critic: code checks on what the Moderator is about to show, and when a stronger model's correction is used.
import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { checkProblems, checkRisks, comparisonProblems, comparisonRisks, criticSettings, DEFAULT_CRITIC_MODEL, reviewCheck, reviewComparison } from "../agents/critic";
import type { DetectDecisionInput } from "../agents/moderator";
import type { DecisionDetection } from "../agents/protocol";
import { enableFixtureModels } from "./mocks";

enableFixtureModels();
afterEach(() => { delete process.env.CRITIC_LLM_MODEL; delete process.env.CRITIC_MODE; });

const chat = (goal = "Prepare the final presentation"): DetectDecisionInput => ({
  goal, trigger: "new_message",
  group: [
    { author: "Minsu", text: "We still need slides and a demo video." },
    { author: "Taeho", text: "I can do the slides if Minsu does the video." },
    { author: "Minsu", text: "I thought Soyeon wanted the slides?" },
    { author: "Minsu", text: "OK, let's split the slides and the video like that." },
  ],
});
const draft = (over: Partial<DecisionDetection> = {}): DecisionDetection => ({
  is_decision: true, invitation_quote: "", revision_quote: "", decision: "Taeho will do the slides and Minsu the video.", ambiguity: "",
  question: "Is this how you understood the decision?", options: ["Yes, as stated", "I understood it differently", "Not sure yet"], reason: "", challenged: 0, ...over,
});

test("critic code checks: what a drafted check must not do", () => {
  const input = chat();
  assert.deepEqual(checkProblems(input, draft()), []);
  assert.ok(checkProblems(input, draft({ question: "Which places?", options: ["Not specified in the chat", "Not sure yet"] })).length >= 2);
  assert.ok(checkProblems(input, draft({ question: "Was using Wi-Fi part of the decision?", options: ["Yes", "No", "Not sure yet"] })).some((p) => /part of the decision/.test(p)));
  assert.ok(checkProblems(input, draft({ decision: "Taeho does the slides by 5:00." })).some((p) => /number/.test(p)));
  // The generic question after a real discussion, and a decision that resolves "like that", are risks.
  assert.equal(checkRisks(input, draft()).length, 2);
});

test("critic: off unless a model is set; in risk mode a clean draft is not reviewed", async () => {
  const input = chat();
  const d = draft({ question: "Who does the slides?", options: ["Taeho", "Soyeon", "Not sure yet"] });
  assert.deepEqual(await reviewCheck(input, draft()), draft());
  process.env.CRITIC_LLM_MODEL = "critic-model";
  const plain = { ...input, group: [{ author: "Minsu", text: "Let's meet Tuesday at 5:00 PM at the main gate." }] };
  assert.deepEqual(await reviewCheck(plain, d), d);
});

test("critic: a correction is used only if it passes the code checks", async () => {
  process.env.CRITIC_LLM_MODEL = "critic-model";
  const revised = await reviewCheck(chat(), draft());
  assert.equal(revised.question, "Who does the slides?");
  assert.deepEqual(revised.options, ["Taeho does the slides", "Soyeon does the slides", "Not sure yet"]);
  // A correction with one reading fails the checks: the draft stands.
  assert.deepEqual(await reviewCheck(chat("BAD goal"), draft()), draft());
  // The critic can call off a false alarm.
  assert.equal((await reviewCheck(chat("NOT goal"), draft())).is_decision, false);
});

test("critic: the follow-up after a split", async () => {
  const input = { decision: "We build the app.", question: "Is this how you understood the decision?", labels: ["Yes, as stated", "I understood it differently", "Yes, as stated"], concerns: [] };
  const res = { groups: [[1, 3], [2]], aligned: false, final_statement: "", anonymous_question: "Quick check: did we build it as stated, or differently?", reason: "" };
  assert.ok(comparisonProblems(input, res).some((p) => /as stated/.test(p)));
  assert.ok(comparisonProblems(input, { ...res, anonymous_question: "Two of you read it as stated. Which part is different?" }).some((p) => /who or how many/.test(p)));
  const live = { decision: "Show wait times.", question: "What do you picture?", labels: ["Live wait times", "Live wait times right now", "Real-time wait estimate"], concerns: [] };
  assert.ok(comparisonRisks(live, { ...res, groups: [[1], [2], [3]] }).some((r) => /same reading/.test(r)));
  // The critic merges three wordings of one reading: aligned follows from the groups, counted in code.
  process.env.CRITIC_LLM_MODEL = "critic-model";
  const merged = await reviewComparison(live, { ...res, groups: [[1], [2], [3]], anonymous_question: "Quick check before we move on: live or typical?" });
  assert.equal(merged.aligned, true);
  assert.equal(merged.anonymous_question, "");
});

test("critic: on by default with a live model, off with fixture models, and CRITIC_MODE=off turns it off", () => {
  assert.deepEqual(criticSettings(false), { model: DEFAULT_CRITIC_MODEL, mode: "risk" });
  assert.deepEqual(criticSettings(true), { model: null, mode: "off" });
  process.env.CRITIC_LLM_MODEL = "openai/gpt-6.2-astra";
  assert.deepEqual(criticSettings(true), { model: "openai/gpt-6.2-astra", mode: "risk" });
  process.env.CRITIC_MODE = "always";
  assert.equal(criticSettings(false).mode, "always");
  process.env.CRITIC_MODE = "off";
  assert.equal(criticSettings(false).mode, "off");
});
