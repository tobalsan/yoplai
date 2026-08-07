import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerInput } from "@yoplai/shared";
import { callGatewayTool } from "../gateway-client.js";
import { startIpcPoller } from "../ipc.js";
import {
  EVENT_PREFIX,
  OUTPUT_END,
  OUTPUT_START,
  runAgentRunner,
  writeProtocolOutput,
  writeStreamEvent,
} from "../index.js";

type FetchMock = (input: URL, init?: RequestInit) => Promise<Response>;

const input: ContainerInput = {
  agentId: "agent-1",
  sessionId: "session-1",
  message: "hello",
  workspaceDir: "/workspace",
  sessionDir: "/sessions",
  ipcDir: "/ipc",
  gatewayUrl: "http://gateway:3000",
  agentToken: "token-1",
  sdkConfig: {
    sdk: "pi",
    model: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent runner entry point", () => {
  it("parses stdin, streams events, and writes final output", async () => {
    const chunks: string[] = [];
    const runAgent = vi.fn(async (_input, onStreamEvent) => {
      onStreamEvent?.({ type: "assistant_text", text: "delta", timestamp: 1 });
      return { text: "stubbed" };
    });

    await runAgentRunner({
      readStdin: async () => JSON.stringify(input),
      writeStdout: (chunk) => chunks.push(chunk),
      writeStderr: () => undefined,
      runAgent,
      startIpcPoller: () => () => undefined,
    });

    expect(runAgent).toHaveBeenCalledWith(input, expect.any(Function));
    expect(chunks.join("")).toBe(
      `${EVENT_PREFIX}{"type":"assistant_text","text":"delta","timestamp":1}\n${OUTPUT_START}\n{"text":"stubbed"}\n${OUTPUT_END}\n`
    );
  });

  it("formats stream event output", () => {
    const chunks: string[] = [];

    writeStreamEvent(
      { type: "assistant_text", text: "hello", timestamp: 1 },
      (chunk) => chunks.push(chunk)
    );

    expect(chunks).toEqual([
      `${EVENT_PREFIX}{"type":"assistant_text","text":"hello","timestamp":1}\n`,
    ]);
  });

  it("formats sentinel output", () => {
    const chunks: string[] = [];

    writeProtocolOutput({ text: "hello" }, (chunk) => chunks.push(chunk));

    expect(chunks).toEqual([
      `${OUTPUT_START}\n`,
      '{"text":"hello"}\n',
      `${OUTPUT_END}\n`,
    ]);
  });
});

describe("IPC poller", () => {
  it("does not redeliver a message while its handler is pending", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-ipc-"));
    const inputDir = path.join(tempDir, "input");
    await fs.mkdir(inputDir);
    await fs.writeFile(
      path.join(inputDir, "0001.json"),
      JSON.stringify({ message: "follow-up" })
    );

    let releaseHandler: (() => void) | undefined;
    const handlerPending = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const onMessage = vi.fn(async () => handlerPending);
    const cleanup = startIpcPoller(tempDir, onMessage, () => undefined);

    try {
      await waitFor(() => onMessage.mock.calls.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(onMessage).toHaveBeenCalledTimes(1);
      releaseHandler?.();
    } finally {
      cleanup();
      releaseHandler?.();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads follow-up messages and close sentinel", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-ipc-"));
    const inputDir = path.join(tempDir, "input");
    await fs.mkdir(inputDir);

    const messages: unknown[] = [];
    let closed = false;
    const messageSeen = waitFor(() => messages.length === 1);
    const closeSeen = waitFor(() => closed);

    const cleanup = startIpcPoller(
      tempDir,
      (message) => {
        messages.push(message);
      },
      () => {
        closed = true;
      }
    );

    try {
      await fs.writeFile(
        path.join(inputDir, "0001.json"),
        JSON.stringify({ message: "follow-up" })
      );
      await messageSeen;
      await fs.writeFile(path.join(inputDir, "_close"), "");
      await closeSeen;
    } finally {
      cleanup();
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(messages).toEqual([{ message: "follow-up" }]);
    expect(closed).toBe(true);
  });
});

