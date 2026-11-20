import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { StreamClient } from "@stream-io/node-sdk";
import { AgentConfigError } from "./agents/openrouter.mjs";
import { MODERATOR_USER, runModerator, shouldModeratorSpeak } from "./agents/moderator.mjs";
import { runPersonal } from "./agents/personal.mjs";

const port = Number(process.env.PORT || 8787);

let stream;

function loadEnv() {
  try {
    const text = readFileSync(new URL(".env", import.meta.url), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key) process.env[key] = value;
    }
  } catch {
    // .env is optional until the first join request.
  }
}

function userIdFromName(name) {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 20);
  return `u_${hash}`;
}

function channelIdFromCode(code) {
  return String(code ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
}

function channelTitle(state) {
  const custom = state?.channel?.custom;
  if (custom && typeof custom.name === "string" && custom.name.trim()) {
    return custom.name.trim();
  }
  return "";
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("요청 본문이 올바른 JSON이 아닙니다."));
      }
    });
    req.on("error", reject);
  });
}

function getStream() {
  loadEnv();
  const apiKey = process.env.STREAM_API_KEY ?? "";
  const apiSecret = process.env.STREAM_API_SECRET ?? "";
  if (!apiKey || !apiSecret) {
    throw new Error(
      ".env 에 STREAM_API_KEY 와 STREAM_API_SECRET 을 넣어 주세요. .env.example 을 복사하면 됩니다.",
    );
  }
  if (!stream || stream.apiKey !== apiKey) {
    stream = new StreamClient(apiKey, apiSecret);
  }
  return stream;
}

const routes = {
  "/api/join": handleJoin,
  "/api/agent/moderator": handleModerator,
  "/api/agent/personal": handlePersonal,
};

const server = createServer(async (req, res) => {
  const handler = req.method === "POST" ? routes[req.url ?? ""] : undefined;
  if (!handler) {
    send(res, 404, { error: "Not found" });
    return;
  }
  try {
    await handler(await readJson(req), res);
  } catch (error) {
    console.error(error);
    const status = error instanceof AgentConfigError ? error.status : 500;
    send(res, status, { error: error instanceof Error ? error.message : "Request failed." });
  }
});

async function handleJoin(body, res) {
  const name = String(body.name ?? "").trim();
  const title = String(body.title ?? "")
    .trim()
    .slice(0, 80);
  const code = channelIdFromCode(body.code);
  if (!name || name.length > 40) {
    send(res, 400, { error: "이름은 1~40자로 입력해 주세요." });
    return;
  }
  if (!code) {
    send(res, 400, { error: "그룹 코드는 영문, 숫자, _, - 만 사용할 수 있습니다." });
    return;
  }

  const userId = userIdFromName(name);
  const client = getStream();
  await client.upsertUsers([{ id: userId, name }]);

  const channel = client.chat.channel("messaging", code);
  const created = await channel.getOrCreate({
    data: {
      created_by_id: userId,
      members: [{ user_id: userId }],
      ...(title ? { custom: { name: title } } : {}),
    },
  });
  await channel.update({
    add_members: [{ user_id: userId }],
  });

  send(res, 200, {
    apiKey: client.apiKey,
    token: client.generatePermanentUserToken({ user_id: userId }),
    userId,
    name,
    code,
    title: channelTitle(created) || title || code.toUpperCase(),
  });
}

/** Short meeting info sent by the client: { title, startsAt } or null. */
function readMeeting(value) {
  if (!value || typeof value !== "object") return null;
  const title = String(value.title ?? "")
    .trim()
    .slice(0, 80);
  const startsAt = String(value.startsAt ?? "");
  return title ? { title, startsAt } : null;
}

/**
 * Moderator turn. Reads the team chat from Stream itself (it never receives
 * personal chats), asks the model, and posts the reply into the team chat.
 * Called by the client after each team message.
 * Body: { code, meeting? }
 */
async function handleModerator(body, res) {
  loadEnv();
  const code = channelIdFromCode(body.code);
  if (!code) {
    send(res, 400, { error: "Missing group code." });
    return;
  }
  const client = getStream();
  const channel = client.chat.channel("messaging", code);
  const state = await channel.getOrCreate({ messages: { limit: 100 } });
  const team = (state.messages ?? [])
    .filter((message) => {
      const kind = message.custom?.kind;
      return message.text?.trim() && kind !== "decision" && kind !== "meeting";
    })
    .map((message) => ({
      author: message.user?.name || message.user?.id || "Someone",
      text: message.text.trim(),
      createdAt: new Date(message.created_at).toISOString(),
      ...(message.custom?.quote?.text ? { quote: message.custom.quote } : {}),
    }));

  if (!shouldModeratorSpeak({ team })) {
    send(res, 200, { skipped: true });
    return;
  }

  const text = await runModerator({
    groupTitle: channelTitle(state) || code.toUpperCase(),
    meeting: readMeeting(body.meeting),
    team,
  });

  await client.upsertUsers([{ id: MODERATOR_USER.id, name: MODERATOR_USER.name }]);
  await channel.update({ add_members: [{ user_id: MODERATOR_USER.id }] });
  const sent = await channel.sendMessage({
    message: { text, user_id: MODERATOR_USER.id, custom: { kind: "moderator" } },
  });
  send(res, 200, { text, id: sent.message?.id });
}

/**
 * Personal agent turn. Sees the team chat and the person's private chat (both
 * sent by the client) and only answers back to that person.
 * Body: { name, groupTitle, meeting?, team: [...], personal: [...] }
 */
async function handlePersonal(body, res) {
  loadEnv();
  const owner = String(body.name ?? "")
    .trim()
    .slice(0, 40);
  if (!owner) {
    send(res, 400, { error: "Missing name." });
    return;
  }
  const team = Array.isArray(body.team) ? body.team : [];
  const personal = Array.isArray(body.personal) ? body.personal : [];
  const text = await runPersonal({
    owner,
    groupTitle: String(body.groupTitle ?? "").slice(0, 80),
    meeting: readMeeting(body.meeting),
    team: team.map((message) => ({
      author: String(message.author ?? "Someone"),
      text: String(message.text ?? ""),
      createdAt: message.createdAt,
      ...(message.quote?.text ? { quote: message.quote } : {}),
    })),
    personal: personal.map((message) => ({
      from: message.from === "agent" ? "agent" : "user",
      text: String(message.text ?? ""),
      ...(message.quote?.text ? { quote: message.quote } : {}),
    })),
  });
  send(res, 200, { text });
}

server.listen(port, "127.0.0.1", () => {
  console.log(`token server http://127.0.0.1:${port}`);
});
