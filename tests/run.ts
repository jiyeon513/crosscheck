// Prompt tests. Runs each fixture in tests/fixtures/<agent>/ through the real agent function
// (same prompt file, same formatting, same model settings as the app) and checks the output.
//
//   npm run test:moderator                 only tests/fixtures/moderator
//   npm run test:personal                  only tests/fixtures/personal
//   npm run test:prompts -- --only angle   fixtures whose id or fn contains "angle"
//   npm run test:prompts -- --repeat 3     run each fixture 3 times (consistency)
//   npm run test:prompts -- --dry-run      print the filled prompts, call nothing (free)
//   npm run test:prompts -- --mock         force mock mode (checks the harness, not the prompts)
//   npm run test:prompts -- --model anthropic/claude-haiku-4.5

import fs from "node:fs";
import path from "node:path";
import { llmInfo, settings, usageSummary } from "../agents/llm";
import { enableFixtureModels } from "./mocks";
import * as moderator from "../agents/moderator";
import * as personal from "../agents/personal";
import * as critic from "../agents/critic";

type Fixture = {
  id: string;
  fn: string;
  note?: string;
  /** "skip" = do not run in mock mode (the mock cannot pass it by design) */
  mock?: "skip";
  input: Record<string, unknown>;
  expect: Record<string, unknown>;
};

const FNS: Record<string, (input: never) => Promise<unknown>> = {
  "moderator.findMissingAngle": moderator.findMissingAngle,
  "moderator.detectDecision": moderator.detectDecision,
  "moderator.compareUnderstanding": moderator.compareUnderstanding,
  "personal.chat": personal.chat,
  "personal.angleReply": personal.angleReply,
  "personal.react": personal.react,
  "personal.suggestCheckAnswer": personal.suggestCheckAnswer,
};

// ---------- arguments ----------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const valueFlags = new Set(["only", "repeat", "model", "critic", "critic-mode"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !valueFlags.has((argv[i - 1] ?? "").replace(/^--/, "")));

if (flag("dry-run")) process.env.LLM_DRY_RUN = "1";
if (flag("mock") || flag("dry-run") || !settings().apiKey) enableFixtureModels();
if (option("model")) process.env.LLM_MODEL = option("model");
// --critic <model> [--critic-mode always]: run the moderator fixtures through the critic as the app does.
if (option("critic")) {
  process.env.CRITIC_LLM_MODEL = option("critic");
  if (option("critic-mode")) process.env.CRITIC_MODE = option("critic-mode");
  FNS["moderator.detectDecision"] = critic.detectDecisionReviewed;
  FNS["moderator.compareUnderstanding"] = critic.compareUnderstandingReviewed;
}
const repeat = Math.max(1, Number(option("repeat") || 1));
const only = option("only");
const agentFilter = positional[0];

// ---------- expectations ----------
// "key": value                         exact match (strings ignore case)
// "key": { "one_of": [..] }            any of these
// "key": { "includes_any": [..] }      text contains at least one (ignore case)
// "key": { "includes_all": [..] }      text contains all
// "key": { "includes_each": [[..], [..]] }  for each list, text contains at least one (e.g. both readings among the options)
// "key": { "not_includes_any": [..] }  text contains none (for example: no participant names)
// "key": { "max_words": 30 }           word limit
// "key": { "min_length": 2 } / { "max_length": 4 } / { "length": 1 }   for lists
// "key": { "is_null": true } / { "is_empty": true } / { "not_empty": true }

const lower = (v: unknown): string => (Array.isArray(v) ? v.join(" | ") : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).toLowerCase();

