import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../config/index.js", async () => {
  const nodeFs = await import("node:fs");
  const nodeOs = await import("node:os");
  home.dir = nodeFs.mkdtempSync(path.join(nodeOs.tmpdir(), "sh-"));
  return { CONFIG_DIR: home.dir, getAgents: () => [{ id: "a1" }, { id: "a2" }] };
});
vi.mock("../sessions/index.js", () => ({ getSessionEntry: async () => null }));
vi.mock("../sessions/store.js", () => ({ getSessionCreatedAt: async () => 0 }));

import type { AgentConfig } from "@yoplai/shared";
import { runSessionHistory, sessionHistoryExtension } from "./index.js";
import { ChatProjectStore } from "../chat-projects/store.js";
import * as historyStore from "../history/store.js";

const agent = (id: string) => ({ id }) as AgentConfig;

async function writeSession(dir: string, agentId: string, sessionId: string, texts: string[], base: number, project?: string, owner = true) {
  await fs.mkdir(dir, { recursive: true });
  const meta = project ? [JSON.stringify({ type: "meta", key: "project", value: project, timestamp: base })] : [];
  const lines = texts.map((t, i) =>
    JSON.stringify({
      type: "history", role: i % 2 ? "assistant" : "user",
      content: [{ type: "text", text: t }], timestamp: base + i * 1000,
      ...(owner ? { agentId, sessionId } : {}),
    })
  );
  await fs.writeFile(path.join(dir, `${agentId}-${sessionId}.jsonl`), [...meta, ...lines].join("\n") + "\n");
}

