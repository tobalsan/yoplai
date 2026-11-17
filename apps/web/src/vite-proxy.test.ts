import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "vite";

describe("vite dev proxy", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("adds the client address to X-Forwarded-For for a request and a socket upgrade", async () => {
    const seen: Array<string | string[] | undefined> = [];
    const gateway = http.createServer((req, res) => {
      seen.push(req.headers["x-forwarded-for"]);
      res.end("ok");
    });
    gateway.on("upgrade", (req, socket) => {
      seen.push(req.headers["x-forwarded-for"]);
      socket.destroy();
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => { gateway.closeAllConnections(); gateway.close(() => resolve()); }));
    process.env.YOPLAI_GATEWAY_PORT = String((gateway.address() as AddressInfo).port);
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
  });
});
