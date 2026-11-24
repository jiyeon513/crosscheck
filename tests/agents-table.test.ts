// The agents' table: after a split check the Moderator talks it over with each agent under code names,
// proposes a bridge wording, and brings it back as a new check. Private notes reach the table only with approval.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findPrivacyLeaks, Meeting } from "../agents/meeting";
import { approvalReason } from "../agents/membrane";
import { enableFixtureModels } from "./mocks";

enableFixtureModels();

const NAMES = ["Minsu", "Soyeon", "Taeho"];
const SOYEON_NOTE = "Honestly this whole campus plan is too big for one semester.";
const TAEHO_NOTE = "Wi-Fi access counts for every building are public.";

/** A split: two read it as library and cafeteria only, one as the whole campus. */
async function splitMeeting(now?: () => number) {
  const m = new Meeting({ goal: "Campus app proposal", host: "Minsu", tracePrompts: true, ...(now ? { now } : {}) });
  m.join("Soyeon");
  m.join("Taeho");
  await m.sendPrivateMessage("Soyeon", SOYEON_NOTE);
  await m.sendPrivateMessage("Taeho", TAEHO_NOTE);
  await m.postGroupMessage("Minsu", "Let's go with crowding prediction.");
  const check = m.check!;
  const narrow = check.options.find((o) => /library/i.test(o))!;
  const wide = check.options.find((o) => /whole/i.test(o))!;
  assert.ok(narrow && wide, "the fixture offers both readings");
  await m.answerCheck("Minsu", check.id, narrow, true);
  await m.answerCheck("Soyeon", check.id, narrow, true);
  await m.answerCheck("Taeho", check.id, wide, false);
  assert.equal(check.status, "mismatch");
  // Offered, not started: the split flow is unchanged until a member asks for the table.
  const offered = m.table.threads[0];
  assert.equal(offered.status, "offered");
  assert.equal(offered.messages.length, 0);
  await m.table.start("Taeho", offered.id);
  return { m, check, narrow, wide };
}

const tableText = (m: Meeting) => m.table.threads.flatMap((t) => t.messages.map((x) => `${x.from} ${x.to} ${x.text} ${x.condition ?? ""}`)).join("\n");
const draft = (m: Meeting, user: string) => m.view(user).table[0].drafts.at(-1)!;

test("table: after a split each agent speaks under a code name; private reasons wait for the member; a bridge becomes the next version", async () => {
  const { m, check } = await splitMeeting();
  const thread = m.table.threads[0];
  assert.equal(thread.status, "talking");
  assert.ok(m.group.some((line) => line.id === thread.messageId && line.kind === "moderator"));
  // Minsu said nothing private: his agent spoke straight away, and he sees what it said for him.
  const minsu = draft(m, "Minsu");
  assert.equal(minsu.status, "sent");
  assert.equal(minsu.auto, true);
  // The others drew on private notes: nothing is sent until they approve.
  for (const user of ["Soyeon", "Taeho"]) {
    assert.equal(draft(m, user).status, "waiting");
    assert.match(draft(m, user).why!, /privately/);
  }
  assert.ok(!tableText(m).includes(SOYEON_NOTE) && !tableText(m).includes("Wi-Fi"));
  assert.equal(m.view("Minsu").table[0].waitingFor, 2);

  await m.table.answer("Soyeon", draft(m, "Soyeon").id, true, draft(m, "Soyeon").text);
  await m.table.answer("Taeho", draft(m, "Taeho").id, true, "My member reads it as the whole campus: building-wide Wi-Fi data is public.");

  // Bridge 1 keeps one reading, the third agent counters, bridge 2 covers both and everyone accepts.
  assert.equal(thread.status, "bridged");
  const acts = thread.messages.map((x) => x.act);
  assert.deepEqual(acts.filter((a) => a === "propose").length, 2);
  assert.ok(acts.includes("counter"));
  assert.match(m.group.map((l) => l.text).join("\n"), /From the agents’ table/);
  // The bridge is the next version of the same topic, and members confirm it themselves.
  assert.equal(m.check!.decision, thread.bridge);
  assert.equal(m.check!.status, "collecting");
  assert.equal(m.check!.version, 2);
  for (const user of NAMES) await m.answerCheck(user, m.check!.id, "Yes, this works for me", true);
  assert.equal(m.check!.status, "aligned");

  // Code names only: no member name on the table, and the Moderator's prompt never sees one.
  for (const name of NAMES) assert.ok(!tableText(m).includes(name), name);
  const bridges = m.trace.filter((e) => e.type === "llm_call" && e.data.prompt === "moderator/propose_bridge");
  assert.equal(bridges.length, 2);
  for (const call of bridges) for (const name of NAMES) assert.ok(!String(call.data.input).includes(name), name);
  // Each member sees which code name is theirs, and only their own drafts.
  const views = NAMES.map((u) => m.view(u).table[0]);
  assert.equal(new Set(views.map((v) => v.yours)).size, 3);
  assert.ok(views.every((v) => v.drafts.every((d) => d.alias === v.yours)));
  // Approved text is shared on purpose; nothing else crossed.
  assert.deepEqual(findPrivacyLeaks(m), []);
});

