import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import { getUserHistoryDir } from "@yoplai/extension-multi-user/isolation";
import { GatewayConfigSchema } from "@yoplai/shared";
import { expect, it } from "vitest";
import { durableCoreTools } from "../durable/core-tools.js";
import { sessionHistoryExtension } from "../session-history/index.js";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";
import { writeTestAgent } from "../test-utils/v3-config.js";

type Gateway = Awaited<ReturnType<typeof startDurableTestGateway>>;
type User = Parameters<Gateway["send"]>[0];
const timestamp = Date.parse("2024-05-10T12:00:00Z");

function startGateway(multiUser: boolean) {
  return startDurableTestGateway({
    multiUser,
    fixtureExtensions: [sessionHistoryExtension],
    extraYaml: "toolDeferral: { enabled: false }",
  });
}

async function seed(gateway: Gateway, user: User, filename: string, rows: object[]) {
  const dir = getUserHistoryDir(user === "local" ? undefined : gateway.accountId(user), gateway.home);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, filename + ".jsonl");
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

function text(role: string, value: string, at = timestamp) {
  return { type: "history", role, content: [{ type: "text", text: value }], timestamp: at };
}

function meta(key: string, value: unknown) {
  return { type: "meta", key, value };
}

async function call(gateway: Gateway, user: User, args: Record<string, JsonValue>, sessionId?: string) {
  const start = gateway.requests.length;
  gateway.script({ tool: "legacy_history", args }, "Lookup complete.");
  const response = await gateway.send(user, "Look up the old chat.", { clientSendId: "lookup-" + start, sessionId });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ payloads: [{ text: "Lookup complete." }] });
  return gateway.requests.at(-1)?.messages.filter((message) => message.role === "toolResult").at(-1);
}

async function lookup(gateway: Gateway, user: User, args: Record<string, JsonValue>, sessionId?: string) {
  const result = await call(gateway, user, args, sessionId);
  expect(result).toMatchObject({ toolName: "legacy_history", isError: false, content: [{ type: "text" }] });
  const block = result?.content[0];
  return block?.type === "text" ? block.text : "";
}

it.each([false, true])("lists private legacy sessions by activity and paginates (multi-user: %s)", async (multiUser) => {
  const gateway = await startGateway(multiUser);
  const user = multiUser ? "alice" : "local";
  try {
    await seed(gateway, user, "2024-05-09T00-00-00-000Z_pilot-older", [
      text("user", "First orchard report", timestamp - 86400000),
    ]);
    await seed(gateway, user, "2024-05-10T00-00-00-000Z_pilot-chat", [
      text("user", "Inspect the crate"), text("assistant", "Crate inspected"), meta("title", "Crate\nplans"),
    ]);
    expect(await lookup(gateway, user, { action: "list", limit: 1 })).toBe(
      "legacy:pilot:chat · 2024-05-10 12:00 · 2 msgs · Crate plans\nmore: list cursor=1",
    );
    expect(gateway.offeredTools(0)).toContain("legacy_history");
    expect(await lookup(gateway, user, { action: "list", cursor: "1" })).toBe(
      "legacy:pilot:older · 2024-05-09 12:00 · 1 msgs · First orchard report",
    );
    expect(await lookup(gateway, user, { action: "list", since: "2024-05-11" })).toBe("no sessions");
  } finally {
    await gateway.close();
  }
}, 20000);

