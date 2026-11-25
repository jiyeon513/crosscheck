// Task 2: personal agents report topic labels, and the Moderator uses them to choose the angle.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findPrivacyLeaks, Meeting } from "../agents/meeting";
import { topicLabels } from "../agents/topics";
import { enableFixtureModels } from "./mocks";

enableFixtureModels();

const base = { user: "Taeho", goal: "Pick a project topic", group: [] };
const note = "Yesterday the line was out the door at noon";
const returns = (labels: unknown) => async () => ({ labels });

test("no private notes means no model call and no labels", async () => {
  const labels = await topicLabels({ ...base, privateHistory: [] }, undefined, async () => {
    throw new Error("the model must not be called");
  });
  assert.deepEqual(labels, []);
});

test("only short topic labels pass: no sentences, no copied private text, at most three", async () => {
  const privateHistory = [{ id: "p1", role: "user" as const, text: note }];
  const out = await topicLabels({ ...base, privateHistory }, undefined, returns([
    "queue length", "queue length", "", 7,
    "the line was out the door at noon yesterday", // a sentence
    `About: ${note}`, // carries the private text
    "busy hours", "walking distance", "friends' plans",
  ]));
  assert.deepEqual(out, ["queue length", "busy hours", "walking distance"]);
});

test("after silence the agents report labels, and the Moderator receives labels without names or private text", async () => {
  let clock = 0;
  const m = new Meeting({ goal: "Pick a project topic", host: "Minsu", now: () => clock, tracePrompts: true });
  m.join("Jiwoo");
  m.join("Taeho");
  const secret = "I heard the Wi-Fi access counts for every building are public on the campus portal.";
  await m.sendPrivateMessage("Taeho", secret);
  await m.postGroupMessage("Minsu", "How about a study group matching app?");
  await m.postGroupMessage("Jiwoo", "A chatbot for club recruiting could work too.");
  clock += 65_000;
  await m.tick();

  const reports = m.trace.filter((e) => e.type === "agent_to_mod" && e.data.type === "topic_labels");
  // The labels are logged merged, never per agent.
  assert.deepEqual(reports.map((e) => [e.from, e.data.labels]), [["agents", ["campus data sources"]]]);

  const call = m.trace.find((e) => e.type === "llm_call" && e.data.prompt === "moderator/find_missing_angle");
  const input = String(call?.data.input);
  assert.match(input, /campus data sources/);
  assert.doesNotMatch(input, /Wi-Fi access counts|Taeho/);
  assert.deepEqual(findPrivacyLeaks(m), []);
});

test("when labels were used and nobody gets a card, the Moderator does not post the angle in public", async () => {
  let clock = 0;
  const m = new Meeting({ goal: "Pick a project topic", host: "Minsu", now: () => clock, tracePrompts: true });
  m.join("Jiwoo");
  m.join("Taeho");
  await m.sendPrivateMessage("Taeho", "Maybe the city publishes open data we could use.");
  await m.postGroupMessage("Minsu", "How about a study group matching app?");
  await m.postGroupMessage("Jiwoo", "A chatbot for club recruiting could work too.");
  clock += 65_000;
  await m.tick();

  assert.ok(m.trace.some((e) => e.type === "agent_to_mod" && e.data.type === "topic_labels"));
  assert.ok(m.trace.some((e) => e.type === "mod_to_agents" && e.data.type === "angle_query"));
  assert.deepEqual(m.group.filter((g) => g.kind === "moderator"), []);
});
