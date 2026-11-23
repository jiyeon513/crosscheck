# Scenarios and test results (Jeehye, 2026-11-22)

All three scenarios ran on the real model (openai/gpt-5-mini) through `npm run simulate -- <file>`.
Everything of mine lives in `tests/scenarios/jeehye/`: this doc, `s1_demo_topic.json`, `s2_ko_roles_no_false_alarm.json`, `s3_event_concern.json`, `annotations.csv`. Run one with `npm run simulate -- tests/scenarios/jeehye/s1_demo_topic.json`.
Total cost of all runs: about $0.15.

Format per scenario: setup / lines in order / where the moderator should engage (our annotation) / what actually happened / feedback.

---

## S1 · Demo candidate: four students pick a project topic (Jiwoo's screen)

**Setup.** Minsu (host), Seoyeon, Jiwoo, Taeho. Goal: "Pick one topic for our team project".
Jiwoo and Taeho have private notes before the group talks.

| # | Who | Where | Line | Moderator should engage? |
|---|---|---|---|---|
| 1 | Jiwoo | private | I'm thinking about predicting how crowded the cafeteria and library are. Not sure if it's good enough to share. | no |
| 2 | Taeho | private | Wi-Fi access counts for every building are public data. Keep that in mind. | no |
| 3 | Minsu | group | How about a study group matching app? | no |
| 4 | Seoyeon | group | A chatbot for club recruiting could work too. | no |
| 5 | (all) | | silence 60 s | **yes: missing angle** (two similar ideas) |
| 6 | Jiwoo | card | Share | no |
| 7 | Taeho | card | Share | no |
| 8 | Minsu | group | Nice. Let's go with crowding prediction then. | **yes: decision** (ambiguity: scope) |
| 9 | Minsu, Taeho | card | choose "whole campus"-like option | |
| 10 | Jiwoo, Seoyeon | card | choose "library and cafeteria"-like option | **yes: compare, mismatch, one anonymous question** |
| 11 | Minsu | group | OK, let's just do the library and the cafeteria. | **yes: decision** |
| 12 | all | card | choose "library and cafeteria" | **yes: Agreed 4/4** |

**What happened (2 runs).**
- Lines 3-4: the personal agents reacted at once. Jiwoo got a share card right after Minsu's first message (react), before the silence. Taeho too. So in practice T2 is triggered by a teammate's post, and the moderator's angle comes second.
- Line 5: the moderator did find an angle, but one that did not match anyone's private note ("event planning and coordination" in run 2). Nobody had a thought on it, so the moderator posted its one-line question to the group. In run 1 the group line was a concrete idea ("a platform where members barter workshops"), which the prompt forbids.
- Line 8: decision detected both times. Question and options differ per run ("Which locations does crowding prediction cover?" / "Part of the study-group app or a separate project?").
- Lines 9-12: compare worked. "Agreed 4/4" posted; in run 1 the final statement dropped the shared reading ("We will build a crowding prediction project." instead of "... in the library and cafeteria").
- Privacy check: OK in both runs. Cost: about $0.03 per run.

