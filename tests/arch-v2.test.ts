// The four architecture additions: the back room (private questions, telling the Moderator only), one meeting
// state (the board and its phase), agent memory across meetings, and the quiet-member nudge.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findPrivacyLeaks, Meeting } from "../agents/meeting";
import type { Card, PollCard } from "../agents/protocol";
import { enableFixtureModels } from "./mocks";

enableFixtureModels();

const cards = (m: Meeting, user: string): Card[] =>
  m.view(user).private.flatMap((item) => (item.type === "card" ? [item.card] : []));
const openPollCard = (m: Meeting, user: string) =>
  cards(m, user).find((c): c is PollCard => c.kind === "poll" && c.status === "open")!;
const groupText = (m: Meeting) => m.group.map((line) => line.text).join("\n");

test("back room: agents pre-fill a private question, only the combined result is posted, then everyone confirms", async () => {
  const m = new Meeting({ goal: "Campus app proposal", host: "Minsu", tracePrompts: true });
  m.join("Soyeon");
  m.join("Taeho");
  await m.sendPrivateMessage("Taeho", "I'll be coming from Daejeon Station, so 5:30 by the main gate would be easiest.");

  await m.requestPoll("Minsu", "What time on Tuesday afternoon works for you?");
  assert.equal(m.view("Taeho").phase, "confirm");
  assert.equal(m.group.at(-1)!.note?.type, "poll_opened");
  assert.equal(openPollCard(m, "Taeho").draft, "Prefer 5:30."); // from his own private note, without the station
  assert.equal(openPollCard(m, "Minsu").draft, ""); // nothing to go on: the member writes it

  const first = m.polls[0];
  await m.answerPoll("Minsu", first.id, "5:00 is fine, I'm free all afternoon");
  await m.answerPoll("Soyeon", first.id, "I can do 5:00 to 5:30");
  await m.answerPoll("Taeho", first.id, openPollCard(m, "Taeho").draft);
  // Nothing fits everyone: one follow-up, asked privately again.
  assert.equal(first.status, "done");
  assert.equal(first.fitsAll, false);
  const second = m.polls[1];
  assert.equal(second.round, 2);
  assert.equal(second.question, "Could you make 5:00?");

  await m.answerPoll("Minsu", second.id, "Yes, 5:00 works");
  await m.answerPoll("Soyeon", second.id, "5:00 works");
  await m.answerPoll("Taeho", second.id, "I can make 5:00 if I leave a bit earlier");
  assert.equal(second.fitsAll, true);
  // The result is confirmed like any decision: privately, one count for the team.
  assert.equal(m.check!.decision, "5:00 works for everyone.");
  for (const user of ["Minsu", "Soyeon", "Taeho"]) await m.answerCheck(user, m.check!.id, "Yes, this works for me", true);
  assert.equal(m.check!.status, "aligned");
  assert.match(m.group.at(-1)!.text, /^Agreed 3\/3\./);
  assert.equal(m.view("Minsu").phase, "explore");

  // Only results reached the team: no answer, no reason, no place.
  const chat = groupText(m);
  for (const secret of ["Daejeon", "Prefer 5:30", "free all afternoon", "leave a bit earlier", "5:00 to 5:30"]) assert.ok(!chat.includes(secret), secret);
  // The Moderator combined answers without names.
  const combines = m.trace.filter((e) => e.type === "llm_call" && e.data.prompt === "moderator/combine_poll");
  assert.equal(combines.length, 2);
  for (const call of combines) for (const name of ["Minsu", "Soyeon", "Taeho"]) assert.ok(!String(call.data.input).includes(name), name);
  assert.deepEqual(findPrivacyLeaks(m), []);
  assert.deepEqual(m.view("Soyeon").board.polls.map((p) => [p.round, p.status, p.fitsAll]), [[1, "done", false], [2, "done", true]]);
});

test("back room: a concern told to the Moderator only shows its label, never the text or the name, and joins the next check", async () => {
  const m = new Meeting({ goal: "Pick a project topic", host: "Minsu" });
  m.join("Jiwoo");
  await m.sendPrivateMessage("Jiwoo", "Covering the whole campus feels too big for one semester.");
  const concern = cards(m, "Jiwoo").find((c) => c.kind === "concern");
  assert.ok(concern && concern.kind === "concern");
  await m.tellModerator("Jiwoo", concern.id, concern.draft);
  assert.equal(concern.status, "told_moderator");
  const said = m.group.at(-1)!;
  assert.equal(said.note?.type, "private_concern");
  assert.ok(said.text.includes(concern.label));
  assert.ok(!said.text.includes("Jiwoo") && !groupText(m).includes(concern.draft));
  await m.postGroupMessage("Minsu", "Let's go with crowding prediction for the whole campus.");
  assert.deepEqual(m.check!.concerns, [concern.draft]);
});

