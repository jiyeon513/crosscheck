// Shared helpers for turning app state into model input.
import { readFileSync } from "node:fs";

/**
 * Reads agents/prompts/<name>.md on every call, so prompt edits apply without a restart.
 * `<!-- notes -->` are stripped, and `{{key}}` placeholders are filled from `vars`
 * (unknown keys become empty strings).
 */
export function loadPrompt(name, vars = {}) {
  const raw = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(vars[key] ?? ""))
    .trim();
}

/** "Tue, Nov 10, 2:06 PM" in the server's local time. */
export function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Team chat as plain text, one line per message.
 * @param {Array<{ author: string, text: string, createdAt?: string, quote?: { author: string, text: string } }>} messages
 */
export function formatTeamTranscript(messages, { selfName } = {}) {
  if (!messages.length) return "(no messages yet)";
  return messages
    .map((message) => {
      const who =
        selfName && message.author === selfName ? `${message.author} (you)` : message.author;
      const when = message.createdAt ? `[${formatTime(message.createdAt)}] ` : "";
      const quote = message.quote?.text
        ? ` (sharing ${message.quote.author}: "${oneLine(message.quote.text)}")`
        : "";
      return `${when}${who}: ${message.text}${quote}`;
    })
    .join("\n");
}

/** Meeting line for prompts, or a note that none is scheduled. */
export function describeMeeting(meeting) {
  if (!meeting?.title) return "No meeting is scheduled right now.";
  const when = meeting.startsAt ? ` (${formatTime(meeting.startsAt)})` : "";
  return `${meeting.title}${when}`;
}

/** Keep at most the newest `limit` items so long chats don't blow the context window. */
export function lastN(items, limit) {
  return items.length > limit ? items.slice(items.length - limit) : items;
}

function oneLine(text) {
  const line = String(text).replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
