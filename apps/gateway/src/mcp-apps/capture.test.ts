import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentConfigSchema, GatewayConfigSchema } from "@yoplai/shared";

// Thinh approved public capture/read/clear/delete with real files in ALG-599
// comment f0b31b16-5802-41d7-aa24-72d7e959dd59. This catches replay lookup and
// record identity; HTTP authorization and browser delivery are covered elsewhere.
let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-app-records-"));
  vi.stubEnv("YOPLAI_HOME", home);
  vi.resetModules();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

function context(toolCallId: string) {
  return {
    agent: AgentConfigSchema.parse({ id: "artist", name: "Artist", workspace: path.join(home, "workspace"), model: { provider: "test", model: "test" } }),
    config: GatewayConfigSchema.parse({ agents: [] }), sessionId: "drawing", toolCallId,
  };
}
const mcp = { server: "canvas", tool: "draw", ui: { resourceUri: "ui://canvas/view", visibility: ["model" as const, "app" as const] } };

it("reads captured calls among many records after a turn ends without listing the directory again", async () => {
  const capture = await import("./capture.js");
  for (let index = 0; index < 40; index++) {
    await capture.captureMcpApp(mcp, context(`call-${index}`), { shape: "box" }, { content: [{ type: "text", text: "Drawing" }] });
  }
  capture.clearMcpAppViews({ agentId: "artist", sessionId: "drawing" });
  const dir = path.join(home, "history", "mcp-apps", "artist", "drawing");
  await fs.chmod(dir, 0o111);
  try {
    await expect(fs.readdir(dir)).rejects.toMatchObject({ code: "EACCES" });
    expect(await capture.readMcpAppRecord({ agentId: "artist", sessionId: "drawing" }, "call-17")).toMatchObject({
      toolCallId: "call-17", args: { shape: "box" }, result: { content: [{ type: "text", text: "Drawing" }] },
    });
  } finally { await fs.chmod(dir, 0o700); }
});

it("discovers persisted records after restart and reuses that lookup on subsequent reads", async () => {
  const initial = await import("./capture.js");
  await initial.captureMcpApp(mcp, context("saved-call"), { shape: "circle" }, { content: [{ type: "text", text: "Saved drawing" }] });
  vi.resetModules();
  const reloaded = await import("./capture.js");
  expect(await reloaded.readMcpAppRecord({ agentId: "artist", sessionId: "drawing" }, "unknown-call")).toBeUndefined();
  const dir = path.join(home, "history", "mcp-apps", "artist", "drawing");
  await fs.chmod(dir, 0o111);
  try {
    expect(await reloaded.readMcpAppRecord({ agentId: "artist", sessionId: "drawing" }, "saved-call")).toMatchObject({
      toolCallId: "saved-call", args: { shape: "circle" }, result: { content: [{ type: "text", text: "Saved drawing" }] },
    });
  } finally { await fs.chmod(dir, 0o700); }
});

it("revalidates every stored identity and payload field on repeated reads", async () => {
  const capture = await import("./capture.js");
  const scope = { agentId: "artist", sessionId: "drawing" };
  await capture.captureMcpApp(mcp, context("call-one"), {}, { content: [{ type: "text", text: "Original" }] });
  const record = await capture.readMcpAppRecord(scope, "call-one");
  expect(record).toBeDefined();
  const filename = path.join(home, "history", "mcp-apps", "artist", "drawing", `${record!.recordId}.json`);
  for (const invalid of [
    { recordId: "different-record" }, { agentId: "other-agent" }, { sessionId: "other-session" },
    { ownerUserId: "other-owner" }, { toolCallId: "other-call" }, { server: 7 }, { tool: null },
    { resourceUri: false }, { result: { content: "not-an-array" } },
  ]) {
    await fs.writeFile(filename, JSON.stringify({ ...record, ...invalid }));
    expect(await capture.readMcpAppRecord(scope, "call-one")).toBeUndefined();
    await fs.writeFile(filename, JSON.stringify(record));
    expect(await capture.readMcpAppRecord(scope, "call-one")).toMatchObject({ toolCallId: "call-one", result: { content: [{ type: "text", text: "Original" }] } });
  }
});

it("deletes replay data and lets a recreated session return only its new capture", async () => {
  const capture = await import("./capture.js");
  const scope = { agentId: "artist", sessionId: "drawing" };
  await capture.captureMcpApp(mcp, context("call-one"), { revision: 1 }, { content: [{ type: "text", text: "Old drawing" }] });
  expect(await capture.readMcpAppRecord(scope, "call-one")).toMatchObject({ args: { revision: 1 } });
  await capture.deleteMcpAppRecords(scope);
  expect(capture.getMcpAppView(scope, "call-one")).toBeUndefined();
  expect(await capture.readMcpAppRecord(scope, "call-one")).toBeUndefined();
  await capture.captureMcpApp(mcp, context("call-one"), { revision: 2 }, { content: [{ type: "text", text: "New drawing" }] });
  expect(await capture.readMcpAppRecord(scope, "call-one")).toMatchObject({
    args: { revision: 2 }, result: { content: [{ type: "text", text: "New drawing" }] },
  });
});
