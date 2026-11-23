// Timing and limit rules. These are enforced by code (agents/meeting.ts), not by prompts.
// Change the numbers here, not inside the prompts.

export type Rules = {
  /** Ideation: the moderator looks for a missing angle after the group chat is silent this long. */
  silenceMs: number;
  /** ...and only if at least this many user messages exist. */
  minIdeasBeforeAngle: number;
  /** ...and at most this many angle questions per meeting. */
  maxAngleQueries: number;
  /** A personal agent waits this long before it makes another unprompted suggestion to the same user. */
  suggestionCooldownMs: number;
  /** An agreement check is compared with the answers so far after this long (needs 2+ answers). */
  checkTimeoutMs: number;
  /** How many recent group messages the agents read. */
  groupContextMessages: number;
  /** How many recent private turns a personal agent reads. */
  privateContextTurns: number;
  /** A new decision replaces the open check only while fewer than this share of members have answered it. */
  supersedeBelowAnswered: number;
  /**
   * While brainstorming, unprompted suggestion cards wait until the Moderator has looked for a missing
   * angle once, so the angle comes first. They start anyway after this many team posts.
   */
  reactWithoutAngleAfter: number;
};

export const DEFAULT_RULES: Rules = {
  silenceMs: 60_000,
  minIdeasBeforeAngle: 2,
  maxAngleQueries: 2,
  suggestionCooldownMs: 30_000,
  checkTimeoutMs: 180_000,
  groupContextMessages: 60,
  privateContextTurns: 30,
  supersedeBelowAnswered: 0.5,
  reactWithoutAngleAfter: 6,
};
