// The agents' table: after a split check, each agent gives its reason to the Moderator alone, then the agents work on one
// wording together (accept, change, support, object) without names. Only wordings and acts cross between agents.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findPrivacyLeaks, Meeting } from "../agents/meeting";
import { approvalReason } from "../agents/membrane";
import { enableFixtureModels } from "./mocks";

enableFixtureModels();

const NAMES = ["Minsu", "Soyeon", "Taeho"];
const TOO_BIG = "Honestly this whole campus plan is too big for one semester.";
const CARES = "I mostly care about the cafeteria and the library.";
const TAEHO_NOTE = "Wi-Fi access counts for every building are public.";

/** A split: two read it as library and cafeteria only, one as the whole campus. The table is then started. */
async function splitMeeting(soyeonNote: string, options: { now?: () => number; goal?: string } = {}) {
  const m = new Meeting({ goal: options.goal ?? "Campus app proposal", host: "Minsu", tracePrompts: true, ...(options.now ? { now: options.now } : {}) });
  m.join("Soyeon");
  m.join("Taeho");
  await m.sendPrivateMessage("Soyeon", soyeonNote);
  await m.sendPrivateMessage("Taeho", TAEHO_NOTE);
  await m.postGroupMessage("Minsu", "Let's go with crowding prediction.");
  const check = m.check!;
  const narrow = check.options.find((o) => /library/i.test(o))!;
  const wide = check.options.find((o) => /whole/i.test(o))!;
  await m.answerCheck("Minsu", check.id, narrow, true);
  await m.answerCheck("Soyeon", check.id, narrow, true);
  await m.answerCheck("Taeho", check.id, wide, false);
  assert.equal(check.status, "mismatch");
  // Offered, not started: the split flow is unchanged until a member asks for the table.
  const thread = m.table.threads[0];
  assert.equal(thread.status, "offered");
  assert.equal(thread.messages.length, 0);
  await m.table.start("Taeho", thread.id);
  return { m, check, thread };
}

const draft = (m: Meeting, user: string) => m.view(user).table[0].drafts.at(-1)!;
/** Everything a member sees of the table except their own agent's thread and drafts. */
const publicPart = (m: Meeting, user: string) => {
  const { mine: _mine, drafts: _drafts, ...rest } = m.view(user).table[0];
  return JSON.stringify(rest);
};
async function approveAll(m: Meeting) {
  for (let i = 0; i < 6 && m.table.threads[0].status === "talking"; i++) {
    const waiting = NAMES.flatMap((u) => m.view(u).table[0].drafts.filter((d) => d.status === "waiting").map((d) => [u, d] as const));
    if (!waiting.length) break;
    for (const [u, d] of waiting) await m.table.answer(u, d.id, true, d.text);
  }
}

test("table: reasons go to the Moderator alone; an objected change leads to a second wording everyone accepts", async () => {
  const { m, check, thread } = await splitMeeting(TOO_BIG);
  // Step 1 is private. Minsu used nothing private, so his agent answered at once; the others wait for their member.
  assert.equal(draft(m, "Minsu").auto, true);
  for (const user of ["Soyeon", "Taeho"]) {
    assert.equal(draft(m, user).status, "waiting");
    assert.equal(draft(m, user).step, "position");
  }
  await approveAll(m);

  assert.equal(thread.status, "bridged");
  assert.equal(thread.bridgedBy, "moderator");
  const rounds = m.view("Minsu").table[0].rounds;
  assert.equal(rounds.length, 2);
  // Round 1: two accepted, Taeho's agent proposed a change, one other agent supported it and one objected.
  assert.deepEqual([rounds[0].accepted, rounds[0].changed, rounds[0].rejected], [2, 1, 0]);
  assert.deepEqual([rounds[0].changes[0].support, rounds[0].changes[0].object], [1, 1]);
  assert.deepEqual([rounds[1].accepted, rounds[1].changed], [3, 0]);
  // The bridge is the next version of the check, and members confirm it themselves.
  assert.equal(m.check!.decision, thread.bridge);
  assert.equal(m.check!.version, check.version + 1);
  for (const user of NAMES) await m.answerCheck(user, m.check!.id, "Yes, this works for me", true);
  assert.equal(m.check!.status, "aligned");
  assert.deepEqual(findPrivacyLeaks(m), []);
});

test("table: the agents settle on one agent's change by themselves when every other agent supports it", async () => {
  const { m, thread } = await splitMeeting(CARES);
  await approveAll(m);
  assert.equal(thread.status, "bridged");
  assert.equal(thread.bridgedBy, "agents");
  const round = m.view("Soyeon").table[0].rounds[0];
  assert.deepEqual([round.changes.length, round.changes[0].support, round.changes[0].object], [1, 2, 0]);
  assert.equal(m.check!.decision, round.changes[0].wording);
  assert.match(m.group.at(-2)!.text, /the agents settled on a change one of them proposed/);
  assert.deepEqual(findPrivacyLeaks(m), []);
});

