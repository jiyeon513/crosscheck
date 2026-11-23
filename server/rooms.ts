// Meeting rooms for the chat UI, built on the agent engine in agents/meeting.ts.
//
// One room = one scheduled meeting of one group (key "<groupCode>.<meetingId>"). The engine decides
// when the Moderator and the Personal Agents run and what crosses the privacy boundary. This file
// adds who may enter (signed-in group members), starts a room from the group's earlier chat so the
// agents keep context across meetings, and saves new chat lines and agreed decisions in the store.

import { randomUUID } from "node:crypto";
import { Meeting, PersonalAgentUnavailable } from "../agents/meeting";
import type { Quote } from "../agents/protocol";
import { HttpError } from "./auth";
import { findMeeting, memberGroup } from "./groups";
import { store } from "./store";

type Body = Record<string, unknown>;

type Room = {
  key: string;
  code: string;
  meetingId: string;
  /** Distinguishes this process's copy of the room, so saved ids never collide after a restart. */
  instance: string;
  meeting: Meeting;
  savedGroup: number;
  savedDecisions: number;
};

const rooms = new Map<string, Room>();
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const acknowledge = { ok: true };
const HISTORY = 60;

function createRoom(code: string, meetingId: string, host: string): Room {
  const group = store.db.groups[code];
  const scheduled = findMeeting(code, meetingId);
  const goal = scheduled ? `${scheduled.title} (${group.title})` : group.title;
  const meeting = new Meeting({ id: `${code}.${meetingId}`, goal, host });

  // Earlier team chat is context for the agents, not new ideas for this meeting.
  const history = (store.db.chats[code] ?? []).slice(-HISTORY);
  history.forEach((line, index) => {
    meeting.group.push({
      id: `h_${index + 1}`,
      author: line.author,
      kind: line.kind,
      text: line.text,
      at: line.at,
      ...(line.anonymous ? { anonymous: true } : {}),
      ...(line.quote ? { quote: line.quote } : {}),
      ...(line.note ? { note: line.note } : {}),
    });
  });
  // The silence trigger should wait for this meeting's own posts.
  (meeting as unknown as { userMsgsAtLastAngleRun: number }).userMsgsAtLastAngleRun = history.filter(
    (line) => line.kind === "user",
  ).length;

  const room: Room = {
    key: meeting.id,
    code,
    meetingId,
    instance: randomUUID().slice(0, 8),
    meeting,
    savedGroup: meeting.group.length,
    savedDecisions: 0,
  };
  rooms.set(room.key, room);
  return room;
}

/** POST /api/rooms/join { code, meetingId } — enter the room of a group meeting. */
export function joinRoom(name: string, body: Body) {
  const group = memberGroup(text(body.code), name);
  const requested = text(body.meetingId).replace(/[^\w-]/g, "").slice(0, 80);
  const meetingId = requested && findMeeting(group.code, requested) ? requested : "general";
  const key = `${group.code}.${meetingId}`;
  const room = rooms.get(key) ?? createRoom(group.code, meetingId, name);
  if (!room.meeting.participants.includes(name)) room.meeting.join(name);
  return { roomKey: key };
}

/** Group actions return once stored; agent work continues and shows up on the next poll. */
async function run(room: Room, job: Promise<void>) {
  await Promise.race([job, Promise.resolve()]);
  job
    .catch((error) => console.error("[CrossCheck] background agent work failed:", error))
    .finally(() => save(room));
  save(room);
  return acknowledge;
}

function shareMode(value: unknown): "named" | "anonymous" {
  if (value !== "named" && value !== "anonymous") throw new HttpError(400, "Choose how to share the confirmed text");
  return value;
}

function readQuote(value: unknown): Quote | undefined {
  if (!value || typeof value !== "object") return undefined;
  const quote = value as Body;
  const quoteText = text(quote.text).trim().slice(0, 2000);
  return quoteText ? { author: text(quote.author).trim().slice(0, 60) || "Someone", text: quoteText } : undefined;
}

