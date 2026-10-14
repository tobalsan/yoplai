import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import {
  createInternalSocketApp,
  startConfiguredInternalSocket,
  startInternalSocketServer,
} from "./internal-socket.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tmpDir(): string {
  // Short path: Unix socket paths are limited to ~104-108 bytes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ygs-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function request(
  socketPath: string,
  method: string,
  urlPath: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: urlPath }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function stubRoutes(): Hono {
  const routes = new Hono();
  routes.post("/tools", (c) => c.json({ ok: true }));
  return routes;
}

describe("internal socket server", () => {
  it("serves /internal and nothing else", async () => {
    const dir = tmpDir();
    const socket = await startInternalSocketServer(
      path.join(dir, "run"),
      createInternalSocketApp(stubRoutes())
    );
    cleanups.push(() => socket.close());

    expect(await request(socket.socketPath, "POST", "/internal/tools")).toEqual({
      status: 200,
      body: JSON.stringify({ ok: true }),
    });
    expect((await request(socket.socketPath, "GET", "/api/agents")).status).toBe(404);
    expect((await request(socket.socketPath, "GET", "/health")).status).toBe(404);
  });

  it("restricts the socket and its directory to the gateway user", async () => {
    const dir = tmpDir();
    const socket = await startInternalSocketServer(
      path.join(dir, "run"),
      createInternalSocketApp(stubRoutes())
    );
    cleanups.push(() => socket.close());

    expect(fs.statSync(socket.socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "run")).mode & 0o777).toBe(0o700);
  });

  it("replaces a stale socket left by a crashed gateway", async () => {
    const dir = tmpDir();
    const runDir = path.join(dir, "run");
    fs.mkdirSync(runDir);
    // A gateway killed with SIGKILL leaves its socket file behind; a clean
    // Node close() would unlink it, so the crash runs in a child process.
    const stalePath = path.join(runDir, "gateway.sock");
    const child = spawn(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(stalePath)}, () => console.log("up"))`,
    ]);
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(fs.lstatSync(stalePath).isSocket()).toBe(true);

    const second = await startInternalSocketServer(
      path.join(dir, "run"),
      createInternalSocketApp(stubRoutes())
    );
    cleanups.push(() => second.close());

    expect((await request(second.socketPath, "POST", "/internal/tools")).status).toBe(200);
  });

  it("removes the socket on close", async () => {
    const dir = tmpDir();
    const socket = await startInternalSocketServer(
      path.join(dir, "run"),
      createInternalSocketApp(stubRoutes())
    );
    socket.close();
    expect(fs.existsSync(socket.socketPath)).toBe(false);
  });
});

describe("startConfiguredInternalSocket", () => {
  it("starts with the socket transport even when no agent is sandboxed yet", async () => {
    const home = tmpDir();
    // No sandboxed agent at boot: one may enable its sandbox later via reload.
    const config = {
      agents: [{ id: "a", sandbox: { enabled: false } }],
      sandbox: { gatewayTransport: "socket" },
    } as unknown as GatewayConfig;
    const socket = await startConfiguredInternalSocket(config, home, (dir) =>
      startInternalSocketServer(dir, createInternalSocketApp(stubRoutes()))
    );
    expect(socket).toBeDefined();
    cleanups.push(() => socket?.close());
    expect(
      (await request(socket!.socketPath, "POST", "/internal/tools")).status
    ).toBe(200);
  });

  it("does nothing with the default http transport", async () => {
    let started = false;
    const socket = await startConfiguredInternalSocket(
      { agents: [] } as unknown as GatewayConfig,
      tmpDir(),
      async (dir) => {
        started = true;
        return startInternalSocketServer(dir);
      }
    );
    expect(socket).toBeUndefined();
    expect(started).toBe(false);
  });
});
