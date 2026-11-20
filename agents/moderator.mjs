// Moderator agent
// - Sees: the team chat only (never anyone's personal agent chat).
// - Speaks: in the team chat, as its own participant ("Moderator").
//
// The server reads the team chat straight from the Stream channel, so what the
// moderator sees is exactly what every member sees.

import { complete } from "./openrouter.mjs";
import { describeMeeting, formatTeamTranscript, lastN, loadPrompt } from "./context.mjs";

export const MODERATOR_USER = { id: "crosscheck-moderator", name: "Moderator" };

/** How many recent team messages the moderator reads. */
const HISTORY_LIMIT = 80;

/**
 * Called after every team message. Decide whether the moderator posts now.
 * TODO: replace with your own policy (e.g. every N messages, when the team
 * goes quiet, when a decision seems to be forming). Return false to keep it silent.
 *
 * @param {{ team: Array<{ author: string, text: string, createdAt?: string }> }} input
 *   the team chat, oldest first (the moderator's own posts have author "Moderator")
 */
export function shouldModeratorSpeak({ team }) {
  // Default: answer every message from a person, never its own post.
  const last = team.at(-1);
  return Boolean(last) && last.author !== MODERATOR_USER.name;
}

/**
 * @param {{
 *   groupTitle: string,
 *   meeting: { title: string, startsAt: string } | null,
 *   team: Array<{ author: string, text: string, createdAt?: string, quote?: { author: string, text: string } }>,
 * }} context
 */
export function buildModeratorMessages({ groupTitle, meeting, team }) {
  const system = loadPrompt("moderator", {
    agentName: MODERATOR_USER.name,
    groupTitle,
    meeting: describeMeeting(meeting),
  });
  const transcript = formatTeamTranscript(lastN(team, HISTORY_LIMIT), {
    selfName: MODERATOR_USER.name,
  });
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `Team chat so far:\n${transcript}\n\nWrite your next message to the team chat.`,
    },
  ];
}

/** Returns the text the moderator will post to the team chat. */
export async function runModerator(context) {
  return complete({
    model: process.env.OPENROUTER_MODERATOR_MODEL,
    messages: buildModeratorMessages(context),
    temperature: 0.4,
    maxTokens: 400,
  });
}