it.each([false, true])("searches with sidebar word matching and returns real anchors (multi-user: %s)", async (multiUser) => {
  const gateway = await startGateway(multiUser);
  const user = multiUser ? "alice" : "local";
  try {
    await seed(gateway, user, "2024-05-10T00-00-00-000Z_pilot-chat", [
      text("system", "Hidden system"),
      text("user", "Check the spruce shelf", timestamp + 60000),
      { ...text("assistant", "", timestamp + 120000), content: [
        { type: "toolCall", id: "probe", name: "inspect", arguments: { path: "argument-only" } },
      ] },
      { ...text("toolResult", "result-only", timestamp + 180000), toolCallId: "probe", toolName: "inspect" },
      text("assistant", "The fern is under the crate", timestamp + 240000),
      text("user", "Move the crate near the fern", timestamp + 300000),
      meta("title", "Orchard inventory"),
    ]);
    const search = (query: string, extra = {}) => lookup(gateway, user, { action: "search", query, ...extra });
    expect(await search("INVENTORY orchard")).toBe("legacy:pilot:chat · Orchard inventory");
    expect(await search("orchard spruce")).toBe("legacy:pilot:chat · Check the spruce shelf");
    expect(await search("spruce fern")).toBe("legacy:pilot:chat · Check the spruce shelf");
    expect(await search("FERN crate", { role: "system", session: "legacy:pilot:chat" })).toBe(
      "legacy:pilot:chat#5 user 2024-05-10 12:05  Move the crate near the fern\n" +
      "legacy:pilot:chat#4 asst 2024-05-10 12:04  The fern is under the crate",
    );
    expect(await search("fern crate", { limit: 1 })).toBe(
      "legacy:pilot:chat#5 user 2024-05-10 12:05  Move the crate near the fern\n" +
      "more: results capped at limit=1; narrow the query or raise limit",
    );
    for (const query of ["argument-only", "result-only", "Hidden system", "fern missing"]) {
      expect(await search(query)).toBe("no matches");
    }
  } finally {
    await gateway.close();
  }
}, 20000);

