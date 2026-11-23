// Calls to the CrossCheck server (server/index.ts). Every call after login carries the session token.
import type { UserView } from "../agents/protocol";
import type { Decision, Group, GroupDetail, GroupSummary, Meeting } from "./model";

export type RoomView = UserView & { meetingId: string; log: Decision[] };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = "crosscheck.session";
let signedOut: () => void = () => {};

// A tab keeps its own login. localStorage is shared by every window on this
// browser, so a second login used to replace the first and both windows then
// loaded the same personal-agent thread.
export function getToken() {
  try {
    const own = sessionStorage.getItem(TOKEN_KEY);
    if (own) return own;
    const shared = localStorage.getItem(TOKEN_KEY);
    if (!shared) return "";
    sessionStorage.setItem(TOKEN_KEY, shared);
    localStorage.removeItem(TOKEN_KEY);
    return shared;
  } catch {
    return "";
  }
}

function setToken(token: string) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Without storage the session lasts until the page closes.
  }
}

/** Called when the server says the session is no longer valid. */
export function onSignedOut(callback: () => void) {
  signedOut = callback;
}

async function request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.status === 401 && token) {
    setToken("");
    signedOut();
  }
  if (!response.ok) throw new ApiError(response.status, data.error || `Request failed (${response.status}).`);
  return data;
}

type Session = { name: string; token: string };

export const api = {
  async signUp(name: string, password: string) {
    const session = await request<Session>("POST", "/api/auth/signup", { name, password });
    setToken(session.token);
    return session.name;
  },
  async logIn(name: string, password: string) {
    const session = await request<Session>("POST", "/api/auth/login", { name, password });
    setToken(session.token);
    return session.name;
  },
  async logOut() {
    await request("POST", "/api/auth/logout").catch(() => undefined);
    setToken("");
  },
  me: () => request<{ name: string }>("GET", "/api/me"),
  groups: () => request<GroupSummary[]>("GET", "/api/groups"),
  createGroup: (title: string) => request<Group>("POST", "/api/groups", { title }),
  joinGroup: (code: string) => request<Group>("POST", "/api/groups/join", { code }),
  group: (code: string) => request<GroupDetail>("GET", `/api/groups/${code}`),
  scheduleMeeting: (code: string, title: string, startsAt: string) =>
    request<Meeting>("POST", `/api/groups/${code}/meetings`, { title, startsAt }),
  editDecision: (code: string, id: string, text: string) =>
    request<Decision>("PATCH", `/api/groups/${code}/decisions/${id}`, { text }),
  joinRoom: (code: string, meetingId: string | null) =>
    request<{ roomKey: string }>("POST", "/api/rooms/join", { code, meetingId }),
  roomView: (roomKey: string) => request<RoomView>("GET", `/api/rooms/${roomKey}/view`),
  roomAction: (roomKey: string, action: string, body: object) =>
    request<{ ok: true }>("POST", `/api/rooms/${roomKey}/${action}`, body),
};

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