describe("session_history tool", () => {
  beforeAll(async () => {
    const hist = path.join(home.dir, "history");
    await writeSession(hist, "a1", "old", ["deploy the widget", "ok widget deployed"], 1_700_000_000_000);
    await writeSession(hist, "a1", "cur", ["widget again", "yes"], 1_800_000_000_000);
    await writeSession(hist, "a2", "other", ["widget secret of agent two"], 1_800_000_000_000);
    const userHist = path.join(home.dir, "sessions", "users", "u1", "history");
    await writeSession(userHist, "a1", "mine", ["widget for user one"], 1_800_000_000_000);
  });
  afterAll(() => fs.rm(home.dir, { recursive: true, force: true }));

  it("marks a missing search query as invalid input without changing the message", async () => {
    await expect(runSessionHistory({ action: "search" }, { agent: agent("a1") })).rejects.toMatchObject({
      message: "search requires `query`", code: "invalid_input",
    });
  });

  it("marks a missing read session as invalid input without changing the message", async () => {
    await expect(runSessionHistory({ action: "read" }, { agent: agent("a1") })).rejects.toMatchObject({
      message: "read requires `session`", code: "invalid_input",
    });
  });

  it("marks an unparseable since date as invalid input without changing the message", async () => {
    await expect(runSessionHistory({ action: "list", since: "not-a-date" }, { agent: agent("a1") })).rejects.toMatchObject({
      message: "Invalid since date: not-a-date", code: "invalid_input",
    });
  });

  it("marks an unparseable until date as invalid input without changing the message", async () => {
    await expect(runSessionHistory({ action: "search", query: "widget", until: "not-a-date" }, { agent: agent("a1") })).rejects.toMatchObject({
      message: "Invalid until date: not-a-date", code: "invalid_input",
    });
  });

  it("marks an unknown action as invalid input with the original Zod message", async () => {
    await expect(runSessionHistory({ action: "unknown" }, { agent: agent("a1") })).rejects.toMatchObject({
      code: "invalid_input",
      message: `[
  {
    "received": "unknown",
    "code": "invalid_enum_value",
    "options": [
      "list",
      "search",
      "read"
    ],
    "path": [
      "action"
    ],
    "message": "Invalid enum value. Expected 'list' | 'search' | 'read', received 'unknown'"
  }
]`,
    });
  });

  it.each([
    [0, `[
  {
    "code": "too_small",
    "minimum": 1,
    "type": "number",
    "inclusive": true,
    "exact": false,
    "message": "Number must be greater than or equal to 1",
    "path": [
      "limit"
    ]
  }
]`],
    [100, `[
  {
    "code": "too_big",
    "maximum": 50,
    "type": "number",
    "inclusive": true,
    "exact": false,
    "message": "Number must be less than or equal to 50",
    "path": [
      "limit"
    ]
  }
]`],
  ])("marks limit %i as invalid input with the original Zod message", async (limit, message) => {
    await expect(runSessionHistory({ action: "list", limit }, { agent: agent("a1") })).rejects.toMatchObject({
      message, code: "invalid_input",
    });
  });

  it("leaves unexpected history failures untagged", async () => {
    const read = vi.spyOn(historyStore, "getFullHistory").mockRejectedValueOnce(new Error("History unavailable"));
    try {
      const result = runSessionHistory({ action: "read", session: "old" }, { agent: agent("a1") });
      await expect(result).rejects.toThrow("History unavailable");
      await expect(result).rejects.not.toHaveProperty("code");
    } finally {
      read.mockRestore();
    }
  });

  it("describes the required search and read arguments to the model", async () => {
    const tools = await sessionHistoryExtension.getAgentTools?.(agent("a1"));
    const tool = tools?.find((tool) => tool.name === "session_history");
    expect(tool?.description).toMatch(/action=search:.*required.*query/i);
    expect(tool?.description).toMatch(/action=read:.*required.*session/i);
    expect(tool?.parameters).toMatchObject({
      properties: {
        query: { description: expect.stringMatching(/required/i) },
        session: { description: expect.stringMatching(/required/i) },
      },
      required: ["action"],
    });
  });

  it("lists own sessions newest first and marks the current one", async () => {
    const out = await runSessionHistory({ action: "list" }, { agent: agent("a1"), sessionId: "cur" });
    expect(out.split("\n")[0]).toContain("cur");
    expect(out).toContain("★ CURRENT SESSION");
    expect(out).toContain("old");
    expect(out).not.toContain("other");
  });

  it("searches only the agent's own sessions and labels the current session", async () => {
    const out = await runSessionHistory({ action: "search", query: "WIDGET" }, { agent: agent("a1"), sessionId: "cur" });
    expect(out).toContain("session cur ★ CURRENT SESSION");
    expect(out).toContain("[current session — earlier messages compacted");
    expect(out).toContain("session old");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("user one");
  });

  it("scopes to the calling user's history dir", async () => {
    const out = await runSessionHistory({ action: "search", query: "widget" }, { agent: agent("a1"), userId: "u1" });
    expect(out).toContain("user one");
    expect(out).not.toContain("deploy the widget");
  });

  it("reads a session, refuses other agents' sessions", async () => {
    const read = await runSessionHistory({ action: "read", session: "old" }, { agent: agent("a1"), sessionId: "cur" });
    expect(read).toContain("#0 user");
    expect(read).not.toContain("[current session");
    const cur = await runSessionHistory({ action: "read", session: "cur" }, { agent: agent("a1"), sessionId: "cur" });
    expect(cur).toContain("[current session");
    expect(await runSessionHistory({ action: "read", session: "other" }, { agent: agent("a1") })).toContain("no such session");
  });

  it("stops search at limit", async () => {
    const out = await runSessionHistory({ action: "search", query: "widget", limit: 1 }, { agent: agent("a1") });
    expect(out.match(/^\s+#\d+/gm)).toHaveLength(1);
  });

  describe("chat project scope", () => {
    const dir = () => path.join(home.dir, "sessions", "users", "u2", "history");
    let p1 = "";
    let p2 = "";
    beforeAll(async () => {
      const store = new ChatProjectStore(home.dir, "u2");
      p1 = (await store.create("one")).id;
      p2 = (await store.create("two")).id;
      await writeSession(dir(), "a1", "pcur", ["pcur marker"], 1_800_000_000_000, p1);
      await writeSession(dir(), "a2", "pother", ["gizmo from agent two"], 1_800_000_001_000, p1);
      await writeSession(dir(), "a2", "pforeign", ["gizmo foreign project"], 1_800_000_002_000, p2);
      await writeSession(dir(), "a2", "pnone", ["gizmo untagged"], 1_800_000_003_000);
      await writeSession(dir(), "a1", "nocur", ["gizmo own untagged"], 1_800_000_004_000);
      await writeSession(dir(), "a1", "same", ["gizmo same a1"], 1_800_000_005_000, p1);
      await writeSession(dir(), "a2", "same", ["gizmo same a2"], 1_800_000_006_000, p1);
      await writeSession(dir(), "gone", "old", ["gizmo removed agent"], 1_800_000_007_000, p1);
      await writeSession(dir(), "a1-x", "s", ["gizmo prefix collision"], 1_800_000_008_000, p1);
      await writeSession(dir(), "legacygone", "l", ["gizmo legacy removed"], 1_800_000_009_000, p1, false);
      await writeSession(dir(), "a2", "lg", ["gizmo legacy configured"], 1_800_000_010_000, p1, false);
      await writeSession(path.join(home.dir, "sessions", "users", "u3", "history"), "a2", "x", ["gizmo other user"], 1_800_000_000_000, p1);
    });
    const ctx = (sessionId: string) => ({ agent: agent("a1"), userId: "u2", sessionId });

    it("lists and reads other agents' sessions in the same project only", async () => {
      const list = await runSessionHistory({ action: "list", limit: 50 }, ctx("pcur"));
      expect(list).toContain("a2/pother");
      expect(list).not.toContain("pforeign");
      expect(list).not.toContain("pnone");
      const read = await runSessionHistory({ action: "read", session: "a2/pother" }, ctx("pcur"));
      expect(read).toContain("gizmo from agent two");
      expect(await runSessionHistory({ action: "read", session: "a2/pforeign" }, ctx("pcur"))).toContain("no such session");
      expect(await runSessionHistory({ action: "read", session: "a2/pnone" }, ctx("pcur"))).toContain("no such session");
    });

    it("keeps same bare session ids of different agents distinct", async () => {
      const ctxSame = ctx("same");
      expect(await runSessionHistory({ action: "read", session: "same" }, ctxSame)).toContain("same a1");
      const other = await runSessionHistory({ action: "read", session: "a2/same" }, ctxSame);
      expect(other).toContain("same a2");
      expect(other).not.toContain("same a1");
    });

    it("includes removed agents via persisted ownership, with prefix-collision safety", async () => {
      const list = await runSessionHistory({ action: "list", limit: 50 }, ctx("pcur"));
      expect(list).toContain("gone/old");
      expect(list).toContain("a1-x/s");
      expect(list).not.toMatch(/^x-s /m);
      expect(list).toContain("a2/lg");
      expect(list).not.toContain("legacygone");
      expect(await runSessionHistory({ action: "read", session: "gone/old" }, ctx("pcur"))).toContain("removed agent");
      expect(await runSessionHistory({ action: "read", session: "a1-x/s" }, ctx("pcur"))).toContain("prefix collision");
      expect(await runSessionHistory({ action: "search", query: "gizmo", limit: 50 }, ctx("pcur"))).toContain("session gone/old");
    });

    it("searches across project agents without leaking foreign project or user", async () => {
      const out = await runSessionHistory({ action: "search", query: "gizmo", limit: 50 }, ctx("pcur"));
      expect(out).toContain("session a2/pother");
      expect(out).toContain("own untagged");
      expect(out).not.toContain("foreign project");
      expect(out).not.toContain("other user");
    });

    it("denies direct cross-user reads", async () => {
      expect(await runSessionHistory({ action: "read", session: "a2/x" }, ctx("pcur"))).toContain("no such session");
    });

    it("stays own-agent only without a project", async () => {
      const out = await runSessionHistory({ action: "search", query: "gizmo" }, ctx("nocur"));
      expect(out).toContain("own untagged");
      expect(out).not.toContain("agent two");
    });

    it("drops access when membership moved or project cleared", async () => {
      await writeSession(dir(), "a1", "moved", ["moved marker"], 1_800_000_020_000, p1);
      const file = path.join(dir(), "a1-moved.jsonl");
      expect(await runSessionHistory({ action: "list", limit: 50 }, ctx("moved"))).toContain("a2/pother");
      await fs.appendFile(file, JSON.stringify({ type: "meta", key: "project", value: p2, timestamp: 1 }) + "\n");
      const moved = await runSessionHistory({ action: "list", limit: 50 }, ctx("moved"));
      expect(moved).not.toContain("a2/pother");
      expect(moved).toContain("a2/pforeign");
      await fs.appendFile(file, JSON.stringify({ type: "meta", key: "project", value: null, timestamp: 2 }) + "\n");
      expect(await runSessionHistory({ action: "list", limit: 50 }, ctx("moved"))).not.toContain("a2/");
    });

    it("fails closed when the project metadata is dangling or deleted", async () => {
      await writeSession(dir(), "a1", "dangling", ["dangling marker"], 1_800_000_030_000, "missing-project");
      expect(await runSessionHistory({ action: "list", limit: 50 }, ctx("dangling"))).not.toContain("a2/");
      await writeSession(dir(), "a1", "todelete", ["todelete marker"], 1_800_000_031_000, p2);
      expect(await runSessionHistory({ action: "list", limit: 50 }, ctx("todelete"))).toContain("a2/pforeign");
      await new ChatProjectStore(home.dir, "u2").delete(p2);
      expect(await runSessionHistory({ action: "list", limit: 50 }, ctx("todelete"))).not.toContain("a2/");
    });
  });
});
