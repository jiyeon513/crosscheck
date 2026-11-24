# Design summary

## Problem

In a text-chat meeting, a team says "OK, let's do that" and everyone leaves. Later they find out they pictured different things. Members who are unsure often stay silent, because asking would break the flow.

From our survey (15 people; check the numbers against the survey sheet before using them in the report):

- 15 of 15 have misunderstood a meeting decision.
- 10 found out only after they started working.
- 8 did not ask because they did not want to break the flow.
- A private assistant during the meeting was rated 4.27 / 5.

## Target situation

An ideation meeting in text chat. Opinions spread out first. Then the team has to agree and leave on the same page. There is no separate preparation step. The personal agent is an everyday private assistant inside the meeting.

## Core tasks

| | Task | What the user does | Who helps |
|---|---|---|---|
| T1 | Make up ideas with my personal agent | Thinks out loud in a private chat. Asks what the group is talking about. | Personal agent |
| T2 | Share my idea in the group | Gets a nudge and a draft when the group misses an angle the user already thought about. Presses Share, edits, or ignores it. | Moderator finds the angle. Personal agent writes the draft. |
| T3 | Reach final agreement | Answers a private check about a decision. Can pin down a concern with the agent and raise it with or without a name. | Moderator opens the check and compares. Personal agent helps with the concern. |

## Agents

| | Personal agent | Moderator |
|---|---|---|
| How many | One per member | One per meeting |
| Input | Group chat + its own user's private chat | Group chat + labels from the personal agents |
| Output | Replies and cards in its own user's private window. A label for the moderator. | Requests to the personal agents. Short group messages. |
| Never | Posts in the group chat | Reads private chat, names a member |

A label is a short, neutral phrase, for example "campus crowding" or "Library and cafeteria only". Labels are the only thing that crosses from the private side to the moderator.

## When each agent runs

| Trigger | Who runs | What happens |
|---|---|---|
| User writes in the private chat | That user's agent | Replies. May offer a draft for the group, or a concern card. |
| Teammate posts in the group chat (ideation) | Agents of the other members who have private notes | If the post connects to the user's notes, suggest a reply draft. At most one unprompted suggestion per 30 s per user. |
| Any new group message | Moderator | Is this a decision? If yes, open an agreement check. |
| Group chat silent for 60 s (ideation, at least 2 messages, at most 2 times per meeting) | Moderator, then the personal agents | Moderator names a missing angle. Each agent checks its own user's notes and may suggest a draft. If nobody has a view, the moderator asks the group directly. |
| Agreement check opens | Each personal agent | Privately checks the current version against the member’s words. A suggested interpretation is advisory. The member chooses an answer and separately decides whether to approve. |
| All members answered (or 3 minutes passed with 2+ answers) | Moderator | Compares the shuffled, nameless answers. Matching interpretations and unanimous explicit approval on the same version record the decision. Different: "Agreement 2/4" and one anonymous question. |
| User raises a concern anonymously | Moderator | The server publishes the exact edited text with anonymous attribution. |
| User presses Tell the Moderator only on a concern | Moderator | The team sees only the concern's short label, never the text or the name. The text joins the open check (or the next one) and is used, in neutral words, when the answers are compared. |
| Any member asks everyone privately (back room) | Every personal agent, then the Moderator | Each agent pre-fills its own member's answer from what they said (private chat, own posts, saved notes). The member edits and sends it, or skips. The Moderator combines the nameless answers and posts only the result. If nothing fits everyone, it asks one follow-up privately; if something fits, it opens an agreement check on it. |
| A member has not posted while teammates posted 5 messages | That member's agent | One private nudge, only if something the member said privately fits the current discussion. Nothing is posted about who is quiet. |
| The agent notices a lasting fact in the private chat | That member's agent | Offers to remember it. Saved only if the member presses Remember; the member can see, add and forget notes. Notes carry over to the group's next meetings and only that member's agent reads them. |

The Moderator keeps one meeting state, the board: each topic with its versions, the open question, the readings found after a split (no names, no counts, own-words answers never verbatim), and the private questions with their results. The phase (explore, converge, confirm) is derived from it and shown in the team chat header.

After a mismatch, members can keep talking privately or publicly. The host can edit the proposal, which opens a new version and clears approvals. This repeats until everyone agrees.

All numbers are in `agents/rules.ts`.

## Privacy boundary

The boundary is enforced by code, not by prompts.

- The moderator functions receive only the group chat and labels. Private text is never passed in.
- A personal agent receives only its own user's private chat.
- Answers are shuffled and sent without names before the moderator compares them.
- Private content reaches the group only when the user presses Share or Raise. A private answer or a concern told to the Moderator only reaches the Moderator, without a name; the team sees only the combined result or the concern's label.
- Saved notes are passed only to their owner's agent, and `findPrivacyLeaks()` treats them like private chat.
- `findPrivacyLeaks()` in `agents/meeting.ts` checks every model call in a meeting. `npm run simulate` runs it at the end.

## Demo scenario

`tests/scenarios/project_topic.json`. Four students pick a team project topic.

1. **T1.** Jiwoo privately develops a "crowding prediction" idea but is not sure about it. Taeho privately notes that Wi-Fi access counts are public.
2. Minsu and Seoyeon post two ideas, both about connecting people. Jiwoo and Taeho stay quiet.
3. **T2.** The chat is silent for a minute. The moderator asks about "using real campus data". Jiwoo's agent suggests sharing her idea. She shares. Taeho's agent sees the connection to his Wi-Fi note. He shares.
4. **T3.** Minsu: "Let's go with crowding prediction then." The moderator opens a private check about scope.
5. Seoyeon feels uneasy. Her agent helps her pin it down: the whole campus is too big. She raises it anonymously.
6. Answers split 2 / 2. The moderator posts "Agreement 2/4", one anonymous question, and the concern.
7. The team narrows the scope. Second check: "Agreed 4/4".

## Open questions

- Is 60 s of silence the right trigger, or should the host be able to ask for an angle?
- Should the personal agent react to every teammate message, or only when asked? (cost and noise)
- What does the user see while the check is open: only "2 of 4 answered", or nothing?
- Does the moderator show the count "2/4" when answers differ? It might pressure the minority.
