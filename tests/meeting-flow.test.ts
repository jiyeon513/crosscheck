// Flow changes made in this repository's copy of the engine (agents/meeting.ts, agents/personal.ts).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { useFixtureGenerator } from "../agents/llm";
import { Meeting } from "../agents/meeting";
import * as personal from "../agents/personal";
import { TEAM_QUESTION_NOTICE, type Card } from "../agents/protocol";
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

test("a team invitation relays its original message privately, once per relevant idea", async () => {
  const m = room();
  const idea = "Wi-Fi access counts are public data.";
  await m.sendPrivateMessage("Taeho", idea);
  await m.sendPrivateMessage("Jiwoo", "I like drawing logos.");
  const question = "What other campus data could we use?";
  // Another teammate can keep typing while the Moderator classifies the question.
  await Promise.all([
    m.postGroupMessage("Minsu", question),
    m.postGroupMessage("Jiwoo", "Give me a second to think."),
  ]);
  const relay = m.trace.filter(e => e.type === "mod_to_agents" && e.data.type === "angle_query");
  assert.deepEqual(relay.map(e => e.data), [{ type: "angle_query", angle: question, intent: "find_contribution" }]);
  assert.equal(m.trace.some(e => e.type === "agent_to_mod" && e.data.type === "angle_reply"), false);
  const suggestions = cards(m, "Taeho").filter(c => c.kind === "share_suggestion" && c.source === "group_question");
  assert.equal(suggestions.length, 1);
  const card = suggestions[0];
  assert.ok(card.kind === "share_suggestion");
  assert.deepEqual(card.relayedQuestion, { author: "Minsu", text: question });
  const evidence = m.view("Taeho").private.find(item => item.type === "user" && item.text === idea);
  assert.deepEqual(card.evidenceIds, [evidence!.id]);
  assert.deepEqual(m.group.filter(line => line.kind === "user").map(line => line.text), [question, "Give me a second to think."]);
  const receipts = m.group.filter(line => line.kind === "moderator").map(({ id, at, ...line }) => line);
  assert.deepEqual(receipts, [{ author: "Moderator", kind: "moderator", note: { type: "angle_requested" },
    text: TEAM_QUESTION_NOTICE, quote: { author: "Minsu", text: question } }]);
  for (const user of ["Minsu", "Jiwoo"]) {
    assert.equal(cards(m, user).some(c => c.kind === "share_suggestion" && c.source === "group_question"), false);
    assert.ok(!JSON.stringify(m.view(user)).includes(idea));
  }
  await m.postGroupMessage("Minsu", question);
  assert.equal(cards(m, "Taeho").filter(c => c.kind === "share_suggestion" && c.source === "group_question").length, 1);
});

test("a lead-in to a pitch and a question appearing only in a quoted reply cannot trigger a relay", async () => {
  const m = room();
  let citation = "We need an idea.";
  useFixtureGenerator(() => ({ is_decision: false, invitation_quote: citation }));
  try {
    await m.postGroupMessage("Minsu", "We need an idea. What about a night at the gallery?");
    citation = "Where else should we look?";
    await m.postGroupMessage("Minsu", "I will think about it.", {
      quote: { author: "Jiwoo", text: citation },
    });
    assert.equal(m.trace.some(e => e.data.type === "angle_query"), false);
  } finally {
    enableFixtureModels();
  }
});

test("the team sees a delivery receipt even when nobody has relevant private notes; open checks take precedence", async () => {
  const m = room();
  const question = "What other campus data could we use?";
  await m.postGroupMessage("Jiwoo", question);
  assert.equal(m.group.length, 2);
  const { id, at, ...receipt } = m.group[1];
  assert.deepEqual(receipt, { author: "Moderator", kind: "moderator", note: { type: "angle_requested" },
    text: TEAM_QUESTION_NOTICE, quote: { author: "Jiwoo", text: question } });
  assert.ok(m.participants.every(user => cards(m, user).length === 0));
  assert.equal(m.trace.filter(e => e.data.type === "angle_query").length, 1);
  assert.equal(m.trace.filter(e => e.data.prompt === "personal/react").length, 0);
  await m.proposeDecision("Minsu", "Start with the campus library.");
  await m.postGroupMessage("Jiwoo", question);
  assert.equal(m.trace.filter(e => e.data.type === "angle_query").length, 1);
});

test("Ask immediately posts the same public receipt whether or not a private card is offered", async () => {
  const question = "How could we use real campus data?";
  for (const hasIdea of [false, true]) {
    const m = room();
    if (hasIdea) await m.sendPrivateMessage("Taeho", "Wi-Fi access counts are public data.");
    const asking = m.requestAngle("Jiwoo", question, "find_contribution");
    assert.equal(m.group.length, 1);
    await asking;

    for (const user of m.participants) {
      const publicLines = m.view(user).group.map(({ id, at, ...message }) => message);
      assert.deepEqual(publicLines, [{
        author: "Moderator", kind: "moderator", text: `I asked everyone’s Personal Agent about “${question}”`,
        note: { type: "angle_requested" },
      }]);
      const offered = cards(m, user).some(c => c.kind === "share_suggestion" && c.source === "missing_angle");
      assert.equal(offered, hasIdea && user === "Taeho");
    }
  }
});

