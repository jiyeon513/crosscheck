// Personal agent
// - Sees: the team chat AND this person's private chat with the agent.
// - Speaks: only in the private chat; it never posts to the team chat.

import { complete } from "./openrouter.mjs";
import { describeMeeting, formatTeamTranscript, lastN, loadPrompt } from "./context.mjs";

/** How many recent messages of each chat the agent reads. */
const TEAM_LIMIT = 80;
const PERSONAL_LIMIT = 40;

/**
 * @param {{
 *   owner: string,
 *   groupTitle: string,
 *   meeting: { title: string, startsAt: string } | null,
 *   team: Array<{ author: string, text: string, createdAt?: string, quote?: { author: string, text: string } }>,
 *   personal: Array<{ from: "user" | "agent", text: string, quote?: { author: string, text: string } }>,
 * }} context
 */
export function buildPersonalMessages({ owner, groupTitle, meeting, team, personal }) {
  const system = loadPrompt("personal", {
    owner,
    groupTitle,
    meeting: describeMeeting(meeting),
    teamTranscript: formatTeamTranscript(lastN(team, TEAM_LIMIT), { selfName: owner }),
  });

  // The private chat becomes the conversation turns.
  const turns = mergeSameRole(
    lastN(personal, PERSONAL_LIMIT)
      .map((message) => ({
        role: message.from === "agent" ? "assistant" : "user",
        content: withQuote(message),
      }))
      .filter((turn) => turn.content),
  );

  // Many models require the first turn after the system prompt to be the user's,
  // so notes the agent left before the person spoke go into the system prompt.
  const opening = [];
  while (turns[0]?.role === "assistant") opening.push(turns.shift().content);
  const fullSystem = opening.length
    ? `${system}\n\nYou already told ${owner} earlier:\n${opening.join("\n")}`
    : system;

  return [{ role: "system", content: fullSystem }, ...turns];
}

/** Joins back-to-back turns from the same side (e.g. after a failed reply). */
function mergeSameRole(turns) {
  const merged = [];
  for (const turn of turns) {
    const last = merged.at(-1);
    if (last && last.role === turn.role) last.content = `${last.content}\n\n${turn.content}`;
    else merged.push({ ...turn });
  }
  return merged;
}

/** Returns the agent's reply for the private chat. */
export async function runPersonal(context) {
  return complete({
    model: process.env.OPENROUTER_PERSONAL_MODEL,
    messages: buildPersonalMessages(context),
    temperature: 0.5,
    maxTokens: 600,
  });
}

function withQuote(message) {
  const text = String(message.text ?? "").trim();
  if (!message.quote?.text) return text;
  const shared = `[Shared from the team chat, ${message.quote.author}: "${message.quote.text}"]`;
  return text ? `${shared}\n${text}` : shared;
}
