import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as personal from "../agents/personal";
import type { ChatLine, PrivateTurn } from "../agents/protocol";

const group: ChatLine[] = [
  { id: "msg_1", kind: "user", author: "Jia", text: "How can we collect real visitor counts?" },
];
const privateHistory: PrivateTurn[] = [
  { id: "p_2", role: "user", text: "I can count people at the entrance by hand." },
  { id: "p_3", role: "agent", text: "Another option would be a laser sensor." },
];
const base = { user: "Min", goal: "Plan a museum visitor study", group, privateHistory };
const reactInput = { ...base, newMessage: group[0] };
const grounded = {
  kind: "grounded", nudge: "Your entrance count would answer that question.",
  draft: "Could we count visitors at the entrance by hand?",
  evidence: [{ id: "p_2", quote: "count people at the entrance by hand" }],
};
const returns = (value: unknown): personal.Generate => async () => value;

test("the same incoming group message grounds a card only for its actual author", async () => {
  const mine = await personal.react(reactInput, undefined, returns(grounded));
  assert.equal(mine.suggest, true);
  assert.deepEqual(mine.evidenceIds, ["p_2"]);
  assert.equal(mine.nudge, grounded.nudge);
  assert.equal(mine.draft, grounded.draft);
  const other = await personal.react({
    ...reactInput, user: "Bo", privateHistory: [{ id: "p_4", role: "user", text: "Please use a legible font." }],
  }, undefined, returns(grounded));
  assert.equal(other.suggest, false);
});

test("peer, assistant, fabricated IDs, invented quotes and leaked IDs cannot ground a draft", async () => {
  for (const evidence of [
    [{ id: "msg_1", quote: "real visitor counts" }],
    [{ id: "p_3", quote: "laser sensor" }],
    [{ id: "p_999", quote: "count people" }],
    [{ id: "p_2", quote: "buy electronic counters" }], [],
  ]) {
    assert.equal((await personal.react(reactInput, undefined, returns({ ...grounded, evidence }))).suggest, false);
  }
  assert.equal((await personal.react(reactInput, undefined, returns({ ...grounded, draft: "As p_2-suggested, count entrants." }))).suggest, false);
});

test("repeated public text, a rewording of an already posted private quote, and an earlier suggestion stay quiet", async () => {
  const posted = { id: "msg_5", author: "Jia", text: grounded.draft.toUpperCase() };
  assert.equal((await personal.react({ ...reactInput, group: [...group, posted] }, undefined, returns(grounded))).suggest, false);
  const repeatedQuote = { id: "msg_6", author: "Teo", text: grounded.evidence[0].quote + "!" };
  assert.equal((await personal.react({ ...reactInput, group: [...group, repeatedQuote] }, undefined, returns(grounded))).suggest, false);
  assert.equal((await personal.react({
    ...reactInput, recentSuggestions: [{ nudge: "Earlier", draft: grounded.draft, status: "dismissed" }],
  }, undefined, returns(grounded))).suggest, false);
});

test("Moderator recall requires evidence; brainstorming can start from an empty private history", async () => {
  const input = { ...base, privateHistory: [], angle: "How do we include frequent visitors?" };
  const noModelCall: personal.Generate = async () => { throw new Error("No owner evidence to recall"); };
  assert.equal((await personal.angleReply(input, undefined, noModelCall)).has_view, false);
  const novel = { kind: "brainstorm", nudge: "A new possibility is a repeat visitor diary.", draft: "Could visitors keep diaries?", evidence: [] };
  assert.equal((await personal.angleReply({ ...input, privateHistory }, undefined, returns(novel))).has_view, false);
  const idea = await personal.angleReply({ ...input, intent: "invite_brainstorm" }, undefined, returns(novel));
  assert.deepEqual(idea.evidenceIds, []);
  assert.equal(idea.has_view, true);
  assert.equal(idea.label, input.angle);
});

test("an open card is optional context to chat; historical turns are not truncated", async () => {
  const longGroup = Array.from({ length: 80 }, (_, i) => ({ id: "msg_" + i, author: "Bo", text: "Turn " + i }));
  const card = { id: "card_7", kind: "share_suggestion", source: "react", nudge: grounded.nudge, draft: grounded.draft, status: "open" } as const;
  const seen: Record<string, unknown>[] = [];
  const generate: personal.Generate = async (_, ctx) => {
    seen.push(ctx as Record<string, unknown>);
    return { reply: "Here is an answer.", share_draft: null, concern: null };
  };
  const chat = { ...base, group: longGroup, stage: "ideation" as const };
  await personal.chat({ ...chat, reference: card, message: "Can you shorten this draft?" }, undefined, generate);
  await personal.chat({ ...chat, message: "Explain a different topic." }, undefined, generate);
  assert.deepEqual(seen[0].reference, { kind: card.kind, nudge: card.nudge, draft: card.draft });
  assert.ok(!JSON.stringify(seen[0].reference).includes(card.id));
  await assert.rejects(personal.chat({ ...chat, reference: card, message: "Edit it." }, undefined, returns({
    reply: "Suggested wording", share_draft: "We can use card_7 for the plan.", concern: null,
  })));
  assert.deepEqual(seen[1].reference, null);
  assert.equal(seen[1].message, "Explain a different topic.");
  assert.equal((seen[1].group as ChatLine[])[0].text, "Turn 0");
  const angle = { id: "msg_90", kind: "moderator", author: "Moderator", at: 123, text: "How could we measure access?", note: { type: "angle_prompt", angle: "Measurement" } } as const;
  await personal.chat({ ...chat, reference: angle, intent: "invite_brainstorm", message: "Explore that." }, undefined, generate);
  assert.equal(seen[2].intent, "invite_brainstorm");
  assert.equal((seen[2].reference as { text: string }).text, angle.text);
  assert.equal((seen[2].reference as { angle: string }).angle, angle.note.angle);
});

test("a private agreement check sends the proposal version and accepts only evidenced tentative choices", async () => {
  const input = { ...base, proposal: { id: "check_1", version: 2, decision: "Count everyone" },
    decision: "Count everyone", question: "Which method?", options: ["Hand count", "Sensors"] };
  const result = { suggested_option: "Hand count", why: "Does a manual count match the plan?", evidence: grounded.evidence };
  const check = await personal.suggestCheckAnswer(input, undefined, async (_, ctx) => {
    assert.deepEqual((ctx as {proposal: unknown}).proposal, input.proposal);
    return result;
  });
  assert.equal(check.suggested_option, "Hand count");
  assert.deepEqual(check.evidenceIds, ["p_2"]);
  // An unsupported guess is dropped (the member still gets the question), not turned into an error.
  for (const unsupported of [{ ...result, evidence: [] }, { ...result, suggested_option: "unlisted" }]) {
    const dropped = await personal.suggestCheckAnswer(input, undefined, returns(unsupported));
    assert.equal(dropped.suggested_option, null);
    assert.deepEqual(dropped.evidenceIds, []);
  }
  const neutral = await personal.suggestCheckAnswer(input, undefined, returns({
    suggested_option: null, why: "Which parts would you like to clarify?", evidence: [],
  }));
  assert.equal(neutral.suggested_option, null);
  assert.deepEqual(neutral.evidenceIds, []);
});

test("missing or malformed live output never becomes a scripted private answer", async () => {
  const input = { ...base, stage: "ideation" as const, message: "Can we compare methods?" };
  await assert.rejects(personal.chat(input, undefined, returns({ reply: "" })));
  await assert.rejects(personal.chat(input, undefined, async () => { throw new Error("Provider unavailable"); }), /Provider unavailable/);
});
