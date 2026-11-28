import fs from "node:fs/promises";
import path from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai-durable";
import type { Extension, FeedWindow } from "@yoplai/shared";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { sessionHistoryExtension } from "../session-history/index.js";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

type Gateway = Awaited<ReturnType<typeof startDurableTestGateway>>;
type User = Parameters<Gateway["request"]>[0];

async function post(gateway: Gateway, user: User, path: string, body: object) {
  const response = await gateway.request(user, path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}

async function createRoom(gateway: Gateway, user: User, name: string) {
  const { id } = await post(gateway, user, "/api/chat-projects", { name }) as { id: string };
  const path = `/api/rooms/${id}`;
  await post(gateway, user, `${path}/agents`, { agentId: "pilot" });
  return { id, path };
}

function say(gateway: Gateway, user: User, path: string, clientSendId: string, message: string) {
  return post(gateway, user, `${path}/messages`, { clientSendId, message });
}

async function roomFeed(gateway: Gateway, user: User, path: string) {
  const response = await gateway.request(user, `${path}/feed`);
  expect(response.status).toBe(200);
  return (await response.json() as FeedWindow).items;
}

async function waitForAnswer(gateway: Gateway, user: User, path: string, text: string) {
  await vi.waitFor(async () => expect((await roomFeed(gateway, user, path)).at(-1)).toMatchObject({ role: "assistant", text }));
}

it("lists only the current room and counts messages from its public feed", async () => {
  const gateway = await startDurableTestGateway({
    multiUser: true, fixtureExtensions: [sessionHistoryExtension], extraYaml: "toolDeferral: { enabled: false }",
  });
  try {
    const room = await createRoom(gateway, "alice", "Orchard");
    await createRoom(gateway, "alice", "Workshop");
    gateway.script("Private note recorded.");
    expect((await gateway.send("alice", "My inventory is private.", { clientSendId: "main" })).status).toBe(200);
    const request = gateway.callCount();
    gateway.script({ tool: "session_history", args: { action: "list" } }, "Room history listed.");
    await say(gateway, "alice", room.path, "list", "@pilot List this room's history.");
    await waitForAnswer(gateway, "alice", room.path, "Room history listed.");
    expect(gateway.offeredTools(request)).toContain("session_history");
    expect(gateway.requests.at(-1)?.messages.filter(({ role }) => role === "toolResult")).toMatchObject([{
      toolName: "session_history", isError: false, content: [{ text: expect.stringMatching(new RegExp(
        `^room:${room.id} · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d · 1 msgs · @pilot List this room's history\\. ★ CURRENT CONVERSATION$`,
      )) }],
    }]);
  } finally {
    await gateway.close();
  }
}, 20_000);

it("searches and reads room log messages by their public IDs", async () => {
  const gateway = await startDurableTestGateway({
    multiUser: true, fixtureExtensions: [sessionHistoryExtension], extraYaml: "toolDeferral: { enabled: false }",
  });
  try {
    const room = await createRoom(gateway, "alice", "Orchard");
    const other = await createRoom(gateway, "alice", "Workshop");
    await say(gateway, "alice", other.path, "other", "The workshop has an Obsidian compass.");
    gateway.script("Inventory filed.", "Thread inventory filed.");
    expect((await gateway.send("alice", "The private inventory contains a Citrine vase.", { clientSendId: "main" })).status).toBe(200);
    const thread = await post(gateway, "alice", "/api/agents/pilot/threads", {}) as { id: string };
    expect((await gateway.send("alice", "The thread inventory contains a Citrine clock.", {
      clientSendId: "thread", sessionId: `thread:${thread.id}`,
    })).status).toBe(200);
    expect(await say(gateway, "alice", room.path, "room-note", "The orchard keeps a Lapis marker.")).toMatchObject({ id: "r_1" });
    const firstRequest = gateway.callCount();
    const roomRef = `room:${room.id}`;
    const otherRef = `room:${other.id}`;
    const calls: Record<string, string | number>[] = [
      { action: "search", query: "LAPIS", role: "user", since: "2000-01-01", until: "2100-01-01" },
      { action: "search", query: "Citrine" },
      { action: "search", query: "Obsidian" },
      { action: "read", session: "durable-main" },
      { action: "read", session: `thread:${thread.id}` },
      { action: "read", session: otherRef },
      { action: "read", session: roomRef, around: "r_1", n: 0 },
      { action: "read", from: "r_1", to: "r_1" },
      { action: "read", full: "r_1" },
    ];
    gateway.script(...calls.map((args) => ({ tool: "session_history", args })), "Room archive checked.");
    await say(gateway, "alice", room.path, "lookups", "@pilot Review the orchard archive.");
    await waitForAnswer(gateway, "alice", room.path, "Room archive checked.");

    const roomMessage = /\[r_1\] user .* {2}The orchard keeps a Lapis marker\.$/;
    const results = gateway.requests.at(-1)?.messages.filter(({ role }) => role === "toolResult");
    expect(results).toMatchObject([
      roomMessage, /no matches$/, /no matches$/, "no such session: durable-main",
      `no such session: thread:${thread.id}`, `no such session: ${otherRef}`,
      roomMessage, roomMessage, roomMessage,
    ].map((text) => ({
      toolName: "session_history", isError: false,
      content: [{ text: text instanceof RegExp ? expect.stringMatching(text) : text }],
    })));
    expect(JSON.stringify(getCurrentTools(gateway.requests[firstRequest]?.messages ?? []))).toContain("r_<n>");
    expect(JSON.stringify(getCurrentTools(gateway.requests[firstRequest]?.messages ?? []))).not.toMatch(/m_<n>|durable-main|legacy_history/);
  } finally {
    await gateway.close();
  }
}, 20_000);

const resourceTool = "orchard_report";
const teamToken = "fixture-orchard-team";
const noReport = "No orchard report in this conversation.";

function resourceFixture() {
  const executions: Array<{
    userId?: string; actorKind?: string; token?: string; folder: string; sessionId?: string; report?: string;
  }> = [];
  let barrier: Promise<void> | undefined;
  const extension: Extension = {
    id: "orchard", displayName: "Orchard fixture", description: "Fixture resources",
    dependencies: [], routePrefixes: [], requiredSecrets: ["apiToken"],
    configSchema: z.object({ apiToken: z.string().optional() }),
    validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes() {}, async start() {}, async stop() {}, capabilities: () => [],
    getAgentTools(_agent, hook) {
      const token = (hook?.config.extensions?.orchard as { apiToken?: string } | undefined)?.apiToken;
      return [{
        name: resourceTool, description: "Read the conversation's orchard report.",
        parameters: { type: "object", properties: {} },
        async execute(_args, context) {
          const folder = context.conversationFiles?.hostPath;
          if (!folder) throw new Error("Missing conversation files");
          const report = await fs.readFile(path.join(folder, "report.txt"), "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          });
          executions.push({ userId: context.userId, actorKind: context.actorKind, token, folder, sessionId: context.sessionId, report });
          await barrier;
          return report ?? noReport;
        },
      }];
    },
  };
  return {
    extension, executions,
    hold() {
      let release!: () => void;
      barrier = new Promise<void>((resolve) => { release = resolve; });
      return release;
    },
  };
}

const resourceYaml = `codemode: true
toolDeferral: { enabled: false }
extensions: { orchard: { enabled: true, apiToken: ${teamToken} } }`;

it("keeps room tool scope fixed through both members' steers and refuses private tools", async () => {
  const fixture = resourceFixture();
  let delivered = 0;
  let release: (() => void) | undefined;
  const gateway = await startDurableTestGateway({
    multiUser: true, extraYaml: resourceYaml, fixtureExtensions: [fixture.extension, sessionHistoryExtension],
    keeper: { idleMs: 60_000, turns: 1 },
    afterRoomCommit({ lastSeq }) { delivered = lastSeq; },
  });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const topic = "Saffron graft schedule";
  const plan = "Move the saffron grafts indoors";
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockImplementation(async ({ prompt }) => JSON.stringify({
    topics: prompt.includes("Remember the graft delivery.") ? [{ kind: "open", title: topic, note: "Wait for the courier." }] : [],
  }));
  try {
    const privateResources = [
      { user: "alice", token: "fixture-orchard-alice", report: "Alice's private basil report." },
      { user: "bob", token: "fixture-orchard-bob", report: "Bob's private mint report." },
    ] as const;
    const mainFolders: string[] = [];
    for (const { user, token, report } of privateResources) {
      await gateway.seedPersonalToken(user, "orchard", token);
      mainFolders.push(path.dirname(await gateway.seedConversationFile(user, "report.txt", report)));
    }
    gateway.script(
      { tool: resourceTool },
      { tool: "plan_update", args: { goals: [plan], nextSteps: [] } },
      "Alice's resources checked.",
      { tool: resourceTool },
      "Bob's resources checked.",
    );
    expect((await gateway.send("alice", "Remember the graft delivery.", { clientSendId: "alice-main" })).status).toBe(200);
    expect((await gateway.send("bob", "Check my report.", { clientSendId: "bob-main" })).status).toBe(200);
    expect(fixture.executions).toEqual(privateResources.map(({ user, token, report }, index) => ({
      userId: gateway.accountId(user), actorKind: "user", token, report,
      sessionId: "durable-main", folder: mainFolders[index],
    })));
    await vi.waitFor(async () => {
      const memory = await gateway.request("alice", "/api/agents/pilot/memory");
      expect(memory.status).toBe(200);
      expect(await memory.json()).toMatchObject({
        topics: [{ title: topic }], plan: { goals: [plan] },
      });
    });

    const room = await createRoom(gateway, "alice", "Orchard");
    await post(gateway, "alice", `${room.path}/members`, { userId: gateway.accountId("bob") });
    const firstRoomRequest = gateway.callCount();
    for (const [starter, member] of [["alice", "bob"], ["bob", "alice"]] as const) {
      const before = fixture.executions.length;
      const request = gateway.callCount();
      const answer = `Room check for ${starter} complete.`;
      release = fixture.hold();
      gateway.script({ tool: resourceTool }, { tool: resourceTool }, answer);
      await say(gateway, starter, room.path, `${starter}-start`, "@pilot Check the shared orchard report.");
      await vi.waitFor(() => expect(fixture.executions).toHaveLength(before + 1));
      const firstSteer = "Check the east bed.";
      const secondSteer = "@pilot Include the west bed.";
      await say(gateway, starter, room.path, `${starter}-east`, firstSteer);
      const { seq } = await say(gateway, member, room.path, `${starter}-west`, secondSteer) as { seq: number };
      await vi.waitFor(() => expect(delivered).toBe(seq));
      release();
      await waitForAnswer(gateway, member, room.path, answer);
      expect(gateway.callCount()).toBe(request + 3);
      const userMessages = JSON.stringify(gateway.requests[request + 1]?.messages.filter(({ role }) => role === "user"));
      expect(userMessages).toContain(`[from ${starter} via web]\\n${firstSteer}`);
      expect(userMessages).toContain(`[from ${member} via web]\\n${secondSteer}`);
      expect(gateway.requests[request + 2]?.messages.filter(({ role }) => role === "toolResult").slice(-2)).toMatchObject(
        Array.from({ length: 2 }, () => ({
          toolName: resourceTool, isError: false, content: [{ text: noReport }],
        })),
      );
      expect(fixture.executions).toHaveLength(before + 2);
    }

    const roomExecutions = fixture.executions.slice(2);
    expect(roomExecutions).toEqual(Array.from({ length: 4 }, () => ({
      userId: undefined, actorKind: "service", token: teamToken, report: undefined,
      sessionId: `room:${room.id}`, folder: expect.any(String),
    })));
    expect(new Set(roomExecutions.map(({ folder }) => folder)).size).toBe(1);
    expect(mainFolders).not.toContain(roomExecutions[0]?.folder);

    const request = gateway.callCount();
    const blocked = ["topics_get", "plan_get", "plan_update", "legacy_history", "read", "write", "edit", "bash", "codemode"];
    gateway.script([
      { tool: "codemode", args: { code: `await tools.${resourceTool}({});` } },
      { tool: "topics_get" },
      { tool: "plan_get" },
    ], "Room tools checked.");
    await say(gateway, "bob", room.path, "blocked", "@pilot Check the tools available here.");
    await waitForAnswer(gateway, "bob", room.path, "Room tools checked.");
    expect(gateway.offeredTools(request)).toContain(resourceTool);
    for (const tool of blocked) expect(gateway.offeredTools(request)).not.toContain(tool);
    expect(gateway.requests.at(-1)?.messages.filter(({ role }) => role === "toolResult").slice(-3)).toMatchObject(
      ["codemode", "topics_get", "plan_get"].map((toolName) => ({ toolName, isError: true })),
    );
    expect(fixture.executions).toHaveLength(6);

    const sharedOutput = JSON.stringify({
      feed: await roomFeed(gateway, "alice", room.path), requests: gateway.requests.slice(firstRoomRequest),
    });
    for (const { token, report } of privateResources) {
      expect(sharedOutput).not.toContain(token);
      expect(sharedOutput).not.toContain(report);
    }
    expect(sharedOutput).not.toContain(topic);
    expect(sharedOutput).not.toContain(plan);
  } finally {
    release?.();
    complete.mockRestore();
    await gateway.close();
  }
}, 20_000);

it("keeps single-user Main files and legacy history out of room tools", async () => {
  const fixture = resourceFixture();
  const gateway = await startDurableTestGateway({
    extraYaml: resourceYaml, fixtureExtensions: [fixture.extension, sessionHistoryExtension],
  });
  try {
    const mainFile = await gateway.seedConversationFile("local", "report.txt", "Private cypress notes.");
    const room = await createRoom(gateway, "local", "Orchard");
    gateway.script({ tool: resourceTool }, { tool: "session_history", args: { action: "list" } }, "Single-user room checked.");
    await say(gateway, "local", room.path, "check", "@pilot Check this room and its report.");
    await waitForAnswer(gateway, "local", room.path, "Single-user room checked.");
    expect(fixture.executions).toEqual([{
      userId: undefined, actorKind: "local", token: teamToken, report: undefined,
      sessionId: `room:${room.id}`, folder: expect.any(String),
    }]);
    expect(fixture.executions[0]?.folder).not.toBe(path.dirname(mainFile));
    expect(gateway.offeredTools(0)).not.toContain("legacy_history");
    expect(gateway.requests.at(-1)?.messages.filter(({ role }) => role === "toolResult")).toMatchObject([
      { toolName: resourceTool, isError: false, content: [{ text: noReport }] },
      {
        toolName: "session_history", isError: false, content: [{ text: expect.stringMatching(
          new RegExp(`^room:${room.id} · .* · 1 msgs · @pilot Check this room and its report\\. ★ CURRENT CONVERSATION$`),
        ) }],
      },
    ]);
  } finally {
    await gateway.close();
  }
}, 20_000);
