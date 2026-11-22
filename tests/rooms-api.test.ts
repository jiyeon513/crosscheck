// The room API used by the chat UI (server/rooms.ts), end to end over HTTP with offline fixture models.
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { Card, UserView } from "../agents/protocol";
import { startServer } from "../server/index";
import { enableFixtureModels } from "./mocks";

process.env.STREAM_API_KEY = "";
process.env.STREAM_API_SECRET = "";
enableFixtureModels();

type GroupLine = UserView["group"][number] & { quote?: { author: string; text: string } };
type View = Omit<UserView, "group"> & { group: GroupLine[] };
const cards = (view: View): Card[] => view.private.flatMap((item) => (item.type === "card" ? [item.card] : []));

test("a group meeting: seeded history, private suggestion, anonymous share, agreement and decision", async () => {
  const server = startServer(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tokens = new Map<string, string>();
  let roomKey = "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(method: string, path: string, user: string, body?: object): Promise<any> {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", "X-CrossCheck-Session": tokens.get(user) ?? "" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
    return data;
  }
  const join = async (user: string, extra: object = {}) => {
    const result = await call("POST", "/api/rooms/join", user, {
      code: "cs473", user, groupTitle: "CS473", meeting: { id: "mtg-topic", title: "Topic meeting" }, ...extra,
    });
    tokens.set(user, result.sessionToken);
    roomKey = result.roomKey;
  };
  const view = (user: string): Promise<View> => call("GET", `/api/rooms/${roomKey}/view`, user);
  const post = (user: string, action: string, body: object) => call("POST", `/api/rooms/${roomKey}/${action}`, user, body);
  async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean) {
    for (let i = 0; i < 50; i++) {
      const value = await read();
      if (ok(value)) return value;
      await delay(20);
    }
    throw new Error("timed out");
  }

  try {
    await join("Minsu", { history: [{ author: "Jun", text: "Earlier meeting note.", createdAt: "2026-11-10T05:00:00Z" }] });
    await join("Jiwoo");
    await join("Taeho");
    assert.equal(roomKey, "cs473.mtg-topic");

    // Earlier chat seeds the room; the host is the first person in.
    let minsu = await view("Minsu");
    assert.equal(minsu.isHost, true);
    assert.deepEqual(minsu.group.map((m) => m.text), ["Earlier meeting note."]);
    assert.deepEqual(minsu.participants, ["Minsu", "Jiwoo", "Taeho"]);

    // The same name from another tab without its token is refused.
    await assert.rejects(
      fetch(base + "/api/rooms/join", {
        method: "POST",
        body: JSON.stringify({ code: "cs473", user: "Taeho", meeting: { id: "mtg-topic" } }),
      }).then(async (r) => { if (!r.ok) throw new Error(String(r.status)); }),
      /403/,
    );

    // Taeho thinks privately; Jiwoo posts a related idea; Taeho's agent suggests a draft only to Taeho.
    await post("Taeho", "private", { text: "I found that campus Wi-Fi access counts are public." });
    await post("Jiwoo", "group", { text: "What about predicting how crowded the cafeteria gets?" });
    const taeho = await until(() => view("Taeho"), (v) => cards(v).some((c) => c.kind === "share_suggestion"));
    const suggestion = cards(taeho).find((c) => c.kind === "share_suggestion")!;
    assert.equal(cards(await view("Jiwoo")).some((c) => c.kind === "share_suggestion"), false);

    // Taeho shares it without his name.
    await post("Taeho", "share", { cardId: suggestion.id, text: "Wi-Fi counts could measure crowding.", mode: "anonymous" });
    minsu = await until(() => view("Minsu"), (v) => v.group.some((m) => m.anonymous));
    const shared = minsu.group.find((m) => m.anonymous)!;
    assert.equal(shared.author, "Anonymous");

    // A forwarded quote travels with the post for the UI.
    await post("Jiwoo", "group", { text: "", quote: { author: "Agent", text: "Peak hours are 12-1." } });
    minsu = await until(() => view("Minsu"), (v) => v.group.some((m) => m.quote));
    assert.equal(minsu.group.find((m) => m.quote)!.text, "Peak hours are 12-1.");

    // A decision opens a private check for everyone; matching answers and approvals record it.
    await post("Minsu", "group", { text: "Let's go with crowding prediction for the library and cafeteria." });
    await until(() => view("Minsu"), (v) => v.agreement?.status === "collecting");
    for (const user of ["Minsu", "Jiwoo", "Taeho"]) {
      const check = cards(await view(user)).find((c) => c.kind === "understanding_check")!;
      assert.ok(check && check.kind === "understanding_check");
      await post(user, "check/answer", { checkId: check.checkId, label: "Library and cafeteria only", approve: true });
    }
    minsu = await until(() => view("Minsu"), (v) => v.decisions.length === 1);
    assert.equal(minsu.agreement?.status, "aligned");
    assert.match(minsu.group.at(-1)!.text, /^Agreed 3\/3\./);

    // Privacy: nobody else's view contains Taeho's private note.
    for (const user of ["Minsu", "Jiwoo"]) {
      assert.equal(JSON.stringify(await view(user)).includes("Wi-Fi access counts are public"), false);
    }
  } finally {
    server.close();
  }
});
