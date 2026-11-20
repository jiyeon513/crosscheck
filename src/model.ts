export type Profile = {
  name: string;
  role: string;
};

export type Group = {
  id: string;
  code: string;
  title: string;
  createdAt: string;
  openedAt: string;
};

export type TeamMessage = {
  id: string;
  groupId?: string;
  text: string;
  author: string;
  role: string;
  createdAt: string;
  mine?: boolean;
};

export type AgentMessage = {
  id: string;
  label: string;
  text: string;
  createdAt: string;
  from: "user" | "agent";
};

export type Decision = {
  id: string;
  groupId: string;
  text: string;
  author: string;
  role: string;
  createdAt: string;
};

type Store = {
  profile: Profile | null;
  groups: Group[];
  decisions: Decision[];
  demoMessages: TeamMessage[];
  agent: Record<string, AgentMessage[]>;
};

const STORE_KEY = "crosscheck.v1";
const CURRENT_KEY = "crosscheck.current";

const SEED_GROUPS: Group[] = [
  {
    id: "cs473",
    code: "cs473",
    title: "CS473 · Prototype meeting",
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

const SEED_MESSAGES: TeamMessage[] = [
  {
    id: "demo-alex",
    groupId: "cs473",
    text: "Let's get ready for our next project review.",
    author: "Alex",
    role: "Testing & review",
    createdAt: "2026-11-16T10:00:00.000Z",
  },
  {
    id: "demo-jia",
    groupId: "cs473",
    text: "I'll bring the screen flow to the review.",
    author: "Jia",
    role: "Frontend",
    createdAt: "2026-11-16T10:04:00.000Z",
  },
  {
    id: "demo-mina",
    groupId: "hci201",
    text: "The interview notes are in the shared doc.",
    author: "Mina",
    role: "Research",
    createdAt: "2026-10-20T09:12:00.000Z",
  },
];

const SEED_DECISIONS: Decision[] = [
  {
    id: "decision-cs473-1",
    groupId: "cs473",
    text: "Next phase is a clickable Figma flow, then coding.",
    author: "Jun",
    role: "UI/UX design",
    createdAt: "2026-11-09T08:30:00.000Z",
  },
  {
    id: "decision-cs473-2",
    groupId: "cs473",
    text: "Review the prototype with the whole team on Monday.",
    author: "Alex",
    role: "Testing & review",
    createdAt: "2026-11-12T14:10:00.000Z",
  },
  {
    id: "decision-hci-1",
    groupId: "hci201",
    text: "Park the interview script until the prototype is clickable.",
    author: "Mina",
    role: "Research",
    createdAt: "2026-10-18T11:00:00.000Z",
  },
];

const SEED_AGENT: Record<string, AgentMessage[]> = {
  cs473: [
    {
      id: "agent-cs473",
      label: "From your preparation",
      text: "You planned a clickable Figma flow, with coding in the next phase.",
      createdAt: "2026-11-16T09:40:00.000Z",
      from: "agent",
    },
  ],
  hci201: [
    {
      id: "agent-hci201",
      label: "From last time",
      text: "The group paused interviews until the prototype could be clicked through.",
      createdAt: "2026-10-20T09:00:00.000Z",
      from: "agent",
    },
  ],
};

function emptyStore(): Store {
  return {
    profile: null,
    groups: SEED_GROUPS,
    decisions: SEED_DECISIONS,
    demoMessages: SEED_MESSAGES,
    agent: {},
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
    return {
      profile: parsed.profile ?? null,
      groups: parsed.groups?.length ? parsed.groups : SEED_GROUPS,
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
  return loadStore().profile;
}

export function saveProfile(profile: Profile) {
  const store = loadStore();
  store.profile = profile;
  saveStore(store);
}

export function loadGroups(): Group[] {
  return loadStore().groups.slice().sort((a, b) => b.openedAt.localeCompare(a.openedAt));
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

export function decisionsFor(groupId: string): Decision[] {
  return loadStore()
    .decisions.filter((item) => item.groupId === groupId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function saveDecisions(groupId: string, decisions: Decision[]) {
  const store = loadStore();
  store.decisions = [
    ...store.decisions.filter((item) => item.groupId !== groupId),
    ...decisions,
  ];
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

export function agentReply(name: string, text: string) {
  const line = text.trim().split("\n").find(Boolean) ?? text.trim();
  const clipped = line.length > 160 ? `${line.slice(0, 157)}...` : line;
  return `I kept this with your note, ${name}:\n"${clipped}"\nDrag a bubble to the other box, or drop it on the decision log if the team should keep it.`;
}
