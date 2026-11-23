// Flow changes made in this repository's copy of the engine (agents/meeting.ts, agents/personal.ts).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { useFixtureGenerator } from "../agents/llm";
import { Meeting } from "../agents/meeting";
import * as personal from "../agents/personal";
import type { Card } from "../agents/protocol";
import { enableFixtureModels } from "./mocks";

enableFixtureModels();

const cards = (m: Meeting, user: string): Card[] =>
  m.view(user).private.flatMap((item) => (item.type === "card" ? [item.card] : []));
const openCheckCard = (m: Meeting, user: string) =>
  cards(m, user).find((c) => c.kind === "understanding_check" && c.status === "open");

function room(rules: ConstructorParameters<typeof Meeting>[0]["rules"] = {}) {
  const m = new Meeting({ goal: "Pick a project topic", host: "Minsu", rules });
  m.join("Jiwoo");
  m.join("Taeho");
  return m;
}

test("a new decision replaces an open check that nobody has answered yet", async () => {
  const m = room();
  await m.postGroupMessage("Minsu", "Let's go with a study app.");
  const first = m.check!;
  assert.equal(first.status, "collecting");
  await m.postGroupMessage("Jiwoo", "Actually, let's go with crowding prediction for the library.");
  assert.equal(first.status, "cancelled");
  assert.equal(m.check!.version, 2);
  assert.match(m.group.at(-1)!.text, /^Replacing the earlier check\. Agreement check \(version 2\)/);
});

test("an open check that most members answered is not replaced", async () => {
  const m = room();
  await m.postGroupMessage("Minsu", "Let's go with a study app.");
  const check = m.check!;
  await m.answerCheck("Minsu", check.id, "Yes, as stated", true);
  await m.answerCheck("Jiwoo", check.id, "Yes, as stated", true);
  await m.postGroupMessage("Taeho", "Let's go with crowding prediction instead.");
  assert.equal(m.check, check);
});

test("a mismatch closes the check, explains the next step, and the next decision opens a new version", async () => {
  const m = room();
  await m.postGroupMessage("Minsu", "Let's go with crowding prediction for the campus.");
  const check = m.check!;
  await m.answerCheck("Minsu", check.id, "The whole campus", true);
  await m.answerCheck("Jiwoo", check.id, "Library and cafeteria only", true);
  await m.answerCheck("Taeho", check.id, "Library and cafeteria only", true);
  assert.equal(check.status, "mismatch");
  const note = m.group.at(-1)!;
  assert.match(note.text, /^Agreement 2\/3\./);
  assert.match(note.text, /say it in the chat and I will check it again/);
  assert.equal(cards(m, "Jiwoo").find((c) => c.kind === "understanding_check")!.status, "closed");

  await m.postGroupMessage("Taeho", "OK, let's go with the library and cafeteria only.");
  assert.equal(m.check!.version, 2);
  for (const user of ["Minsu", "Jiwoo", "Taeho"]) {
    assert.ok(openCheckCard(m, user));
    await m.answerCheck(user, m.check!.id, "Library and cafeteria only", true);
  }
  assert.equal(m.check!.status, "aligned");
  assert.equal(m.decisions.length, 1);
  assert.equal(m.stage, "ideation");
});

test("re-confirming an agreed decision does not open another check", async () => {
  const m = room();
  await m.proposeDecision("Jiwoo", "Send the consent forms by Friday");
  for (const user of ["Minsu", "Jiwoo", "Taeho"]) await m.answerCheck(user, m.check!.id, "Yes, as stated", true);
  assert.equal(m.decisions.length, 1);
  const agreed = m.check;
  await assert.rejects(m.proposeDecision("Taeho", "Send the consent forms by Friday"), /already agreed/);
  assert.equal(m.check, agreed);
});

