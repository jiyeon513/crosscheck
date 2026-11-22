// Stream Chat on the server: users, channels, and the persistent copy of each group chat.
// Optional at runtime: without keys the meeting rooms still work, they just are not persisted.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { StreamClient } from "@stream-io/node-sdk";

let client: StreamClient | undefined;

export function loadEnv(): void {
  try {
    const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key) process.env[key] = value;
    }
  } catch {
    // .env is optional.
  }
}

export function streamConfigured(): boolean {
  loadEnv();
  return Boolean(process.env.STREAM_API_KEY && process.env.STREAM_API_SECRET);
}

export function getStream(): StreamClient {
  loadEnv();
  const apiKey = process.env.STREAM_API_KEY ?? "";
  const apiSecret = process.env.STREAM_API_SECRET ?? "";
  if (!apiKey || !apiSecret) {
    throw new Error(
      ".env 에 STREAM_API_KEY 와 STREAM_API_SECRET 을 넣어 주세요. .env.example 을 복사하면 됩니다.",
    );
  }
  if (!client || client.apiKey !== apiKey) client = new StreamClient(apiKey, apiSecret);
  return client;
}

export function userIdFromName(name: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) return name;
  return `u_${createHash("sha256").update(name).digest("hex").slice(0, 20)}`;
}

export function channelIdFromCode(code: unknown): string {
  return String(code ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
}

export function channelTitle(state: { channel?: { custom?: Record<string, unknown> } }): string {
  const name = state?.channel?.custom?.name;
  return typeof name === "string" ? name.trim() : "";
}

/** Bot accounts the server posts as. */
export const BOTS = {
  moderator: { id: "crosscheck-moderator", name: "Moderator" },
  anonymous: { id: "crosscheck-anonymous", name: "Anonymous" },
} as const;

export type HistoryLine = { author: string; text: string; at: number; kind: "user" | "moderator" };

/** Recent group chat from Stream (team messages only, no schedule or decision records). */
export async function readHistory(code: string, limit = 60): Promise<HistoryLine[]> {
  if (!streamConfigured()) return [];
  const channel = getStream().chat.channel("messaging", code);
  const state = await channel.getOrCreate({ messages: { limit } });
  return (state.messages ?? [])
    .filter((message) => {
      const kind = message.custom?.kind;
      return message.text?.trim() && kind !== "decision" && kind !== "meeting";
    })
    .map((message) => ({
      author: message.user?.name || message.user?.id || "Someone",
      text: message.text!.trim(),
      at: new Date(message.created_at).getTime(),
      kind: message.user?.id === BOTS.moderator.id ? ("moderator" as const) : ("user" as const),
    }));
}
