import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { writeTestV3Config } from "../test-utils/v3-config.js";

describe("gateway multi-user websocket auth", () => {
  let tmpDir: string;
  let prevHomeDir: string | undefined;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let port: number;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-ws-auth-"));
    prevHomeDir = process.env.YOPLAI_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    await writeTestV3Config(path.join(tmpDir, ".yoplai"), {
      agents: [{ id: "main", name: "Main" }],
      extensions: {
        multiUser: {
          enabled: true,
          oauth: {
            google: {
              clientId: "client-id",
              clientSecret: "client-secret",
            },
          },
          sessionSecret: "x".repeat(32),
        },
      },
    });

    vi.resetModules();
    const { clearConfigCacheForTests, loadConfig } =
      await import("../config/index.js");
    clearConfigCacheForTests();
    const { loadExtensions } = await import("../extensions/registry.js");
    await loadExtensions(loadConfig());

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

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects websocket upgrades without a valid session", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const statusCode = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 2000);
      ws.on("unexpected-response", (_request, response) => {
        clearTimeout(timeout);
        resolve(response.statusCode ?? 0);
      });
      ws.on("open", () => {
        clearTimeout(timeout);
        reject(new Error("unexpected open"));
      });
      ws.on("error", () => undefined);
    });

    expect(statusCode).toBe(401);
  });
});
