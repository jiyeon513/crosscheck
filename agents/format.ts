// Small helpers that turn state into prompt text and clean up model output.

import type { ChatLine, PrivateTurn } from "./protocol";

export function formatChat(lines: ChatLine[], limit = 60): string {
  const recent = lines.slice(-limit);
  if (recent.length === 0) return "(empty)";
  return recent.map((l) => `[${l.kind === "moderator" ? "Moderator" : l.author}] ${l.text}`).join("\n");
}

export function formatPrivate(turns: PrivateTurn[], userName: string, limit = 30): string {
  const recent = turns.slice(-limit);
  if (recent.length === 0) return "(empty)";
  return recent.map((t) => `[${t.role === "user" ? userName : "You"}] ${t.text}`).join("\n");
}

export function formatList(items: string[]): string {
  return items.length ? items.map((x, i) => `${i + 1}. ${x}`).join("\n") : "(none)";
}

export const str = (x: unknown): string => (typeof x === "string" ? x.trim() : x == null ? "" : String(x).trim());

export const strList = (x: unknown): string[] => (Array.isArray(x) ? x.map(str).filter(Boolean) : []);

export const norm = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();

export const isUnsure = (s: string): boolean => /not sure|unsure|don'?t know|no preference|잘 모르|모르겠/i.test(s);
