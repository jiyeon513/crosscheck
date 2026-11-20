export type Profile = {
  name: string;
};

export type Quote = {
  author: string;
  text: string;
};

export type Group = {
  id: string;
  code: string;
  title: string;
  createdAt: string;
  openedAt: string;
};

export type Meeting = {
  id: string;
  groupId: string;
  title: string;
  startsAt: string;
  createdBy: string;
  createdAt: string;
};

export type TeamMessage = {
  id: string;
  groupId?: string;
  text: string;
  author: string;
  createdAt: string;
  mine?: boolean;
  quote?: Quote;
  forwarded?: boolean;
};

export type AgentMessage = {
  id: string;
  label: string;
  text: string;
  createdAt: string;
  from: "user" | "agent";
  quote?: Quote;
};

export type Decision = {
  id: string;
  groupId: string;
  meetingId?: string;
  text: string;
  author: string;
  createdAt: string;
};

type Store = {
  version: number;
  profile: Profile | null;
  groups: Group[];
  meetings: Meeting[];
  decisions: Decision[];
  demoMessages: TeamMessage[];
  agent: Record<string, AgentMessage[]>;
};

const STORE_VERSION = 2;
const STORE_KEY = "crosscheck.v1";
const CURRENT_KEY = "crosscheck.current";

const SEED_GROUPS: Group[] = [
  {
    id: "cs473",
    code: "cs473",
    title: "CS473 · Team project",
    createdAt: "2026-11-02T10:00:00.000Z",
    openedAt: "2026-11-16T10:00:00.000Z",
  },
  {
    id: "hci201",
    code: "hci201",
    title: "HCI201 · Field study",
    createdAt: "2026-10-04T10:00:00.000Z",
    openedAt: "2026-10-20T10:00:00.000Z",
  },
];

/** Local wall-clock time, so seeds read as "2 PM" wherever the demo runs. */
function at(y: number, m: number, d: number, h: number, min = 0) {
  return new Date(y, m - 1, d, h, min).toISOString();
}

const SEED_MEETINGS: Meeting[] = [
  {
    id: "mtg-cs473-proto",
    groupId: "cs473",
    title: "Prototype meeting",
    startsAt: at(2026, 11, 10, 14),
    createdBy: "Jun",
    createdAt: at(2026, 11, 3, 10),
  },
  {
    id: "mtg-cs473-testing",
    groupId: "cs473",
    title: "User testing meeting",
    startsAt: at(2026, 11, 15, 15),
    createdBy: "Alex",
    createdAt: at(2026, 11, 10, 15),
  },
  {
    id: "mtg-cs473-final",
    groupId: "cs473",
    title: "Final review",
    startsAt: at(2026, 11, 24, 14),
    createdBy: "Jia",
    createdAt: at(2026, 11, 16, 10),
  },
  {
    id: "mtg-hci-interview",
    groupId: "hci201",
    title: "Interview planning",
    startsAt: at(2026, 10, 18, 11),
    createdBy: "Mina",
    createdAt: at(2026, 10, 12, 9),
  },
];

const SEED_MESSAGES: TeamMessage[] = [
  {
    id: "demo-jun-1",
    groupId: "cs473",
    text: "Let's lock the screen flow before anyone starts coding.",
    author: "Jun",
    createdAt: at(2026, 11, 10, 14, 6),
  },
  {
    id: "demo-alex-1",
    groupId: "cs473",
    text: "Testers got stuck on the second screen. The back button is hard to find.",
    author: "Alex",
    createdAt: at(2026, 11, 15, 15, 12),
  },
  {
    id: "demo-alex",
    groupId: "cs473",
    text: "Let's get ready for our next project review.",
    author: "Alex",
    createdAt: at(2026, 11, 16, 10),
  },
  {
    id: "demo-jia",
    groupId: "cs473",
    text: "I'll bring the screen flow to the review.",
    author: "Jia",
    createdAt: at(2026, 11, 16, 10, 4),
  },
  {
    id: "demo-mina",
    groupId: "hci201",
    text: "The interview notes are in the shared doc.",
    author: "Mina",
    createdAt: at(2026, 10, 20, 9, 12),
  },
];

