// Private questions, telling the Moderator only, and agent notes across meetings, over HTTP.
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

test("private question, tell the Moderator only, and agent notes that carry over to the next meeting", async () => {
  const server = startServer(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tokens = new Map<string, string>();
  async function call(method: string, path: string, user: string | null, body?: object): Promise<Json> {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${tokens.get(user)}` } : {}) },
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
    for (const name of ["Minsu", "Taeho"]) {
      tokens.set(name, (await call("POST", "/api/auth/signup", null, { name, password: `${name}-secret` })).token);
    }
    const group = await call("POST", "/api/groups", "Minsu", { title: "Campus app proposal" });
    await call("POST", "/api/groups/join", "Taeho", { code: group.code });
    const first = await call("POST", `/api/groups/${group.code}/meetings`, "Minsu", { title: "Idea meeting", startsAt: new Date().toISOString() });
    let key = "";
    for (const name of ["Minsu", "Taeho"]) key = (await call("POST", "/api/rooms/join", name, { code: group.code, meetingId: first.id })).roomKey;
    const view = (name: string) => call("GET", `/api/rooms/${key}/view`, name);

    // Taeho tells his agent something lasting; it offers a note; he keeps it.
    await call("POST", `/api/rooms/${key}/private`, "Taeho", { text: "I usually come from Daejeon Station on Tuesdays, keep that in mind." });
    const note = cards(await view("Taeho")).find((c) => c.kind === "memory")!;
    await call("POST", `/api/rooms/${key}/memory/save`, "Taeho", { cardId: note.id });
    await call("POST", `/api/rooms/${key}/memory/add`, "Taeho", { text: "5:30 is easier for me than 5:00." });
    assert.equal((await view("Taeho")).memory.length, 2);
    assert.equal((await view("Minsu")).memory.length, 0);

    // A private question: only the combined result reaches the team chat.
    await call("POST", `/api/rooms/${key}/poll`, "Minsu", { question: "What time on Tuesday works for you?" });
    const poll = await until(() => view("Taeho"), (v) => cards(v).some((c) => c.kind === "poll" && c.draft !== ""));
    const taehoCard = cards(poll).find((c) => c.kind === "poll")!;
    assert.equal(taehoCard.kind === "poll" && taehoCard.draft, "Prefer 5:30."); // from his kept note
    const pollId = taehoCard.kind === "poll" ? taehoCard.pollId : "";
    await call("POST", `/api/rooms/${key}/poll/answer`, "Taeho", { pollId, text: "5:30" });
    await call("POST", `/api/rooms/${key}/poll/answer`, "Minsu", { pollId, skip: true });
    const done = await until(() => view("Minsu"), (v) => v.board.polls[0]?.status === "done");
    assert.match(done.group.find((m: Json) => m.note?.type === "poll_result").text, /^Combined result: 5:30 works for everyone\./);
    assert.equal(done.agreement?.decision, "5:30 works for everyone."); // then confirmed privately, like any decision
    assert.ok(!done.group.some((m: Json) => /Daejeon/.test(m.text)));

    // A concern told to the Moderator only.
    await call("POST", `/api/rooms/${key}/private`, "Taeho", { text: "Honestly this whole campus plan is too big for us." });
    const concern = cards(await view("Taeho")).find((c) => c.kind === "concern")!;
    await call("POST", `/api/rooms/${key}/tell`, "Taeho", { cardId: concern.id, text: concern.kind === "concern" ? concern.draft : "" });
    const after = await until(() => view("Minsu"), (v) => v.group.some((m: Json) => m.note?.type === "private_concern"));
    assert.ok(!after.group.some((m: Json) => m.anonymous || m.author === "Taeho" && /too big/.test(m.text)));

    // The next meeting of the same group: Taeho's agent still has his notes; he can delete one.
    const second = await call("POST", `/api/groups/${group.code}/meetings`, "Minsu", { title: "Plan meeting", startsAt: new Date(Date.now() + 1000).toISOString() });
    const key2 = (await call("POST", "/api/rooms/join", "Taeho", { code: group.code, meetingId: second.id })).roomKey;
    const kept = (await call("GET", `/api/rooms/${key2}/view`, "Taeho")).memory;
    assert.deepEqual(kept.map((m: Json) => m.text), ["I usually come from Daejeon Station on Tuesdays,", "5:30 is easier for me than 5:00."]);
    await call("POST", `/api/rooms/${key2}/memory/delete`, "Taeho", { id: kept[0].id });
    assert.equal((await call("GET", `/api/rooms/${key2}/view`, "Taeho")).memory.length, 1);
  } finally {
    server.close();
  }
});