test("memory: only the member's own agent reads their notes; the agent can suggest one, the member saves it", async () => {
  const m = new Meeting({ goal: "Campus app proposal", host: "Minsu", tracePrompts: true });
  m.join("Taeho");
  m.setMemory("Taeho", [{ id: "n1", text: "On Tuesdays I come from Daejeon Station after a lab.", at: 1 }]);
  await m.sendPrivateMessage("Taeho", "What should I keep an eye on today?");
  const own = m.trace.find((e) => e.type === "llm_call" && e.from === "agent:Taeho");
  assert.ok(String(own?.data.input).includes("Daejeon Station"));
  await m.postGroupMessage("Taeho", "Hi all, ready when you are.");
  await m.postGroupMessage("Minsu", "Let's brainstorm app ideas for campus life.");
  assert.deepEqual(findPrivacyLeaks(m), []); // nobody else's agent, nor the Moderator, got the note
  assert.deepEqual(m.view("Minsu").memory, []);

  await m.sendPrivateMessage("Taeho", "I usually come from Daejeon Station on Tuesdays, keep that in mind.");
  const card = cards(m, "Taeho").find((c) => c.kind === "memory");
  assert.ok(card && card.kind === "memory" && card.status === "open");
  assert.equal(m.saveMemoryCard("Taeho", card.id), "I usually come from Daejeon Station on Tuesdays,");
  assert.equal(card.status, "saved");
});

test("facilitation: a member who stays quiet gets one private nudge from their own agent, grounded in their own note", async () => {
  const m = new Meeting({ goal: "Pick a project topic", host: "Minsu", rules: { quietAfterMessages: 3, suggestionCooldownMs: 0 } });
  m.join("Jiwoo");
  m.join("Taeho");
  await m.sendPrivateMessage("Taeho", "Public counts could estimate library occupancy.");
  await m.postGroupMessage("Minsu", "What about something for the library?");
  await m.postGroupMessage("Jiwoo", "Occupancy would be an interesting thing to show.");
  assert.equal(cards(m, "Taeho").filter((c) => c.kind === "share_suggestion").length, 0); // not quiet for long enough yet
  await m.postGroupMessage("Minsu", "Any other thoughts?");
  const nudges = cards(m, "Taeho").filter((c) => c.kind === "share_suggestion" && c.source === "quiet");
  assert.equal(nudges.length, 1);
  assert.ok(!groupText(m).includes("Taeho")); // nothing public about who is quiet
  await m.postGroupMessage("Jiwoo", "Maybe also the gym?");
  assert.equal(cards(m, "Taeho").filter((c) => c.kind === "share_suggestion" && c.source === "quiet").length, 1);
});

test("one meeting state: the board follows a topic through its versions and the phase follows the board", async () => {
  const m = new Meeting({ goal: "Pick a project topic", host: "Minsu" });
  m.join("Jiwoo");
  m.join("Taeho");
  assert.equal(m.view("Minsu").phase, "explore");
  await m.postGroupMessage("Minsu", "Let's go with crowding prediction.");
  let board = m.view("Jiwoo").board;
  assert.equal(board.phase, "confirm");
  assert.equal(board.topics.length, 1);
  assert.equal(board.topics[0].status, "checking");
  assert.equal(board.topics[0].ambiguity, "scope");
  assert.deepEqual([board.topics[0].answered, board.topics[0].askedOf], [0, 3]);

  const v1 = m.check!;
  await m.answerCheck("Minsu", v1.id, "Library and cafeteria only", true);
  await m.answerCheck("Jiwoo", v1.id, "The whole campus", true);
  await m.answerCheck("Taeho", v1.id, "Only the two places I study in", true);
  board = m.view("Taeho").board;
  assert.equal(board.phase, "converge");
  assert.equal(board.topics[0].status, "discussing");
  assert.equal(board.topics[0].versions[0].status, "split");
  // Readings without names or counts; an own-words answer is never shown verbatim.
  assert.deepEqual(new Set(board.topics[0].versions[0].readings), new Set(["Library and cafeteria only", "The whole campus", "another reading, in someone’s own words"]));
  assert.ok(!JSON.stringify(board).includes("two places I study"));

  await m.postGroupMessage("Minsu", "OK, let's just do the library and the cafeteria.");
  board = m.view("Minsu").board;
  assert.equal(board.topics.length, 1); // the same topic, a new version
  assert.deepEqual(board.topics[0].versions.map((v) => [v.version, v.status]), [[1, "split"], [2, "checking"]]);
  for (const user of ["Minsu", "Jiwoo", "Taeho"]) await m.answerCheck(user, m.check!.id, "Library and cafeteria only", true);
  board = m.view("Minsu").board;
  assert.deepEqual(board.topics[0].versions.map((v) => v.status), ["split", "agreed"]);
  assert.equal(board.topics[0].status, "agreed");
  assert.equal(board.phase, "explore");
});

