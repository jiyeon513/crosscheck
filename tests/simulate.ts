// Runs a whole meeting in the terminal, without the web UI.
// It plays a scripted scenario through agents/meeting.ts and prints what each party sees:
// the group chat, each private window, and every message between the moderator and the personal agents.
//
//   npm run simulate                       mock mode if there is no API key (free)
//   npm run simulate -- --mock             force mock mode
//   npm run simulate -- --quiet            hide the moderator <-> agent messages
//   npm run simulate -- tests/scenarios/other.json

import fs from "node:fs";
import path from "node:path";
import { findPrivacyLeaks, Meeting } from "../agents/meeting";
import { llmInfo, usageSummary } from "../agents/llm";
import { enableFixtureModels } from "./mocks";
import type { PrivateItem, ShareSuggestionCard, UnderstandingCheckCard, ConcernCard } from "../agents/protocol";

type Step =
  | { do: "private" | "group"; user: string; text: string; after?: number; title?: string }
  | { do: "revise"; user: string; text: string; after?: number; title?: string }
  | { do: "angle"; user: string; text: string; after?: number; title?: string }
  | { do: "wait"; seconds: number; title?: string }
  | { do: "share"; user: string; fallback: string; after?: number; title?: string }
  | { do: "answer"; user: string; prefer: string; after?: number; title?: string }
  | { do: "concern"; user: string; mode: "named" | "anonymous"; after?: number; title?: string };

type Scenario = { name: string; goal: string; host: string; participants: string[]; steps: Step[] };

const argv = process.argv.slice(2);
if (argv.includes("--mock") || !process.env.OPENROUTER_API_KEY) enableFixtureModels();
const quiet = argv.includes("--quiet");
const file = argv.find((a) => a.endsWith(".json")) ?? "tests/scenarios/project_topic.json";
const scenario = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as Scenario;

// A fake clock, so "wait 65 seconds" takes no real time.
let clock = 0;
const meeting = new Meeting({ goal: scenario.goal, host: scenario.host, now: () => clock, tracePrompts: true });
for (const p of scenario.participants) meeting.join(p);

// ---------- printing ----------

