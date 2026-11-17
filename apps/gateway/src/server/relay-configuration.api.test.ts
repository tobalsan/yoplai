import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { writeTestV3Config } from "../test-utils/v3-config.js";

let home: string;
let previousHome: string | undefined;
let scheduler: typeof import("@yoplai/extension-scheduler").schedulerExtension;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-local-schedule-"));
  previousHome = process.env.YOPLAI_HOME;
  process.env.YOPLAI_HOME = home;
  await writeTestV3Config(home, { agents: [{ id: "local" }], extensions: { scheduler: {} } });
  vi.resetModules();
  const { loadConfig } = await import("../config/index.js");
  const { loadExtensions } = await import("../extensions/registry.js");
  const { createExtensionContext } = await import("../extensions/context.js");
  const { api } = await import("./api.core.js");
  const extensions = await loadExtensions(loadConfig());
  scheduler = extensions.find((item) => item.id === "scheduler")!;
  scheduler.registerRoutes!(api);
  await scheduler.start(createExtensionContext(loadConfig()));
  const state = await import("../relay/state.js");
  state.configureRelay("127.0.0.1", false);
  state.getRemoteGatewayStore().save({ name: "east", url: "https://east.test", token: "fake-bearer" });
});

afterAll(async () => {
  await scheduler?.stop();
  const state = await import("../relay/state.js");
  state.configureRelay("127.0.0.1", true);
  vi.unstubAllGlobals();
  if (previousHome === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
});

it("creates a valid local schedule after the relay reads its bounded body", async () => {
  const remote = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", remote);
  const { app } = await import("./index.js");
  const body = { agentId: "local", name: "Local schedule", schedule: { runAt: "2099-01-01T00:00:00Z" }, payload: { message: "x".repeat(400_000) } };
  const response = await app.request("/api/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(response.status).toBe(201);
  const job = await response.json();
  expect(job).toMatchObject(body);
  const jobs = await (await app.request("/api/schedules?agent=local")).json();
  expect(jobs).toEqual([job]);
  expect(remote).not.toHaveBeenCalled();
});
