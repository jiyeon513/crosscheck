// Deterministic fixtures for the agents' table (tests/mocks.ts hands these two prompts here).
// A first bridge keeps one reading, so the other agents counter; the second covers every reading, so all accept.

import { isUnsure } from "../agents/format";
import type { PrivateTurn } from "../agents/protocol";
import type { ProposeBridgeInput } from "../agents/table";

export function tableFixture(prompt: string, context: object): unknown {
  if (prompt === "moderator/propose_bridge") {
    const input = context as ProposeBridgeInput;
    const readings = [...new Set(input.table.flatMap((l) => (l.from !== "Moderator" && l.reading ? [l.reading] : [])))];
    const countered = input.table.some((l) => l.act === "counter");
    if (!readings.length) return { action: "none", bridge: "", message: "", reason: "mock: no readings to bridge" };
    return countered
      ? { action: "bridge", bridge: `${input.decision}: ${readings.join(", and ")}`, message: "This adds what was asked for.", reason: "mock: every reading" }
      : { action: "bridge", bridge: `${input.decision}: ${readings[0]}`, message: "This keeps one reading.", reason: "mock: first reading" };
  }
  const input = context as { privateHistory: PrivateTurn[]; own_answer: string | null; allowed_acts: string[]; bridge: string | null };
  const note = input.privateHistory.filter((t) => t.role === "user").at(-1);
  const own = input.own_answer ?? "";
  if (input.allowed_acts.includes("justify")) {
    if (!own || isUnsure(own)) return { act: "inform", text: "My member has not said why yet.", condition: null, evidence: [] };
    // Drawing on a private note: the member approves it first.
    if (note) return { act: "justify", text: `My member reads it as “${own}”: ${note.text}`, condition: null, evidence: [{ id: note.id, quote: note.text }] };
    return { act: "justify", text: `My member reads it as “${own}”, going by the team chat.`, condition: null, evidence: [] };
  }
  const bridge = (input.bridge ?? "").toLowerCase();
  const keys = own.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  if (!own || isUnsure(own) || keys.some((w) => bridge.includes(w))) {
    return { act: "accept", text: "This covers what my member said.", condition: null, evidence: [] };
  }
  return { act: "counter", text: "My member needs their reading covered too.", condition: `if it also covers “${own}”`, evidence: [] };
}
