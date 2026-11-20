# Agents

두 에이전트는 서버(`server.mjs`)에서 OpenRouter 로 호출합니다. API 키는 브라우저로 가지 않습니다.

| | 보는 것 | 말하는 곳 | 엔드포인트 |
|---|---|---|---|
| **Moderator** | 팀 채팅만 (서버가 Stream 채널에서 직접 읽음) | 팀 채팅 (`Moderator` 참가자로 게시) | `POST /api/agent/moderator` |
| **Personal agent** | 팀 채팅 + 본인 개인 채팅 | 본인 개인 채팅만 | `POST /api/agent/personal` |

## 파일

- `prompts/moderator.md`, `prompts/personal.md` — **시스템 프롬프트 (여기에 instruction 작성)**. 요청마다 다시 읽으므로 서버 재시작 없이 반영됩니다. `<!-- -->` 주석은 모델에 전달되지 않습니다.
- `moderator.mjs` — 모더레이터 입력 구성, `shouldModeratorSpeak()` 발언 정책, 모델 파라미터.
- `personal.mjs` — 개인 에이전트 입력 구성(팀 채팅은 시스템 프롬프트에, 개인 채팅은 대화 턴으로), 모델 파라미터.
- `context.mjs` — 프롬프트 로딩, 채팅 기록 포맷 등 공통 함수.
- `openrouter.mjs` — OpenRouter API 호출.

## 설정

`.env.example` 을 `.env` 로 복사한 뒤 `OPENROUTER_API_KEY` 와 (선택) 에이전트별 모델을 채우세요.

## 모더레이터가 말하는 시점

팀 메시지가 올라올 때마다 서버가 `moderator.mjs` 의 `shouldModeratorSpeak({ team })` 를 호출하고,
`true` 면 모더레이터가 답합니다. 기본값은 "사람이 보낸 메시지마다 답하기"이고, `false` 를 반환하면 조용히 있습니다.
