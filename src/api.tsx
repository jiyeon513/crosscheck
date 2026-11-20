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

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

type MeetingRef = { title: string; startsAt: string } | null;
type QuoteRef = { author: string; text: string };

/** Personal agent: sees the team chat and your private chat, answers only you. */
export function askPersonalAgent(input: {
  name: string;
  groupTitle: string;
  meeting: MeetingRef;
  team: { author: string; text: string; createdAt: string; quote?: QuoteRef }[];
  personal: { from: "user" | "agent"; text: string; quote?: QuoteRef }[];
}) {
  return post<{ text: string }>("/api/agent/personal", input);
}

/**
 * Moderator: the server reads the team chat itself and posts the reply there,
 * so it arrives for everyone through the normal chat sync.
 */
export function askModerator(input: { code: string; meeting: MeetingRef }) {
  return post<{ text?: string; skipped?: boolean }>("/api/agent/moderator", input);
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
