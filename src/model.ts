// Shapes the server returns, and small helpers. All data lives on the server (server/store.ts).

export type Group = {
  code: string;
  title: string;
  createdBy: string;
  createdAt: string;
  members: string[];
};

export type Meeting = {
  id: string;
  groupCode: string;
  title: string;
  startsAt: string;
  createdBy: string;
  createdAt: string;
};

/** A decision the Moderator recorded after everyone agreed. Members may correct its wording. */
export type Decision = {
  id: string;
  groupCode: string;
  meetingId: string | null;
  text: string;
  original: string;
  agreed: string;
  createdAt: string;
  editedBy?: string;
  editedAt?: string;
  /** The earlier decision this one replaced, after the team revisited it. */
  replaces?: string;
  /** The later decision that replaced this one. */
  replacedBy?: string;
};

export type GroupSummary = Group & { meetings: Meeting[]; decisionCount: number; openedAt: string };
export type GroupDetail = { group: Group; meetings: Meeting[]; decisions: Decision[] };

export function sortMeetings(meetings: Meeting[]) {
  return meetings.slice().sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export type MeetingStatus = "past" | "today" | "upcoming";

export function meetingStatus(meeting: Meeting, now = new Date()): MeetingStatus {
  const start = new Date(meeting.startsAt);
  if (start.toDateString() === now.toDateString()) return "today";
  return start < now ? "past" : "upcoming";
}

/** The meeting the chat room works on: today's, else the next upcoming one. */
export function currentMeeting(meetings: Meeting[], now = new Date()): Meeting | null {
  const sorted = sortMeetings(meetings);
  return (
    sorted.find((item) => meetingStatus(item, now) === "today") ??
    sorted.find((item) => meetingStatus(item, now) === "upcoming") ??
    null
  );
}

export function cleanCode(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
}

/** Same rule as the engine (agents/format.ts): these answers do not count as agreeing. */
export function isUnsure(answer: string) {
  return /not sure|unsure|don'?t know|no preference|잘 모르|모르겠/i.test(answer);
}

export function formatMeetingTime(value: string) {
  const date = new Date(value);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}`;
}

export function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
