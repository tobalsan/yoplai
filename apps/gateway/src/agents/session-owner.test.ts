import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, RunAgentParams } from "@yoplai/shared";
import type { SdkAdapter, SdkRunParams } from "../sdk/types.js";

const home = vi.hoisted(
  () =>
    `/tmp/yoplai-session-owner-${process.pid}-${Math.random().toString(36).slice(2)}`
);
const { getAgent, getAdapter } = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getAdapter: vi.fn(),
}));
vi.mock("../config/index.js", () => ({
  CONFIG_DIR: home,
  getAgent,
  loadConfig: () => ({ agents: [], extensions: {}, sessions: {} }),
  resolveWorkspaceDir: (dir: string) => dir,
}));
vi.mock("../sdk/registry.js", () => ({
  getSdkAdapter: getAdapter,
  getDefaultSdkId: () => "pi",
}));
vi.mock("../sdk/container/adapter.js", () => ({
  getContainerAdapter: getAdapter,
}));
vi.mock("../extensions/registry.js", () => ({
  getExtensionRuntime: () => undefined,
}));
vi.mock("../maintenance/session-auto-title.js", () => ({
  maybeAutoTitleSession: vi.fn(),
}));
vi.mock("../maintenance/tool-labels.js", () => ({
  maybeGenerateToolLabel: vi.fn(),
}));
vi.mock("../tasks/store.js", () => ({
  getTask: async () => undefined,
  pauseTaskForControlCommand: vi.fn(),
}));

import { runAgent } from "./runner.js";
import { getSimpleHistory } from "../history/store.js";
import { getSessionEntry } from "../sessions/store.js";
import {
  ensureSession,
  hasSession,
  resetSession,
} from "../sessions/persistence.js";
import { deleteSession } from "./sessions.js";
import { SessionRunLifecycle } from "./run-lifecycle.js";

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  getAgent.mockReturnValue({
    id: "alpha",
    name: "Alpha",
    workspace: path.join(home, "workspace"),
    sdk: "pi",
    model: { provider: "anthropic", model: "test" },
    queueMode: "queue",
  } as AgentConfig);
});

function adapter(run: SdkAdapter["run"], nativeQueue = true): SdkAdapter {
  return {
    id: "pi",
    displayName: "test",
    resolveDisplayModel: () => ({}),
    capabilities: {
      queueWhileStreaming: nativeQueue,
      interrupt: true,
      toolEvents: true,
      fullHistory: true,
    },
    run,
    queueMessage: vi.fn(async () => {}),
  };
}

