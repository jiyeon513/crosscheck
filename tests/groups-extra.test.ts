// The demo group and removing a scheduled meeting, over HTTP with the fixture models.
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { startServer } from "../server/index";
import { store } from "../server/store";
import { enableFixtureModels } from "./mocks";

enableFixtureModels();
store.open({ memory: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

test("demo group, and removing meetings that have no decisions", async () => {
  const server = startServer(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let token = "";
  async function call(method: string, path: string, body?: object): Promise<Json> {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await response.json()) as Json;
    if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
    return data;
  }
  try {
    token = (await call("POST", "/api/auth/signup", { name: "Dara", password: "Dara-secret-1" })).token;

    // The demo group: earlier messages from sample teammates and two meetings, one already started.
    const demo = await call("POST", "/api/groups/demo", {});
    const detail = await call("GET", `/api/groups/${demo.code}`);
    assert.deepEqual(detail.group.members, ["Dara"]);
    assert.equal(detail.meetings.length, 2);
    assert.ok(detail.meetings.some((m: Json) => new Date(m.startsAt) < new Date()));
    assert.deepEqual((store.db.chats[demo.code] ?? []).map((line) => line.author), ["Jun", "Alex", "Jia"]);

    // A meeting without decisions can be removed; one with a decision stays.
    const [first, second] = detail.meetings;
    store.db.decisions.push({ id: "d1", groupCode: demo.code, meetingId: second.id, text: "Ship it", original: "Ship it", agreed: "1/1", createdAt: new Date().toISOString() });
    await call("DELETE", `/api/groups/${demo.code}/meetings/${first.id}`);
    await assert.rejects(call("DELETE", `/api/groups/${demo.code}/meetings/${second.id}`), /already has decisions/);
    assert.deepEqual((await call("GET", `/api/groups/${demo.code}`)).meetings.map((m: Json) => m.id), [second.id]);
  } finally {
    server.close();
  }
});
