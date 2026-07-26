import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FullHistoryMessage } from "@yoplai/shared";

let tmpDir = "";

vi.mock("../config/index.js", () => ({
  get CONFIG_DIR() {
    return tmpDir;
  },
}));

vi.mock("@yoplai/extension-multi-user/isolation", () => ({
  getUserHistoryDir: (userId: string | undefined, configDir: string) =>
    userId
      ? path.join(configDir, "users", userId, "history")
      : path.join(configDir, "history"),
}));

vi.mock("../sessions/store.js", () => ({
  getSessionCreatedAt: vi.fn(() => 1),
}));

describe("compact history rewrite", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "yoplai-compact-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("rewrites canonical history to summary plus recent user and assistant messages", async () => {
    const { replaceCanonicalHistoryWithCompaction, getFullHistory } =
      await import("./store.js");
    const messages: FullHistoryMessage[] = [];
    for (let i = 1; i <= 10; i += 1) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: `user ${i}` }],
        timestamp: i * 10,
      });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `assistant ${i}` }],
        timestamp: i * 10 + 1,
      });
    }

    await replaceCanonicalHistoryWithCompaction({
      agentId: "alpha",
      sessionId: "session-1",
      summary: "Older context summary",
      recentMessages: messages.slice(-16),
    });

    const rewritten = await getFullHistory("alpha", "session-1");
    expect(rewritten).toHaveLength(17);
    expect(rewritten[0]).toEqual({
      role: "system",
      content: [
        {
          type: "text",
          text: "[COMPACTED CONTEXT SUMMARY]\nOlder context summary",
        },
      ],
      timestamp: expect.any(Number),
    });
    expect(rewritten[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "user 3" }],
    });
    expect(rewritten.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "assistant 10" }],
    });
  });

  it("reads full history in chronological order when file append order is inverted", async () => {
    const { replaceCanonicalHistoryWithCompaction, getFullHistory } =
      await import("./store.js");

    await replaceCanonicalHistoryWithCompaction({
      agentId: "alpha",
      sessionId: "session-1",
      summary: "summary",
      recentMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant reply" }],
          timestamp: 200,
        },
        {
          role: "user",
          content: [{ type: "text", text: "user asks" }],
          timestamp: 100,
        },
      ],
    });

    const rewritten = await getFullHistory("alpha", "session-1");
    expect(rewritten.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });

  it("drops old assistant usage metadata from compacted recent messages", async () => {
    const { replaceCanonicalHistoryWithCompaction, getFullHistory } =
      await import("./store.js");

    await replaceCanonicalHistoryWithCompaction({
      agentId: "alpha",
      sessionId: "session-1",
      summary: "summary",
      recentMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant reply" }],
          timestamp: 100,
          meta: {
            model: "gpt-5.2",
            usage: { input: 120000, output: 10, totalTokens: 120010 },
          },
        },
      ],
    });

    const assistant = (await getFullHistory("alpha", "session-1")).find(
      (message) => message.role === "assistant"
    );
    expect(assistant).toMatchObject({
      role: "assistant",
      meta: { model: "gpt-5.2" },
    });
    expect(assistant).not.toMatchObject({
      meta: { usage: expect.anything() },
    });
  });
});
