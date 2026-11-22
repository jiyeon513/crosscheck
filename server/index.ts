// HTTP API for the web app (Vite proxies /api here in development).
//
//   POST /api/join                 join or create a group (Stream user, channel and token)
//   POST /api/rooms/join           enter the meeting room of a group's current meeting
//   GET  /api/rooms/:key/view      everything this participant may see (poll every 1-2 s)
//   POST /api/rooms/:key/<action>  group, private, share, concern, dismiss, check/*
//
// The room session token travels in the X-CrossCheck-Session header.

import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { llmInfo } from "../agents/llm";
import { errorStatus, HttpError, joinRoom, roomAction, tickRooms } from "./rooms";
import { channelIdFromCode, channelTitle, getStream, loadEnv, userIdFromName } from "./stream";

type Body = Record<string, unknown>;

async function readJson(req: http.IncomingMessage): Promise<Body> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "요청 본문이 올바른 JSON이 아닙니다.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Expected a JSON object");
  return body as Body;
}

/** POST /api/join — create or join a group's Stream channel and return a chat token. */
async function handleJoin(body: Body) {
  const name = String(body.name ?? "").trim();
  const title = String(body.title ?? "").trim().slice(0, 80);
  const code = channelIdFromCode(body.code);
  if (!name || name.length > 40) throw new HttpError(400, "이름은 1~40자로 입력해 주세요.");
  if (!code) throw new HttpError(400, "그룹 코드는 영문, 숫자, _, - 만 사용할 수 있습니다.");
  if (["moderator", "anonymous"].includes(name.toLowerCase())) throw new HttpError(400, "That display name is reserved.");

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
  await channel.update({ add_members: [{ user_id: userId }] });
  return {
    apiKey: client.apiKey,
    token: client.generatePermanentUserToken({ user_id: userId }),
    userId,
    name,
    code,
    title: channelTitle(created) || title || code.toUpperCase(),
  };
}

async function route(method: string, path: string, body: Body, token: string) {
  if (method === "GET" && path === "/api/health") return { ok: true, llm: llmInfo() };
  if (method === "POST" && path === "/api/join") return handleJoin(body);
  if (method === "POST" && path === "/api/rooms/join") return joinRoom(body, token);
  const match = path.match(/^\/api\/rooms\/([\w.-]+)\/(.+)$/);
  if (match) return roomAction(match[1], `${method} ${match[2]}`, body, token);
  throw new HttpError(404, "Not found");
}

export function startServer(port: number, host = "127.0.0.1") {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = req.method === "POST" ? await readJson(req) : {};
      const token = String(req.headers["x-crosscheck-session"] ?? "");
      const result = await route(req.method ?? "GET", url.pathname.replace(/\/+$/, ""), body, token);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(result));
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500 && !(error instanceof HttpError)) console.error(error);
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Request failed." }));
    }
  });
  const timer = setInterval(tickRooms, 2000);
  server.once("close", () => clearInterval(timer));
  return server.listen(port, host);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  const port = Number(process.env.PORT || 8787);
  startServer(port).on("listening", () => {
    console.log(`CrossCheck API on http://127.0.0.1:${port} (agents: ${llmInfo().mode})`);
  });
}
