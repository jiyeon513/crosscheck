// The CrossCheck server: the JSON API and, in production, the built web app (dist/).
//
//   POST /api/auth/signup | /api/auth/login | /api/auth/logout     GET /api/me
//   GET  /api/groups              POST /api/groups { title }         POST /api/groups/join { code }
//   GET  /api/groups/:code        POST /api/groups/:code/meetings     PATCH /api/groups/:code/decisions/:id
//   POST /api/rooms/join { code, meetingId }
//   GET  /api/rooms/:key/view     POST /api/rooms/:key/<action>
//
// Every call except signup/login sends "Authorization: Bearer <token>".

import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { llmInfo } from "../agents/llm";
import { bearer, HttpError, logIn, logOut, requireUser, signUp } from "./auth";
import { serveFile, uploadFile } from "./files";
import { createGroup, editDecision, groupDetail, joinGroup, listGroups, scheduleMeeting, createDemoGroup, removeMeeting } from "./groups";
import { errorStatus, joinRoom, roomAction, tickRooms } from "./rooms";
import { store } from "./store";

type Body = Record<string, unknown>;

async function readJson(req: http.IncomingMessage): Promise<Body> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new HttpError(413, "Request too large");
  }
  if (!raw) return {};
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Expected a JSON object");
  return body as Body;
}

async function route(method: string, path: string, body: Body, token: string) {
  if (method === "GET" && path === "/api/health") return { ok: true, llm: llmInfo() };
  if (method === "POST" && path === "/api/auth/signup") return signUp(body);
  if (method === "POST" && path === "/api/auth/login") return logIn(body);

  const name = requireUser(token);
  if (method === "POST" && path === "/api/auth/logout") {
    logOut(token);
    return { ok: true };
  }
  if (method === "GET" && path === "/api/me") return { name };
  if (method === "GET" && path === "/api/groups") return listGroups(name);
  if (method === "POST" && path === "/api/groups") return createGroup(name, body);
  if (method === "POST" && path === "/api/groups/join") return joinGroup(name, body);
  if (method === "POST" && path === "/api/groups/demo") return createDemoGroup(name);
  if (method === "POST" && path === "/api/rooms/join") return joinRoom(name, body);

  let match = path.match(/^\/api\/groups\/([\w-]+)$/);
  if (match && method === "GET") return groupDetail(name, match[1]);
  match = path.match(/^\/api\/groups\/([\w-]+)\/meetings$/);
  if (match && method === "POST") return scheduleMeeting(name, match[1], body);
  match = path.match(/^\/api\/groups\/([\w-]+)\/meetings\/([\w-]+)$/);
  if (match && method === "DELETE") return removeMeeting(name, match[1], match[2]);
  match = path.match(/^\/api\/groups\/([\w-]+)\/decisions\/([\w-]+)$/);
  if (match && method === "PATCH") return editDecision(name, match[1], match[2], body);
  match = path.match(/^\/api\/rooms\/([\w.-]+)\/(.+)$/);
  if (match) return roomAction(name, match[1], `${method} ${match[2]}`, body);
  throw new HttpError(404, "Not found");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

/** Serve the built web app; unknown paths get index.html so client-side screens load. */
function serveStatic(dist: string, path: string, res: http.ServerResponse) {
  const target = normalize(join(dist, decodeURIComponent(path)));
  const file =
    target.startsWith(dist) && existsSync(target) && statSync(target).isFile() ? target : join(dist, "index.html");
  const type = MIME[extname(file)] ?? "application/octet-stream";
  const cache = file.includes(`${join(dist, "assets")}`) ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
  createReadStream(file).pipe(res);
}

export function startServer(port: number, host = "127.0.0.1") {
  const dist = resolve("dist");
  const hasWeb = existsSync(join(dist, "index.html"));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (!path.startsWith("/api/")) {
      if (hasWeb && (req.method === "GET" || req.method === "HEAD")) return serveStatic(dist, path, res);
      res.writeHead(404).end();
      return;
    }
    const fileMatch = path.match(/^\/api\/files\/([\w-]+)$/);
    if (fileMatch && req.method === "GET") return serveFile(fileMatch[1], res);
    try {
      const token = bearer(req.headers.authorization);
      // Uploads send raw bytes, not JSON.
      const result =
        req.method === "POST" && path === "/api/uploads"
          ? await uploadFile(requireUser(token), req)
          : await route(
              req.method ?? "GET",
              path,
              req.method === "POST" || req.method === "PATCH" ? await readJson(req) : {},
              token,
            );
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(result));
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) console.error(error);
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Request failed." }));
    }
  });
  const timer = setInterval(tickRooms, 2000);
  server.once("close", () => clearInterval(timer));
  return server.listen(port, host);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  store.open(); // agents/llm.ts already loaded .env
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  startServer(port, host).on("listening", () => {
    console.log(`CrossCheck on http://${host}:${port} (agents: ${llmInfo().mode}, model ${llmInfo().model})`);
  });
  const flush = () => {
    store.flush();
    process.exit(0);
  };
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);
}