test("stances: the agent reads each member's stance, the member chooses to share it, the board shows the mix without names", async () => {
  const m = new Meeting({ goal: "Pick a project topic", host: "Minsu" });
  m.join("Jiwoo");
  m.join("Taeho");
  await m.sendPrivateMessage("Jiwoo", "I'm worried the crowding idea might be too much work.");
  await m.sendPrivateMessage("Taeho", "I'd use a crowding app every day.");
  await m.postGroupMessage("Minsu", "Let's go with crowding prediction.");
  const card = (user: string) => cards(m, user).find((c) => c.kind === "understanding_check" && c.status === "open");
  const jiwoo = card("Jiwoo"), taeho = card("Taeho");
  assert.ok(jiwoo?.kind === "understanding_check" && taeho?.kind === "understanding_check");
  assert.equal(jiwoo.suggestedStance, "hesitant");
  assert.equal(taeho.suggestedStance, "support");
  m.shareStance("Jiwoo", m.check!.id, "hesitant");
  assert.equal(m.view("Minsu").board.topics[0].stances, undefined); // one shared stance is never shown on its own
  m.shareStance("Taeho", m.check!.id, "support");
  assert.deepEqual(m.view("Minsu").board.topics[0].stances, { support: 1, hesitant: 1, unsure: 0 });
  assert.ok(!JSON.stringify(m.view("Minsu").board).match(/Jiwoo|Taeho/));
  assert.equal(jiwoo.stance, "hesitant");
});

function pairingRoom() {
  const m = new Meeting({ goal: "Pick a project topic", host: "Minsu", tracePrompts: true });
  m.join("Jiwoo");
  m.join("Taeho");
  return m;
}

test("pairing: two agents with something on the same angle; names and a joint draft only after both say yes", async () => {
  const m = pairingRoom();
  await m.sendPrivateMessage("Jiwoo", "I want to predict how crowded the cafeteria and library are.");
  await m.sendPrivateMessage("Taeho", "Wi-Fi access counts for every building are public.");
  await m.requestAngle("Minsu", "using real campus data", "find_contribution");
  const offer = (user: string) => cards(m, user).find((c) => c.kind === "pair");
  const jiwooOffer = offer("Jiwoo"), taehoOffer = offer("Taeho");
  assert.ok(jiwooOffer?.kind === "pair" && taehoOffer?.kind === "pair");
  assert.equal(jiwooOffer.pairingId, taehoOffer.pairingId);
  const privateText = (user: string) => JSON.stringify(m.view(user).private);
  assert.ok(!privateText("Jiwoo").includes("Taeho") && !privateText("Taeho").includes("Jiwoo")); // nobody named yet

  await m.answerPairing("Jiwoo", jiwooOffer.pairingId, true);
  assert.equal(jiwooOffer.status, "accepted");
  assert.ok(!privateText("Jiwoo").includes("Taeho")); // still nothing until both say yes
  await m.answerPairing("Taeho", taehoOffer.pairingId, true);
  const joint = (user: string) => cards(m, user).find((c) => c.kind === "joint");
  const jiwooJoint = joint("Jiwoo"), taehoJoint = joint("Taeho");
  assert.ok(jiwooJoint?.kind === "joint" && taehoJoint?.kind === "joint");
  assert.equal(jiwooJoint.partner, "Taeho");
  assert.equal(taehoJoint.partner, "Jiwoo");
  assert.ok(taehoJoint.draft.includes("crowded") && taehoJoint.draft.toLowerCase().includes("wi-fi"));

  await m.postJoint("Taeho", taehoJoint.id, taehoJoint.draft);
  const posted = m.group.find((line) => line.joint);
  assert.equal(posted?.author, "Jiwoo & Taeho");
  assert.deepEqual(posted?.joint, ["Jiwoo", "Taeho"]);
  assert.equal(jiwooJoint.status, "posted");
  // Each member's own card for that piece is covered by the joint post.
  assert.ok(cards(m, "Jiwoo").filter((c) => c.kind === "share_suggestion").every((c) => c.status !== "open"));
  assert.deepEqual(findPrivacyLeaks(m), []);
});

test("pairing: one 'no' ends the offer and reveals nothing", async () => {
  const m = pairingRoom();
  await m.sendPrivateMessage("Jiwoo", "I want to predict how crowded the cafeteria and library are.");
  await m.sendPrivateMessage("Taeho", "Wi-Fi access counts for every building are public.");
  await m.requestAngle("Minsu", "using real campus data", "find_contribution");
  const jiwooOffer = cards(m, "Jiwoo").find((c) => c.kind === "pair");
  const taehoOffer = cards(m, "Taeho").find((c) => c.kind === "pair");
  assert.ok(jiwooOffer?.kind === "pair" && taehoOffer?.kind === "pair");
  await m.answerPairing("Taeho", taehoOffer.pairingId, true);
  await m.answerPairing("Jiwoo", jiwooOffer.pairingId, false);
  assert.equal(jiwooOffer.status, "declined");
  assert.equal(taehoOffer.status, "closed");
  assert.ok(!cards(m, "Jiwoo").some((c) => c.kind === "joint") && !cards(m, "Taeho").some((c) => c.kind === "joint"));
  assert.ok(!JSON.stringify(m.view("Taeho").private).includes("Jiwoo"));
  await assert.rejects(m.answerPairing("Taeho", taehoOffer.pairingId, true), /closed/);
});