const SEED_DECISIONS: Decision[] = [
  {
    id: "decision-cs473-1",
    groupId: "cs473",
    meetingId: "mtg-cs473-proto",
    text: "Next phase is a clickable Figma flow, then coding.",
    author: "Jun",
    createdAt: at(2026, 11, 10, 14, 40),
  },
  {
    id: "decision-cs473-3",
    groupId: "cs473",
    meetingId: "mtg-cs473-proto",
    text: "Jia owns the screen flow; Jun owns visual style.",
    author: "Jia",
    createdAt: at(2026, 11, 10, 14, 52),
  },
  {
    id: "decision-cs473-2",
    groupId: "cs473",
    meetingId: "mtg-cs473-testing",
    text: "Move the back button to the top-left on every screen.",
    author: "Alex",
    createdAt: at(2026, 11, 15, 15, 30),
  },
  {
    id: "decision-hci-1",
    groupId: "hci201",
    meetingId: "mtg-hci-interview",
    text: "Park the interview script until the prototype is clickable.",
    author: "Mina",
    createdAt: at(2026, 10, 18, 11, 30),
  },
];

const SEED_AGENT: Record<string, AgentMessage[]> = {
  cs473: [
    {
      id: "agent-cs473",
      label: "Carried over from earlier meetings",
      text: "Prototype meeting (Nov 10): clickable Figma flow first, then coding.\nUser testing (Nov 15): move the back button to the top-left.\nNext up is the Final review.",
      createdAt: at(2026, 11, 16, 9, 40),
      from: "agent",
    },
  ],
  hci201: [
    {
      id: "agent-hci201",
      label: "From last time",
      text: "The group paused interviews until the prototype could be clicked through.",
      createdAt: at(2026, 10, 20, 9),
      from: "agent",
    },
  ],
};

function emptyStore(): Store {
  return {
    version: STORE_VERSION,
    profile: null,
    groups: SEED_GROUPS,
    meetings: SEED_MEETINGS,
    decisions: SEED_DECISIONS,
    demoMessages: SEED_MESSAGES,
    agent: {},
  };
}

/** Bring data saved before meetings existed onto the new shape, keeping the profile and user groups. */
function migrate(parsed: Partial<Store>): Store {
  const groups = (parsed.groups?.length ? parsed.groups : SEED_GROUPS).map((group) =>
    group.id === "cs473" && group.title === "CS473 · Prototype meeting"
      ? { ...group, title: "CS473 · Team project" }
      : group,
  );
  const seedIds = new Set(SEED_DECISIONS.map((item) => item.id));
  const legacy = (parsed.decisions ?? []).filter(
    (item) => !seedIds.has(item.id) && !item.id.startsWith("decision-"),
  );
  return {
    version: STORE_VERSION,
    profile: parsed.profile ?? null,
    groups,
    meetings: SEED_MEETINGS,
    decisions: [...SEED_DECISIONS, ...legacy],
    demoMessages: SEED_MESSAGES,
    agent: parsed.agent ?? {},
  };
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) {
      const seeded = emptyStore();
      localStorage.setItem(STORE_KEY, JSON.stringify(seeded));
      return seeded;
    }
    const parsed = JSON.parse(raw) as Partial<Store>;
    if ((parsed.version ?? 1) < STORE_VERSION) {
      const migrated = migrate(parsed);
      saveStore(migrated);
      return migrated;
    }
    return {
      version: STORE_VERSION,
      profile: parsed.profile ?? null,
      groups: parsed.groups?.length ? parsed.groups : SEED_GROUPS,
      meetings: parsed.meetings ?? [],
      decisions: parsed.decisions ?? [],
      demoMessages: parsed.demoMessages ?? SEED_MESSAGES,
      agent: parsed.agent ?? {},
    };
  } catch {
    return emptyStore();
  }
}

