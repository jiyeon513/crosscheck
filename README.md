# CrossCheck

A group chat for student team projects. Each group keeps one ongoing team chat, a schedule of meetings, and a decision log per meeting. Inside a meeting, two kinds of agents help the team share ideas and leave with the same understanding:

| | Moderator (one per meeting) | Personal Agent (one per member) |
|---|---|---|
| Reads | The team chat, plus short labels from the personal agents | The team chat and its own member's private window |
| Writes | Short messages in the team chat, and the decision log once everyone agrees | Replies and cards in its own member's private window |
| Never | Reads private chats or names who said what | Posts in the team chat. Only the member can share. |

Design direction: [docs/design-direction.md](docs/design-direction.md). Agent design and privacy boundary: [docs/agents-design.md](docs/agents-design.md).

## Run it locally

Node 20 or newer.

```bash
npm ci
cp .env.example .env   # set OPENROUTER_API_KEY
npm run dev            # server on :8787, web app with hot reload on :5173
```

Open http://localhost:5173, create an account, create a group, and share the invitation code. Use a second browser (or a private window) to log in as a teammate. Without `OPENROUTER_API_KEY` everything works except the agents, and the room shows "Agents are off".

Data (accounts, groups, meetings, decisions, team chat) is saved in `data/crosscheck.json` (`DATA_DIR`). Passwords are stored as scrypt hashes.

## Deploy

The server serves both the API and the built web app, so one process is all it needs.

```bash
npm ci && npm run build
OPENROUTER_API_KEY=... DATA_DIR=/var/lib/crosscheck PORT=8787 npm start
```

Or with Docker: `docker build -t crosscheck .` then `docker run -p 8787:8787 -e OPENROUTER_API_KEY=... -v crosscheck-data:/data crosscheck`.

**Render** (`render.yaml`): in the Render dashboard choose New → Blueprint, pick this repository, and enter `OPENROUTER_API_KEY` when asked. The Blueprint uses the free plan, which has no persistent disk: accounts and chats are lost whenever the service restarts, sleeps after about 15 idle minutes, or redeploys. For lasting data, switch to a paid plan and uncomment the `disk` block.

Any host that runs a Docker image or a Node 20+ process with a writable folder works the same way (Railway, Fly.io, a VM).

## How the pieces fit

```
Browser (src/)                    Server (server/)                         Agents (agents/, prompts/)
 Login, groups, group page ─────► auth.ts, groups.ts, store.ts (JSON file)
 Room.tsx ── polls the view ────► rooms.ts: one room per group meeting ───► meeting.ts decides WHEN each agent
 PrivateWindow.tsx ─ actions ───►  (members only, starts from earlier chat)  runs and WHAT crosses the privacy
                                                                              boundary; moderator.ts / personal.ts
```

- A room is the group's **current meeting** (today's, else the next one). It starts from the group's recent chat, so the agents keep the context of earlier meetings.
- Only the Moderator adds to a decision log, after everyone agrees. Members can correct the wording later; the agreed original is kept. Dropping a message on the decision log proposes it, and the Moderator opens an agreement check.
- Room actions: `group`, `private`, `share`, `concern`, `dismiss`, `propose`, `angle`, `check/answer`, `check/start`, `check/compare` (host), `check/revise` (host), `check/cancel` (host). See `server/index.ts`.

### What happens in a meeting

| When | Who | What |
|---|---|---|
| A member writes in their private window | Their agent | Replies. It may offer a draft to share or a concern card. |
| A teammate posts in the team chat | The other members' agents | If the post connects to something the member said before, suggest a reply draft, privately. Paused while a check collects answers; at most one open suggestion per member. |
| Any new team message | Moderator | Is the team settling on a decision? If yes, everyone gets a private agreement check and the Moderator says so in the chat. A new decision replaces an open check that fewer than half have answered. |
| Team chat quiet for 60 s while brainstorming | Moderator, then the agents | The Moderator names a missing angle. Agents whose member has a related thought suggest sharing it. If nobody has one, the Moderator asks the team. Any member can also ask about an angle directly, or ask the Moderator to check agreement now. |
| Everyone answered | Moderator | Compares answers without names. Same reading from everyone: "Agreed n/n" and it goes into the decision log. Otherwise: "Agreement k/n", one anonymous question, and what to do next. The next decision stated in the chat opens a new version; the host can also revise it or close the check. |

Timing numbers live in `agents/rules.ts`.

## Working on the agents

Prompts are in `prompts/moderator/*.md` and `prompts/personal/*.md`. In moderator prompts, text above `=== INPUT ===` is the system prompt and text below is the input template. `<!-- comments -->` are not sent to the model.

| Command | What it does |
|---|---|
| `npm test` | Agent unit tests, the meeting flow, and the whole server API, offline |
| `npm run test:prompts -- --mock` | All prompt fixtures with offline models (checks the harness) |
| `npm run test:moderator` / `npm run test:personal` | Fixtures with the real model (needs the key) |
| `npm run test:prompts -- --dry-run --only <id>` | Print exactly what the model receives |
| `npm run simulate -- <scenario.json>` | A whole meeting in the terminal; ends with a privacy check |
| `npm run typecheck` | Web app and server types |

## Changes from the team's agent repository

The engine started as a copy of `naajeehxe/CS40703_Xmas` at `0b60de5` (also the source of `tests/scenarios/jeehye/` and `tests/eval_commitment.ts`). This repository changes it to fix problems found in the two-UI test report:

- `agents/personal.ts`: a reply with both a concern and a draft keeps the concern instead of failing (the cause of the 503s and lost messages); invalid output is retried once and the reason logged; an unsupported "agent's guess" is dropped instead of failing the card.
- `agents/meeting.ts`:
  - Detection also runs while a check is open, and a new decision replaces a check that fewer than half have answered (`rules.supersedeBelowAnswered`).
  - A mismatch closes the check with a next-step message. Agreement goes back to the idea stage, so the silence prompt works again.
  - A decision already agreed is not checked again.
  - Revisions and member proposals get a real question with several readings.
  - New `cancelCheck` and `proposeDecision`.
  - Private messages are kept when a new version opens.
  - Suggestion cards pause during checks, with at most one open per member.
  - Quoted replies reach the agents.
- `agents/llm.ts`: `PERSONAL_LLM_MODEL` sets the Personal Agent model.
- Prompts:
  - `detect_decision.md`: not decisions (tone, preference, volunteering), already agreed or open checks, the group's main language, options taken from the chat.
  - `chat.md`: product facts, short replies, "keep it in mind".
  - `react.md`: no cards that only reinforce a position.
- Tests: `tests/meeting-flow.test.ts` covers the changes above; two upstream assertions were updated to the new behaviour.

## Limits

- One server process holds the meeting rooms in memory. After a restart, the team chat, schedule and decisions come back from `data/`, but private windows and open agreement checks start over.
- Data is a single JSON file, which suits a class project; use a database for more users.
