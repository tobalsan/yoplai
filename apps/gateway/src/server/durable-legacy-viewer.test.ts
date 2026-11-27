import fs from "node:fs/promises";
import path from "node:path";
import { getUserHistoryDir } from "@yoplai/extension-multi-user/isolation";
import { expect, it } from "vitest";
import { sessionHistoryExtension } from "../session-history/index.js";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";
import { writeTestAgent } from "../test-utils/v3-config.js";

type Gateway = Awaited<ReturnType<typeof startDurableTestGateway>>;
type User = Parameters<Gateway["request"]>[0];
const agent = "/api/agents/pilot";
const legacy = agent + "/legacy-sessions";
const timestamp = 1715342400000;

function startGateway(multiUser: boolean) {
  return startDurableTestGateway({
    multiUser,
    extraConfig: { agents: "agents/*" },
    fixtureExtensions: [sessionHistoryExtension],
    extraYaml: "toolDeferral: { enabled: false }",
  });
}

function text(role: string, value: string, at = timestamp) {
  return { type: "history", role, content: [{ type: "text", text: value }], timestamp: at };
}

function meta(key: string, value: unknown) {
  return { type: "meta", key, value };
}

async function seed(gateway: Gateway, user: User, filename: string, rows: object[]) {
  const dir = getUserHistoryDir(user === "local" ? undefined : gateway.accountId(user), gateway.home);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, filename + ".jsonl");
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

it.each([false, true])("reads the owner's archived chat by its old id without writing (multi-user: %s)", async (multiUser) => {
  const gateway = await startGateway(multiUser);
  const user = multiUser ? "alice" : "local";
  try {
    const url = legacy + "/tile%23plan%25";
    const file = await seed(gateway, user, "pilot-tile#plan%", [
      text("assistant", "Blue tiles are in stock.", timestamp + 1),
      meta("title", "Tile samples"),
      text("user", "Check the tile stock."),
      meta("archived", timestamp + 2),
    ]);
    const before = await fs.readFile(file);
    const files = await fs.readdir(path.dirname(file));

    const result = await gateway.request(user, url);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      agentId: "pilot", sessionId: "tile#plan%", title: "Tile samples", archived: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "Check the tile stock." }], timestamp },
        { role: "assistant", content: [{ type: "text", text: "Blue tiles are in stock." }], timestamp: timestamp + 1 },
      ],
    });
    if (multiUser) expect((await gateway.request("bob", url)).status).toBe(404);
    expect((await gateway.request(user, legacy + "/missing")).status).toBe(404);
    expect((await gateway.request(user, legacy + "/unsafe%2Fid")).status).toBe(400);
    await gateway.setDurableMode(user, false);
    expect((await gateway.request(user, url)).status).toBe(404);

    expect(await fs.readFile(file)).toEqual(before);
    expect(await fs.readdir(path.dirname(file))).toEqual(files);
  } finally {
    await gateway.close();
  }
}, 20_000);

