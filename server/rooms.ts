// Meeting rooms for the chat UI, built on the agent engine in agents/meeting.ts.
//
// One room = one scheduled meeting of one group (key "<groupCode>.<meetingId>"). The engine decides
// when the moderator and the personal agents run and what crosses the privacy boundary; this file only
// handles sessions, HTTP actions, starting a room from earlier group chat, and copying the group chat
// and agreed decisions into Stream so they outlive the server process.
//
// Route handling follows the team's reference server (CS40703_Xmas server/index.ts).

import { randomBytes, randomUUID } from "node:crypto";
import { Meeting, PersonalAgentUnavailable } from "../agents/meeting";
import type { GroupMessage } from "../agents/protocol";
import { BOTS, getStream, readHistory, streamConfigured, userIdFromName, type HistoryLine } from "./stream";

type Body = Record<string, unknown>;
type Quote = { author: string; text: string };
type Extra = { quote?: Quote; forwarded?: boolean };

type Room = {
  key: string;
  code: string;
  meetingId: string;
  /** Distinguishes this process's copy of the room, so Stream message ids never collide after a restart. */
  instance: string;
  meeting: Meeting;
  sessions: Map<string, string>; // private token -> display name
  extras: Map<string, Extra>; // UI-only data on group messages; never given to a model
  mirroredGroup: number;
  mirroredDecisions: number;
  mirror: Promise<void>;
};

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const rooms = new Map<string, Room>();
const creating = new Map<string, Promise<Room>>();
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const acknowledge = { ok: true };

// ---------- creating and joining ----------

function roomKey(code: string, meetingId: string) {
  return `${code}.${meetingId}`;
}

function meetingGoal(groupTitle: string, meeting: { title?: unknown } | null): string {
  const title = meeting ? text(meeting.title).trim() : "";
  return title ? `${title} (${groupTitle || "team project"})` : groupTitle || "Team meeting";
}

/**
 * Earlier group chat becomes the start of the room, so the agents keep the context of past meetings.
 * Stream history wins; the client's copy is used only when Stream has none (local demo data).
 */
function readClientHistory(value: unknown): HistoryLine[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-60)
    .map((item) => ({
      author: text(item?.author).trim().slice(0, 40),
      text: text(item?.text).trim().slice(0, 2000),
      at: Number(new Date(text(item?.createdAt)).getTime()) || 0,
      kind: "user" as const,
    }))
    .filter((line) => line.author && line.text && line.at);
}

async function createRoom(code: string, meetingId: string, host: string, body: Body): Promise<Room> {
  const meetingInfo = body.meeting && typeof body.meeting === "object" ? (body.meeting as Body) : null;
  const meeting = new Meeting({
    id: roomKey(code, meetingId),
    goal: meetingGoal(text(body.groupTitle).trim(), meetingInfo),
    host,
  });

  let history: HistoryLine[] = [];
  try {
    history = await readHistory(code);
  } catch (error) {
    console.error("[CrossCheck] could not read Stream history:", error);
  }
  if (history.length === 0) history = readClientHistory(body.history);
  history.sort((a, b) => a.at - b.at);
  history.forEach((line, index) => {
    meeting.group.push({ id: `h_${index + 1}`, author: line.author, kind: line.kind, text: line.text, at: line.at });
  });
  // Earlier chat is context, not new ideas: the silence trigger should wait for this meeting's own posts.
  (meeting as unknown as { userMsgsAtLastAngleRun: number }).userMsgsAtLastAngleRun = history.filter(
    (line) => line.kind === "user",
  ).length;

  const room: Room = {
    key: meeting.id,
    code,
    meetingId,
    instance: randomUUID().slice(0, 8),
    meeting,
    sessions: new Map(),
    extras: new Map(),
    mirroredGroup: meeting.group.length,
    mirroredDecisions: 0,
    mirror: Promise.resolve(),
  };
  rooms.set(room.key, room);
  return room;
}

function issueSession(room: Room, user: string) {
  const token = randomBytes(32).toString("base64url");
  room.sessions.set(token, user);
  return token;
}

/** POST /api/rooms/join  { code, user, groupTitle, meeting: {id,title,startsAt} | null, history? } */
export async function joinRoom(body: Body, token: string) {
  const code = text(body.code).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  const user = text(body.user).trim().slice(0, 40);
  const meetingInfo = body.meeting && typeof body.meeting === "object" ? (body.meeting as Body) : null;
  const meetingId = text(meetingInfo?.id).replace(/[^\w-]/g, "").slice(0, 80) || "general";
  if (!code) throw new HttpError(400, "Missing group code.");
  if (!user) throw new HttpError(400, "Missing name.");

  const key = roomKey(code, meetingId);
  let room = rooms.get(key);
  if (!room) {
    let pending = creating.get(key);
    if (!pending) {
      pending = createRoom(code, meetingId, user, body).finally(() => creating.delete(key));
      creating.set(key, pending);
    }
    room = await pending;
    if (room.meeting.host === user && room.sessions.size === 0) {
      return { roomKey: key, sessionToken: issueSession(room, user) };
    }
  }

  const { meeting } = room;
  const owner = room.sessions.get(token);
  const existing = meeting.participants.find((name) => name.toLowerCase() === user.toLowerCase());
  if (existing) {
    if (owner === existing) return { roomKey: key, sessionToken: token };
    // The host was added by the engine before any session existed (for example after a restart).
    if (![...room.sessions.values()].includes(existing)) {
      return { roomKey: key, sessionToken: issueSession(room, existing) };
    }
    throw new HttpError(403, "That name is already in this meeting on another device or tab.");
  }
  meeting.join(user);
  return { roomKey: key, sessionToken: issueSession(room, user) };
}