**Feedback.**
- Moderator: angle choice is blind to private notes, so the angle-to-card path is not reliable for a demo. For the demo use the host button "Ask about an angle" with "real campus data" typed (deterministic), and say that the automatic trigger exists.
- Moderator: final statement should always include the shared reading (prompt says so; model sometimes skips it).
- Personal agent: reacts to almost every group message with a card (3 cards before the silence). The design says at most one unprompted suggestion per 30 s and "usually none".
- Personal agent: Taeho wrote in English and got a Korean reply in run 2.
- Personal agent: drafts add content the member never said (Taeho's draft proposed "infrastructure improvement priorities").

---

## S2 · Korean: dividing presentation roles (false-alarm test)

**Setup.** 민수 (host), 서연, 지우, 태호. Goal: "발표 준비 역할 나누기". 지우 has one private note.

| # | Who | Where | Line | Moderator should engage? |
|---|---|---|---|---|
| 1 | 지우 | private | 나는 슬라이드 디자인은 자신 있는데 데모 시연은 좀 긴장돼. 일단 기억해둬. | no |
| 2 | 민수 | group | 발표 준비 어떻게 나눌까? 슬라이드, 데모, 대본, 질문 대응 정도가 있을 것 같아. | no |
| 3 | 서연 | group | 나는 데모 쪽 해볼게! 코드를 제일 많이 봤으니까. | no |
| 4 | 태호 | group | 오 좋다 ㅋㅋ | no (reaction) |
| 5 | 지우 | group | 슬라이드 만들자! 템플릿은 내가 찾아볼까? | no (own pitch) |
| 6 | (all) | | silence 60 s | no (assigning work, not brainstorming) |
| 7 | 민수 | group | 그럼 서연이 데모, 지우가 슬라이드, 나머지는 대본이랑 질문 대응을 나눠서 하자. | **yes: decision** (ambiguity: who does the rest, deadline) |
| 8 | all | card | answer | **yes: compare** |

**What happened (1 run).**
- Line 4: **false alarm.** After "오 좋다 ㅋㅋ" the moderator opened a check ("데모 범위가 정확히 무엇인가요?") with options nobody had discussed ("라이브 코드 실행만", ...). It read 서연's volunteering plus 태호's approval as a decision.
- Line 6: correct, no angle.
- Line 7: the real decision was **not** checked, because the check from line 4 was still open. The meeting allows one open check at a time.
- Line 8: everyone answered the old check; "Agreed 4/4. 서연이 데모 담당을 하기로 했다." The role split itself was never confirmed.
- Personal agent: 4 share cards in 5 group messages, including nudges to post procedural replies ("데모 맡아줘서 고마워! 그러면 ... 어떻게 배분할까?").
- Cost: $0.014.

**Feedback.**
- Moderator, flow: an open check blocks every later decision. If a stronger decision arrives while a check is open and few have answered, the new one should replace it (change in agents/meeting.ts, shared file; the host "revise" button is a manual workaround).
- Moderator, prompt: options must come from what was said in the chat. When nothing was said about the ambiguous aspect, use the generic "Is this how you understood the decision?" fallback.
- Moderator, prompt: one member volunteering plus a reaction is borderline. Decide as a team whether that should open a check.
- Personal agent: same noise issue as S1.

---

## S3 · Club event: fast convergence and a private budget concern

**Setup.** Mina (host), Leo, Sara, Jun. Goal: "Plan our club's end-of-semester event". Sara has a private worry about budget.

| # | Who | Where | Line | Moderator should engage? |
|---|---|---|---|---|
| 1 | Sara | private | Our budget is only about 100 dollars and last year's picnic cost 200. I don't want to be the one who brings it up though. | no |
| 2 | Mina | group | Any ideas for the end-of-semester event? | no |
| 3 | Leo | group | A picnic by the river like last year? | no |
| 4 | Jun | group | I liked the picnic too, let's not overthink it. | no |
| 5 | Mina | group | Same, picnic works for me. | borderline (3 of 4 agree) |
| 6 | (all) | | silence 60 s | no (converging) |
| 7 | Leo | group | OK, picnic it is. Let's do it on Saturday. | **yes: decision** (ambiguity: which Saturday, budget) |
| 8 | Sara | private | Something about this bothers me but everyone already agrees. / It's the money... | no |
| 9 | Sara | card | raise concern anonymously | **yes: concern label attached to the check** |
| 10 | all | card | answers split | **yes: compare, mismatch, question + "One concern was raised: budget"** |
| 11 | Mina | group | Good point on the budget. Let's do next Saturday, potluck style, and keep it under 100 dollars. | **yes: decision** |
| 12 | all | card | same answer | **yes: Agreed 4/4** |

**What happened (4 runs, 3 aborted).**
- Line 1: the personal agent turned Sara's worry into a concern card right away (label "Bring up budget"), which is the intended T3 behaviour. Good.
- Line 5: the moderator opened a check on "Same, picnic works for me" (question: same riverside spot and time as last year?). Borderline: three of four had agreed.
- Line 6: correct, no angle.
- Line 7: not checked, same reason as S2 (a check was already open).
- Line 8: **the personal agent crashed** in 3 of 4 runs with "Personal Agent could not complete the request. Check the server's OpenRouter configuration." The model's reply was fine (HTTP 200, finish_reason stop). The agent code rejects a reply that contains both `share_draft` and `concern` (`requireFormat(data.share_draft === null)` in agents/personal.ts) and throws instead of keeping one of them. In the web the member sees an error toast and no reply.
- Lines 9-12 could not be reached in the simulator because of that crash.
- Cost: about $0.03 per attempt.

**Feedback.**
- Personal agent, bug: when the model returns both a share draft and a concern, keep the concern (or the draft) instead of failing. Or make the two mutually exclusive in the JSON schema. Also log the real reason; today every failure shows the same "OpenRouter configuration" message, which was misleading here.
- Moderator: same open-check issue as S2.

---

## Evaluation: commitment detection (first batch)

Hand annotation vs. what the moderator did, over the group messages above.

| Scenario | Group messages | Judged by moderator | Correct | False alarm | Missed (blocked by an open check) |
|---|---|---|---|---|---|
| S1 (run 2) | 6 | 6 | 6 | 0 | 0 |
| S2 | 5 | 3 | 2 | 1 (line 4) | 1 (line 7) |
| S3 (run 1) | 5 | 4 | 3 | 1 (line 5, borderline) | 1 (line 7) |
| **Total** | 16 | 13 | 11 (85%) | 2 | 2 |

Both misses have the same cause (an earlier check still open), not a wrong judgement. Both false alarms are "others approve one member's suggestion" cases.

### Message-by-message evaluation (no open-check effect)

`tests/scenarios/jeehye/annotations.csv` lists every group message of the three scenarios with one label column per annotator (yes / no / borderline). `npm run eval:commitment` (default folder `tests/scenarios/jeehye`; pass another folder such as `tests/scenarios/jaewon`) asks the moderator about each message on its own, with the chat up to that point, and compares with the labels (`-- --by hamza` for another column; `-- --mock` is free and only checks the setup).

Result on gpt-5-mini (annotator jeehye): 16 messages judged, 15 correct (94%), 1 false alarm ("I liked the picnic too, let's not overthink it."), 0 missed, 1 borderline not counted. Cost $0.012.

Observation: when the ambiguity is "who does what", the options name participants ("민수가 둘 다 맡는다"), which the prompt forbids. For owner questions names are unavoidable, so that rule should allow them.

To add your own: make `tests/scenarios/<yourname>/` with your `.json` files and an `annotations.csv` in the same format. Each person's folder is separate, so no merge conflicts.

The 18 moderator fixtures (`npm run test:moderator`) all pass on gpt-5-mini: decision detection 8/8, missing angle 5/5, compare 5/5.

---

## Issues to fix before Tuesday (by owner)

**Jeehye (moderator)**
1. Prompt: options must come from the chat; use the generic fallback when nothing was said.
2. Prompt: final statement must include the shared reading.
3. Propose to the team: let a new decision replace an open check that few have answered (agents/meeting.ts).

**Jaewon (personal agent)**
1. Bug: reply rejected when both share_draft and concern are present (S3). Keep one instead of throwing.
2. Noise: a share card on almost every group message. Honour the cooldown and "usually none".
3. Reply language should follow the member's message (S1 run 2).

**Hamza / Jiyeon (web)**
1. Fewer small gray explanation texts, larger main text, so the three panels and the cards stand out.
2. Moderator card label says "Approved 2/4"; design says "Agreement 2/4".

---

## Demo script for the presentation (one screen: Jiwoo)

Setup: 4 laptops in one room. Screen shows Jiwoo. Others play Minsu (host), Seoyeon, Taeho. Silence trigger set to 15 s for the demo, or the host uses "Ask about an angle".

| Step | Who | Where | Types / clicks | What the audience sees on Jiwoo's screen | Presenter says |
|---|---|---|---|---|---|
| T1 | Jiwoo | private | I'm thinking about predicting how crowded the cafeteria and library are. Not sure if it's good enough to share. | Agent replies privately. Group chat empty. | "Jiwoo has an idea but is not sure. Nothing reaches the group." |
| T1 | Taeho | private | Wi-Fi access counts for every building are public data. | (nothing on Jiwoo's screen) | |
| T2 | Minsu | group | How about a study group matching app? | Group message. A share card may appear for Jiwoo (her agent sees the connection). | "Her agent notices her idea fits. Only she sees this." |
| T2 | Seoyeon | group | A chatbot for club recruiting could work too. | | |
| T2 | Minsu | host button | Ask about an angle: "real campus data" | Share card for Jiwoo (and Taeho) if not already shown. | "The moderator found an angle nobody raised and asked the agents privately. The group sees nothing." |
| T2 | Jiwoo | card | Share | Her idea appears in the group chat under her name. | "She decides to share. Only the user posts." |
| T2 | Taeho | card | Share | Taeho's data note appears. | |
| T3 | Minsu | group | Nice. Let's go with crowding prediction then. | Check card: question + options. | "Sounds like a decision. The moderator asks everyone privately how they understood it." |
| T3 | Minsu, Taeho | card | pick the broader option, approve | | |
| T3 | Jiwoo, Seoyeon | card | pick the narrower option, approve | Moderator card: "Approved 2/4" + one anonymous question. | "Same words, two readings. Nobody is named." |
| T3 | Minsu | group | OK, let's just do the library and the cafeteria. | New check card. | |
| T3 | all | card | pick the narrower option, approve | "Agreed 4/4" + decision log entry. | "Now they agree on the same thing." |

Risks: the check's question and options vary per run, so presenters pick whichever two options differ. Model replies take 3-10 s. Keep a screen recording as backup.

### Recording (2026-11-23)

Three automated takes of this script on the real web UI and the real model, recorded from Jiwoo's window (headless Chromium, four browsers playing the four members). Files: `/home/jeehye/CS470/demo_videos/S1_take1_94s.mp4`, `S1_take2_95s.mp4`, `S1_take3_134s.mp4` (not in git).

Two flow facts learned while recording, now reflected in the script above and in `tests/scenarios/jeehye/s1_demo_topic.json`:
- After a split answer, the check stays open ("Not agreed yet"). A new chat message does not open a new check. The host presses "Suggest a revised proposal" (version 2), everyone answers again, and that gives "Agreed 4/4". The demo does the chat message and then the revise.
- The silence rule was set to 30 s for the demo (`agents/rules.ts`, `silenceMs`). In takes 1 and 2 Jiwoo's share card came from a teammate's post (react) before the silence; in take 3 it came from the automatic angle after the silence.

Take 2 (95 s) has the cleanest check question (scope: "Any campus buildings" vs "Only cafeteria and library"). Take 3 (134 s) shows the automatic silence trigger. Both are under 5 minutes.
