// Groups, meetings and decision logs of the signed-in member.

import { randomBytes } from "node:crypto";
import { HttpError } from "./auth";
import { store, type DecisionRecord, type GroupRecord, type MeetingRecord } from "./store";

type Body = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const isMember = (group: GroupRecord, name: string) =>
  group.members.some((member) => member.toLowerCase() === name.toLowerCase());

export function cleanCode(value: unknown) {
  return text(value).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
}

function makeCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  for (;;) {
    const code = Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join("");
    if (!store.db.groups[code]) return code;
  }
}

/** The group, if this member belongs to it. */
export function memberGroup(code: string, name: string): GroupRecord {
  const group = store.db.groups[cleanCode(code)];
  if (!group) throw new HttpError(404, "No group has that code.");
  if (!isMember(group, name)) throw new HttpError(403, "Join this group first.");
  return group;
}

const meetingsOf = (code: string) =>
  store.db.meetings.filter((m) => m.groupCode === code).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
const decisionsOf = (code: string) =>
  store.db.decisions.filter((d) => d.groupCode === code).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const openedKey = (name: string, code: string) => `${name.toLowerCase()}|${code}`;

/** GET /api/groups */
export function listGroups(name: string) {
  return Object.values(store.db.groups)
    .filter((group) => isMember(group, name))
    .map((group) => ({
      ...group,
      meetings: meetingsOf(group.code),
      decisionCount: decisionsOf(group.code).length,
      openedAt: store.db.opened[openedKey(name, group.code)] ?? group.createdAt,
    }))
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}

/** POST /api/groups { title } */
export function createGroup(name: string, body: Body) {
  const title = text(body.title).slice(0, 80);
  if (!title) throw new HttpError(400, "Give the group a name.");
  const group: GroupRecord = {
    code: makeCode(),
    title,
    createdBy: name,
    createdAt: new Date().toISOString(),
    members: [name],
  };
  store.db.groups[group.code] = group;
  store.db.opened[openedKey(name, group.code)] = group.createdAt;
  store.save();
  return group;
}

/** POST /api/groups/join { code } */
export function joinGroup(name: string, body: Body) {
  const group = store.db.groups[cleanCode(body.code)];
  if (!group) throw new HttpError(404, "No group has that code. Check it with whoever invited you.");
  if (!isMember(group, name)) group.members.push(name);
  store.db.opened[openedKey(name, group.code)] = new Date().toISOString();
  store.save();
  return group;
}

/** GET /api/groups/:code — also marks the group as just opened by this member. */
export function groupDetail(name: string, code: string) {
  const group = memberGroup(code, name);
  store.db.opened[openedKey(name, group.code)] = new Date().toISOString();
  store.save();
  return { group, meetings: meetingsOf(group.code), decisions: decisionsOf(group.code) };
}

/** POST /api/groups/:code/meetings { title, startsAt } */
export function scheduleMeeting(name: string, code: string, body: Body): MeetingRecord {
  const group = memberGroup(code, name);
  const title = text(body.title).slice(0, 60);
  const startsAt = new Date(text(body.startsAt));
  if (!title) throw new HttpError(400, "Name the meeting.");
  if (Number.isNaN(startsAt.getTime())) throw new HttpError(400, "Pick a date and time.");
  const meeting: MeetingRecord = {
    id: `mtg_${randomBytes(8).toString("hex")}`,
    groupCode: group.code,
    title,
    startsAt: startsAt.toISOString(),
    createdBy: name,
    createdAt: new Date().toISOString(),
  };
  store.db.meetings.push(meeting);
  store.save();
  return meeting;
}

/** PATCH /api/groups/:code/decisions/:id { text } — members may correct the wording; the agreed original is kept. */
export function editDecision(name: string, code: string, id: string, body: Body): DecisionRecord {
  const group = memberGroup(code, name);
  const decision = store.db.decisions.find((d) => d.id === id && d.groupCode === group.code);
  if (!decision) throw new HttpError(404, "Decision not found.");
  const next = text(body.text).slice(0, 500);
  if (!next) throw new HttpError(400, "A decision cannot be empty.");
  if (next !== decision.text) {
    decision.text = next;
    decision.editedBy = name;
    decision.editedAt = new Date().toISOString();
    store.save();
  }
  return decision;
}

export function findMeeting(code: string, meetingId: string): MeetingRecord | undefined {
  return store.db.meetings.find((m) => m.groupCode === code && m.id === meetingId);
}

/** DELETE /api/groups/:code/meetings/:id — remove a scheduled meeting that has no decisions yet. */
export function removeMeeting(name: string, code: string, meetingId: string) {
  const group = memberGroup(code, name);
  const index = store.db.meetings.findIndex((m) => m.groupCode === group.code && m.id === meetingId);
  if (index === -1) throw new HttpError(404, "That meeting is not on the schedule.");
  if (store.db.decisions.some((d) => d.groupCode === group.code && d.meetingId === meetingId)) {
    throw new HttpError(409, "This meeting already has decisions, so it stays on the schedule.");
  }
  store.db.meetings.splice(index, 1);
  store.save();
  return { ok: true };
}

/**
 * POST /api/groups/demo — a sample group to try the app alone: a few earlier team messages from sample
 * teammates (they are chat history only, not accounts) and two meetings, one in progress and one coming up.
 */
export function createDemoGroup(name: string) {
  const group = createGroup(name, { title: "Demo · Pick one topic for our team project" });
  const now = Date.now();
  const lines: [string, string][] = [
    ["Jun", "Should we lock the screen flow before anyone starts coding?"],
    ["Alex", "Testers got stuck on the second screen. The back button was hard to find."],
    ["Jia", "What should we bring to the next project review?"],
  ];
  lines.forEach(([author, line], index) =>
    store.appendChat(group.code, { id: `demo-${index + 1}`, author, kind: "user", text: line, at: now - (lines.length - index) * 60_000 }),
  );
  const review = new Date(now + 4 * 24 * 3600_000);
  review.setHours(14, 0, 0, 0);
  for (const [title, startsAt] of [["Prototype meeting", new Date(now - 30 * 60_000)], ["Final review", review]] as const) {
    store.db.meetings.push({
      id: `mtg_${randomBytes(8).toString("hex")}`,
      groupCode: group.code,
      title,
      startsAt: startsAt.toISOString(),
      createdBy: name,
      createdAt: new Date(now).toISOString(),
    });
  }
  store.save();
  return group;
}
