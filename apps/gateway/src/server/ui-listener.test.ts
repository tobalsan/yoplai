import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { relayLinkApi } from "../relay/link-routes.js";
import { isForwardedPath, redactedTarget, startUiListener } from "./ui-listener.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function listening(server: http.Server): Promise<void> {
  return server.listening ? Promise.resolve() : new Promise((resolve) => server.once("listening", () => resolve()));
}

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders };

/** A raw request with a path that fetch would normalize, or a Host that fetch would not send. */
function rawGet(port: number, target: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = host ? { host } : undefined;
    const request = http.request({ host: "127.0.0.1", port, path: target, method: "GET", headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("UI listener", () => {
  let webDist: string;
  let outside: string;
  let gateway: http.Server;
  let wss: WebSocketServer;
  let ui: http.Server;
  let gatewayPort: number;
  let uiPort: number;
  let seen = undefined as Seen | undefined;
  let upgradeSeen = undefined as Seen | undefined;

  beforeEach(async () => {
    seen = undefined;
    upgradeSeen = undefined;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-ui-listener-"));
    webDist = path.join(root, "web");
    outside = path.join(root, "secret.txt");
    await fs.mkdir(path.join(webDist, "assets"), { recursive: true });
    await fs.writeFile(path.join(webDist, "index.html"), "<html>app shell</html>");
    await fs.writeFile(path.join(webDist, "assets", "app-abc.js"), "console.log('app')");
    await fs.writeFile(outside, "outside secret");
    await fs.symlink(outside, path.join(webDist, "link.txt"));

    gatewayPort = await freePort();
    gateway = http.createServer((request, response) => {
      seen = { method: request.method, url: request.url, headers: request.headers };
      if (request.url?.startsWith("/api/missing")) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end('{"error":"not found"}');
        return;
      }
      if (request.url?.startsWith("/api/truncate")) {
        response.writeHead(200, { "Content-Length": "100" });
        response.write("partial");
        setTimeout(() => response.destroy(), 20);
        return;
      }
      if (request.url?.startsWith("/api/hop")) {
        response.writeHead(200, { Connection: "x-private-response, close", "X-Private-Response": "secret", "Keep-Alive": "timeout=5", "X-Kept": "yes" });
        response.end("ok");
        return;
      }
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json", "X-Upstream": "yes" });
        response.end(JSON.stringify({ ok: true, body }));
      });
    });
    wss = new WebSocketServer({ noServer: true });
    gateway.on("upgrade", (request, socket, head) => {
      upgradeSeen = { url: request.url, headers: request.headers };
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (data) => ws.send(`echo:${data.toString()}`));
      });
    });
    gateway.listen(gatewayPort, "127.0.0.1");
    await listening(gateway);

    uiPort = await freePort();
    ui = startUiListener({
      webDist,
      host: "127.0.0.1",
      port: uiPort,
      gatewayHost: "127.0.0.1",
      gatewayPort,
      onError: (error) => {
        throw error;
      },
    });
    await listening(ui);
  });

  afterEach(async () => {
    for (const ws of wss.clients) ws.terminate();
    ui.closeAllConnections();
    gateway.closeAllConnections();
    await Promise.all([new Promise((r) => ui.close(r)), new Promise((r) => gateway.close(r))]);
    await fs.rm(path.dirname(webDist), { recursive: true, force: true });
  });

  const lastSeen = () => seen;
  const get = (target: string) => fetch(`http://127.0.0.1:${uiPort}${target}`);

  it("serves the app shell for the root and for a deep link", async () => {
    for (const target of ["/", "/chat/agent-1/session-2", "/p/project-9"]) {
      const response = await get(target);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<html>app shell</html>");
    }
  });

  it("serves a built asset with its type", async () => {
    const response = await get("/assets/app-abc.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/javascript/);
    expect(await response.text()).toBe("console.log('app')");
  });

  it("returns 404 for a missing asset and not the app shell", async () => {
    const response = await get("/assets/missing-abc.js");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("app shell");
  });

  it("returns 404 for a missing asset in any spelling and for a missing file extension", async () => {
    for (const target of ["/assets/missing%2ejs", "/assets/missing", "/assets/", "/%61ssets/missing", "/missing.css", "/chat/a%2eb"]) {
      const response = await rawGet(uiPort, target);
      expect(response.status, target).toBe(404);
      expect(response.body, target).not.toContain("app shell");
    }
  });

  it("answers HEAD for a real file with no body, and gives no app shell to HEAD of a page", async () => {
    const file = await fetch(`http://127.0.0.1:${uiPort}/assets/app-abc.js`, { method: "HEAD" });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-length")).toBe(String("console.log('app')".length));
    expect(await file.text()).toBe("");
    const page = await fetch(`http://127.0.0.1:${uiPort}/chat/agent-1`, { method: "HEAD" });
    expect(page.status).toBe(404);
  });

  it("accepts every loopback Host name of the UI port", async () => {
    for (const host of [`127.0.0.1:${uiPort}`, `localhost:${uiPort}`, `[::1]:${uiPort}`]) {
      expect((await rawGet(uiPort, "/", host)).status, host).toBe(200);
    }
  });

  it("refuses a foreign Host for pages and forwarded paths, and forwards nothing", async () => {
    for (const host of [`evil.example:${uiPort}`, "localhost", `127.0.0.1:${uiPort + 1}`]) {
      for (const target of ["/", "/api/agents"]) {
        const response = await rawGet(uiPort, target, host);
        expect(response.status, `${host} ${target}`).toBe(403);
        expect(response.body).not.toContain("app shell");
      }
    }
    expect(seen).toBeUndefined();
  });

  it("refuses a WebSocket upgrade with a foreign Host", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${uiPort}/ws`, { headers: { Host: `evil.example:${uiPort}` } });
    const status = await new Promise<number | undefined>((resolve) => {
      ws.once("unexpected-response", (_request, response) => resolve(response.statusCode));
      ws.once("open", () => resolve(101));
      ws.once("error", () => resolve(undefined));
    });
    ws.terminate();
    expect(status).not.toBe(101);
    expect(upgradeSeen).toBeUndefined();
  });

  it("does not serve the app shell to a non-GET request", async () => {
    const response = await fetch(`http://127.0.0.1:${uiPort}/chat/agent-1`, { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
  });

  it("returns the 404 of the gateway for an unknown /api path and not the app shell", async () => {
    const response = await get("/api/missing/thing");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"not found"}');
  });

  it("returns 502 and not the app shell when the gateway is down", async () => {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    const response = await get("/api/anything");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("app shell");
    gateway.listen(gatewayPort, "127.0.0.1");
    await listening(gateway);
  });

  it("blocks path traversal, encoded traversal, and a symlink out of the web directory", async () => {
    for (const target of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/link.txt"]) {
      const response = await rawGet(uiPort, target);
      expect(response.status).toBe(404);
      expect(response.body).not.toContain("outside secret");
    }
  });

  it("forwards a request with the Host of the gateway, the Origin kept, and the peer added", async () => {
    const origin = `http://127.0.0.1:${uiPort}`;
    const response = await fetch(`${origin}/api/things?x=1`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: '{"a":1}',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream")).toBe("yes");
    expect(await response.json()).toEqual({ ok: true, body: '{"a":1}' });
    expect(seen?.method).toBe("POST");
    expect(seen?.url).toBe("/api/things?x=1");
    expect(seen?.headers.host).toBe(`127.0.0.1:${gatewayPort}`);
    expect(seen?.headers.origin).toBe(origin);
    expect(seen?.headers["x-forwarded-for"]).toMatch(/127\.0\.0\.1/);
  });

  it("destroys the response when the upstream closes in the middle of the body", async () => {
    const outcome = await new Promise<string>((resolve) => {
      const request = http.get({ host: "127.0.0.1", port: uiPort, path: "/api/truncate" }, (response) => {
        response.on("data", () => {});
        response.on("error", () => resolve("closed"));
        response.on("close", () => resolve(response.complete ? "complete" : "closed"));
      });
      request.on("error", () => resolve("closed"));
      setTimeout(() => resolve("still open"), 3000).unref();
    });
    expect(outcome).toBe("closed");
  });

  it("removes hop-by-hop headers and the headers that Connection names, in both directions", async () => {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get(
        {
          host: "127.0.0.1",
          port: uiPort,
          path: "/api/hop",
          headers: { Connection: "x-private-request, close", "X-Private-Request": "secret", TE: "trailers", "Proxy-Authorization": "Basic abc", "X-Kept": "yes" },
        },
        resolve
      );
      request.on("error", reject);
    });
    response.resume();
    expect(response.headers["x-private-response"]).toBeUndefined();
    expect(response.headers["keep-alive"]).toBeUndefined();
    expect(response.headers["x-kept"]).toBe("yes");
    expect(seen?.headers["x-private-request"]).toBeUndefined();
    expect(seen?.headers.te).toBeUndefined();
    expect(seen?.headers["proxy-authorization"]).toBeUndefined();
    expect(seen?.headers["x-kept"]).toBe("yes");
  });

  it("forwards /hooks, /d/, and /d-assets/", async () => {
    for (const target of ["/hooks/github", "/d/dash-1", "/d-assets/kit.js"]) {
      const response = await get(target);
      expect(response.status).toBe(200);
      expect(lastSeen()?.url).toBe(target);
    }
  });

  it("forwards a WebSocket upgrade and passes messages both ways", async () => {
    const origin = `http://127.0.0.1:${uiPort}`;
    const ws = new WebSocket(`ws://127.0.0.1:${uiPort}/ws`, { headers: { Origin: origin } });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.once("open", () => ws.send("hello"));
      ws.once("message", (data) => resolve(data.toString()));
      ws.once("error", reject);
    });
    ws.close();

    expect(reply).toBe("echo:hello");
    expect(upgradeSeen?.url).toBe("/ws");
    expect(upgradeSeen?.headers.host).toBe(`127.0.0.1:${gatewayPort}`);
    expect(upgradeSeen?.headers.origin).toBe(origin);
  });

  it("refuses a WebSocket upgrade on a path that the gateway does not own", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${uiPort}/chat`);
    const error = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(error.message).toMatch(/404/);
  });

  it("decides which paths belong to the gateway", () => {
    for (const forwarded of ["/api", "/api/x", "/ws", "/hooks/a", "/d/x", "/d-assets/a.js", "/%61pi/x", "/API/x", "/api%2Fx"]) {
      expect(isForwardedPath(forwarded), forwarded).toBe(true);
    }
    for (const page of ["/", "/apis", "/apple", "/dashboard", "/d", "/chat/api"]) {
      expect(isForwardedPath(page), page).toBe(false);
    }
  });

  it("redacts secret paths in log targets", () => {
    expect(redactedTarget("/api/relay/link/status/SECRETSECRET?x=1")).toBe("/api/relay/link/[redacted]");
    expect(redactedTarget("/api/relay/dashboard-views/handle")).toBe("/api/relay/dashboard-views/[redacted]");
    expect(redactedTarget("/api/auth/gateway-link/req-1")).toBe("/api/auth/gateway-link/[redacted]");
    expect(redactedTarget("/api/%52elay/link/status/SECRET")).toBe("/api/relay/link/[redacted]");
    expect(redactedTarget("/api/agents?token=abc")).toBe("/api/agents");
  });
});

describe("browser link through the UI listener", () => {
  let gateway: ReturnType<typeof serve>;
  let ui: http.Server;
  let gatewayPort: number;
  let uiPort: number;

  beforeEach(async () => {
    gatewayPort = await freePort();
    uiPort = await freePort();
    const app = new Hono();
    app.use(
      "*",
      relayLinkApi({
        isEnabled: () => true,
        listener: () => ({ address: "127.0.0.1", port: gatewayPort }),
        configuredOrigins: () => [`http://127.0.0.1:${uiPort}`, `http://127.0.0.1:${gatewayPort}`, `http://localhost:${gatewayPort}`],
        service: () => ({ list: () => [] }) as never,
      })
    );
    gateway = serve({ fetch: app.fetch, port: gatewayPort, hostname: "127.0.0.1" });
    await listening(gateway as http.Server);
    const webDist = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-ui-link-"));
    await fs.writeFile(path.join(webDist, "index.html"), "<html></html>");
    ui = startUiListener({ webDist, host: "127.0.0.1", port: uiPort, gatewayHost: "127.0.0.1", gatewayPort, onError: (e) => { throw e; } });
    await listening(ui);
  });

  afterEach(async () => {
    ui.closeAllConnections();
    (gateway as http.Server).closeAllConnections();
    await Promise.all([new Promise((r) => ui.close(r)), new Promise((r) => (gateway as http.Server).close(r))]);
  });

  const metadata = (port: number, origin: string) =>
    fetch(`http://127.0.0.1:${port}/api/relay/link/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    });

  it("accepts a link route from the UI origin through the forward", async () => {
    const response = await metadata(uiPort, `http://127.0.0.1:${uiPort}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ gateways: [] });
  });

  it("still refuses a UI request that carries the gateway origin", async () => {
    const response = await metadata(uiPort, `http://127.0.0.1:${gatewayPort}`);

    expect(response.status).toBe(403);
  });
});
