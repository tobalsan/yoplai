import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Logger } from "vite";

describe("vite dev proxy", () => {
  const closers: Array<() => Promise<void>> = [];
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-vite-proxy-"));
    for (const name of Object.keys(process.env)) {
      if (!/^(?:PATH|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TZ|CI|NODE_ENV|VITEST(?:_.*)?)$/.test(name)) vi.stubEnv(name, undefined);
    }
    vi.stubEnv("HOME", home);
    vi.stubEnv("YOPLAI_HOME", path.join(home, "yoplai"));
  });
  afterEach(async () => {
    try {
      await Promise.all(closers.splice(0).map((close) => close()));
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("adds the client address to X-Forwarded-For for a request and a socket upgrade", async () => {
    const seen: Array<string | string[] | undefined> = [];
    let upgradeHeaders: http.IncomingHttpHeaders | undefined;
    const gateway = http.createServer((req, res) => {
      seen.push(req.headers["x-forwarded-for"]);
      res.end("ok");
    });
    gateway.on("upgrade", (req, socket) => {
      upgradeHeaders = req.headers;
      seen.push(req.headers["x-forwarded-for"]);
      socket.destroy();
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => { gateway.closeAllConnections(); gateway.close(() => resolve()); }));
    const gatewayPort = (gateway.address() as AddressInfo).port;
    vi.stubEnv("YOPLAI_GATEWAY_PORT", String(gatewayPort));
    const ui = await createServer({
      configFile: new URL("../vite.config.ts", import.meta.url).pathname,
      logLevel: "silent",
      server: { port: 0, host: "127.0.0.1" },
    });
    closers.push(() => ui.close());
    await ui.listen();
    const uiPort = (ui.httpServer?.address() as AddressInfo).port;

    await fetch(`http://127.0.0.1:${uiPort}/api/agents`, { headers: { "x-forwarded-for": "10.0.0.5" } });
    await new Promise<void>((resolve) => {
      const upgrade = http.request({
        port: uiPort,
        host: "127.0.0.1",
        path: "/ws",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          origin: `http://127.0.0.1:${uiPort}`,
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "x-forwarded-for": "10.0.0.5",
        },
      });
      upgrade.on("error", () => resolve());
      upgrade.on("close", () => resolve());
      upgrade.end();
    });
    expect(seen).toEqual(["10.0.0.5,127.0.0.1", "10.0.0.5,127.0.0.1"]);
    expect(upgradeHeaders).toMatchObject({
      host: `127.0.0.1:${gatewayPort}`,
      origin: `http://127.0.0.1:${uiPort}`,
    });
  });

  it("keeps a viewer grant out of the proxy error log when the gateway connection fails", async () => {
    // An ephemeral port with no listener stands for a gateway that is down.
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("YOPLAI_GATEWAY_PORT", String((closed.address() as AddressInfo).port));
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const errors: string[] = [];
    const customLogger: Logger = {
      info: () => undefined,
      warn: () => undefined,
      warnOnce: () => undefined,
      error: (message) => { errors.push(message); },
      clearScreen: () => undefined,
      hasErrorLogged: () => false,
      hasWarned: false,
    };
    const ui = await createServer({
      configFile: new URL("../vite.config.ts", import.meta.url).pathname,
      customLogger,
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { port: 0, host: "127.0.0.1" },
    });
    closers.push(() => ui.close());
    await ui.listen();
    const uiPort = (ui.httpServer?.address() as AddressInfo).port;

    const grant = "synthetic-grant-not-a-real-credential-0000";
    const id = "A".repeat(32);
    const viewerRequests = [
      `/api/relay/dashboard-views/${grant}/${id}/`,
      `/api/relay/dashboard-views/${grant}/${id}/?region=emea`,
      `/api/relay/dashboard-views/${grant}/current`,
      `/api/relay/dashboard-views%2F${grant}/${id}/`,
      `/api/relay/dashboard-views%252F${grant}/${id}/`,
      `/api/relay/dashboard%2Dviews/${grant}/${id}/`,
      `/api/Relay/Dashboard-Views/${grant}/${id}/`,
      `/api/relay/dashboard-views%2F${grant}%zz/${id}/`,
    ];
    for (const path of viewerRequests) {
      const response = await fetch(`http://127.0.0.1:${uiPort}${path}`);
      expect(response.status).toBe(500);
    }
    expect(errors).toHaveLength(viewerRequests.length);
    for (const message of errors) {
      expect(message).toContain("http proxy error");
      expect(message).not.toContain(grant);
    }

    // The status path of a browser link holds an attempt ID, in every spelling.
    errors.length = 0;
    const attempt = "SyntheticAttemptNotReal0123456789abcdefghi";
    const linkRequests = [
      `/api/relay/link/status/${attempt}`,
      `/api/relay/link%2Fstatus%2F${attempt}`,
      `/api/Relay/Link/status/${attempt}`,
      `/api/relay/link/status/${attempt}?x=1`,
    ];
    for (const path of linkRequests) {
      expect((await fetch(`http://127.0.0.1:${uiPort}${path}`)).status).toBe(500);
    }
    expect(errors).toHaveLength(linkRequests.length);
    for (const message of errors) {
      expect(message).toContain("http proxy error");
      expect(message).not.toContain(attempt);
    }

    // The remote link paths hold request IDs, and a stray request can hold a verifier. The whole target is hidden.
    errors.length = 0;
    const requestId = "SyntheticRequestNotReal0123456789abcdefghi";
    const remoteLinkRequests = [
      `/api/auth/gateway-link/requests/${requestId}`,
      `/api/auth/gateway-link/token?verifier=${requestId}`,
      `/api/auth/gateway%2Dlink/requests/${requestId}`,
      `/api/auth/gateway-link%2Frequests%2F${requestId}`,
      `/api/Auth/Gateway-Link/requests/${requestId}`,
      `/api/auth/gateway-link%3Fverifier=${requestId}`,
    ];
    for (const path of remoteLinkRequests) {
      expect((await fetch(`http://127.0.0.1:${uiPort}${path}`)).status).toBe(500);
    }
    expect(errors).toHaveLength(remoteLinkRequests.length);
    for (const message of errors) {
      expect(message).toContain("http proxy error");
      expect(message).not.toContain(requestId);
    }

    errors.length = 0;
    const handle = "fake-model-attempt-handle";
    const query = "fake-model-access-query";
    const modelAccessRequests = [
      `/api/model-access/oauth/attempts/${handle}/answer?code=${query}`,
      `/api/model%2Daccess/oauth/attempts%2F${handle}?other=${query}`,
      `/api/model-access?other=${query}`,
    ];
    for (const path of modelAccessRequests) {
      expect((await fetch(`http://127.0.0.1:${uiPort}${path}`)).status).toBe(500);
    }
    expect(errors).toHaveLength(modelAccessRequests.length);
    for (const message of errors) {
      expect(message).toContain("http proxy error: /api/model-access/[redacted]");
      expect(message).not.toContain(handle);
      expect(message).not.toContain(query);
    }

    // Other proxy errors keep their request URL.
    errors.length = 0;
    expect((await fetch(`http://127.0.0.1:${uiPort}/api/agents?agent=pom`)).status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("http proxy error: /api/agents?agent=pom");
    expect(errors[0]).toContain("ECONNREFUSED");
  });
});