test("table: nobody can tell who said what, and reasons never reach another agent", async () => {
  const { m, thread } = await splitMeeting(TOO_BIG);
  await approveAll(m);
  const positions = thread.messages.filter((x) => x.step === "position" && x.from !== "Moderator");
  assert.equal(positions.length, 3);
  for (const user of NAMES) {
    const seen = publicPart(m, user);
    // No code names, no member names, no reasons in what members see of the table.
    assert.ok(!/Agent [A-Z]/.test(seen), `${user} sees a code name`);
    for (const name of NAMES) assert.ok(!seen.includes(name), `${user} sees ${name}`);
    for (const p of positions) assert.ok(!seen.includes(p.text), `${user} sees a reason`);
    // Their own thread holds only their own agent, called "Your agent".
    const mine = m.view(user).table[0].mine;
    assert.ok(mine.length > 0);
    assert.ok(mine.every((x) => ["Your agent", "Moderator", "all", "another agent"].includes(x.from) && !/Agent [A-Z]/.test(JSON.stringify(x))));
    assert.ok(mine.some((x) => x.from === "Your agent" && x.step === "position"));
  }
  // No agent's model input holds another member's reason; only the Moderator reads them.
  for (const p of positions) {
    const author = Object.entries(thread.aliases).find(([, a]) => a === p.from)![0];
    for (const call of m.trace.filter((e) => e.type === "llm_call" && String(e.from).startsWith("agent:") && e.from !== `agent:${author}`)) {
      assert.ok(!String(call.data.input).includes(p.text), `${call.from} received ${author}'s reason`);
    }
  }
  // The Moderator reads code names, never member names.
  for (const call of m.trace.filter((e) => e.type === "llm_call" && e.data.prompt === "moderator/propose_bridge")) {
    for (const name of NAMES) assert.ok(!String(call.data.input).includes(name), name);
  }
  // A step is shown only once it is over: no counts while agents are still answering.
  assert.ok(m.view("Minsu").table[0].rounds.every((r) => r.answered));
  assert.deepEqual(findPrivacyLeaks(m), []);
});

test("table: a Moderator wording that repeats a private reason is refused, and the table ends without one", async () => {
  const { m, thread } = await splitMeeting(TOO_BIG, { goal: "LEAKY campus app proposal" });
  await approveAll(m);
  assert.equal(thread.status, "no_bridge");
  assert.equal(thread.wordings.length, 0);
  const bridges = m.trace.filter((e) => e.type === "llm_call" && e.data.prompt === "moderator/propose_bridge");
  assert.equal(bridges.length, 2); // asked once more, then dropped
  assert.ok(!m.group.some((l) => l.text.includes("too big for one semester")));
  assert.match(m.group.at(-1)!.text, /could not find one wording/);
  assert.deepEqual(findPrivacyLeaks(m), []);
});

test("table: a Moderator wording may use a few words a member told it, without quoting the reason", async () => {
  const { m, thread } = await splitMeeting(TOO_BIG, { goal: "REUSE campus app proposal" });
  await approveAll(m);
  assert.ok(thread.wordings.length >= 1);
  assert.match(thread.wordings[0].text, /whole campus plan is too/);
  assert.equal(m.trace.filter((e) => e.type === "llm_call" && e.data.prompt === "moderator/propose_bridge").length, thread.wordings.length);
});

test("table: declining sends nothing, and a new version in the chat ends the table", async () => {
  const { m, thread } = await splitMeeting(TOO_BIG);
  await m.table.answer("Soyeon", draft(m, "Soyeon").id, false);
  assert.equal(draft(m, "Soyeon").status, "declined");
  assert.ok(!thread.messages.some((x) => x.text.includes(TOO_BIG)));
  await m.postGroupMessage("Minsu", "OK, let's just do the library and the cafeteria.");
  assert.equal(thread.status, "closed");
  assert.equal(draft(m, "Taeho").status, "closed");
  await assert.rejects(m.table.answer("Taeho", draft(m, "Taeho").id, true, "too late"), /not waiting/);
  assert.deepEqual(findPrivacyLeaks(m), []);
});

test("table: an agent that does not answer in time is skipped", async () => {
  let clock = 1_000_000;
  const { m, thread } = await splitMeeting(TOO_BIG, { now: () => clock });
  m.table.rules.bridgeRounds = 1;
  clock += m.table.rules.roundMs;
  await m.tick();
  // The two waiting agents were skipped; the table went on with the reason it had.
  assert.ok(thread.round >= 2);
  for (let i = 0; i < 3 && thread.status === "talking"; i++) {
    clock += m.table.rules.roundMs;
    await m.tick();
  }
  assert.notEqual(thread.status, "talking");
  assert.deepEqual(findPrivacyLeaks(m), []);
});

