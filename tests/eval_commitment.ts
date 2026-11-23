// Commitment-point evaluation. Owner: Jeehye.
//
// For every group message in a scenario folder, ask the moderator "is this a decision?" with the chat up to
// that message, and compare with the human labels in <folder>/annotations.csv.
// Each message is judged on its own, so an open check never blocks a judgement (unlike the live meeting).
//
// A scenario folder holds one person's scenarios: tests/scenarios/<name>/*.json + annotations.csv
// (columns: scenario,msg,author,text, then one label column per annotator: yes / no / borderline).
//
//   npm run eval:commitment                                   # tests/scenarios/jeehye, label column "jeehye"
//   npm run eval:commitment -- tests/scenarios/jaewon          # another folder
//   npm run eval:commitment -- --by hamza                      # compare with another annotator's column
//   npm run eval:commitment -- --mock                          # free, keyword rules only (checks the setup, not the prompt)
//
// Cost: one moderator call per group message (about $0.001 each).

import fs from "node:fs";
import path from "node:path";
import { detectDecision } from "../agents/moderator";
import { usageSummary } from "../agents/llm";
import { enableFixtureModels } from "./mocks";
import type { ChatLine } from "../agents/protocol";

type Step = { do: string; user?: string; text?: string; fallback?: string };
type Scenario = { goal: string; steps: Step[] };
type Row = { scenario: string; msg: number; author: string; text: string; labels: Record<string, string> };

const argv = process.argv.slice(2);
if (argv.includes("--mock") || !process.env.OPENROUTER_API_KEY) enableFixtureModels();
const folder = argv.find((a) => !a.startsWith("--") && a !== argv[argv.indexOf("--by") + 1]) ?? "tests/scenarios/jeehye";
const annotator = argv.includes("--by") ? argv[argv.indexOf("--by") + 1] : path.basename(folder);

function parseCsv(file: string): Row[] {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells: string[] = [];
    let cur = "", quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    const get = (name: string) => cells[header.indexOf(name)] ?? "";
    const labels: Record<string, string> = {};
    for (const h of header.slice(4)) labels[h] = get(h).trim().toLowerCase();
    return { scenario: get("scenario"), msg: Number(get("msg")), author: get("author"), text: get("text"), labels };
  });
}

/** The group messages of a scenario, in order, as the moderator would see them. */
function groupMessages(scenario: Scenario): ChatLine[] {
  const out: ChatLine[] = [];
  for (const s of scenario.steps) {
    if (s.do === "group" && s.user && s.text) out.push({ author: s.user, text: s.text, kind: "user" });
    if (s.do === "share" && s.user && s.fallback) out.push({ author: s.user, text: s.fallback, kind: "user" });
  }
  return out;
}

async function main() {
  const rows = parseCsv(path.resolve(folder, "annotations.csv"));
  const byScenario = new Map<string, Row[]>();
  for (const r of rows) byScenario.set(r.scenario, [...(byScenario.get(r.scenario) ?? []), r]);

  let correct = 0, judged = 0, falseAlarms = 0, misses = 0, borderline = 0;
  console.log(`folder: ${folder}   annotator: ${annotator}\n`);
  for (const [name, labelled] of byScenario) {
    const scenario = JSON.parse(fs.readFileSync(path.resolve(folder, `${name}.json`), "utf8")) as Scenario;
    const group = groupMessages(scenario);
    console.log(`── ${name}`);
    for (const row of labelled) {
      const line = group[row.msg - 1];
      if (!line || line.text !== row.text) { console.log(`  #${row.msg} text in csv does not match the scenario file, skipped`); continue; }
      const res = await detectDecision({ goal: scenario.goal, group: group.slice(0, row.msg), trigger: "new_message" });
      const human = row.labels[annotator] || "(blank)";
      const model = res.is_decision ? "yes" : "no";
      let mark = "  ";
      if (human === "yes" || human === "no") {
        judged++;
        if (human === model) { correct++; mark = "✓ "; }
        else if (model === "yes") { falseAlarms++; mark = "✗ false alarm"; }
        else { misses++; mark = "✗ missed"; }
      } else if (human === "borderline") { borderline++; mark = "~ borderline"; }
      console.log(`  #${row.msg} [${row.author}] ${row.text.slice(0, 60).padEnd(60)}  human=${human.padEnd(10)} moderator=${model.padEnd(3)} ${mark}`);
      if (res.is_decision) console.log(`       question: ${res.question}  options: ${res.options.join(" | ")}`);
    }
  }
  console.log(`\n================ SUMMARY ================`);
  console.log(`  judged ${judged}   correct ${correct} (${judged ? Math.round((100 * correct) / judged) : 0}%)   false alarms ${falseAlarms}   missed ${misses}   borderline (not counted) ${borderline}`);
  console.log(`  ${usageSummary()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
