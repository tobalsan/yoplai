import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { FullHistoryMessage, GatewayConfig } from "@yoplai/shared";

describe("createExtensionContext media helpers", () => {
  let tmpDir: string;
  let prevHomeDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-context-"));
    prevHomeDir = process.env.YOPLAI_HOME;
    process.env.YOPLAI_HOME = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("emits extension fields at the top level on one physical JSON line", async () => {
    const { createExtensionContext } = await import("./context.js");
    const logger = createExtensionContext({} as GatewayConfig).logger;
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.info("started", { jobId: "job-1", message: "first\nsecond" });
    logger.warn("refused", { agentId: "alpha", status: 404 });
    logger.error("failed", "short failure", { runId: "run-1", channel: "slack" });

    for (const [spy, expected] of [
      [info, { level: "info", msg: "started", jobId: "job-1", message: "first\nsecond" }],
      [warn, { level: "warn", msg: "refused", agentId: "alpha", status: 404 }],
      [error, { level: "error", msg: "failed", message: "short failure", runId: "run-1", channel: "slack" }],
    ] as const) {
      expect(spy.mock.calls).toHaveLength(1);
      const args = spy.mock.calls[0]!;
      expect(args).toHaveLength(1);
      expect(args[0]).toMatch(/^\{"level"/);
      expect(args[0].split("\n")).toHaveLength(1);
      expect(JSON.parse(args[0])).toEqual(expected);
    }
  });

  it("preserves legacy details and error call shapes", async () => {
    const { createExtensionContext } = await import("./context.js");
    const logger = createExtensionContext({} as GatewayConfig).logger;
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("legacy failure");
    class Detail { value = 1; }

    logger.info("empty");
    logger.info("multiple", { jobId: "job-1" }, "extra");
    logger.info("array", [1, 2]);
    logger.warn("error detail", failure);
    logger.warn("class detail", new Detail());
    logger.error("alone");
    logger.error("failed", failure, "ignored", { ignored: true });

    expect(info.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { level: "info", msg: "empty", details: [] },
      { level: "info", msg: "multiple", details: [{ jobId: "job-1" }, "extra"] },
      { level: "info", msg: "array", details: [[1, 2]] },
    ]);
    expect(warn.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { level: "warn", msg: "error detail", details: [{ message: "legacy failure", stack: failure.stack }] },
      { level: "warn", msg: "class detail", details: [{ value: 1 }] },
    ]);
    expect(error.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { level: "error", msg: "alone", message: "alone" },
      { level: "error", msg: "failed", message: "legacy failure", stack: failure.stack },
    ]);
  });

  it("keeps explicit error diagnostic fields when the error is a short string", async () => {
    const { createExtensionContext } = await import("./context.js");
    const logger = createExtensionContext({} as GatewayConfig).logger;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("failed", "Short failure", {
      status: 503, endpoint: "https://api.example.test/items", requestId: "req-1",
      details: { retry: true },
    });
    expect(JSON.parse(error.mock.calls[0]![0])).toEqual({
      level: "error", msg: "failed", message: "Short failure",
      status: 503, endpoint: "https://api.example.test/items", requestId: "req-1",
      details: { retry: true },
    });
  });

  it("preserves explicit null diagnostics extracted from legacy Error objects", async () => {
    const { createExtensionContext } = await import("./context.js");
    const logger = createExtensionContext({} as GatewayConfig).logger;
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(new Error("Legacy failure"), { status: null, endpoint: null, requestId: null });
    logger.error("failed", failure);
    expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({
      status: null, endpoint: null, requestId: null,
    });
  });

  it("exposes encrypted personal and team credential resolution", async () => {
    const { writeTestV3Config } = await import("../test-utils/v3-config.js");
    await writeTestV3Config(tmpDir, {
      agents: [],
      extraConfig: { oauth: { encryptionKey: "context-test-encryption-key" } },
    });
    const { createExtensionContext } = await import("./context.js");
    const ctx = createExtensionContext({} as GatewayConfig);
    const credentials = ctx.credentials!;
    const team = { agentId: "probe", integration: "mcp:claap", scope: { type: "team" } as const };
    const personal = { ...team, scope: { type: "personal", userId: "alice" } as const };
    credentials.save(team, { account: "shared" });
    credentials.save(personal, { account: "alice" });
    const lookup = { agentId: "probe", integration: "mcp:claap", connectUrl: "/connect" };
    expect(credentials.resolve({ ...lookup, requesterUserId: "alice" })).toMatchObject({ payload: { account: "alice" } });
    expect(credentials.resolve({ ...lookup, requesterUserId: "bob" })).toMatchObject({ payload: { account: "shared" } });
    const files = await fs.readdir(path.join(tmpDir, "credentials"));
    for (const file of files) expect(await fs.readFile(path.join(tmpDir, "credentials", file), "utf8")).not.toContain("shared");
    credentials.delete(team);
    expect(credentials.resolve({ ...lookup, requesterUserId: "bob" })).toEqual({ connected: false, reason: "not_connected", connectUrl: "/connect" });
    expect(credentials.get(personal)).toEqual({ account: "alice" });
  });

  it("reports active run details only for the session owner and excludes paused tasks", async () => {
    const { writeTestV3Config } = await import("../test-utils/v3-config.js");
    await writeTestV3Config(tmpDir);
    const { SessionRunLifecycle } = await import("../agents/run-lifecycle.js");
    const { adoptTask, updateTask } = await import("../tasks/store.js");
    const { createExtensionContext } = await import("./context.js");
    const ctx = createExtensionContext({} as GatewayConfig);
    expect(await ctx.getActiveRun!("alpha", "live", "alice")).toBeUndefined();
    const clock = vi.spyOn(Date, "now").mockReturnValue(60_000);
    const lifecycle = new SessionRunLifecycle({ agentId: "alpha", sessionId: "live", userId: "alice" });
    lifecycle.beginRun();
    clock.mockRestore();
    try {
      expect(await ctx.getActiveRun!("alpha", "live", "alice")).toEqual({ startedAt: 60_000 });
      await adoptTask("alpha", "live", "Review sales pipeline", "alice");
      await adoptTask("alpha", "live", "Another owner's task", "bob");
      expect(await ctx.getActiveRun!("alpha", "live", "alice")).toEqual({ startedAt: 60_000, taskTitle: "Review sales pipeline" });
      expect(await ctx.getActiveRun!("alpha", "live", "bob")).toBeUndefined();
      expect(await ctx.getActiveRun!("alpha", "live")).toBeUndefined();
      await updateTask("alpha", "live", "alice", { status: "paused" });
      expect(await ctx.getActiveRun!("alpha", "live", "alice")).toEqual({ startedAt: 60_000 });
    } finally {
      lifecycle.finishRun();
    }
    expect(await ctx.getActiveRun!("alpha", "live", "alice")).toBeUndefined();
  });

  it("reports shared run details with an omitted or explicit shared owner", async () => {
    const { writeTestV3Config } = await import("../test-utils/v3-config.js");
    await writeTestV3Config(tmpDir);
    const { SessionRunLifecycle } = await import("../agents/run-lifecycle.js");
    const { adoptTask } = await import("../tasks/store.js");
    const { createExtensionContext } = await import("./context.js");
    const ctx = createExtensionContext({} as GatewayConfig);
    const clock = vi.spyOn(Date, "now").mockReturnValue(90_000);
    const lifecycle = new SessionRunLifecycle({ agentId: "alpha", sessionId: "shared" });
    lifecycle.beginRun();
    clock.mockRestore();
    try {
      await adoptTask("alpha", "shared", "Shared investigation");
      expect(await ctx.getActiveRun!("alpha", "shared")).toEqual({ startedAt: 90_000, taskTitle: "Shared investigation" });
      expect(await ctx.getActiveRun!("alpha", "shared", null)).toEqual({ startedAt: 90_000, taskTitle: "Shared investigation" });
      expect(await ctx.getActiveRun!("alpha", "shared", "alice")).toBeUndefined();
    } finally {
      lifecycle.finishRun();
    }
  });

  it("reads canonical full history from the explicit owner or shared store", async () => {
    const { writeTestV3Config } = await import("../test-utils/v3-config.js");
    await writeTestV3Config(tmpDir);
    const messages: FullHistoryMessage[] = [
      { role: "user", content: [{ type: "text", text: "Prompt" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "Reason" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "notes" } }], timestamp: 2, meta: { stopReason: "toolUse" } },
      { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "Result" }], timestamp: 3, isError: true },
    ];
    for (const [dir, history] of [
      [path.join(tmpDir, "sessions/users/alice/history"), messages],
      [path.join(tmpDir, "history"), [messages[0]!]],
    ] as const) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "alpha-session.jsonl"), history.map((message) =>
        JSON.stringify({ type: "history", agentId: "alpha", sessionId: "session", ...message })).join("\n"));
    }
    const { createExtensionContext } = await import("./context.js");
    const ctx = createExtensionContext({} as GatewayConfig);
    expect((await ctx.getFullSessionHistory!("alpha", "session", "alice")).messages).toEqual(messages);
    expect((await ctx.getFullSessionHistory!("alpha", "session", null)).messages).toEqual([messages[0]]);
    expect((await ctx.getFullSessionHistory!("alpha", "session", "bob")).messages).toEqual([]);
  });

  it("snapshots pending tool turns and current output only for the recorded storage owner", async () => {
    const { writeTestV3Config } = await import("../test-utils/v3-config.js");
    await writeTestV3Config(tmpDir);
    const { SessionRunLifecycle } = await import("../agents/run-lifecycle.js");
    const { createExtensionContext } = await import("./context.js");
    const lifecycle = new SessionRunLifecycle({ agentId: "alpha", sessionId: "live", userId: "alice" });
    lifecycle.beginRun();
    await lifecycle.beginUserTurn("Prompt", 100);
    lifecycle.acceptHistoryEvent({ type: "assistant_thinking", text: "Reason", timestamp: 101 });
    lifecycle.acceptHistoryEvent({ type: "tool_call", id: "call", name: "read", args: { path: "notes" }, timestamp: 102 });
    lifecycle.acceptHistoryEvent({ type: "tool_result", id: "call", name: "read", content: "Buffered result", isError: true, details: { diff: "diff" }, timestamp: 103 });
    const ctx = createExtensionContext({} as GatewayConfig);
    const first = await ctx.getFullSessionHistory!("alpha", "live", "alice");
    expect(first.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Prompt" }], timestamp: 100 }]);
    expect(first.liveTurn).toMatchObject({ prompt: "Prompt", messages: [
      { role: "user" },
      { role: "assistant", content: [{ type: "thinking", thinking: "Reason" }, { type: "toolCall", id: "call", arguments: { path: "notes" } }] },
      { role: "toolResult", toolCallId: "call", isError: true, details: { diff: "diff" }, content: [{ type: "text", text: "Buffered result" }] },
    ] });
    lifecycle.acceptHistoryEvent({ type: "turn_end", timestamp: 104 });
    lifecycle.acceptHistoryEvent({ type: "assistant_text", text: "Output", timestamp: 105 });
    const second = await ctx.getFullSessionHistory!("alpha", "live", "alice");
    expect(second.liveTurn?.prompt).toBe("Prompt");
    expect(second.liveTurn?.messages).toHaveLength(4);
    expect(first.liveTurn?.messages).toHaveLength(3);
    expect((await ctx.getFullSessionHistory!("alpha", "live", "bob")).liveTurn).toBeUndefined();
    expect((await ctx.getFullSessionHistory!("alpha", "live", null)).liveTurn).toBeUndefined();
    await lifecycle.flushTurns();
    lifecycle.finishRun();
    const finished = await ctx.getFullSessionHistory!("alpha", "live", "alice");
    expect(finished.liveTurn).toBeUndefined();
    expect(finished.messages).toEqual(second.liveTurn?.messages);
  });

  it("rejects tampered media metadata paths outside the media directory", async () => {
    const outsidePath = path.join(tmpDir, "outside.txt");
    await fs.writeFile(outsidePath, "secret", "utf8");

    const { registerMediaFile } = await import("../media/metadata.js");
    const metadata = await registerMediaFile({
      direction: "inbound",
      filename: "outside.txt",
      storedFilename: "../outside.txt",
      path: outsidePath,
      mimeType: "text/plain",
      size: 6,
    });

    const { createExtensionContext } = await import("./context.js");
    const ctx = createExtensionContext({
      version: 2,
      agents: [],
    } as unknown as GatewayConfig);

    await expect(ctx.readMediaFile?.(metadata.fileId)).rejects.toThrow(
      "Media file not found"
    );
  });

  it("rejects media metadata path traversal even with a valid stored filename", async () => {
    const { getMediaInboundDir, registerMediaFile } = await import(
      "../media/metadata.js"
    );
    const inboundDir = getMediaInboundDir();
    await fs.mkdir(inboundDir, { recursive: true });

    const storedFilename = `${randomUUID()}.txt`;
    const storedPath = path.join(inboundDir, storedFilename);
    const outsidePath = path.join(tmpDir, "outside.txt");
    await fs.writeFile(storedPath, "safe", "utf8");
    await fs.writeFile(outsidePath, "secret", "utf8");

    const metadata = await registerMediaFile({
      direction: "inbound",
      filename: "safe.txt",
      storedFilename,
      path: outsidePath,
      mimeType: "text/plain",
      size: 4,
    });

    const { createExtensionContext } = await import("./context.js");
    const ctx = createExtensionContext({
      version: 2,
      agents: [],
    } as unknown as GatewayConfig);

    await expect(ctx.readMediaFile?.(metadata.fileId)).rejects.toThrow(
      "Media file not found"
    );
  });

  it("rejects media files whose stored filename symlink escapes the media directory", async () => {
    const { getMediaInboundDir, registerMediaFile } = await import(
      "../media/metadata.js"
    );
    const inboundDir = getMediaInboundDir();
    await fs.mkdir(inboundDir, { recursive: true });

    const outsidePath = path.join(tmpDir, "outside.txt");
    const storedFilename = `${randomUUID()}.txt`;
    const symlinkPath = path.join(inboundDir, storedFilename);
    await fs.writeFile(outsidePath, "secret", "utf8");
    await fs.symlink(outsidePath, symlinkPath);

    const metadata = await registerMediaFile({
      direction: "inbound",
      filename: "safe.txt",
      storedFilename,
      path: symlinkPath,
      mimeType: "text/plain",
      size: 6,
    });

    const { createExtensionContext } = await import("./context.js");
    const ctx = createExtensionContext({
      version: 2,
      agents: [],
    } as unknown as GatewayConfig);

    await expect(ctx.readMediaFile?.(metadata.fileId)).rejects.toThrow(
      "Media file not found"
    );
  });

  it("rejects stored media filenames containing a null byte", async () => {
    const { registerMediaFile } = await import("../media/metadata.js");
    const metadata = await registerMediaFile({
      direction: "inbound",
      filename: "passwd",
      storedFilename: "foo\0../etc/passwd",
      path: path.join(tmpDir, "media", "inbound", "foo\0../etc/passwd"),
      mimeType: "text/plain",
      size: 0,
    });

    const { createExtensionContext } = await import("./context.js");
    const ctx = createExtensionContext({
      version: 2,
      agents: [],
    } as unknown as GatewayConfig);

    await expect(ctx.readMediaFile?.(metadata.fileId)).rejects.toThrow(
      "Media file not found"
    );
  });
});

