// Everything the app keeps between requests: accounts, sessions, groups, meetings, decisions and the
// team chat of each group. Stored as one JSON file in DATA_DIR (default ./data), written shortly after
// each change. Small and dependency-free on purpose; swap for a database if the app grows.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ModeratorNote, Quote } from "../agents/protocol";

export type User = { name: string; salt: string; hash: string; createdAt: string };
export type Session = { name: string; createdAt: string };
export type GroupRecord = { code: string; title: string; createdBy: string; createdAt: string; members: string[] };
export type MeetingRecord = {
  id: string;
  groupCode: string;
  title: string;
  startsAt: string;
  createdBy: string;
  createdAt: string;
};
export type DecisionRecord = {
  id: string;
  groupCode: string;
  meetingId: string | null;
  /** Current wording. Members can edit it; the wording everyone agreed on stays in `original`. */
  text: string;
  original: string;
  /** "3/3": how many agreed when the Moderator recorded it. */
  agreed: string;
  createdAt: string;
  editedBy?: string;
  editedAt?: string;
};
export type ChatRecord = {
  id: string;
  author: string;
  kind: "user" | "moderator";
  text: string;
  at: number;
  anonymous?: boolean;
  quote?: Quote;
  note?: ModeratorNote;
};

type Data = {
  users: Record<string, User>; // key: lower-case name
  sessions: Record<string, Session>; // key: token
  groups: Record<string, GroupRecord>; // key: code
  meetings: MeetingRecord[];
  decisions: DecisionRecord[];
  chats: Record<string, ChatRecord[]>; // key: group code
  opened: Record<string, string>; // key: "<lower-case name>|<code>", last time the member opened the group
};

const CHAT_LIMIT = 500;

function empty(): Data {
  return { users: {}, sessions: {}, groups: {}, meetings: [], decisions: [], chats: {}, opened: {} };
}

class Store {
  private data: Data = empty();
  private file = "";
  private timer: NodeJS.Timeout | undefined;

  /** Load from DATA_DIR. With `memory`, nothing is read or written (tests). */
  open(options: { memory?: boolean } = {}) {
    this.data = empty();
    if (options.memory) {
      this.file = "";
      return;
    }
    const dir = resolve(process.env.DATA_DIR || "data");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "crosscheck.json");
    try {
      this.data = { ...empty(), ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<Data>) };
    } catch {
      // First start: nothing saved yet.
    }
  }

  get db(): Data {
    return this.data;
  }

  /** Call after every change. Writes are batched and atomic (temp file + rename). */
  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this.timer);
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data));
    renameSync(temp, this.file);
  }

  appendChat(code: string, record: ChatRecord) {
    const list = (this.data.chats[code] ??= []);
    list.push(record);
    if (list.length > CHAT_LIMIT) list.splice(0, list.length - CHAT_LIMIT);
    this.save();
  }
}

export const store = new Store();
