// The check every agent message passes before it reaches the agents' table. Code, not a prompt:
// a message that draws on what the member said only in private waits for the member's approval.

export type MembraneInput = {
  /** Everything the message would say (text and condition). */
  text: string;
  /** What the agent cited for it (ids of the member's own turns and posts). */
  evidenceIds: string[];
  /** What the member said only in private: their turns with their agent, their memory, an own-words answer. */
  privateNotes: { id: string; text: string }[];
  /** Everything already public: the team chat and the table. */
  publicTexts: string[];
  /** Member names. A code name stops meaning anything once a name appears. */
  names: string[];
};

/** Runs of this many words in a row count as repeating a note. */
const RUN = 4;

/** Why the member must approve the message first, or null when it uses nothing private. */
export function approvalReason(input: MembraneInput): string | null {
  const publicRuns = new Set(input.publicTexts.flatMap((t) => runs(words(t))));
  const secret = input.privateNotes.filter((n) => words(n.text).length > 0 && !input.publicTexts.some((p) => p.includes(n.text.trim())));
  if (input.evidenceIds.some((id) => secret.some((n) => n.id === id))) return "It uses what you told me privately.";
  const said = words(input.text);
  const saidRuns = new Set(runs(said));
  for (const note of secret) {
    const w = words(note.text);
    // A short note is private as a whole phrase.
    if (w.length < RUN ? w.length >= 2 && contains(said, w) : runs(w).some((r) => saidRuns.has(r) && !publicRuns.has(r))) {
      return "It repeats words you wrote privately.";
    }
  }
  const lower = input.text.toLowerCase();
  if (input.names.some((name) => name.trim().length > 1 && lower.includes(name.trim().toLowerCase()))) {
    return "It mentions a name, so your code name would no longer hide who you are.";
  }
  return null;
}

function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function runs(w: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + RUN <= w.length; i++) out.push(w.slice(i, i + RUN).join(" "));
  return out;
}

function contains(haystack: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((word, j) => haystack[i + j] === word)) return true;
  }
  return false;
}
