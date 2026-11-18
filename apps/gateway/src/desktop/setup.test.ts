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
  for (const key of Object.keys(process.env)) {
    if (/^(?:YOPLAI_|AIHUB_|PI_|CODEX_|CLAUDE_|XDG_)|(?:_API_KEY|_AUTH_TOKEN)$/.test(key)) vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("YOPLAI_HOME", configHome);
  vi.stubEnv("YOPLAI_DESKTOP", "1");
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