it.each([false, true])("searches canonical private chats and links only real message hits (multi-user: %s)", async (multiUser) => {
  const gateway = await startGateway(multiUser);
  const user = multiUser ? "alice" : "local";
  try {
    await writeTestAgent(gateway.home, { id: "pilot-shelf", extraYaml: "sandbox: { enabled: true }" });
    if (multiUser) await writeTestAgent(gateway.home, { id: "pilot-shelf-shadow" });
    await gateway.configure("fixture");
    const file = await seed(gateway, user, "2024-05-10T00-00-00-000Z_pilot-tiles", [
      text("assistant", "See the cobalt tile.", timestamp + 3),
      text("system", "Internal cobalt tile note."),
      text("user", "Count the green tiles.", timestamp + 1),
      text("assistant", "Inventory is ready.", timestamp + 2),
      meta("title", "Cobalt inventory guide"),
    ]);
    await seed(gateway, user, "2024-05-09T00-00-00-000Z_pilot-tiles", [text("user", "Cobalt tile duplicate marker.")]);
    await seed(gateway, user, "pilot-cli-work", [text("user", "Cobalt tile CLI marker.")]);
    await seed(gateway, user, "pilot-subagent:work", [text("user", "Cobalt tile subagent marker.")]);
    await seed(gateway, user, "pilot-foreign", [
      { ...text("user", "Cobalt tile foreign marker."), agentId: "pilot-shelf", sessionId: "mismatch" },
    ]);
    await seed(gateway, user, "pilot-archived", [text("user", "Cobalt tile archived marker."), meta("archived", timestamp)]);
    await fs.symlink(file, path.join(path.dirname(file), "pilot-symlink.jsonl"));
    await seed(gateway, user, "pilot-shelf-crossing", [
      { ...text("user", "Inspect the glaze."), agentId: "pilot", sessionId: "shelf-crossing" },
      meta("title", "Cobalt tile crossing notes"),
    ]);
    await seed(gateway, user, "pilot-shelf-samples", [
      text("assistant", "Cobalt tile reference.", timestamp + 2),
      text("user", "A question for the bench.", timestamp + 1),
    ]);
    if (multiUser) {
      const hidden = await gateway.request("alice", "/api/admin/forks/pilot-shelf-shadow/visibility", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: '{"public":false}',
      });
      expect(hidden.status).toBe(200);
      const visible = await gateway.request("bob", "/api/agents");
      expect((await visible.json()).map(({ id }: { id: string }) => id).sort()).toEqual(["pilot", "pilot-shelf"]);
      await seed(gateway, "bob", "pilot-shelf-shadow-chat", [text("user", "Cobalt tile hidden agent marker.")]);
    }
    const files = (await fs.readdir(path.dirname(file))).sort();
    const before = await fs.readFile(file);

    const search = async (query: string, caller: User = user) => {
      const response = await gateway.request(caller, "/api/agents/sessions/search?q=" + encodeURIComponent(query));
      expect(response.status).toBe(200);
      const { items } = await response.json();
      return items.map(({ agentId, sessionId, match, legacy, messageIndex, snippet }: Record<string, unknown>) =>
        ({ agentId, sessionId, match, legacy, messageIndex, snippet }));
    };
    const hits = await search("cobalt tile");
    expect(hits).toEqual([
      { agentId: "pilot", sessionId: "shelf-crossing", match: "title", legacy: true },
      { agentId: "pilot-shelf", sessionId: "samples", match: "content", snippet: "Cobalt tile reference.", messageIndex: 1 },
      { agentId: "pilot", sessionId: "tiles", match: "content", legacy: true, messageIndex: 3, snippet: "See the cobalt tile." },
    ]);
    expect(await search("cobalt inventory")).toEqual([
      { agentId: "pilot", sessionId: "tiles", match: "title", legacy: true },
    ]);
    expect(await search("green inventory")).toEqual([
      { agentId: "pilot", sessionId: "tiles", match: "content", legacy: true, snippet: "Count the green tiles." },
    ]);
    if (multiUser) expect(await search("cobalt tile", "bob")).toEqual([]);

    gateway.script(
      { tool: "legacy_history", args: { action: "read", session: "legacy:pilot:tiles#" + hits[2].messageIndex, n: 0 } },
      "Found the purple ceramic.",
    );
    const sent = await gateway.send(user, "Find the latest ceramic sample.", { clientSendId: "ceramic-main" });
    expect(sent.status).toBe(200);
    expect(gateway.requests.at(-1)?.messages).toContainEqual(expect.objectContaining({
      role: "toolResult", toolName: "legacy_history",
      content: [{ type: "text", text: expect.stringContaining("#3 asst 12:00  See the cobalt tile.") }],
    }));
    const feed = await gateway.request(user, agent + "/feed/search?q=purple+ceramic");
    expect(feed.status).toBe(200);
    expect(await feed.json()).toEqual(expect.objectContaining({
      hits: [expect.objectContaining({ snippet: "Found the purple ceramic." })],
    }));
    expect(await search("purple ceramic")).toEqual([]);
    expect(await fs.readFile(file)).toEqual(before);
    expect((await fs.readdir(path.dirname(file))).sort()).toEqual(files);
  } finally {
    await gateway.close();
  }
}, 20_000);