test("an Ask receipt does not interrupt detection of a team decision", async () => {
  const m = room();
  const deciding = m.postGroupMessage("Minsu", "Let's go with a study app.");
  await m.requestAngle("Jiwoo", "Who can test it?", "find_contribution");
  await deciding;
  assert.equal(m.check?.status, "collecting");
  assert.match(m.check!.decision, /study app/);
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

/** Scripted Moderator for the revisit tests: decisions, challenges and comparisons by keyword. */
function revisitModels(seenUnderDiscussion: (string | null)[]) {
  useFixtureGenerator(async (prompt, context) => {
    const c = context as {
      group?: { text: string }[]; underDiscussion?: string | null; agreed?: string[]; labels?: string[];
    };
    switch (prompt) {
      case "moderator/detect_decision": {
        const newest = c.group?.at(-1)?.text ?? "";
        seenUnderDiscussion.push(c.underDiscussion ?? null);
        const decide = (decision: string) => ({
          is_decision: true, decision, ambiguity: "scope", question: "Which places?",
          options: ["Library only", "Library and cafeteria"], challenged: 0, reason: "",
        });
        if (/let's go with crowding/i.test(newest)) return decide("Predict crowding in the library and cafeteria");
        if (/just the library/i.test(newest)) return decide("Predict crowding in the library only");
        if (/not sure the cafeteria/i.test(newest)) {
          return { is_decision: false, decision: "", ambiguity: "", question: "", options: [], challenged: 1, reason: "" };
        }
        return { is_decision: false, decision: "", ambiguity: "", question: "", options: [], challenged: 0, reason: "" };
      }
      case "moderator/compare_understanding": {
        const labels = c.labels ?? [];
        const same = labels.every((label) => label === labels[0]);
        return {
          groups: same ? [labels.map((_, i) => i + 1)] : labels.map((_, i) => [i + 1]),
          aligned: same, final_statement: "", anonymous_question: same ? "" : "Which places do we mean?", reason: "",
        };
      }
      case "personal/chat":
        return { reply: "ok", share_draft: null, concern: null };
      case "personal/suggest_check_answer":
        return { suggested_option: null, why: "Which reading is yours?", evidence: [] };
      default:
        return { kind: "none", nudge: "", draft: "", evidence: [] };
    }
  });
}

async function answerAll(m: Meeting, label: string) {
  for (const user of ["Minsu", "Jiwoo", "Taeho"]) await m.answerCheck(user, m.check!.id, label, true);
}

test("after a split check, follow-up messages are read as about that decision and open its next version", async () => {
  const seen: (string | null)[] = [];
  revisitModels(seen);
  try {
    const m = room();
    await m.postGroupMessage("Minsu", "Let's go with crowding prediction.");
    await m.answerCheck("Minsu", m.check!.id, "Library and cafeteria", true);
    await m.answerCheck("Jiwoo", m.check!.id, "Library only", true);
    await m.answerCheck("Taeho", m.check!.id, "Library only", true);
    assert.equal(m.check!.status, "mismatch");
    assert.deepEqual(m.view("Jiwoo").discussing, { decision: "Predict crowding in the library and cafeteria", status: "open" });
    seen.length = 0;
    await m.postGroupMessage("Taeho", "OK, just the library then.");
    assert.equal(seen[0], "Predict crowding in the library and cafeteria"); // the Moderator knew what was being discussed
    assert.equal(m.check!.version, 2);
    assert.equal(m.check!.decision, "Predict crowding in the library only");
    assert.equal(m.view("Jiwoo").discussing, null);
  } finally {
    enableFixtureModels();
  }
});

test("when someone questions an agreed decision, the Moderator asks the team first; a new agreed version replaces it", async () => {
  revisitModels([]);
  try {
    const m = room();
    await m.postGroupMessage("Minsu", "Let's go with crowding prediction.");
    await answerAll(m, "Library and cafeteria");
    const agreed = m.decisions[0];
    assert.ok(agreed);

    await m.postGroupMessage("Taeho", "Actually, I'm not sure the cafeteria data is available.");
    const ask = m.group.at(-1)!;
    assert.equal(ask.note?.type, "reopen_prompt");
    assert.ok(!ask.text.includes("Taeho")); // nobody is named
    assert.equal(m.check!.status, "aligned"); // nothing reopened yet
    assert.deepEqual(m.view("Minsu").discussing, { decision: agreed.statement, status: "asking", recordId: agreed.id });

    m.answerRevisit("Jiwoo", agreed.id, true);
    assert.equal(m.view("Minsu").discussing?.status, "open");
    assert.throws(() => m.answerRevisit("Minsu", agreed.id, false), /already answered/);

    await m.postGroupMessage("Minsu", "Fine, just the library then.");
    assert.equal(m.check!.replaces, agreed.id);
    assert.match(m.group.at(-1)!.text, /New version of an agreed decision/);
    await answerAll(m, "Library only");
    const replacement = m.decisions[1];
    assert.equal(replacement.replaces, agreed.id);
    assert.equal(agreed.replacedBy, replacement.id);
    assert.match(m.group.at(-1)!.text, /This replaces the earlier decision\.$/);
  } finally {
    enableFixtureModels();
  }
});

test("if the team keeps an agreed decision, the Moderator does not ask again right away", async () => {
  revisitModels([]);
  try {
    const m = room();
    await m.postGroupMessage("Minsu", "Let's go with crowding prediction.");
    await answerAll(m, "Library and cafeteria");
    await m.postGroupMessage("Taeho", "Hmm, not sure the cafeteria works.");
    m.answerRevisit("Minsu", m.decisions[0].id, false);
    assert.match(m.group.at(-1)!.text, /stays as agreed/);
    assert.equal(m.view("Minsu").discussing, null);
    const before = m.group.length;
    await m.postGroupMessage("Taeho", "Still not sure the cafeteria works, though.");
    assert.equal(m.group.length, before + 1); // only Taeho's message, no new question
    assert.equal(m.decisions[0].replacedBy, undefined);
  } finally {
    enableFixtureModels();
  }
});