/** /api/rooms/:key/<action> for a signed-in member. */
export async function roomAction(name: string, key: string, action: string, body: Body) {
  const room = rooms.get(key);
  if (!room) throw new HttpError(404, "Room not found. Join again.");
  memberGroup(room.code, name);
  const { meeting } = room;
  if (!meeting.participants.includes(name)) meeting.join(name);

  switch (action) {
    case "GET view":
      return {
        ...meeting.view(name),
        meetingId: room.meetingId,
        // This meeting's decision log as saved (with any wording fixes by members).
        log: store.db.decisions.filter(
          (d) => d.groupCode === room.code && d.meetingId === (room.meetingId === "general" ? null : room.meetingId),
        ),
      };
    case "POST group": {
      const quote = readQuote(body.quote);
      const typed = text(body.text).trim();
      return run(room, meeting.postGroupMessage(name, typed || quote?.text || "", { quote }));
    }
    case "POST private": {
      const intent = body.intent;
      if (intent !== undefined && intent !== "invite_brainstorm") throw new HttpError(400, "Unknown private intent");
      await meeting.sendPrivateMessage(name, text(body.text), {
        cardId: text(body.cardId) || undefined,
        groupMessageId: text(body.groupMessageId) || undefined,
        intent,
      });
      return acknowledge;
    }
    case "POST share":
      return run(room, meeting.shareCard(name, text(body.cardId), text(body.text), shareMode(body.mode)));
    case "POST concern":
      return run(room, meeting.raiseConcern(name, text(body.cardId), shareMode(body.mode), text(body.text)));
    case "POST dismiss":
      meeting.dismissCard(name, text(body.cardId));
      return acknowledge;
    case "POST propose":
      return run(room, meeting.proposeDecision(name, text(body.text)));
    case "POST angle":
      return run(room, meeting.requestAngle(name, text(body.angle), "find_contribution"));
    case "POST check/answer":
      if (typeof body.approve !== "boolean") throw new HttpError(400, "Choose whether to approve this proposal");
      return run(room, meeting.answerCheck(name, text(body.checkId), text(body.label), body.approve));
    case "POST check/revise":
      return run(room, meeting.reviseCheck(name, text(body.checkId), text(body.decision)));
    case "POST check/start":
      return run(room, meeting.startCheck(name));
    case "POST check/compare":
      return run(room, meeting.compareNow(name));
    case "POST reopen":
      if (typeof body.reopen !== "boolean") throw new HttpError(400, "Choose whether to revisit the decision");
      meeting.answerRevisit(name, text(body.recordId), body.reopen);
      save(room);
      return acknowledge;
    case "POST check/cancel":
      meeting.cancelCheck(name, text(body.checkId));
      save(room);
      return acknowledge;
    default:
      throw new HttpError(404, "Unknown endpoint");
  }
}

export function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof PersonalAgentUnavailable) return 503;
  return 400;
}

/** Time-based rules (silence → missing angle, check timeout). Called every few seconds. */
export function tickRooms() {
  for (const room of rooms.values()) {
    room.meeting
      .tick()
      .catch((error) => console.error("[CrossCheck] background meeting update failed:", error))
      .finally(() => save(room));
  }
}

/** Copy new team chat lines and agreed decisions into the store. */
function save(room: Room) {
  const { meeting } = room;
  while (room.savedGroup < meeting.group.length) {
    const line = meeting.group[room.savedGroup++];
    store.appendChat(room.code, {
      id: `${room.instance}-${line.id}`,
      author: line.author,
      kind: line.kind,
      text: line.text,
      at: line.at,
      ...(line.anonymous ? { anonymous: true } : {}),
      ...(line.quote ? { quote: line.quote } : {}),
      ...(line.note ? { note: line.note } : {}),
    });
  }
  while (room.savedDecisions < meeting.decisions.length) {
    const record = meeting.decisions[room.savedDecisions++];
    const check = meeting.check?.id === record.checkId ? meeting.check : null;
    const id = `${room.instance}-${record.id}`;
    if (store.db.decisions.some((d) => d.id === id)) continue;
    store.db.decisions.push({
      id,
      groupCode: room.code,
      meetingId: room.meetingId === "general" ? null : room.meetingId,
      text: record.statement,
      original: record.statement,
      agreed: check?.total ? `${check.agreed ?? check.total}/${check.total}` : "",
      createdAt: new Date(record.at).toISOString(),
      ...(record.replaces ? { replaces: `${room.instance}-${record.replaces}` } : {}),
    });
    store.save();
  }
  // A revisited decision is marked replaced once the new version is agreed.
  for (const record of meeting.decisions) {
    if (!record.replacedBy) continue;
    const saved = store.db.decisions.find((d) => d.id === `${room.instance}-${record.id}`);
    const by = `${room.instance}-${record.replacedBy}`;
    if (saved && saved.replacedBy !== by) {
      saved.replacedBy = by;
      store.save();
    }
  }
}

/** Tests: forget every room. */
export function resetRooms() {
  rooms.clear();
}