test("table: after a check is put on hold, the table is offered when at least two members had answered", async () => {
  const m = new Meeting({ goal: "Campus app proposal", host: "Minsu" });
  m.join("Soyeon");
  m.join("Taeho");
  await m.postGroupMessage("Minsu", "Let's go with crowding prediction.");
  const check = m.check!;
  await m.answerCheck("Minsu", check.id, check.options[0], true);
  await m.answerCheck("Soyeon", check.id, check.options[1], true);
  await m.postGroupMessage("Taeho", "Could we change it to something smaller instead?");
  assert.equal(check.status, "cancelled");
  assert.equal(m.table.threads.at(-1)!.status, "offered");
  assert.equal(m.table.threads.at(-1)!.checkId, check.id);
  // A new version from the chat ends the offer, as after a split.
  await m.postGroupMessage("Minsu", "OK, let's go with crowding prediction for the library only.");
  assert.equal(m.table.threads.at(-1)!.status, "closed");
});

test("a decision about something else waits for a nearly finished check; so does the agents' wording", async () => {
  const m = new Meeting({ goal: "Campus app proposal", host: "Minsu" });
  m.join("Soyeon");
  m.join("Taeho");
  await m.postGroupMessage("Minsu", "Let's go with crowding prediction.");
  const scope = m.check!;
  const narrow = scope.options.find((o) => /library/i.test(o))!, wide = scope.options.find((o) => /whole/i.test(o))!;
  await m.answerCheck("Minsu", scope.id, narrow, true);
  await m.answerCheck("Soyeon", scope.id, narrow, true);

  // Two of three answered; Taeho settles something unrelated. The scope check is not thrown away.
  await m.postGroupMessage("Taeho", "Let's go with Figma for the slides.");
  assert.equal(m.check, scope);
  assert.equal(scope.status, "collecting");
  assert.equal(m.group.at(-1)!.note?.type, "check_queued");

  // The scope check ends (split): the table is offered, and the waiting decision opens without closing the table.
  await m.answerCheck("Taeho", scope.id, wide, false);
  assert.equal(scope.status, "mismatch");
  const figma = m.check!;
  assert.match(figma.decision, /Figma/);
  assert.equal(figma.status, "collecting");
  const thread = m.table.threads.at(-1)!;
  assert.equal(thread.status, "offered");

  // The agents settle a wording while the Figma check is open: it waits instead of being lost.
  await m.table.start("Taeho", thread.id);
  assert.equal(thread.status, "bridged");
  assert.equal(m.check, figma);
  assert.equal(m.group.at(-1)!.note?.type, "check_queued");
  for (const u of ["Minsu", "Soyeon", "Taeho"]) await m.answerCheck(u, figma.id, figma.options[0], true);
  assert.equal(figma.status, "aligned");
  // Then the agents' wording is checked with everyone.
  assert.equal(m.check!.decision, thread.bridge);
  assert.equal(m.check!.status, "collecting");
});

test("membrane: what needs the member's approval before it leaves their agent", () => {
  const notes = [{ id: "p1", text: "I'm commuting from Daejeon Station on Tuesdays" }, { id: "p2", text: "too risky" }];
  const base = { evidenceIds: [], privateNotes: notes, publicTexts: ["Let's do the library and cafeteria."], names: ["Minsu", "Taeho"] };
  assert.equal(approvalReason({ ...base, text: "My member prefers the library and cafeteria." }), null);
  assert.match(approvalReason({ ...base, text: "Fine.", evidenceIds: ["p1"] })!, /privately/);
  assert.match(approvalReason({ ...base, text: "They are commuting from Daejeon Station, so later is better." })!, /repeats/);
  assert.match(approvalReason({ ...base, text: "My member finds it too risky." })!, /repeats/);
  assert.match(approvalReason({ ...base, text: "Taeho agrees with this." })!, /name/);
  // For the Moderator's wordings: a phrase from a never-shared note counts only if it reveals a new word.
  const shared = ["My member said only the cafeteria and library matter."];
  assert.equal(approvalReason({ ...base, privateNotes: [{ id: "s", text: "only the cafeteria and the library matter" }], publicTexts: shared, text: "Start with the cafeteria and the library.", newWordsOnly: true }), null);
  assert.match(approvalReason({ ...base, publicTexts: shared, text: "Meet after commuting from Daejeon Station.", newWordsOnly: true })!, /repeats/);
  // Words already said in the team chat are not private.
  assert.equal(approvalReason({ ...base, privateNotes: [{ id: "p3", text: "do the library and cafeteria" }], text: "Let's do the library and cafeteria first." }), null);
});