describe("session owner and requester (real gateway history/store)", () => {
  it.each([
    { userId: "sender", sessionOwnerId: "opener", owner: "opener" },
    { userId: "sender", sessionOwnerId: null, owner: undefined },
    { userId: undefined, sessionOwnerId: "opener", owner: "opener" },
    { userId: "sender", sessionOwnerId: undefined, owner: "sender" },
  ])(
    "writes history to $owner while running as $userId",
    async ({ userId, sessionOwnerId, owner }) => {
      const run = vi.fn(async () => ({ text: "ok" }));
      getAdapter.mockReturnValue(adapter(run));
      const key = `slack:channel:${Math.random()}`;
      const result = await runAgent({
        agentId: "alpha",
        message: "message",
        sessionKey: key,
        userId,
        sessionOwnerId,
      });
      expect(await getSessionEntry("alpha", key, owner)).toMatchObject({
        sessionId: result.meta.sessionId,
      });
      expect(
        await getSimpleHistory("alpha", result.meta.sessionId, owner)
      ).toMatchObject([{ role: "user", content: "message" }]);
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ userId, sessionOwnerId: owner ?? null })
      );
      if (owner !== userId)
        expect(await getSessionEntry("alpha", key, userId)).toBeUndefined();
    }
  );

  it.each([false, true])(
    "queues other requesters as separate turns for sandbox=%s",
    async (sandbox) => {
      const sessionId = `overlap-${sandbox}`;
      getAgent.mockReturnValue({
        ...getAgent(),
        sandbox: { enabled: sandbox },
      });
      let release!: () => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const run = vi.fn(async (params: SdkRunParams) => {
        if (params.message === "opener") {
          params.onSessionHandle?.({ id: "active" });
          started();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { text: "ok" };
      });
      const sdk = adapter(run);
      getAdapter.mockReturnValue(sdk);
      const first = runAgent({
        agentId: "alpha",
        sessionId,
        message: "opener",
        userId: "owner",
        requesterId: "slack:U1",
      });
      await ready;
      const onEvent = vi.fn();
      const queued: RunAgentParams = {
        agentId: "alpha",
        sessionId,
        message: "reply",
        userId: undefined,
        requesterId: "slack:U2",
        sessionOwnerId: "owner",
        source: "slack",
        attachments: [
          {
            path: "/tmp/example.pdf",
            mimeType: "application/pdf",
            filename: "example.pdf",
            size: 4,
          },
        ],
        context: { kind: "web", name: "Other" },
        slackDelivery: { channel: "C1", threadTs: "1.1", eventId: "event2" },
        onEvent,
      };
      expect((await runAgent(queued)).meta.queued).toBe(true);
      expect(sdk.queueMessage).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(1);
      expect(onEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "done" })
      );
      release();
      await first;
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1][0]).toMatchObject({
        userId: undefined,
        requesterId: "slack:U2",
        sessionOwnerId: "owner",
        attachments: queued.attachments,
        context: queued.context,
      });
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "done" })
      );
      expect(
        (await getSimpleHistory("alpha", sessionId, "owner")).map(
          (message) => message.content
        )
      ).toEqual(["opener", "reply"]);
    }
  );

  it("distinguishes two unpaired requesters and still injects same-requester follow-ups", async () => {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = vi.fn(async (params: SdkRunParams) => {
      params.onSessionHandle?.({});
      if (params.message === "first") {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { text: "ok" };
    });
    const sdk = adapter(run);
    getAdapter.mockReturnValue(sdk);
    const common = {
      agentId: "alpha",
      sessionId: "unpaired-overlap",
      sessionOwnerId: null,
    };
    const first = runAgent({
      ...common,
      message: "first",
      requesterId: "slack:U1",
    });
    await ready;
    await runAgent({ ...common, message: "same", requesterId: "slack:U1" });
    expect(sdk.queueMessage).toHaveBeenCalledTimes(1);
    await runAgent({
      ...common,
      message: "different",
      requesterId: "slack:U2",
    });
    expect(sdk.queueMessage).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(run.mock.calls.map(([params]) => params.message)).toEqual([
      "first",
      "different",
    ]);
  });

  it("reserves an idle session atomically for simultaneous different requesters", async () => {
    let release!: () => void;
    let started!: () => void;
    let activeRuns = 0;
    let maxActiveRuns = 0;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = vi.fn(async () => {
      activeRuns++;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      if (run.mock.calls.length === 1) {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      activeRuns--;
      return { text: "ok" };
    });
    const sdk = adapter(run);
    getAdapter.mockReturnValue(sdk);
    const requests = ["sender-one", "sender-two"].map((requesterId) =>
      runAgent({
        agentId: "alpha",
        sessionId: "simultaneous",
        sessionOwnerId: "owner",
        requesterId,
        message: requesterId,
      })
    );
    await ready;
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(sdk.queueMessage).not.toHaveBeenCalled();
    release();
    await Promise.all(requests);
    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActiveRuns).toBe(1);
  });

  it("delivers queued outcomes once and keeps progressing after turn or delivery failures", async () => {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = vi.fn(async (params: SdkRunParams) => {
      if (params.message === "opener") {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (params.message === "failure") throw new Error("turn failed");
      return { text: params.message };
    });
    getAdapter.mockReturnValue(adapter(run));
    const common = {
      agentId: "alpha",
      sessionId: "deferred-delivery",
      sessionOwnerId: "owner",
    };
    const first = runAgent({
      ...common,
      message: "opener",
      requesterId: "opener",
    });
    await ready;
    const failedTurn = vi.fn();
    const failedDelivery = vi.fn(async () => {
      throw new Error("delivery failed");
    });
    const lastDelivery = vi.fn();
    await runAgent({
      ...common,
      message: "failure",
      requesterId: "sender1",
      onDeferredResult: failedTurn,
    });
    await runAgent({
      ...common,
      message: "delivery failure",
      requesterId: "sender2",
      onDeferredResult: failedDelivery,
    });
    await runAgent({
      ...common,
      message: "last",
      requesterId: "sender3",
      onDeferredResult: lastDelivery,
    });
    release();
    await first;
    expect(failedTurn).toHaveBeenCalledTimes(1);
    expect(failedTurn).toHaveBeenCalledWith({ error: expect.any(Error) });
    expect(failedDelivery).toHaveBeenCalledTimes(1);
    expect(lastDelivery).toHaveBeenCalledTimes(1);
    expect(lastDelivery).toHaveBeenCalledWith({
      result: expect.objectContaining({ payloads: [{ text: "last" }] }),
    });
    expect(run.mock.calls.map(([params]) => params.message)).toEqual([
      "opener",
      "failure",
      "delivery failure",
      "last",
    ]);
  });

  it("checks backing files after restart and resets owner-indexed sessions by id", async () => {
    const original = await ensureSession("alpha", "slack:restart", "owner");
    expect(await hasSession("alpha", original.sessionId, "owner")).toBe(true);
    expect(await hasSession("alpha", original.sessionId, "requester")).toBe(
      false
    );
    deleteSession("alpha", original.sessionId);
    const historyDir = path.join(home, "sessions", "users", "owner", "history");
    const files = await fs.readdir(historyDir);
    const file = files.find((name) => name.includes(original.sessionId));
    await fs.rm(path.join(historyDir, file!));
    expect(
      await getSessionEntry("alpha", "slack:restart", "owner")
    ).toBeDefined();
    expect(await hasSession("alpha", original.sessionId, "owner")).toBe(false);
    await resetSession("alpha", original.sessionId, "owner");
    const fresh = await ensureSession("alpha", "slack:restart", "owner");
    expect(fresh.sessionId).not.toBe(original.sessionId);
    expect(await hasSession("alpha", fresh.sessionId, "owner")).toBe(true);
    await resetSession("alpha", fresh.sessionId, "owner");
    expect(
      await getSessionEntry("alpha", "slack:restart", "owner")
    ).toBeUndefined();
    expect(await hasSession("alpha", fresh.sessionId, "owner")).toBe(false);
  });

  it("waits for stopped-turn persistence before clearing a bound session", async () => {
    const entry = await ensureSession("alpha", "slack:reset-active", "owner");
    const lifecycle = new SessionRunLifecycle({
      agentId: "alpha",
      sessionId: entry.sessionId,
      userId: "owner",
    });
    const controller = lifecycle.beginRun();
    let resetDone = false;
    const reset = resetSession("alpha", entry.sessionId, "owner").then(() => {
      resetDone = true;
    });
    expect(controller.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(resetDone).toBe(false);
    await lifecycle.beginUserTurn("last persisted input", Date.now());
    await lifecycle.flushTurns();
    lifecycle.finishRun();
    await reset;
    expect(await hasSession("alpha", entry.sessionId, "owner")).toBe(false);
  });

  it("cancels queued turns before resetting active history and removes the container transcript", async () => {
    const entry = await ensureSession("alpha", "slack:reset-queued", "owner");
    const transcript = path.join(
      home,
      "sessions",
      "users",
      "owner",
      "sessions",
      "alpha",
      `${entry.sessionId}.jsonl`
    );
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(transcript, "old container session");
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = vi.fn(async (params: SdkRunParams) => {
      started();
      await new Promise<void>((resolve) => {
        params.abortSignal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      return { text: "", aborted: true };
    });
    getAdapter.mockReturnValue(adapter(run));
    const first = runAgent({
      agentId: "alpha",
      sessionId: entry.sessionId,
      message: "opener",
      userId: "owner",
    });
    await ready;
    const onEvent = vi.fn();
    await runAgent({
      agentId: "alpha",
      sessionId: entry.sessionId,
      sessionOwnerId: "owner",
      userId: "requester",
      message: "queued",
      onEvent,
    });
    await resetSession("alpha", entry.sessionId, "owner");
    await first;
    expect(run).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "done",
        meta: expect.objectContaining({ aborted: true }),
      })
    );
    expect(await hasSession("alpha", entry.sessionId, "owner")).toBe(false);
    await expect(fs.access(transcript)).rejects.toThrow();
  });

  it("times out a hung reset without removing its owner binding target", async () => {
    const entry = await ensureSession("alpha", "slack:reset-hang", "owner");
    const lifecycle = new SessionRunLifecycle({
      agentId: "alpha",
      sessionId: entry.sessionId,
      userId: "owner",
    });
    lifecycle.beginRun();
    vi.useFakeTimers();
    try {
      const reset = expect(
        resetSession("alpha", entry.sessionId, "owner")
      ).rejects.toThrow("Session is still stopping");
      await vi.advanceTimersByTimeAsync(2000);
      await reset;
      expect(
        await getSessionEntry("alpha", "slack:reset-hang", "owner")
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
      lifecycle.finishRun();
    }
    expect(await hasSession("alpha", entry.sessionId, "owner")).toBe(true);
    await resetSession("alpha", entry.sessionId, "owner");
  });
});