function saveStore(store: Store) {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

export function loadProfile(): Profile | null {
  const profile = loadStore().profile;
  return profile?.name ? { name: profile.name } : null;
}

export function logout() {
  const store = loadStore();
  store.profile = null;
  saveStore(store);
  sessionStorage.removeItem(CURRENT_KEY);
}

export function saveProfile(profile: Profile) {
  const store = loadStore();
  store.profile = profile;
  saveStore(store);
}

export function loadGroups(): Group[] {
  return loadStore()
    .groups.slice()
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}

export function saveGroup(group: Group) {
  const store = loadStore();
  const index = store.groups.findIndex((item) => item.id === group.id);
  if (index === -1) store.groups.push(group);
  else store.groups[index] = { ...store.groups[index], ...group };
  saveStore(store);
}

export function getGroup(id: string): Group | undefined {
  return loadStore().groups.find((group) => group.id === id);
}

export function markOpened(id: string) {
  const store = loadStore();
  const group = store.groups.find((item) => item.id === id);
  if (!group) return;
  group.openedAt = new Date().toISOString();
  saveStore(store);
}

export function setCurrentGroup(id: string) {
  sessionStorage.setItem(CURRENT_KEY, id);
}

export function getCurrentGroup(): string | null {
  return sessionStorage.getItem(CURRENT_KEY);
}

export function meetingsFor(groupId: string): Meeting[] {
  return sortMeetings(loadStore().meetings.filter((item) => item.groupId === groupId));
}

export function saveMeetings(groupId: string, meetings: Meeting[]) {
  const store = loadStore();
  store.meetings = [...store.meetings.filter((item) => item.groupId !== groupId), ...meetings];
  saveStore(store);
}

export function sortMeetings(meetings: Meeting[]) {
  return meetings.slice().sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export type MeetingStatus = "past" | "today" | "upcoming";

export function meetingStatus(meeting: Meeting, now = new Date()): MeetingStatus {
  const start = new Date(meeting.startsAt);
  if (start.toDateString() === now.toDateString()) return "today";
  return start < now ? "past" : "upcoming";
}

/** The meeting decisions should land in by default: today's, else the next one, else the latest. */
export function pickActiveMeeting(meetings: Meeting[], now = new Date()): Meeting | null {
  const sorted = sortMeetings(meetings);
  return (
    sorted.find((item) => meetingStatus(item, now) === "today") ??
    sorted.find((item) => meetingStatus(item, now) === "upcoming") ??
    sorted.at(-1) ??
    null
  );
}

export function nextMeeting(groupId: string, now = new Date()): Meeting | null {
  return meetingsFor(groupId).find((item) => meetingStatus(item, now) !== "past") ?? null;
}

export function decisionsFor(groupId: string): Decision[] {
  return loadStore()
    .decisions.filter((item) => item.groupId === groupId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function saveDecisions(groupId: string, decisions: Decision[]) {
  const store = loadStore();
  store.decisions = [...store.decisions.filter((item) => item.groupId !== groupId), ...decisions];
  saveStore(store);
}

export function demoMessagesFor(groupId: string): TeamMessage[] {
  return loadStore()
    .demoMessages.filter((message) => message.groupId === groupId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function agentThread(groupId: string, name: string): AgentMessage[] {
  const store = loadStore();
  const key = `${groupId}::${name}`;
  if (store.agent[key]?.length) return store.agent[key];
  return SEED_AGENT[groupId] ?? [];
}

export function saveAgentThread(groupId: string, name: string, messages: AgentMessage[]) {
  const store = loadStore();
  store.agent[`${groupId}::${name}`] = messages;
  saveStore(store);
}

export function makeCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function cleanCode(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
}

export function agentReply(name: string, text: string, meeting: Meeting | null) {
  const line = text.trim().split("\n").find(Boolean) ?? text.trim();
  const clipped = line.length > 160 ? `${line.slice(0, 157)}...` : line;
  const where = meeting ? ` for ${meeting.title} (${formatMeetingTime(meeting.startsAt)})` : "";
  return `Noted${where}, ${name}: "${clipped}"\nDrag a bubble into the team chat, or onto a meeting's decision log if the team should keep it.`;
}

export function formatMeetingTime(value: string) {
  const date = new Date(value);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}`;
}
