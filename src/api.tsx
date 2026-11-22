import type { DecisionRecord, GroupMessage, UserView } from "../agents/protocol";

export type JoinResult = {
  apiKey: string;
  token: string;
  userId: string;
  name: string;
  code: string;
  title: string;
};

export async function joinGroup(input: {
  name: string;
  code: string;
  title?: string;
}): Promise<JoinResult> {
  const response = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as JoinResult & { error?: string };
  if (!response.ok) throw new Error(body.error || "Could not join the group.");
  return body;
}

// ---------- meeting room (agents run on the server: agents/meeting.ts) ----------

export type RoomQuote = { author: string; text: string };
export type RoomGroupMessage = GroupMessage & { quote?: RoomQuote; forwarded?: boolean };
export type RoomDecision = DecisionRecord & { streamId: string };
export type RoomView = Omit<UserView, "group" | "decisions"> & {
  group: RoomGroupMessage[];
  decisions: RoomDecision[];
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST", url: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-CrossCheck-Session": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error || `Request failed (${response.status}).`);
  return data;
}

const tokenKey = (code: string, meetingId: string, name: string) =>
  `crosscheck.room.${code}.${meetingId}.${name}`;

function readToken(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeToken(key: string, token: string) {
  try {
    localStorage.setItem(key, token);
  } catch {
    // The session then lasts only for this page.
  }
}

/** Enter the room of a group's current meeting. The token is kept so a reload resumes the same seat. */
export async function joinRoom(input: {
  code: string;
  user: string;
  groupTitle: string;
  meeting: { id: string; title: string; startsAt: string } | null;
  history: { author: string; text: string; createdAt: string }[];
}) {
  const key = tokenKey(input.code, input.meeting?.id ?? "general", input.user);
  const result = await request<{ roomKey: string; sessionToken: string }>(
    "POST",
    "/api/rooms/join",
    readToken(key),
    input,
  );
  writeToken(key, result.sessionToken);
  return result;
}

export function roomView(roomKey: string, token: string) {
  return request<RoomView>("GET", `/api/rooms/${roomKey}/view`, token);
}

export function roomAction(roomKey: string, token: string, action: string, body: object) {
  return request<{ ok: true }>("POST", `/api/rooms/${roomKey}/${action}`, token, body);
}

export function Logo() {
  return (
    <div className="brand">
      <span className="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path
            d="M6 12.5 10 16.5 18 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <strong>CrossCheck</strong>
    </div>
  );
}
