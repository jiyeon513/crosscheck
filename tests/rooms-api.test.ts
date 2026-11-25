// The server API used by the web app, end to end over HTTP with offline fixture models.
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { Card } from "../agents/protocol";
import { startServer } from "../server/index";
import { store } from "../server/store";
import { enableFixtureModels } from "./mocks";

enableFixtureModels();
store.open({ memory: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

test("accounts, groups, a meeting room with agents, an agreed decision and its log", async () => {
  const server = startServer(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tokens = new Map<string, string>();

  async function call(method: string, path: string, user: string | null, body?: object): Promise<Json> {
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(user && tokens.get(user) ? { Authorization: `Bearer ${tokens.get(user)}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await response.json()) as Json;
    if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
    return data;
  }
  async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean) {
    for (let i = 0; i < 50; i++) {
      const value = await read();
      if (ok(value)) return value;
      await delay(20);
    }
    throw new Error("timed out");
  }
  const cards = (view: Json): Card[] => view.private.flatMap((i: Json) => (i.type === "card" ? [i.card] : []));

  try {
    // Accounts: each person signs up; wrong passwords and taken names are refused.
    for (const name of ["Minsu", "Jiwoo", "Taeho"]) {
      tokens.set(name, (await call("POST", "/api/auth/signup", null, { name, password: `${name}-secret` })).token);
    }
    await assert.rejects(call("POST", "/api/auth/signup", null, { name: "minsu", password: "another1" }), /taken/);
    await assert.rejects(call("POST", "/api/auth/login", null, { name: "Minsu", password: "wrong-pass" }), /Wrong/);
    tokens.set("Minsu", (await call("POST", "/api/auth/login", null, { name: "Minsu", password: "Minsu-secret" })).token);
    await assert.rejects(call("GET", "/api/groups", null), /log in/);

    // Groups: Minsu creates one; the others join with the code; each sees only their own groups.
    const group = await call("POST", "/api/groups", "Minsu", { title: "CS473 · Final project" });
    await assert.rejects(call("GET", `/api/groups/${group.code}`, "Jiwoo"), /Join this group/);
    await call("POST", "/api/groups/join", "Jiwoo", { code: group.code.toUpperCase() });
    await call("POST", "/api/groups/join", "Taeho", { code: group.code });
    assert.equal((await call("GET", "/api/groups", "Jiwoo")).length, 1);
    const startsAt = new Date().toISOString();
    const meeting = await call("POST", `/api/groups/${group.code}/meetings`, "Minsu", { title: "Topic meeting", startsAt });

    // The meeting room. The first one in is the host.
    let key = "";
    for (const name of ["Minsu", "Jiwoo", "Taeho"]) {
      key = (await call("POST", "/api/rooms/join", name, { code: group.code, meetingId: meeting.id })).roomKey;
    }
    assert.equal(key, `${group.code}.${meeting.id}`);
    const view = (name: string) => call("GET", `/api/rooms/${key}/view`, name);
    const act = (name: string, action: string, body: object) => call("POST", `/api/rooms/${key}/${action}`, name, body);
    assert.equal((await view("Minsu")).isHost, true);
    assert.equal((await view("Jiwoo")).isHost, false);

    // Taeho thinks privately. Jiwoo asks the Moderator about a missing angle (any member can);
    // only Taeho's agent finds a related note, so only Taeho gets a suggestion. He shares it anonymously.
    await act("Taeho", "private", { text: "I found that campus Wi-Fi access counts are public." });
    await act("Jiwoo", "group", { text: "What about predicting how crowded the cafeteria gets?" });
    await act("Jiwoo", "angle", { angle: "using real campus data" });
    const taeho = await until(() => view("Taeho"), (v) => cards(v).some((c) => c.kind === "share_suggestion"));
    assert.equal(cards(await view("Jiwoo")).some((c) => c.kind === "share_suggestion"), false);
    const suggestion = cards(taeho).find((c) => c.kind === "share_suggestion")!;
    await act("Taeho", "share", { cardId: suggestion.id, text: "Wi-Fi counts could measure crowding.", mode: "anonymous" });
    await until(() => view("Minsu"), (v) => v.group.some((m: Json) => m.anonymous));

    // A quoted reply keeps its quote.
    await act("Jiwoo", "group", { text: "Yes!", quote: { author: "Anonymous", text: "Wi-Fi counts could measure crowding." } });
    assert.ok((await view("Minsu")).group.some((m: Json) => m.quote?.author === "Anonymous"));

    // Jiwoo settles it in the chat; the Moderator opens a check; everyone answers the same reading; it is recorded.
    const settled = "Let's go with predicting crowding in the library and cafeteria.";
    await act("Jiwoo", "group", { text: settled });
    await until(() => view("Minsu"), (v) => v.agreement?.status === "collecting");
    // Dragging a message into the decision log no longer proposes it.
    await assert.rejects(act("Jiwoo", "propose", { text: "Anything" }));
    for (const name of ["Minsu", "Jiwoo", "Taeho"]) {
      const check = cards(await view(name)).find((c) => c.kind === "understanding_check" && c.status === "open")!;
      assert.ok(check && check.kind === "understanding_check");
      await act(name, "check/answer", { checkId: check.checkId, label: "Yes, as stated", approve: true });
    }
    const agreed = await until(() => view("Minsu"), (v) => v.log.length === 1);
    const statement = agreed.log[0].text;
    assert.match(statement, /predicting crowding in the library and cafeteria/);
    assert.equal(agreed.log[0].agreed, "3/3");

    // Members can fix the wording later; the agreed original is kept. The group page shows it.
    await call("PATCH", `/api/groups/${group.code}/decisions/${agreed.log[0].id}`, "Taeho", {
      text: "Predict crowding in the library and cafeteria (pilot)",
    });
    const detail = await call("GET", `/api/groups/${group.code}`, "Jiwoo");
    assert.equal(detail.decisions[0].text, "Predict crowding in the library and cafeteria (pilot)");
    assert.equal(detail.decisions[0].original, statement);
    assert.equal(detail.decisions[0].editedBy, "Taeho");

    // The team chat is saved for the next meeting's room.
    assert.ok((store.db.chats[group.code] ?? []).length >= 4);

    // Privacy: nobody else's view contains Taeho's private note.
    for (const name of ["Minsu", "Jiwoo"]) {
      assert.equal(JSON.stringify(await view(name)).includes("Wi-Fi access counts are public"), false);
    }
  } finally {
    server.close();
  }
});

test("files and pictures: upload, attach to a team message, download; only pictures and PDFs render", async () => {
  const server = startServer(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = async (path: string, token: string, body?: object) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await r.json()) as Json;
    if (!r.ok) throw new Error(data.error);
    return data;
  };
  const upload = async (token: string, name: string, type: string, bytes: Buffer) => {
    const r = await fetch(base + "/api/uploads", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": type, "X-File-Name": encodeURIComponent(name) },
      body: bytes,
    });
    const data = (await r.json()) as Json;
    if (!r.ok) throw new Error(data.error);
    return data;
  };
  try {
    const ana = (await json("/api/auth/signup", "", { name: "Ana", password: "ana-secret" })).token;
    const ben = (await json("/api/auth/signup", "", { name: "Ben", password: "ben-secret" })).token;
    const group = await json("/api/groups", ana, { title: "Files" });
    await json("/api/groups/join", ben, { code: group.code });
    const key = (await json("/api/rooms/join", ana, { code: group.code })).roomKey;
    await json("/api/rooms/join", ben, { code: group.code });

    await assert.rejects(
      fetch(base + "/api/uploads", { method: "POST", body: Buffer.from("x") }).then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
      }),
      /401/,
    );
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const picture = await upload(ana, "사진 sketch.png", "image/png", png);
    assert.equal(picture.name, "사진 sketch.png");
    await json(`/api/rooms/${key}/group`, ana, { text: "", attachments: [picture.id] });
    const view = await json(`/api/rooms/${key}/view`, ben);
    assert.equal(view.group.at(-1).attachments[0].url, picture.url);

    const got = await fetch(base + picture.url);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);

    const page = await upload(ana, "evil.html", "text/html", Buffer.from("<script>alert(1)</script>"));
    const served = await fetch(base + page.url);
    assert.equal(served.headers.get("content-type"), "application/octet-stream");
    assert.match(served.headers.get("content-disposition") ?? "", /^attachment/);

    // Someone else's upload cannot be attached.
    await assert.rejects(json(`/api/rooms/${key}/group`, ben, { text: "hi", attachments: [picture.id] }), /not found/);
  } finally {
    server.close();
  }
});
