// Deterministic fixtures for the agents' table (tests/mocks.ts hands these prompts here).
// The first wording keeps one reading; an agent whose reading is missing proposes a change; an agent whose owner said the
// wider scope is too big objects to it; the second wording covers every reading. A goal with "LEAKY" makes the Moderator
// repeat a private reason, which code must refuse.

import { isUnsure } from "../agents/format";
import type { PrivateTurn } from "../agents/protocol";
import type { ProposeBridgeInput } from "../agents/table";

type Owner = { privateHistory: PrivateTurn[]; own_answer: string | null };

const keys = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
const covers = (wording: string, own: string) => !own || isUnsure(own) || keys(own).some((w) => wording.toLowerCase().includes(w));
const notes = (input: Owner) => input.privateHistory.filter((t) => t.role === "user");

export function tableFixture(prompt: string, context: object): unknown {
  switch (prompt) {
    case "moderator/propose_bridge": {
      const input = context as ProposeBridgeInput;
      const readings = [...new Set(input.positions.map((p) => p.reading).filter(Boolean))];
      if (!readings.length) return { action: "none", bridge: "", message: "", reason: "mock: no readings" };
      if (input.goal.includes("REUSE")) {
        // A few words a member told the Moderator, in a wording of its own: allowed.
        const told = [...input.positions].sort((a, b) => b.text.length - a.text.length)[0]?.text.split(": ")[1] ?? "";
        const chunk = told.split(/\s+/).slice(2, 7).join(" ");
        return { action: "bridge", bridge: `${input.decision}: ${readings.join(", and ")}, since ${chunk}`, message: "mock", reason: "mock: reuses a few words" };
      }
      if (input.goal.includes("LEAKY")) {
        const reason = [...input.positions].sort((a, b) => b.text.length - a.text.length)[0]?.text ?? "";
        return { action: "bridge", bridge: `${input.decision}, because ${reason}`, message: "mock", reason: "mock: repeats a private reason" };
      }
      return input.rounds.length
        ? { action: "bridge", bridge: `${input.decision}: ${readings.join(", and ")}`, message: "This covers every reading.", reason: "mock" }
        : { action: "bridge", bridge: `${input.decision}: ${readings[0]}`, message: "This keeps one reading.", reason: "mock" };
    }
    case "personal/table_position": {
      const input = context as Owner;
      const own = input.own_answer ?? "";
      const note = notes(input).at(-1);
      if (!own || isUnsure(own)) return { act: "inform", text: "My member has not said why yet.", condition: null, evidence: [] };
      // Drawing on a private note: the member approves it first.
      if (note) return { act: "justify", text: `My member reads it as “${own}”: ${note.text}`, condition: null, evidence: [{ id: note.id, quote: note.text }] };
      return { act: "justify", text: `My member reads it as “${own}”, going by the team chat.`, condition: null, evidence: [] };
    }
    case "personal/table_respond": {
      const input = context as Owner & { wording: string };
      const own = input.own_answer ?? "";
      if (covers(input.wording, own)) return { act: "accept", wording: null, note: "It covers what you answered.", evidence: [] };
      return { act: "counter", wording: `${input.wording}, and ${own}`, note: "I asked to add your reading.", evidence: [] };
    }
    case "personal/table_react": {
      const input = context as Owner & { changes: { id: string; wording: string }[] };
      const own = input.own_answer ?? "";
      const tooBig = notes(input).some((n) => /too big|too much/i.test(n.text));
      return {
        reactions: input.changes.map((c) => ({
          id: c.id, act: (tooBig && /whole|every/i.test(c.wording)) || !covers(c.wording, own) ? "object" : "support",
        })),
        note: "I reacted to the other agents' changes.",
        evidence: [],
      };
    }
    default:
      throw new Error("Unregistered table prompt: " + prompt);
  }
}
