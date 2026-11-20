// Thin OpenRouter client (OpenAI-compatible chat completions).
// The API key stays on this server; the browser never sees it.

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openrouter/auto";

export class AgentConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentConfigError";
    this.status = 503;
  }
}

/**
 * @param {{
 *   model?: string,
 *   messages: Array<{ role: "system" | "user" | "assistant", content: string }>,
 *   temperature?: number,
 *   maxTokens?: number,
 * }} request
 * @returns {Promise<string>} the assistant's reply text
 */
export async function complete({ model, messages, temperature, maxTokens }) {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) {
    throw new AgentConfigError(
      "OPENROUTER_API_KEY is not set. Copy .env.example to .env and fill it in.",
    );
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  // Optional attribution headers that OpenRouter shows on its dashboard.
  if (process.env.OPENROUTER_SITE_URL) headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
  if (process.env.OPENROUTER_APP_NAME) headers["X-Title"] = process.env.OPENROUTER_APP_NAME;

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || response.statusText;
    throw new Error(`OpenRouter ${response.status}: ${detail}`);
  }
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("OpenRouter returned an empty reply.");
  }
  return text.trim();
}
