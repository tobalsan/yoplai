import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { writeTestV3Config } from "../test-utils/v3-config.js";

describe("lead session websocket events", () => {
  let tmpDir: string;
  let prevHomeDir: string | undefined;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let port: number;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-session-ws-"));
    prevHomeDir = process.env.YOPLAI_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    await writeTestV3Config(path.join(tmpDir, ".yoplai"));

    vi.resetModules();
    const { startServer } = await import("./index.js");
    server = startServer(0, "127.0.0.1");
    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.once("listening", () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("broadcasts lead_session_changed", async () => {
    const { agentEventBus } = await import("../agents/index.js");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 2000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === "lead_session_changed") {
          clearTimeout(timeout);
          resolve(msg);
        }
      });
    });

    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    agentEventBus.emit("lead_session.changed", {
      type: "lead_session_changed",
      kind: "created",
      session: {
        id: "lead:PRO-1:abc",
        projectId: "PRO-1",
        agentId: "pom",
        kind: "lead",
        title: "New session",
        titleLocked: false,
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        transcriptRef: "abc",
      },
    });

    await expect(received).resolves.toMatchObject({
      type: "lead_session_changed",
      kind: "created",
      session: { id: "lead:PRO-1:abc" },
    });
    ws.close();
  });
});