const stamp = () => {
  const s = Math.floor(clock / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
let groupSeen = 0;
let traceSeen = 0;
const privateSeen = new Map<string, number>();

function describe(item: PrivateItem): string {
  if (item.type !== "card") return `${item.type === "user" ? "me" : "agent"}: ${item.text}`;
  const c = item.card;
  if (c.kind === "share_suggestion") return `CARD share suggestion (${c.source}): ${c.nudge}\n        draft: "${c.draft}"`;
  if (c.kind === "concern") return `CARD concern: "${c.label}"\n        draft: "${c.draft}"   [raise with my name] [raise anonymously]`;
  return `CARD agreement check: ${c.question}\n        options: ${c.options.join(" | ")}`;
}

function flush(): void {
  for (const m of meeting.group.slice(groupSeen)) {
    console.log(`  [GROUP]  ${m.kind === "moderator" ? "★ Moderator" : m.author}: ${m.text}`);
  }
  groupSeen = meeting.group.length;
  for (const p of meeting.participants) {
    const items = meeting.view(p).private;
    for (const item of items.slice(privateSeen.get(p) ?? 0)) console.log(`  [${p} · private]  ${describe(item)}`);
    privateSeen.set(p, items.length);
  }
  for (const ev of meeting.trace.slice(traceSeen)) {
    if (quiet) continue;
    if (ev.type === "mod_to_agents") console.log(`  [moderator → agents]  ${JSON.stringify(ev.data)}`);
    if (ev.type === "agent_to_mod") console.log(`  [${ev.from} → moderator]  ${JSON.stringify(ev.data)}`);
  }
  traceSeen = meeting.trace.length;
}

// ---------- steps ----------

const cardsOf = (user: string) => meeting.view(user).private.flatMap((i) => (i.type === "card" ? [i.card] : []));

async function run(step: Step): Promise<string> {
  switch (step.do) {
    case "private":
      await meeting.sendPrivateMessage(step.user, step.text);
      return `${step.user} writes to their agent`;
    case "group":
      await meeting.postGroupMessage(step.user, step.text);
      return `${step.user} posts in the group chat`;
    case "revise": {
      const version = meeting.view(step.user).agreement;
      if (!version) throw new Error("No active proposal to revise");
      await meeting.reviseCheck(step.user, version.checkId, step.text);
      return `${step.user} opens the revised proposal for fresh approval`;
    }
    case "angle":
      await meeting.requestAngle(step.user, step.text, "find_contribution");
      return `${step.user} presses [Ask about an angle]`;
    case "wait":
      clock += step.seconds * 1000;
      await meeting.tick();
      return `${step.seconds} seconds pass`;
    case "share": {
      const card = cardsOf(step.user).filter((c): c is ShareSuggestionCard => c.kind === "share_suggestion" && c.status === "open").pop();
      if (card) {
        await meeting.shareCard(step.user, card.id, card.draft, "named");
        return `${step.user} presses [Share to chat] on the agent's draft`;
      }
      await meeting.postGroupMessage(step.user, step.fallback);
      return `${step.user} posts on their own (the agent made no suggestion)`;
    }
    case "answer": {
      const card = cardsOf(step.user).filter((c): c is UnderstandingCheckCard => c.kind === "understanding_check" && c.status === "open").pop();
      if (!card) return `${step.user} has no open agreement check (skipped)`;
      // "prefer" may list several keywords separated by "|"; the first option containing one of them is chosen.
      const wanted = step.prefer.toLowerCase().split("|");
      const label = card.options.find((o) => wanted.some((w) => o.toLowerCase().includes(w))) ?? card.options[0];
      const hint = card.suggested ? `   (agent suggested "${card.suggested}": ${card.why})` : "";
      await meeting.answerCheck(step.user, card.checkId, label, true);
      return `${step.user} answers privately: "${label}"${hint}`;
    }
    case "concern": {
      const card = cardsOf(step.user).filter((c): c is ConcernCard => c.kind === "concern" && c.status === "open").pop();
      if (!card) return `${step.user} has no concern card (skipped)`;
      await meeting.raiseConcern(step.user, card.id, step.mode, card.draft);
      return `${step.user} raises the concern ${step.mode === "anonymous" ? "anonymously" : "with their name"}`;
    }
  }
}

async function main() {
  const info = llmInfo();
  console.log(`Scenario: ${scenario.name}`);
  console.log(`Goal: ${scenario.goal}   Participants: ${scenario.participants.join(", ")}   Agents: ${info.mode === "mock" ? "MOCK (free)" : info.model}\n`);

  for (const step of scenario.steps) {
    if (step.title) console.log(`\n━━━━ ${step.title} ━━━━`);
    if (step.do !== "wait") clock += (step.after ?? 5) * 1000;
    const what = await run(step);
    console.log(`\n(${stamp()}) ${what}`);
    flush();
  }

  // ---------- summary ----------
  const count = (type: string, who?: string) => meeting.trace.filter((e) => e.type === type && (!who || e.from.startsWith(who))).length;
  const leaks = findPrivacyLeaks(meeting);
  console.log("\n================ SUMMARY ================");
  console.log(`  stage: ${meeting.stage}`);
  console.log(`  decisions: ${meeting.decisions.length ? meeting.decisions.map((d) => `"${d.statement}"`).join("; ") : "(none)"}`);
  console.log(`  model calls: moderator ${count("llm_call", "moderator")}, personal agents ${count("llm_call", "agent:")}`);
  console.log(`  messages: moderator → agents ${count("mod_to_agents")}, agents → moderator ${count("agent_to_mod")}`);
  console.log(`  privacy check: ${leaks.length === 0 ? "OK, no private text reached the moderator or another member's agent" : "FAILED"}`);
  for (const l of leaks) console.log(`    ✗ ${l}`);
  console.log(`  ${usageSummary()}`);

  const ok = leaks.length === 0 && (info.mode !== "mock" || (meeting.check?.status === "aligned" && meeting.decisions.length === 1));
  if (!ok) {
    console.log("\n  RESULT: FAILED");
    process.exit(1);
  }
  console.log(info.mode === "mock" ? "\n  RESULT: OK (flow and privacy boundary work; run with an API key to judge the prompts)" : "\n  RESULT: finished. Read the transcript above to judge quality.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
