import { stubDesktopTestEnv } from "../test-utils/desktop-test-env.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let home: string;
let configHome: string;
const stop: (() => void)[] = [];

beforeEach(async () => {
  vi.resetModules();
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-setup-"));
  configHome = path.join(home, "yoplai");
  await fs.mkdir(configHome);
  await fs.writeFile(path.join(configHome, "yoplai.json"), '{"version":3,"agents":[]}');
  stubDesktopTestEnv(home, configHome);
});

afterEach(async () => {
  for (const close of stop.splice(0)) close();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

it("reports the capability and reads and writes setup through the UI proxy", async () => {
  const { app } = await import("../server/index.js");
  const state = await import("../relay/state.js");
  const { startUiListener } = await import("../server/ui-listener.js");
  const gateway = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  stop.push(() => { gateway.close(); if ("closeAllConnections" in gateway) gateway.closeAllConnections(); });
  await new Promise<void>((resolve) => gateway.once("listening", resolve));
  const port = (gateway.address() as AddressInfo).port;
  state.configureRelay("127.0.0.1", false);
  state.setGatewayListener({ address: "127.0.0.1", port });
  const ui = startUiListener({ webDist: home, host: "127.0.0.1", port: 0, gatewayHost: "127.0.0.1", gatewayPort: port, onError: (error) => { throw error; } });
  stop.push(() => { ui.close(); ui.closeAllConnections(); });
  await new Promise<void>((resolve) => ui.once("listening", resolve));
  const uiPort = (ui.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${uiPort}`;
  vi.stubEnv("YOPLAI_UI_PORT", String(uiPort));
  expect(await (await fetch(`${base}/api/capabilities`)).json()).toMatchObject({ desktopSetup: true });
  const url = `${base}/api/desktop-setup`;
  expect(await (await fetch(url)).json()).toMatchObject({ version: 1, wizardExited: false });
  const res = await fetch(url, { method: "PUT", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ wizardExited: true, skipped: ["model"] }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ wizardExited: true, skipped: ["model"] });
  expect((await app.request(`http://127.0.0.1:${port}/api/desktop-setup`, { headers: { host: `127.0.0.1:${uiPort}` } }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } })).status).toBe(403);
});

it("refuses untrusted requests and keeps state when version one lacks fields", async () => {
  const { app } = await import("../server/index.js");
  const state = await import("../relay/state.js");
  state.configureRelay("127.0.0.1", false);
  state.setGatewayListener({ address: "127.0.0.1", port: 4000 });
  const read = (headers: Record<string, string> = {}, peer = "127.0.0.1", init?: RequestInit) => app.request("http://127.0.0.1:4000/api/desktop-setup", { ...init, headers: { host: "127.0.0.1:4000", ...headers } }, { incoming: { socket: { remoteAddress: peer } } });
  const refused: Record<string, string>[] = [{ host: "other:4000" }, { origin: "http://127.0.0.1:4000" }, { "sec-fetch-site": "cross-site" }, { "x-forwarded-for": "127.0.0.1," }, { "x-forwarded-for": "127.0.0.1, 192.0.2.1" }, { forwarded: "for=127.0.0.1;for=" }];
  for (const headers of refused) {
    expect((await read(headers)).status).toBe(403);
  }
  expect((await read({}, "192.0.2.1")).status).toBe(403);
  for (const [multiUser, serve] of [[true, false], [false, true]]) {
    state.configureRelay("127.0.0.1", multiUser, serve);
    expect((await read()).status).toBe(403);
  }
  state.configureRelay("127.0.0.1", false);
  vi.stubEnv("YOPLAI_DESKTOP", undefined);
  expect((await read()).status).toBe(403);
  vi.stubEnv("YOPLAI_DESKTOP", "1");
  await fs.writeFile(path.join(configHome, "desktop-setup.json"), '{"version":1,"wizardExited":true}');
  expect(await (await read({ "x-forwarded-for": "127.0.0.1, ::1" })).json()).toMatchObject({ wizardExited: true, completed: false, completedAt: null });
  const put = (body: unknown, type = "application/json") => read({ "content-type": type }, undefined, { method: "PUT", body: JSON.stringify(body) });
  expect((await put({}, "text/plain")).status).toBe(415);
  expect((await put({ version: 2 })).status).toBe(400);
  expect((await put({ completed: true })).status).toBe(400);
  const response = await put({ completed: true, firstChat: { agentId: "a", sessionId: "s", turnId: "t" } });
  expect(await response.json()).toMatchObject({ wizardExited: true, completed: true, completedAt: expect.any(String) });
});

it("applies every refusal to every desktop route before it reads state", async () => {
  const { app } = await import("../server/index.js");
  const state = await import("../relay/state.js");
  const paths = [
    ["GET", "desktop-setup"], ["PUT", "desktop-setup"], ["GET", "model-access"],
    ["POST", "model-access/oauth/anthropic"], ["GET", "model-access/oauth/attempts/test"],
    ["POST", "model-access/oauth/attempts/test/answer"], ["POST", "model-access/oauth/attempts/test/cancel"],
    ["POST", "model-access/api-key"], ["POST", "model-access/external/pi"], ["DELETE", "model-access/openai"],
    ["GET", "model-access/models"], ["POST", "model-access/models/check"],
  ];
  state.setGatewayListener({ address: "127.0.0.1", port: 4000 });
  const variants: Array<{ headers?: Record<string, string>; peer?: string; flag?: string; relay?: [string, boolean, boolean, string] }> = [
    { peer: "192.0.2.4" }, { headers: { host: "localhost:3000" } }, { headers: { origin: "https://localhost:3000" } },
    { headers: { "x-forwarded-for": "127.0.0.1, 192.0.2.4" } }, { headers: { "x-forwarded-for": "127.0.0.1," } },
    { headers: { "x-forwarded-for": "127.0.0.1, ::ffff:::1" } },
    { headers: { "x-real-ip": "::ffff:::1" } },
    { headers: { forwarded: 'for="[::ffff:::1]:4000"' } },
    { headers: { forwarded: 'for="[127.0.0.1]:4000"' } },
    { headers: { "x-forwarded-for": "[127.0.0.1]" } },
    { headers: { forwarded: "for=127.0.0.1,broken" } }, { headers: { "sec-fetch-site": "cross-site" } }, { flag: "0" },
    { relay: ["127.0.0.1", true, false, "127.0.0.1"] }, { relay: ["127.0.0.1", false, true, "127.0.0.1"] },
    { relay: ["127.0.0.1", false, false, "0.0.0.0"] }, { relay: ["0.0.0.0", false, false, "127.0.0.1"] },
  ];
  const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    for (const variant of variants) {
      vi.stubEnv("YOPLAI_DESKTOP", variant.flag ?? "1");
      state.configureRelay(...(variant.relay ?? ["127.0.0.1", false, false, "127.0.0.1"]));
      for (const [method, route] of paths) {
        const url = `http://127.0.0.1:4000/api/${route}?secret=fake-secret-for-log-test`;
        const response = await app.request(url, { method, headers: { host: "127.0.0.1:4000", ...variant.headers } }, { incoming: { socket: { remoteAddress: variant.peer ?? "127.0.0.1" } } });
        expect(response.status, `${method} ${route}`).toBe(403);
      }
    }
    vi.stubEnv("YOPLAI_DESKTOP", "1");
    state.configureRelay("127.0.0.1", false);
    const allowed = await app.request("http://127.0.0.1:4000/api/desktop-setup", {
      headers: { host: "127.0.0.1:4000", "x-forwarded-for": "127.0.0.1, ::ffff:127.0.0.1", forwarded: 'for="[::ffff:127.0.0.1]:4000", for="[::1]:4000"' },
    }, { incoming: { socket: { remoteAddress: "::ffff:127.0.0.1" } } });
    expect(allowed.status).toBe(200);
    expect(logged.mock.calls.filter(([line]) => String(line).includes("/api/model-access")).every(([line]) => !String(line).includes("fake-secret-for-log-test"))).toBe(true);
    await expect(fs.access(path.join(configHome, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    logged.mockRestore();
  }
});

it("hides the attempt handle and query when the packaged proxy cannot forward a request", async () => {
  const { createServer } = await import("node:http");
  const { startUiListener } = await import("../server/ui-listener.js");
  const failed = createServer((req) => req.socket.destroy());
  await new Promise<void>((resolve) => failed.listen(0, "127.0.0.1", resolve));
  stop.push(() => { failed.close(); failed.closeAllConnections(); });
  const gatewayPort = (failed.address() as AddressInfo).port;
  const ui = startUiListener({ webDist: home, host: "127.0.0.1", port: 0, gatewayHost: "127.0.0.1", gatewayPort, onError: (error) => { throw error; } });
  stop.push(() => { ui.close(); ui.closeAllConnections(); });
  await new Promise<void>((resolve) => ui.once("listening", resolve));
  const uiPort = (ui.address() as AddressInfo).port;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const handle = "fake-model-attempt-handle";
    const query = "fake-model-access-query";
    const res = await fetch(`http://127.0.0.1:${uiPort}/api/model-access/oauth/attempts/${handle}?other=${query}`);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Bad Gateway");
    expect(warn).toHaveBeenCalledTimes(1);
    const log = String(warn.mock.calls[0][0]);
    expect(log).toContain("/api/model-access/[redacted]");
    expect(log).not.toContain(handle);
    expect(log).not.toContain(query);
  } finally {
    warn.mockRestore();
  }
});