test("a member's proposal opens a check on exactly that text; the host can cancel a check", async () => {
  const m = room();
  await m.proposeDecision("Taeho", "Meet every Monday at 7 pm");
  assert.equal(m.check!.decision, "Meet every Monday at 7 pm");
  assert.match(m.group.at(-2)!.text, /^Proposal for the team: "Meet every Monday at 7 pm"/);
  assert.throws(() => m.cancelCheck("Taeho", m.check!.id), /Only the host/);
  m.cancelCheck("Minsu", m.check!.id);
  assert.equal(m.check!.status, "cancelled");
  assert.equal(openCheckCard(m, "Jiwoo"), undefined);
});

test("a revised proposal gets a real question with several readings", async () => {
  const m = room();
  await m.postGroupMessage("Minsu", "Let's go with crowding prediction.");
  await m.reviseCheck("Minsu", m.check!.id, "Predict crowding in the library and cafeteria only.");
  assert.equal(m.check!.version, 2);
  assert.ok(m.check!.options.length >= 2);
});

test("agents read quoted replies, and suggestion cards pause while a check collects answers", async () => {
  const seen: string[] = [];
  useFixtureGenerator(async (prompt, context) => {
    if (prompt === "moderator/detect_decision") {
      const c = context as { group: { text: string }[] };
      seen.push(c.group.at(-1)!.text);
      return { is_decision: /let's go/i.test(c.group.at(-1)!.text), decision: "Go", ambiguity: "", question: "Q?", options: ["A", "B"], reason: "" };
    }
    if (prompt === "personal/react") {
      seen.push("react");
      return { kind: "none", nudge: "", draft: "", evidence: [] };
    }
    if (prompt === "personal/chat") return { reply: "ok", share_draft: null, concern: null };
    return { suggested_option: null, why: "Why?", evidence: [] };
  });
  try {
    const m = room();
    await m.sendPrivateMessage("Jiwoo", "I like libraries.");
    await m.postGroupMessage("Taeho", "Sure", { quote: { author: "Minsu", text: "Library first?" } });
    assert.ok(seen.some((text) => text.includes('(replying to Minsu: "Library first?") Sure')));
    assert.ok(seen.includes("react"));
    await m.postGroupMessage("Minsu", "Let's go with the library.");
    assert.equal(m.check?.status, "collecting");
    seen.length = 0;
    await m.postGroupMessage("Taeho", "Great, the library sounds fun.");
    assert.equal(seen.filter((x) => x === "react").length, 0);
  } finally {
    enableFixtureModels();
  }
});

test("a reply with both a concern and a draft keeps the concern instead of failing", async () => {
  const result = await personal.chat(
    { user: "Min", goal: "g", group: [], privateHistory: [], stage: "agreement", message: "This worries me." },
    undefined,
    async () => ({ reply: "Let's raise it.", share_draft: "Could we narrow it?", concern: { label: "scope", draft: "Too big?" } }),
  );
  assert.deepEqual(result.concern, { label: "scope", draft: "Too big?" });
  assert.equal(result.share_draft, null);
});

test("any member, not only the host, can ask about an angle or ask for an agreement check", async () => {
  const m = room();
  await m.sendPrivateMessage("Taeho", "Wi-Fi access counts are public data.");
  await m.requestAngle("Jiwoo", "using real campus data", "find_contribution");
  assert.ok(cards(m, "Taeho").some((c) => c.kind === "share_suggestion" && c.source === "missing_angle"));
  await m.postGroupMessage("Taeho", "How about a study app?");
  await m.startCheck("Jiwoo");
  assert.equal(m.check?.status, "collecting");
});

test("the personal agent is told to answer in the language the member wrote in", async () => {
  const seen: unknown[] = [];
  const capture: personal.Generate = async (_prompt, context) => {
    seen.push((context as { reply_language: string }).reply_language);
    return { reply: "ok", share_draft: null, concern: null };
  };
  const base = { user: "Min", goal: "g", group: [], privateHistory: [], stage: "ideation" as const };
  await personal.chat({ ...base, message: "What should I bring?" }, undefined, capture);
  await personal.chat({ ...base, message: "뭘 준비하면 좋을까?" }, undefined, capture);
  assert.deepEqual(seen, ["English", "Korean"]);
});
