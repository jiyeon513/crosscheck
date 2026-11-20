# Agents

모더레이터는 연결되어 있지 않습니다.

개인 에이전트는 템플릿만 있습니다. 지시문은 `prompts/personal.md`에 적고, 동작은 `personal.mjs`에 나중에 붙입니다. 지금은 화면의 개인 채팅이 그 메시지를 이 브라우저에만 저장합니다.

OpenRouter 키는 프로젝트 루트의 `.env`에 넣습니다.

```
OPENROUTER_API_KEY=
```

키를 읽는 코드는 `openrouter.mjs`에 있고, 아직 어디에서도 호출하지 않습니다.
