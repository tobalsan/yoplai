import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { writeTestV3Config } from "../test-utils/v3-config.js";

describe("/api/debug/events", () => {
  let tmpDir: string;
  let prevHomeDir: string | undefined;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let port: number;

  let prevDev: string | undefined;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-debug-events-"));
    prevHomeDir = process.env.YOPLAI_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    prevDev = process.env.YOPLAI_DEV;
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    process.env.YOPLAI_DEV = "1";

    await writeTestV3Config(path.join(tmpDir, ".yoplai"), {
      agents: [
        {
          id: "test-agent",
          name: "Test",
          model: {
            provider: "anthropic",
            model: "claude-3-5-sonnet-20241022",
          },
        },
      ],
    });

    vi.resetModules();
    const serverMod = await import("./index.js");
    server = serverMod.startServer(0, "127.0.0.1");
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
    if (prevDev === undefined) delete process.env.YOPLAI_DEV;
    else process.env.YOPLAI_DEV = prevDev;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns recent events", async () => {
    const { agentEventBus } = await import("../agents/events.js");
    agentEventBus.emitStatusChange({
      agentId: "test-agent",
      status: "streaming",
      sessionId: "main",
      sessionStatus: "streaming",
    });
    agentEventBus.emitStatusChange({
      agentId: "test-agent",
      status: "idle",
      sessionId: "main",
      sessionStatus: "idle",
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/debug/events`);
    expect(res.ok).toBe(true);

    const body = await res.json();
    expect(body.events).toBeInstanceOf(Array);
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    expect(body.events[body.events.length - 1]).toMatchObject({
      type: "statusChange",
      data: { agentId: "test-agent", status: "idle" },
    });
  });
});
