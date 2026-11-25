# CrossCheck

[Open the live prototype on Render](https://crosscheck-5269.onrender.com/)

CrossCheck is a group chat for student team projects that helps a team share ideas and leave each meeting with the same understanding of what they decided. Next to the team chat, every member has a private **Personal Agent**, and a **Moderator** agent follows the meeting. Private thoughts stay private until the member chooses to share them, and every decision is confirmed by each member, privately, before it is recorded.

Built with React 19 + Vite (web), Node 20 + TypeScript (server and agents), and OpenRouter (models). The live prototype runs on Render's free plan, so its data resets when the service restarts.

## Features

| Feature | What the member sees |
|---|---|
| **Groups and meetings** | Create a group, share the invitation code, schedule meetings. Each group has one ongoing team chat and a decision log per meeting. |
| **Task 1 · Think privately** | A private chat with your Personal Agent. It answers in your language, and can offer a *Draft for the team* (in the team's language) or a *Concern* you can raise with your name or anonymously. |
| **Task 2 · Missing angles** | When the chat goes quiet, or anyone presses **◆ → Ask about an angle**, the Moderator asks every Personal Agent whether its member already has an idea the team has not heard. Matching members get a private card with an editable draft. |
| **Task 3 · Agreement check** | When the team settles on something, the Moderator asks everyone, privately, about the part people might read differently. It reports only a count ("Agreement 2/3"), never who answered what. A change in the chat opens a new version; a request to change pauses the check. |
| **Agents' table** | After a split check, the agents look for a compromise: each agent gives its member's reason to the Moderator alone, then the agents answer the Moderator's compromise without names. Anything drawn from private notes waits for the member's approval. An accepted compromise goes back to the team as a new check. |
| **Decision log** | Only decisions everyone agreed to are saved, per meeting, and shown on the group home. Members can fix the wording later; the agreed original is kept. |

## Agents

| | Moderator (one per meeting) | Personal Agent (one per member) | Critic (optional) |
|---|---|---|---|
| Reads | The team chat only | The team chat and its own member's private window | The team chat only |
| Does | Detects decisions, runs agreement checks, finds missing angles, runs the agents' table | Replies privately, suggests drafts and concerns, answers checks and the table for its member | Reviews a check question before it opens, and the follow-up after a split |
| Never | Reads private chats or names who said what | Posts in the team chat; only the member can share | Posts anything itself |
| Default model | `openai/gpt-6-luna` | `openai/gpt-6-luna` | `anthropic/claude-opus-5.5` |

The privacy boundary is enforced in code, not only in prompts: the Moderator's inputs are built from the team chat alone, and only short labels cross from a Personal Agent to the Moderator. Design notes: [docs/agents-design.md](docs/agents-design.md), [docs/design-direction.md](docs/design-direction.md).

## Code map

The browser app starts in [src/main.tsx](src/main.tsx), which renders [App](src/App.tsx). The backend starts in [server/index.ts](server/index.ts). The Moderator and Personal Agent are implemented in [agents/moderator.ts](agents/moderator.ts) and [agents/personal.ts](agents/personal.ts), respectively. [agents/meeting.ts](agents/meeting.ts) coordinates when each agent runs and what context it receives.

| Entry point | Role |
|---|---|
| `src/main.tsx` → `src/App.tsx` | Web app: mounts React and routes between login, home, group and meeting room |
| `server/index.ts` | HTTP server: every `/api/*` route, file uploads, and the built web app from `dist/` |
| `agents/meeting.ts` | The agent engine: one `Meeting` per room decides when each agent runs and what crosses the privacy boundary |
| `agents/moderator.ts`, `agents/personal.ts` | One function per agent task; each calls one prompt in `prompts/` |

```
src/        Web app (React)
server/     API, accounts, storage, meeting rooms
agents/     Agent engine and model calls
prompts/    One Markdown prompt per agent task (moderator/, personal/)
tests/      Unit, flow and API tests, prompt fixtures, simulator
docs/       Design notes
```

### Where each feature lives

| Feature | Web app (`src/`) | Server (`server/`) | Agents (`agents/`, `prompts/`) |
|---|---|---|---|
| Login and accounts | `Login.tsx`, `api.tsx` | `auth.ts` (scrypt hashes, bearer sessions) | — |
| Groups, invitation codes, meetings, decision logs | `Home.tsx`, `Start.tsx`, `Group.tsx` | `groups.ts`, `store.ts` (one JSON file) | — |
| Meeting room layout and team chat | `Room.tsx`, `chatParts.tsx`, `useRoom.ts` (polls every 1.5 s) | `rooms.ts` (one room per meeting, all room actions) | `meeting.ts` |
| Task 1 · private chat, drafts, concerns | `PrivateWindow.tsx` | `rooms.ts` → `private`, `share`, `concern` | `personal.ts` · `prompts/personal/chat.md`, `react.md` |
| Task 2 · missing angles | `Meetings.tsx` (◆ Moderator menu) | `rooms.ts` → `angle` | `moderator.ts`, `topics.ts` · `find_missing_angle.md`, `angle_reply.md`, `topic_labels.md` |
| Task 3 · agreement checks | `Meetings.tsx` (`AgreementBox`), `PrivateWindow.tsx` (check card) | `rooms.ts` → `check/*`, `reopen` | `meeting.ts`, `moderator.ts` · `detect_decision.md`, `compare_understanding.md`, `suggest_check_answer.md` |
| Critic | — | — | `critic.ts` · `critic_check.md`, `critic_compare.md` |
| Agents' table | `AgentsTable.tsx`, `agents-table.css` | `rooms.ts` → `table/start`, `table/speak` | `table.ts`, `membrane.ts` (private-text check) · `propose_bridge.md`, `table_*.md` |
| Files and pictures | `chatParts.tsx` (attach, drop) | `files.ts` | Only file names reach the agents |
| Model calls | — | — | `llm.ts` (OpenRouter, JSON output, models from env) |
| Shared types | `model.ts` | — | `protocol.ts`, `table-protocol.ts` |
| Timing and limits | — | — | `rules.ts` (silence 60 s, check timeout 3 min, …) |

### How a team message flows

1. `Room.tsx` sends `POST /api/rooms/:room/group`.
2. `server/rooms.ts` finds the member's room and calls `Meeting.postGroupMessage()` in `agents/meeting.ts`.
3. The Moderator (`moderator.detectDecision`) checks whether the message settles a decision, and each other member's Personal Agent (`personal.react`) checks whether it connects to something its member said privately.
4. A decision opens a check: the critic may review the question (`critic.ts`), and each member gets a private check card with their agent's suggested reading.
5. Every member's browser polls `GET /api/rooms/:room/view`, which returns only that member's view: the team chat, their own private window and the check status.

## Run locally

Node 20 or newer.

```bash
npm ci
cp .env.example .env   # set OPENROUTER_API_KEY
npm run dev            # API on :8787, web app with hot reload on :5173
```

Open http://localhost:5173, create an account and a group, and share the invitation code. Use a second browser or a private window for a teammate. Without `OPENROUTER_API_KEY`, everything except the agents works.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Required for the agents |
| `LLM_MODEL` | `openai/gpt-6-luna` | Moderator model |
| `PERSONAL_LLM_MODEL` | `openai/gpt-6-luna` | Personal Agent model (must support strict JSON schema) |
| `CRITIC_LLM_MODEL` | `anthropic/claude-opus-5.5` | Critic model |
| `CRITIC_MODE` | `risk` | `risk` (only when code checks find a problem), `always`, or `off` |
| `DATA_DIR` | `./data` | Where `crosscheck.json` and uploads are stored |
| `PORT` | `8787` | Server port |

`GET /api/health` reports the models in use.

## Deploy

The server serves both the API and the built web app, so one process is enough.

```bash
npm ci && npm run build
OPENROUTER_API_KEY=... DATA_DIR=/var/lib/crosscheck npm start
```

- **Docker:** `docker build -t crosscheck .` then `docker run -p 8787:8787 -e OPENROUTER_API_KEY=... -v crosscheck-data:/data crosscheck`
- **Render:** New → Blueprint, pick this repository (`render.yaml`), enter `OPENROUTER_API_KEY`. Environment values set in the Render dashboard override the code defaults. The free plan has no persistent disk.

## Testing

| Command | What it does |
|---|---|
| `npm test` | Unit, meeting-flow and API tests with offline fixture models |
| `npm run typecheck` | Web app and server types |
| `npm run test:moderator` / `npm run test:personal` | Prompt fixtures against the real model (needs the key) |
| `npm run test:prompts -- --dry-run --only <id>` | Print exactly what the model receives |
| `npm run simulate -- <scenario.json>` | Play a whole meeting in the terminal, ending with a privacy check |

## Limits

- Meeting rooms live in one server process. After a restart, the team chat, schedule and decisions come back from `DATA_DIR`, but private windows and open checks start over.
- Data is one JSON file, which suits a class project; use a database for more users.
- Language handling distinguishes Korean and English only.