function check(actual: Record<string, unknown>, expect: Record<string, unknown>): string[] {
  const fails: string[] = [];
  for (const [key, rule] of Object.entries(expect)) {
    const value = actual[key];
    const text = lower(value);
    const shown = JSON.stringify(value);
    if (rule === null || typeof rule !== "object") {
      const same = typeof rule === "string" ? text.trim() === rule.toLowerCase().trim() : value === rule;
      if (!same) fails.push(`${key}: expected ${JSON.stringify(rule)}, got ${shown}`);
      continue;
    }
    const r = rule as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : []);
    if (r.one_of && !list(r.one_of).includes(text.trim())) fails.push(`${key}: expected one of ${JSON.stringify(r.one_of)}, got ${shown}`);
    if (r.includes_any && !list(r.includes_any).some((w) => text.includes(w))) fails.push(`${key}: should mention one of ${JSON.stringify(r.includes_any)}, got ${shown}`);
    if (r.includes_all) for (const w of list(r.includes_all)) if (!text.includes(w)) fails.push(`${key}: should mention "${w}", got ${shown}`);
    if (Array.isArray(r.includes_each)) for (const group of r.includes_each) if (!list(group).some((w) => text.includes(w))) fails.push(`${key}: should mention one of ${JSON.stringify(group)}, got ${shown}`);
    if (r.not_includes_any) for (const w of list(r.not_includes_any)) if (text.includes(w)) fails.push(`${key}: must not mention "${w}", got ${shown}`);
    if (typeof r.max_words === "number" && text.split(/\s+/).filter(Boolean).length > r.max_words) fails.push(`${key}: longer than ${r.max_words} words`);
    const len = Array.isArray(value) ? value.length : text.length;
    if (typeof r.min_length === "number" && len < r.min_length) fails.push(`${key}: length ${len} < ${r.min_length}`);
    if (typeof r.max_length === "number" && len > r.max_length) fails.push(`${key}: length ${len} > ${r.max_length}`);
    if (typeof r.length === "number" && len !== r.length) fails.push(`${key}: length ${len}, expected ${r.length}`);
    if (r.is_null === true && value !== null) fails.push(`${key}: expected null, got ${shown}`);
    if (r.is_empty === true && len !== 0) fails.push(`${key}: expected empty, got ${shown}`);
    if (r.not_empty === true && len === 0) fails.push(`${key}: expected a value, got ${shown}`);
  }
  return fails;
}

// ---------- run ----------

function loadFixtures(): Fixture[] {
  const root = path.join(process.cwd(), "tests", "fixtures");
  const out: Fixture[] = [];
  for (const agent of fs.readdirSync(root).sort()) {
    if (agentFilter && agent !== agentFilter) continue;
    const dir = path.join(root, agent);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Fixture | Fixture[];
      out.push(...(Array.isArray(data) ? data : [data]));
    }
  }
  return out.filter((f) => !only || f.id.includes(only) || f.fn.includes(only));
}

async function main() {
  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    console.error("No fixtures matched.");
    process.exit(1);
  }
  const info = llmInfo();
  const dry = settings().dryRun;
  console.log(`model: ${info.model}   fixtures: ${fixtures.length}   repeat: ${repeat}${dry ? "   DRY RUN" : ""}`);
  if (info.mode === "mock" && !dry) {
    console.log("MOCK MODE: these results test the harness and the mock rules, not your prompts. Add OPENROUTER_API_KEY to .env for real results.\n");
  }

  const results: Record<string, unknown>[] = [];
  const perFn = new Map<string, { pass: number; total: number }>();
  let failed = 0;

  for (const fx of fixtures) {
    const fn = FNS[fx.fn];
    if (!fn) {
      console.log(`??    ${fx.fn}  ${fx.id}  unknown fn`);
      failed++;
      continue;
    }
    if (info.mode === "mock" && fx.mock === "skip" && !dry) {
      console.log(`SKIP  ${fx.fn}  ${fx.id}  (needs a real model)`);
      continue;
    }
    for (let i = 0; i < repeat; i++) {
      let output: Record<string, unknown> = {};
      let fails: string[];
      try {
        output = (await fn(fx.input as never)) as Record<string, unknown>;
        fails = dry ? [] : check(output, fx.expect);
      } catch (err) {
        fails = [`call failed: ${err instanceof Error ? err.message : String(err)}`];
      }
      if (dry) continue;
      const stat = perFn.get(fx.fn) ?? { pass: 0, total: 0 };
      stat.total++;
      if (fails.length === 0) stat.pass++;
      else failed++;
      perFn.set(fx.fn, stat);
      const run = repeat > 1 ? ` #${i + 1}` : "";
      console.log(`${fails.length ? "FAIL" : "PASS"}  ${fx.fn}  ${fx.id}${run}`);
      console.log(`      ${JSON.stringify(output)}`);
      for (const f of fails) console.log(`      ✗ ${f}`);
      results.push({ id: fx.id, fn: fx.fn, run: i + 1, pass: fails.length === 0, fails, output });
    }
  }
  if (dry) return;

  console.log("\n================ SUMMARY ================");
  for (const [fn, s] of perFn) console.log(`  ${fn.padEnd(34)} ${s.pass}/${s.total}`);
  console.log(`  ${usageSummary()}`);

  const dir = path.join(process.cwd(), "tests", "results");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `${stamp}_${info.model.replace(/[^\w.-]/g, "_")}.json`);
  fs.writeFileSync(file, JSON.stringify({ model: info.model, repeat, results }, null, 2));
  console.log(`  saved: ${path.relative(process.cwd(), file)}`);
  process.exit(failed ? 1 : 0);
}

main();