it.each([false, true])("continues an archived chat in an owner-only thread with one handoff (multi-user: %s)", async (multiUser) => {
  const gateway = await startGateway(multiUser);
  const user = multiUser ? "alice" : "local";
  try {
    const url = legacy + "/tile%23plan%2523/continue";
    const file = await seed(gateway, user, "pilot-tile#plan%23", [
      text("user", "Check the tile stock."),
      { ...text("assistant", "Checking the shelf.", timestamp + 1), content: [
        { type: "text", text: "Checking the shelf." },
        { type: "toolCall", id: "stock", name: "count_tiles", arguments: { shelf: "Blue" } },
      ] },
      { ...text("toolResult", "Six tiles", timestamp + 2), toolCallId: "stock", toolName: "count_tiles" },
      text("assistant", "Blue tiles are in stock.", timestamp + 3),
      meta("title", "Tile samples\nPurchased yesterday"),
      meta("archived", timestamp + 4),
    ]);
    await fs.writeFile(path.join(gateway.home, "tool-labels.json"), JSON.stringify({ count_tiles: "Counted {shelf} tiles" }));
    const files = (await fs.readdir(path.dirname(file))).sort();
    const before = await fs.readFile(file);
    gateway.script(
      { tool: "plan_update", args: { goals: ["Finish the backsplash."], nextSteps: [] } },
      "Plan saved.",
    );
    const plan = await gateway.send(user, "Remember what we are working on.", { clientSendId: "tile-plan" });
    expect(plan.status).toBe(200);
    expect(await plan.json()).toMatchObject({ payloads: [{ text: "Plan saved." }] });
    const firstThreadRequest = gateway.requests.length;

    const post = (target: string, caller: User = user) => gateway.request(caller, target, { method: "POST" });
    if (multiUser) {
      expect((await post(url, "bob")).status).toBe(404);
      expect(await (await gateway.request("bob", agent + "/threads")).json()).toEqual([]);
    }
    expect((await post(legacy + "/unsafe%2Fid/continue")).status).toBe(400);
    expect((await post(legacy + "/missing/continue")).status).toBe(404);
    expect(await (await gateway.request(user, agent + "/threads")).json()).toEqual([]);

    const continued = await post(url);
    expect(continued.status).toBe(201);
    const thread = await continued.json();
    expect(thread).toEqual({
      id: expect.any(String), title: "Tile samples", preview: "", createdAt: expect.any(Number),
      lastActivityAt: thread.createdAt, closed: false, generation: 1,
    });
    expect(await (await gateway.request(user, agent + "/threads")).json()).toEqual([thread]);
    expect(gateway.requests).toHaveLength(firstThreadRequest);
    const sessionId = "thread:" + thread.id;
    if (multiUser) {
      expect(await (await gateway.request("bob", agent + "/threads")).json()).toEqual([]);
      expect((await gateway.request("bob", agent + "/feed?thread=" + thread.id)).status).toBe(404);
      expect((await gateway.send("bob", "Try the private thread.", { sessionId, clientSendId: "tile-bob" })).status).toBe(404);
    }

    gateway.script("Ready to discuss the tiles.");
    const first = await gateway.send(user, "Continue with blue tiles.", { sessionId, clientSendId: "tile-first" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ payloads: [{ text: "Ready to discuss the tiles." }] });
    const firstMessage = gateway.requests[firstThreadRequest]?.messages.find(({ role }) => role === "user");
    const handoff = typeof firstMessage?.content === "string" ? firstMessage.content : "";
    expect(handoff).toMatch(/^## Memory\n- Goal: Finish the backsplash\./);
    expect(handoff).toContain("Counted Blue tiles");
    expect(handoff).toContain("[legacy:pilot:tile%23plan%2523#3]");
    expect(handoff).toMatch(/legacy_history[^\n]*includeArchived: true[^\n]*$/);
    const anchor = /\[(legacy:pilot:[^\]]+#3)\]/.exec(handoff)?.[1] ?? "";

    gateway.script(
      { tool: "legacy_history", args: { action: "read", session: anchor, includeArchived: true, n: 0 } },
      "Recovered the old reply.",
    );
    const nextRequest = gateway.requests.length;
    const followup = await gateway.send(user, "Read the old reply.", { sessionId, clientSendId: "tile-follow-up" });
    expect(followup.status).toBe(200);
    expect(await followup.json()).toMatchObject({ payloads: [{ text: "Recovered the old reply." }] });
    const prompts = gateway.requests[nextRequest]?.messages.flatMap((message) =>
      message.role === "user" && typeof message.content === "string" ? [message.content] : []);
    expect(prompts?.filter((prompt) => prompt.includes("Finish the backsplash."))).toHaveLength(1);
    expect(gateway.requests.at(-1)?.messages).toContainEqual(expect.objectContaining({
      role: "toolResult", toolName: "legacy_history",
      content: [{ type: "text", text: expect.stringContaining("#3 asst 12:00  Blue tiles are in stock.") }],
    }));

    await gateway.setDurableMode(user, false);
    expect((await post(url)).status).toBe(404);
    expect(await fs.readFile(file)).toEqual(before);
    expect((await fs.readdir(path.dirname(file))).sort()).toEqual(files);
  } finally {
    await gateway.close();
  }
}, 20_000);

it("enforces agent access when an agent id is also an aggregate route name", async () => {
  const gateway = await startGateway(true);
  try {
    await writeTestAgent(gateway.home, { id: "sessions" });
    await gateway.configure("fixture");
    await seed(gateway, "bob", "sessions-tile-notes", [text("user", "Old notes from before access changed.")]);
    const path = "/api/agents/sessions/legacy-sessions/tile-notes";
    expect((await gateway.request("bob", path)).status).toBe(200);

    const restricted = await gateway.request("alice", "/api/admin/forks/sessions/visibility", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: '{"public":false}',
    });
    expect(restricted.status).toBe(200);
    expect((await gateway.request("bob", path)).status).toBe(403);
    expect((await gateway.request("bob", path + "/continue", { method: "POST" })).status).toBe(403);
  } finally {
    await gateway.close();
  }
}, 20_000);
