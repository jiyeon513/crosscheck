import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { StreamClient } from "@stream-io/node-sdk";

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

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/api/join") {
    send(res, 404, { error: "Not found" });
    return;
  }

  try {
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    const title = String(body.title ?? "").trim().slice(0, 80);
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
  } catch (error) {
    console.error(error);
    send(res, 500, {
      error: error instanceof Error ? error.message : "입장에 실패했습니다.",
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`token server http://127.0.0.1:${port}`);
});