describe("concurrent same-agent containers", () => {
  it("delivers one queued follow-up to exactly one live container", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-ipc-home-"));
    // Reproduce the incident shape: BOTH live containers for agent-1 poll the
    // SAME directory (the pre-fix `ipc/<agentId>` layout), so only the
    // envelope's ownership check can keep the follow-up out of the wrong run.
    const sharedIpc = path.join(home, "ipc", "agent-1");
    await fs.mkdir(path.join(sharedIpc, "input"), { recursive: true });

    const suppressed = vi.spyOn(console, "error").mockImplementation(() => {});
    const stderrA: string[] = [];
    const stderrB: string[] = [];
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const holdB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const runA = runAgentRunner({
      readStdin: async () =>
        JSON.stringify({
          ...input,
          sessionId: "session-1",
          runId: "run-1",
          ipcDir: sharedIpc,
        }),
      writeStdout: () => undefined,
      writeStderr: (chunk) => stderrA.push(chunk),
      runAgent: async () => {
        await holdA;
        return { text: "" };
      },
    });
    const runB = runAgentRunner({
      readStdin: async () =>
        JSON.stringify({
          ...input,
          sessionId: "session-2",
          runId: "run-2",
          ipcDir: sharedIpc,
        }),
      writeStdout: () => undefined,
      writeStderr: (chunk) => stderrB.push(chunk),
      runAgent: async () => {
        await holdB;
        return { text: "" };
      },
    });

    try {
      // One follow-up, addressed to container A's run.
      await fs.writeFile(
        path.join(sharedIpc, "input", `${Date.now()}-follow-up.json`),
        JSON.stringify({
          message: "keep going",
          timestamp: Date.now(),
          agentId: "agent-1",
          sessionId: "session-1",
          runId: "run-1",
        })
      );

      await waitFor(() =>
        stderrA.join("").includes("Received follow-up IPC message")
      );
      await waitFor(() =>
        stderrB.join("").includes("Received follow-up IPC message")
      );
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Both pollers read the file — that is the hazard the ownership check
      // exists for. Exactly one of them refuses it, so exactly one steers it.
      const suppressions = suppressed.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes("Suppressed IPC delivery"));
      expect(suppressions).toHaveLength(1);
      expect(suppressions[0]).toContain("session_mismatch");
      expect(suppressions[0]).toContain("session session-2");
      // Follow-up text never reaches stderr, on either container.
      expect(stderrA.join("")).not.toContain("keep going");
      expect(stderrB.join("")).not.toContain("keep going");
    } finally {
      releaseA?.();
      releaseB?.();
      await Promise.all([runA, runB]);
      suppressed.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("does not steer a misaddressed envelope into the session", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-ipc-home-"));
    const ipcA = path.join(home, "ipc", "agent-1", "session-1-run-1");
    await fs.mkdir(path.join(ipcA, "input"), { recursive: true });

    const suppressed = vi.spyOn(console, "error").mockImplementation(() => {});
    const stderrA: string[] = [];
    let releaseA: (() => void) | undefined;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const runA = runAgentRunner({
      readStdin: async () =>
        JSON.stringify({
          ...input,
          sessionId: "session-1",
          runId: "run-1",
          ipcDir: ipcA,
        }),
      writeStdout: () => undefined,
      writeStderr: (chunk) => stderrA.push(chunk),
      runAgent: async () => {
        await holdA;
        return { text: "" };
      },
    });

    try {
      await fs.writeFile(
        path.join(ipcA, "input", `${Date.now()}-stray.json`),
        JSON.stringify({
          message: "not for you",
          timestamp: Date.now(),
          agentId: "agent-1",
          sessionId: "session-9",
          runId: "run-9",
        })
      );

      await waitFor(() =>
        suppressed.mock.calls.some(([message]) =>
          String(message).includes("Suppressed IPC delivery")
        )
      );
      expect(
        suppressed.mock.calls.some(([message]) =>
          String(message).includes("session_mismatch")
        )
      ).toBe(true);
    } finally {
      releaseA?.();
      await runA;
      suppressed.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("gateway client", () => {
  it("posts tool calls to the internal tools endpoint", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      Response.json({ ok: true, value: 42 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callGatewayTool(
      "http://gateway:3000",
      "token-1",
      "project.get",
      { projectId: "PRO-1" },
      "agent-1",
      "session-1"
    );

    expect(result).toEqual({ ok: true, value: 42 });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/internal/tools", "http://gateway:3000"),
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Agent-Id": "agent-1",
          "X-Agent-Token": "token-1",
        },
        body: JSON.stringify({
          tool: "project.get",
          args: { projectId: "PRO-1" },
          agentId: "agent-1",
          agentToken: "token-1",
          sessionId: "session-1",
        }),
      })
    );
  });
});

function waitFor(condition: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        resolve();
        return;
      }

      if (Date.now() - startedAt > 2000) {
        clearInterval(interval);
        reject(new Error("timed out waiting for condition"));
      }
    }, 20);
  });
}