describe("createExtensionContext delivery sink registry", () => {
  async function context() {
    const { createExtensionContext } = await import("./context.js");
    return createExtensionContext({
      version: 2,
      agents: [],
    } as unknown as GatewayConfig);
  }

  it("registers, looks up, and unregisters a sink", async () => {
    const ctx = await context();
    const sink = vi.fn(async () => undefined);

    const unregister = ctx.registerDeliverySink("slack", sink);
    expect(ctx.getDeliverySink("slack")).toBe(sink);

    unregister();
    expect(ctx.getDeliverySink("slack")).toBeUndefined();
  });

  it("replaces a duplicate id with a warning and keeps the replacement after the old unregister", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = await context();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);

    const unregisterFirst = ctx.registerDeliverySink("slack", first);
    ctx.registerDeliverySink("slack", second);
    expect(warn).toHaveBeenCalledWith(
      'Delivery sink "slack" already registered; replacing it'
    );
    expect(ctx.getDeliverySink("slack")).toBe(second);

    unregisterFirst();
    expect(ctx.getDeliverySink("slack")).toBe(second);
    warn.mockRestore();
  });
});

describe("updateAgentExtensionConfig host API", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("./agent-config-writer.js");
    vi.doUnmock("./reload.js");
    vi.doUnmock("../config/index.js");
  });

  async function load() {
    const writer = vi.fn(async () => ({}));
    const reload = vi.fn(async () => ({}));
    vi.resetModules();
    vi.doMock("./agent-config-writer.js", () => ({ updateAgentExtensionConfig: writer }));
    vi.doMock("./reload.js", () => ({ reloadAfterExtensionWrite: reload }));
    vi.doMock("../config/index.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../config/index.js")>()),
      getAgent: (id: string) =>
        id === "bot" ? { id: "bot", workspace: "/ws/bot" } : undefined,
      resolveWorkspaceDir: (dir: string) => `/resolved${dir}`,
    }));
    const mod = await import("./context.js");
    return { mod, writer, reload };
  }

  it("writes the agent config, then reloads", async () => {
    const { mod, writer, reload } = await load();
    const ctx = mod.createExtensionContext({} as GatewayConfig);
    const patch = { secrets: { token: "t" } };
    await ctx.updateAgentExtensionConfig!("bot", "threadit", patch);
    expect(writer).toHaveBeenCalledWith("/resolved/ws/bot", "threadit", patch);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(writer.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]);
  });

  it("rejects an unknown agent without writing", async () => {
    const { mod, writer, reload } = await load();
    const ctx = mod.createExtensionContext({} as GatewayConfig);
    await expect(ctx.updateAgentExtensionConfig!("ghost", "threadit", {})).rejects.toThrow(/Unknown agent/);
    expect(writer).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("lets a bound extension write only its own config", async () => {
    const { mod, writer } = await load();
    const ctx = mod.bindExtensionContext(mod.createExtensionContext({} as GatewayConfig), "threadit");
    await expect(ctx.updateAgentExtensionConfig!("bot", "slack", {})).rejects.toThrow(/only write its own/);
    expect(writer).not.toHaveBeenCalled();
    await ctx.updateAgentExtensionConfig!("bot", "threadit", { enabled: true });
    expect(writer).toHaveBeenCalledTimes(1);
  });
});
