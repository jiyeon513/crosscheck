// One place for every model call.
//  - reads prompts/<name>.md  (text above "=== INPUT ===" is the system prompt, text below is the input template)
//  - fills {{variables}}
//  - calls OpenRouter (or any OpenAI-compatible server) and parses the JSON reply
//  - fixture generators can be injected by the test runners only

import fs from "node:fs";
import path from "node:path";

// ---------- .env ----------

function loadDotEnv(): void {
  const file = path.join(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

// ---------- settings (read at call time, so scripts can override env after import) ----------

export function settings() {
  const env = process.env;
  const apiKey = env.OPENROUTER_API_KEY || "";
  const mock = fixtureGenerator !== undefined;
  return {
    apiKey,
    baseUrl: env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
    mock,
    model: env.LLM_MODEL || "openai/gpt-5-mini",
    reasoningEffort: env.LLM_REASONING_EFFORT ?? "low",
    jsonMode: env.LLM_JSON_MODE !== "0",
    maxTokens: Number(env.LLM_MAX_TOKENS || 1500),
    temperature: env.LLM_TEMPERATURE ? Number(env.LLM_TEMPERATURE) : undefined,
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 65_000),
    dryRun: env.LLM_DRY_RUN === "1",
    priceIn: Number(env.LLM_PRICE_IN || 0.25),
    priceOut: Number(env.LLM_PRICE_OUT || 2.0),
  };
}

export function llmInfo(): { mode: "mock" | "unconfigured" | "live"; model: string } {
  const s = settings();
  return { mode: s.mock ? "mock" : s.apiKey ? "live" : "unconfigured", model: s.mock ? "mock" : personalModel() };
}

// ---------- usage ----------

export const usage = { calls: 0, mockCalls: 0, promptTokens: 0, completionTokens: 0 };

export function usageSummary(): string {
  const s = settings();
  const cost = (usage.promptTokens / 1e6) * s.priceIn + (usage.completionTokens / 1e6) * s.priceOut;
  return (
    `API calls: ${usage.calls}   mock calls: ${usage.mockCalls}   ` +
    `tokens in/out: ${usage.promptTokens}/${usage.completionTokens}   est. cost: $${cost.toFixed(4)}`
  );
}

// ---------- prompts ----------

export type PromptTemplate = { system: string; user: string };

const promptCache = new Map<string, PromptTemplate>();

export function loadPrompt(name: string): PromptTemplate {
  const cached = promptCache.get(name);
  if (cached && process.env.NODE_ENV === "production") return cached;
  const dir = process.env.PROMPTS_DIR || path.join(process.cwd(), "prompts");
  const file = path.join(dir, `${name}.md`);
  // <!-- comments --> are notes for us and are not sent to the model
  const text = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const parts = text.split(/^===\s*INPUT\s*===\s*$/m);
  const tpl = {
    system: parts[0].trim(),
    user: (parts[1] ?? "Reply with the JSON object only.").trim(),
  };
  promptCache.set(name, tpl);
  return tpl;
}

export function fill(template: string, vars: Record<string, string | number>): string {
  const missing: string[] = [];
  const out = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (vars[key] === undefined) {
      missing.push(key);
      return "";
    }
    return String(vars[key]);
  });
  if (missing.length) throw new Error(`Prompt variables not provided: ${[...new Set(missing)].join(", ")}`);
  return out;
}

/** Pull the first JSON object out of a reply (handles ```json fences and extra words). */
export function extractJSON<T>(raw: string): T {
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error("No JSON object in the model reply: " + raw.slice(0, 200));
  }
}

// ---------- the call ----------

export type LLMRecord = { prompt: string; system: string; user: string; raw: string; mocked: boolean; ms: number };

type FixtureGenerator = (prompt: string, context: object) => unknown;
let fixtureGenerator: FixtureGenerator | undefined;

/** Test programs inject their fixture responses here. The HTTP server always uses the provider. */
export function useFixtureGenerator(generator: FixtureGenerator): void {
  fixtureGenerator = generator;
}

/** Personal Agent model. It must support strict JSON-schema output on OpenRouter. */
export const PERSONAL_MODEL = "openai/gpt-5-mini";
export function personalModel(): string {
  return process.env.PERSONAL_LLM_MODEL || PERSONAL_MODEL;
}
const OPENROUTER = "https://openrouter.ai/api/v1";

async function complete<T>(
  prompt: string, system: string, user: string, context: object,
  log?: (record: LLMRecord) => void, schema?: object,
): Promise<T> {
  const s = settings();
  const started = Date.now();
  if (fixtureGenerator) {
    if (s.dryRun) console.log(prompt, system, user);
    const data = await fixtureGenerator(prompt, context);
    usage.mockCalls++;
    log?.({ prompt, system, user, raw: JSON.stringify(data), mocked: true, ms: Date.now() - started });
    return data as T;
  }

  const baseUrl = schema ? OPENROUTER : s.baseUrl;
  if (!s.apiKey && (schema || baseUrl === OPENROUTER)) throw new Error("OPENROUTER_API_KEY is required on the API server.");
  const body: Record<string, unknown> = {
    model: schema ? personalModel() : s.model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_tokens: schema ? Math.max(2500, s.maxTokens) : s.maxTokens,
  };
  if (schema) {
    body.response_format = { type: "json_schema", json_schema: { name: "personal_action", strict: true, schema } };
    body.provider = { require_parameters: true };
  } else if (s.jsonMode) {
    body.response_format = { type: "json_object" };
  }
  if (s.reasoningEffort) body.reasoning = { effort: s.reasoningEffort };
  if (!schema && s.temperature !== undefined) body.temperature = s.temperature;
  const response = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${s.apiKey || "local"}`, "Content-Type": "application/json", "X-Title": "CrossCheck" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(s.timeoutMs),
  });
  if (!response.ok) throw new Error(`Model service returned HTTP ${response.status}.`);
  const data = await response.json() as {
    error?: unknown; choices?: { error?: unknown; finish_reason?: string; message?: { content?: string; refusal?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  const raw = choice?.message?.content;
  if (data.error || choice?.error || choice?.message?.refusal || choice?.finish_reason !== "stop" || typeof raw !== "string") {
    throw new Error("Model service did not return a completed answer.");
  }
  usage.calls++;
  usage.promptTokens += data.usage?.prompt_tokens ?? 0;
  usage.completionTokens += data.usage?.completion_tokens ?? 0;
  let result: T;
  try { result = schema ? JSON.parse(raw) as T : extractJSON<T>(raw); }
  catch { throw new Error("Model service returned an invalid JSON answer."); }
  log?.({ prompt, system, user, raw, mocked: false, ms: Date.now() - started });
  return result;
}

export function callJSON<T>(
  prompt: string, vars: Record<string, string | number>, context: object, log?: (record: LLMRecord) => void,
): Promise<T> {
  const tpl = loadPrompt(prompt);
  return complete(prompt, fill(tpl.system, vars), fill(tpl.user, vars), context, log);
}

export function callPersonalJSON<T>(
  prompt: string, context: object, schema: object, log?: (record: LLMRecord) => void,
): Promise<T> {
  return complete(prompt, loadPrompt(prompt).system, JSON.stringify(context), context, log, schema);
}