it.each([false, true])("reads a condensed transcript and drills down with returned IDs (multi-user: %s)", async (multiUser) => {
  const gateway = await startGateway(multiUser);
  const user = multiUser ? "alice" : "local";
  try {
    const report = "Fern inventory " + "x".repeat(320);
    await seed(gateway, user, "2024-05-10T00-00-00-000Z_pilot-chat", [
      text("user", "Open the orchard"),
      { ...text("assistant", report, timestamp + 60000), content: [
        { type: "text", text: report },
        { type: "toolCall", id: "probe", name: "inspect", arguments: { path: "crate" } },
      ] },
      { ...text("toolResult", "done", timestamp + 120000), toolCallId: "probe", toolName: "inspect" },
      text("user", "Close the orchard", timestamp + 180000),
      meta("title", "Orchard records"),
    ]);
    await seed(gateway, user, "2024-05-09T00-00-00-000Z_pilot-chat#12", [text("user", "Whole hash chat")]);
    await seed(gateway, user, "2024-05-08T00-00-00-000Z_pilot-chat:%23", [text("user", "Percent and colon chat")]);

    const hit = await lookup(gateway, user, { action: "search", query: "inventory fern" });
    expect(hit).toMatch(/^legacy:pilot:chat#1 asst /);
    const read = (session: string, extra = {}) => lookup(gateway, user, { action: "read", session, ...extra });
    const centered = await read(hit.split(" ")[0], { n: 0 });
    expect(centered.split("\n")).toEqual([
      "session legacy:pilot:chat · 4 msgs · showing #1–#1",
      expect.stringMatching(/^#1 asst 12:01 {2}Fern inventory x+… \[\+35 chars · read full=1\]$/),
      "    → inspect crate (ok, 4 chars)",
    ]);
    expect(await read("legacy:pilot:chat", { full: 1 })).toContain(report);
    expect(await read("legacy:pilot:chat#1", { from: 3, to: 3 })).toContain("#3 user 12:03  Close the orchard");
    expect(await read("legacy:pilot:chat#1", { around: 0, n: 0, role: "user" })).toBe(
      "session legacy:pilot:chat · 4 msgs · showing #0–#0\n#0 user 12:00  Open the orchard",
    );
    expect(await read("legacy:pilot:chat")).toContain("#0 user 12:00  Open the orchard");
    expect(await read("legacy:pilot:chat%2312")).toContain("Whole hash chat");
    expect(await read("legacy:pilot:chat:%2523")).toContain("Percent and colon chat");
    const rows = (await lookup(gateway, user, { action: "list" })).split("\n");
    expect(rows.map((row) => row.split(" · ")[0])).toEqual(expect.arrayContaining([
      "legacy:pilot:chat", "legacy:pilot:chat%2312", "legacy:pilot:chat:%2523",
    ]));
  } finally {
    await gateway.close();
  }
}, 20000);

it.each([false, true])("rechecks archive and deletion without writing history (multi-user: %s)", async (multiUser) => {
  const gateway = await startGateway(multiUser);
  const user = multiUser ? "alice" : "local";
  try {
    const file = await seed(gateway, user, "2024-05-10T00-00-00-000Z_pilot-archived", [
      text("user", "The hidden pear"), meta("title", "Old field notes"), meta("archived", timestamp),
    ]);
    const dir = path.dirname(file);
    const snapshot = async () => ({
      files: await fs.readdir(dir),
      mtime: (await fs.stat(file)).mtimeMs,
      bytes: await fs.readFile(file),
    });
    const before = await snapshot();
    const session = "legacy:pilot:archived";
    const list = { action: "list" };
    const search = { action: "search", query: "hidden pear" };
    const read = { action: "read", session };
    expect(await lookup(gateway, user, list)).toBe("no sessions");
    expect(await lookup(gateway, user, search)).toBe("no matches");
    expect(await lookup(gateway, user, read)).toBe("no such session: legacy:pilot:archived");
    expect(await lookup(gateway, user, { ...list, includeArchived: true })).toContain(session);
    expect(await lookup(gateway, user, { ...search, includeArchived: true })).toContain("legacy:pilot:archived#0");
    expect(await lookup(gateway, user, { ...read, includeArchived: true })).toContain("The hidden pear");
    expect(await snapshot()).toEqual(before);

    await fs.unlink(file);
    expect(await lookup(gateway, user, { ...read, includeArchived: true })).toBe("no such session: legacy:pilot:archived");
    expect(await fs.readdir(dir)).toEqual([]);
  } finally {
    await gateway.close();
  }
}, 20000);

it("resolves IDs inside the authenticated user's history, including identical IDs", async () => {
  const gateway = await startGateway(true);
  try {
    await seed(gateway, "alice", "pilot-chat", [text("user", "Alice's yellow peaches")]);
    await seed(gateway, "bob", "pilot-chat", [text("user", "Bob's purple plums")]);
    await seed(gateway, "bob", "pilot-bob-only", [text("user", "Bob's private persimmons")]);
    expect(await lookup(gateway, "alice", { action: "list" })).toMatch(/^legacy:pilot:chat · [^\n]+Alice's yellow peaches$/);
    expect(await lookup(gateway, "alice", { action: "search", query: "private persimmons" })).toBe("no matches");
    expect(await lookup(gateway, "alice", { action: "read", session: "legacy:pilot:bob-only" }))
      .toBe("no such session: legacy:pilot:bob-only");
    for (const [user, expected] of [["alice", "Alice's yellow peaches"], ["bob", "Bob's purple plums"]] as const) {
      expect(await lookup(gateway, user, { action: "read", session: "legacy:pilot:chat" })).toMatch(
        new RegExp("^session legacy:pilot:chat · 1 msgs · showing #0–#0\\n#0 user 12:00  " + expected + "$"),
      );
    }
  } finally {
    await gateway.close();
  }
}, 20000);

it("uses the newest file for a repeated session ID before applying archive or search filters", async () => {
  const gateway = await startGateway(false);
  try {
    await seed(gateway, "local", "2024-05-08T00-00-00-000Z_pilot-chat", [
      text("user", "Old record"), text("assistant", "The old code is copper", timestamp + 1),
    ]);
    const newest = "2024-05-09T00-00-00-000Z_pilot-chat";
    const rows = [text("user", "New record"), text("assistant", "The new code is silver")];
    await seed(gateway, "local", newest, rows);
    expect(await lookup(gateway, "local", { action: "list" })).toBe(
      "legacy:pilot:chat · 2024-05-10 12:00 · 2 msgs · New record",
    );
    expect(await lookup(gateway, "local", { action: "search", query: "copper" })).toBe("no matches");
    const hit = await lookup(gateway, "local", { action: "search", query: "silver" });
    expect(hit).toMatch(/^legacy:pilot:chat#1 /);
    expect(await lookup(gateway, "local", { action: "read", session: hit.split(" ")[0], n: 0 }))
      .toContain("The new code is silver");
    await seed(gateway, "local", newest, [...rows, meta("archived", timestamp)]);
    expect(await lookup(gateway, "local", { action: "list" })).toBe("no sessions");
    expect(await lookup(gateway, "local", { action: "read", session: "legacy:pilot:chat" }))
      .toBe("no such session: legacy:pilot:chat");
  } finally {
    await gateway.close();
  }
}, 20000);

it.each(["mixed owners", "a symlink"])("does not expose foreign text through %s", async (kind) => {
  const gateway = await startGateway(true);
  try {
    const own = await seed(gateway, "alice", "pilot-ordinary", [text("user", "Alice's field record")]);
    if (kind === "mixed owners") {
      await seed(gateway, "alice", "pilot-blue-chat", [
        { ...text("user", "Original row"), agentId: "pilot", sessionId: "blue-chat" },
        { ...text("assistant", "Foreign canary"), agentId: "pilot-blue", sessionId: "chat" },
      ]);
    } else {
      const target = await seed(gateway, "bob", "pilot-blue-chat", [text("user", "Foreign canary")]);
      await fs.symlink(target, path.join(path.dirname(own), "pilot-blue-chat.jsonl"));
    }
    const list = await lookup(gateway, "alice", { action: "list" });
    expect(list).toMatch(/^legacy:pilot:ordinary · [^\n]+Alice's field record$/);
    expect(await lookup(gateway, "alice", { action: "search", query: "Foreign canary" })).toBe("no matches");
    expect(await lookup(gateway, "alice", { action: "read", session: "legacy:pilot:blue-chat" }))
      .toBe("no such session: legacy:pilot:blue-chat");
  } finally {
    await gateway.close();
  }
}, 20000);

it.each([false, true])("never widens to another agent or a legacy Main project (multi-user: %s)", async (multiUser) => {
  const gateway = await startDurableTestGateway({
    multiUser,
    fixtureExtensions: [sessionHistoryExtension],
    extraConfig: { agents: "agents/*" },
    extraYaml: "toolDeferral: { enabled: false }",
  });
  const user = multiUser ? "alice" : "local";
  try {
    await writeTestAgent(gateway.home, { id: "pilot-blue", model: { provider: "faux", model: "fixture" } });
    await gateway.configure("fixture");
    const project = await gateway.request(user, "/api/chat-projects", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Shared orchard" }),
    });
    expect(project.status).toBe(201);
    const { id: projectId } = await project.json();
    await seed(gateway, user, "pilot-durable-main", [text("user", "Old Main orchard"), meta("project", projectId)]);
    await seed(gateway, user, "pilot-blue-ownerless", [text("user", "Ownerless honeysuckle"), meta("project", projectId)]);
    await seed(gateway, user, "2024-05-01T00-00-00-000Z_pilot-blue-chat", [
      { ...text("user", "My private apricots"), agentId: "pilot", sessionId: "blue-chat" }, meta("project", projectId),
    ]);
    await seed(gateway, user, "2024-05-02T00-00-00-000Z_pilot-blue-chat", [
      { ...text("user", "Foreign project quinces"), agentId: "pilot-blue", sessionId: "chat" }, meta("project", projectId),
    ]);

    const rows = (await lookup(gateway, user, { action: "list" })).split("\n");
    expect(rows.map((row) => row.split(" · ")[0]).sort()).toEqual(["legacy:pilot:blue-chat", "legacy:pilot:durable-main"]);
    expect(await lookup(gateway, user, { action: "search", query: "honeysuckle" })).toBe("no matches");
    expect(await lookup(gateway, user, { action: "search", query: "quinces" })).toBe("no matches");
    expect(await lookup(gateway, user, { action: "search", query: "apricots" }))
      .toBe("legacy:pilot:blue-chat · My private apricots");
    expect(await lookup(gateway, user, { action: "read", session: "legacy:pilot-blue:chat" }))
      .toBe("no such session: legacy:pilot-blue:chat");
    expect(await lookup(gateway, user, { action: "read", session: "legacy:pilot:blue-chat" }))
      .toBe("session legacy:pilot:blue-chat · 1 msgs · showing #0–#0\n#0 user 12:00  My private apricots");
  } finally {
    await gateway.close();
  }
}, 20000);

it.each([false, true])("offers history in private Durable threads (multi-user: %s)", async (multiUser) => {
  const gateway = await startGateway(multiUser);
  const user = multiUser ? "alice" : "local";
  try {
    await seed(gateway, user, "pilot-chat", [text("user", "The tangerines are in the pantry")]);
    const response = await gateway.request(user, "/api/agents/pilot/threads", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(201);
    const { id } = await response.json();
    expect(await lookup(gateway, user, { action: "read", session: "legacy:pilot:chat" }, "thread:" + id))
      .toContain("The tangerines are in the pantry");
    expect(gateway.offeredTools(0)).toContain("legacy_history");
  } finally {
    await gateway.close();
  }
}, 20000);

it.each([
  ["root", { sessionHistory: { enabled: false } }, "", [sessionHistoryExtension]],
  ["agent", {}, "extensions:\n  sessionHistory: { enabled: false }", [sessionHistoryExtension]],
  ["runtime", {}, "", []],
] as const)("does not offer the tool when disabled at %s", async (_label, extraConfig, yaml, extensions) => {
  const gateway = await startDurableTestGateway({
    fixtureExtensions: [...extensions], extraConfig, extraYaml: "toolDeferral: { enabled: false }\n" + yaml,
  });
  try {
    const result = await call(gateway, "local", { action: "list" });
    expect(gateway.offeredTools(0)).not.toContain("legacy_history");
    expect(result).toMatchObject({ isError: true });
  } finally {
    await gateway.close();
  }
}, 20000);

it("rejects a tool filter while the conversation continues", async () => {
  const gateway = await startGateway(false);
  try {
    expect(await call(gateway, "local", { action: "search", query: "fixture", tool: "inspect" })).toMatchObject({
      isError: true, content: [{ text: expect.stringMatching(/invalid_input.*tool filter/) }],
    });
  } finally {
    await gateway.close();
  }
}, 20000);

it("omits legacy history unless the trusted Durable caller opts in", () => {
  const config = GatewayConfigSchema.parse({ agents: [] });
  expect(durableCoreTools(config).map(({ name }) => name)).not.toContain("legacy_history");
});

it("keeps legacy history out of the legacy runner even with a Durable-looking session ID", async () => {
  const offered = new Map<string, string[]>();
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] } = JSON.parse(body);
    const turn = input.messages.reverse().find(({ role }) => role === "user");
    const marker = /Verify legacy dispatch (archive|durable-main)\./.exec(JSON.stringify(turn?.content ?? ""))?.[1];
    if (marker && input.tools) offered.set(marker, input.tools.map(({ function: tool }) => tool.name));
    response.writeHead(200, { "Content-Type": "text/event-stream" }).end([
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Legacy reply."},"finish_reason":null}]}',
      'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]\n\n",
    ].join("\n\n"));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  try {
    const { port } = provider.address() as AddressInfo;
    const gateway = await startDurableTestGateway({
      enableDurableMode: false,
      fixtureExtensions: [sessionHistoryExtension],
      customModel: {
        provider: "orchard-models", model: "small", apiKey: "fixture-key", baseUrl: `http://127.0.0.1:${port}/v1`,
      },
      extraYaml: "toolDeferral: { enabled: false }",
    });
    try {
      for (const sessionId of ["archive", "durable-main"]) {
        const result = await gateway.send("local", `Verify legacy dispatch ${sessionId}.`, { sessionId });
        expect(result.status).toBe(200);
        expect(await result.json()).toMatchObject({ payloads: [{ text: "Legacy reply." }], meta: { sessionId } });
      }
      for (const sessionId of ["archive", "durable-main"]) {
        expect(offered.get(sessionId)).toContain("session_history");
        expect(offered.get(sessionId)).not.toContain("legacy_history");
      }
    } finally {
      await gateway.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
}, 20000);