test("table: declining sends nothing private, and a new version in the chat ends the table", async () => {
  const { m } = await splitMeeting();
  const thread = m.table.threads[0];
  const soyeon = draft(m, "Soyeon");
  await m.table.answer("Soyeon", soyeon.id, false);
  assert.equal(draft(m, "Soyeon").status, "declined");
  assert.match(tableText(m), /nothing to add/);
  assert.ok(!tableText(m).includes(SOYEON_NOTE));

  // The team settles it in the chat before Taeho answers: a new check, the table closes.
  await m.postGroupMessage("Minsu", "OK, let's just do the library and the cafeteria.");
  assert.equal(thread.status, "closed");
  assert.equal(draft(m, "Taeho").status, "closed");
  await assert.rejects(m.table.answer("Taeho", draft(m, "Taeho").id, true, "too late"), /not waiting/);
  assert.ok(!tableText(m).includes("Wi-Fi"));
  assert.deepEqual(findPrivacyLeaks(m), []);
});

test("table: an agent that does not answer in time is skipped; no bridge after the last round ends it plainly", async () => {
  let clock = 1_000_000;
  const { m } = await splitMeeting(() => clock);
  m.table.rules.bridgeRounds = 1;
  const thread = m.table.threads[0];
  clock += m.table.rules.roundMs;
  await m.tick();
  // Both waiting agents were skipped; the bridge round ran with the agents that can answer.
  assert.match(tableText(m), /No answer from Agent [A-C] this round/);
  assert.ok(thread.round >= 2);
  // Minsu's and Soyeon's reading is the only one on the table, so the only bridge keeps it; Taeho's agent counters.
  if (thread.status === "talking") {
    clock += m.table.rules.roundMs;
    await m.tick();
  }
  assert.notEqual(thread.status, "talking");
  assert.deepEqual(findPrivacyLeaks(m), []);
});

test("membrane: what needs the member's approval before it reaches the table", () => {
  const notes = [{ id: "p1", text: "I'm commuting from Daejeon Station on Tuesdays" }, { id: "p2", text: "too risky" }];
  const base = { evidenceIds: [], privateNotes: notes, publicTexts: ["Let's do the library and cafeteria."], names: ["Minsu", "Taeho"] };
  assert.equal(approvalReason({ ...base, text: "My member prefers the library and cafeteria." }), null);
  assert.match(approvalReason({ ...base, text: "Fine.", evidenceIds: ["p1"] })!, /privately/);
  assert.match(approvalReason({ ...base, text: "They are commuting from Daejeon Station, so later is better." })!, /repeats/);
  assert.match(approvalReason({ ...base, text: "My member finds it too risky." })!, /repeats/);
  assert.match(approvalReason({ ...base, text: "Taeho agrees with this." })!, /name/);
  // Words already said in the team chat are not private.
  assert.equal(approvalReason({ ...base, privateNotes: [{ id: "p3", text: "do the library and cafeteria" }], text: "Let's do the library and cafeteria first." }), null);
});