// ---------- actions ----------

/** Group actions return once stored; agent work continues and shows up on the next poll. */
async function run(room: Room, job: Promise<void>) {
  await Promise.race([job, Promise.resolve()]);
  job
    .catch((error) => console.error("[CrossCheck] background agent work failed:", error))
    .finally(() => syncToStream(room));
  syncToStream(room);
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

/** /api/rooms/:key/<action> */
export async function roomAction(key: string, action: string, body: Body, token: string) {
  const room = rooms.get(key);
  if (!room) throw new HttpError(404, "Room not found. Join again.");
  const { meeting } = room;
  const owner = room.sessions.get(token);
  if (!owner) throw new HttpError(403, "A session for this meeting is required. Join again.");

  switch (action) {
    case "GET view": {
      const view = meeting.view(owner);
      return {
        ...view,
        group: view.group.map((message) => ({ ...message, ...room.extras.get(message.id) })),
        // The id the decision gets in Stream, so the client can merge both copies.
        decisions: view.decisions.map((decision) => ({ ...decision, streamId: `${room.instance}-${decision.id}` })),
      };
    }
    case "POST group": {
      const quote = readQuote(body.quote);
      const typed = text(body.text).trim();
      const before = meeting.group.length;
      const job = meeting.postGroupMessage(owner, typed || quote?.text || "");
      // postGroupMessage stores the message synchronously, before any model call.
      if (quote && meeting.group.length > before) {
        room.extras.set(meeting.group[before].id, { quote, forwarded: !typed });
      }
      return run(room, job);
    }
    case "POST private": {
      const intent = body.intent;
      if (intent !== undefined && intent !== "invite_brainstorm") throw new HttpError(400, "Unknown private intent");
      await meeting.sendPrivateMessage(owner, text(body.text), {
        cardId: text(body.cardId) || undefined,
        groupMessageId: text(body.groupMessageId) || undefined,
        intent,
      });
      return acknowledge;
    }
    case "POST share":
      return run(room, meeting.shareCard(owner, text(body.cardId), text(body.text), shareMode(body.mode)));
    case "POST concern":
      return run(room, meeting.raiseConcern(owner, text(body.cardId), shareMode(body.mode), text(body.text)));
    case "POST dismiss":
      meeting.dismissCard(owner, text(body.cardId));
      return acknowledge;
    case "POST check/answer":
      if (typeof body.approve !== "boolean") throw new HttpError(400, "Choose whether to approve this proposal");
      return run(room, meeting.answerCheck(owner, text(body.checkId), text(body.label), body.approve));
    case "POST check/revise":
      return run(room, meeting.reviseCheck(owner, text(body.checkId), text(body.decision)));
    case "POST check/start":
      return run(room, meeting.startCheck(owner));
    case "POST check/compare":
      return run(room, meeting.compareNow(owner));
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
      .finally(() => syncToStream(room));
  }
}

// ---------- persistence in Stream ----------

let botsReady: Promise<void> | undefined;
const botMembers = new Set<string>();

function syncToStream(room: Room) {
  room.mirror = room.mirror.then(() => mirror(room)).catch((error) => {
    console.error("[CrossCheck] could not copy the meeting into Stream:", error);
  });
}

async function mirror(room: Room) {
  const { meeting } = room;
  if (!streamConfigured()) {
    room.mirroredGroup = meeting.group.length;
    room.mirroredDecisions = meeting.decisions.length;
    return;
  }
  const client = getStream();
  const channel = client.chat.channel("messaging", room.code);
  botsReady ??= client.upsertUsers([BOTS.moderator, BOTS.anonymous]).then(() => undefined);
  await botsReady;
  if (!botMembers.has(room.code)) {
    await channel.update({ add_members: [{ user_id: BOTS.moderator.id }, { user_id: BOTS.anonymous.id }] });
    botMembers.add(room.code);
  }

  while (room.mirroredGroup < meeting.group.length) {
    const message = meeting.group[room.mirroredGroup];
    room.mirroredGroup++;
    await channel.sendMessage({ message: toStreamMessage(room, message) });
  }
  while (room.mirroredDecisions < meeting.decisions.length) {
    const decision = meeting.decisions[room.mirroredDecisions];
    room.mirroredDecisions++;
    await channel.sendMessage({
      message: {
        id: `${room.instance}-${decision.id}`,
        text: decision.statement,
        user_id: BOTS.moderator.id,
        custom: { kind: "decision", meetingId: room.meetingId, agreed: true },
      },
    });
  }
}

function toStreamMessage(room: Room, message: GroupMessage) {
  const extra = room.extras.get(message.id);
  const base = { id: `${room.instance}-${message.id}`, text: message.text };
  if (message.kind === "moderator") {
    return { ...base, user_id: BOTS.moderator.id, custom: { kind: "moderator", note: message.note ?? null } };
  }
  if (message.anonymous) return { ...base, user_id: BOTS.anonymous.id, custom: { anonymous: true } };
  return { ...base, user_id: userIdFromName(message.author), custom: extra ? { ...extra } : {} };
}
