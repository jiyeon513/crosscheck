# CrossCheck

A group chat for student team projects. Each group keeps one ongoing team chat, a schedule of meetings, and a decision log per meeting. Inside a meeting, two kinds of agents help the team share ideas and leave with the same understanding:

| | Moderator (one per meeting) | Personal Agent (one per member) |
|---|---|---|
| Reads | The team chat, plus short labels from the personal agents | The team chat and its own member's private window |
| Writes | Short messages in the team chat | Replies and cards in its own member's private window |
| Never | Reads private chats or names who said what | Posts in the team chat. Only the member can share. |

Design direction: [docs/design-direction.md](docs/design-direction.md). Agent design and privacy boundary: [docs/agents-design.md](docs/agents-design.md).

## Quick start

Node 20 or newer.

```bash
npm ci
cp .env.example .env   # fill in OPENROUTER_API_KEY, and the Stream keys if you have them
npm run dev            # API on :8787 and the web app on :5173
```

- **OpenRouter** runs the agents. Without a key the room still opens, and a banner says the agents are off.
- **Stream** creates and joins groups and keeps the team chat after a server restart. Without it, an existing group's meeting room still works in memory.

## How the pieces fit

```
Browser (src/)                         Server (server/)                    Agents (agents/, prompts/)
 Room.tsx ── polls /api/rooms/:key/view ─► rooms.ts: one room per ────────► meeting.ts decides WHEN each
 PrivateWindow.tsx ── POST actions ──────►  group meeting, sessions          agent runs and WHAT crosses
 Group page, schedule, decision logs        and Stream copy                  the privacy boundary
                                                │                            moderator.ts / personal.ts
                                                └─► Stream (chat + decisions)  call the prompts via llm.ts
```

- A room is the group's **current meeting** (today's, else the next one). It starts from the recent team chat, so the agents keep the context of earlier meetings.
- When everyone agrees on a decision, it is recorded in that meeting's decision log. The group page lists the logs of every past meeting.
- Room endpoints: `POST /api/rooms/join`, then `GET view` and `POST group | private | share | concern | dismiss | check/answer | check/revise | check/compare | check/start` under `/api/rooms/:key/`. The session token goes in the `X-CrossCheck-Session` header. See `server/index.ts`.

### What happens in a meeting

| When | Who | What |
|---|---|---|
| A member writes in their private window | Their agent | Replies. It may offer a draft to share or a concern card. |
| A teammate posts in the team chat | The other members' agents | If the post connects to something the member said before, suggest a reply draft, privately. |
| Any new team message | Moderator | Is the team settling on a decision? If yes, every member gets a private agreement check. |
| Team chat quiet for 60 s while brainstorming | Moderator, then the agents | The moderator names a missing angle. Agents whose member has a related thought suggest sharing it. If nobody has one, the moderator asks the team. |
| Everyone answered the check | Moderator | Compares the answers without names. If all match and all approve: "Agreed n/n" and the decision is recorded. Otherwise: "Explicit approvals: n/m" and one anonymous question. The host can revise the proposal. |

Timing numbers live in `agents/rules.ts`.

## Working on the agents

Prompts are in `prompts/moderator/*.md` and `prompts/personal/*.md`. In moderator prompts, text above `=== INPUT ===` is the system prompt and text below is the input template. `<!-- comments -->` are not sent to the model.

| Command | What it does |
|---|---|
| `npm test` | Agent unit tests and the room API flow, offline |
| `npm run test:prompts -- --mock` | All prompt fixtures with offline models (checks the harness) |
| `npm run test:moderator` / `npm run test:personal` | Fixtures with the real model (needs the key) |
| `npm run test:prompts -- --dry-run --only <id>` | Print exactly what the model receives |
| `npm run simulate` | A whole meeting in the terminal; ends with a privacy check |
| `npm run typecheck` | Web app and server types |

## Shared with the agent repository

The agent engine comes from the team's agent repository (`naajeehxe/CS40703_Xmas`, commit `483b39a`). These files are copied unchanged, so updates can be copied over again:

- `agents/*.ts`, `prompts/**`
- `tests/fixtures/**`, `tests/scenarios/**`, `tests/mocks.ts`, `tests/run.ts`, `tests/simulate.ts`, `tests/personal-agent.test.ts`
- `docs/agents-design.md` (its `docs/design.md`)

Specific to this repository: `server/` (rooms on top of the engine, Stream), `tests/rooms-api.test.ts`, and the web app in `src/`.

## Limits

- Rooms live in the server's memory. After a restart the team chat comes back from Stream, but private windows and open agreement checks start over.
- The Personal Agent model is fixed to `openai/gpt-5-mini` in `agents/llm.ts`. The moderator model is `LLM_MODEL`.
- A name can be in a meeting from one browser at a time.
