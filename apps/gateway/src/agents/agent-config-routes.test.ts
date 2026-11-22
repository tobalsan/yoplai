import { Hono } from "hono";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubDesktopTestEnv } from "../test-utils/desktop-test-env.js";
import { writeTestAgent, writeTestV3Config } from "../test-utils/v3-config.js";
import { createAgentConfigRoutes } from "./agent-config-routes.js";

let root: string;
let home: string;
let app: Hono;

const deps = {
  isMultiUser: () => false,
  getAuthContext: async () => null,
  canManageAgent: async () => false,
  hasAgentAccess: async () => true,
  listModels: async () => [ { provider: "openai", model: "gpt-4.1-mini" } ],
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
  home = path.join(root, "yoplai");
  stubDesktopTestEnv(root, home);
  await writeTestV3Config(home, { agents: [{ id: "hr", name: "HR" }] });
  await writeTestAgent(home, { id: "unused" }).catch(() => undefined);
  vi.resetModules();
  const mod = await import("./agent-config-routes.js");
  app = new Hono();
  app.route("/api/agents", mod.createAgentConfigRoutes(deps));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("reads core config and instructions", async () => {
  await fs.writeFile(path.join(home, "agents", "hr", "AGENTS.md"), "Be kind.\n");
  const res = await app.request("/api/agents/hr/config");
  expect(res.status).toBe(200);
  const data = (await res.json()) as Record<string, unknown>;
  expect(data).toMatchObject({ id: "hr", name: "HR", canEdit: true });
  expect(data.instructions).toBe("Be kind.\n");
});

it("writes core fields and instructions", async () => {
  const res = await app.request("/api/agents/hr/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "People",
      reasoning: "high",
      globalSkills: true,
      instructions: "New rules.\n",
    }),
  });
  expect(res.status).toBe(200);
  const yaml = await fs.readFile(path.join(home, "agents", "hr", "agent.yaml"), "utf8");
  expect(yaml).toContain("name: People");
  expect(yaml).toContain("reasoning: high");
  expect(yaml).toContain("globalSkills: true");
  expect(await fs.readFile(path.join(home, "agents", "hr", "AGENTS.md"), "utf8")).toBe("New rules.\n");
});

it("rejects an unknown model and an unknown agent", async () => {
  const bad = await app.request("/api/agents/hr/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { provider: "openai", model: "missing" } }),
  });
  expect(bad.status).toBe(400);
  expect((await app.request("/api/agents/nope/config")).status).toBe(404);
  expect(
    (
      await app.request("/api/agents/nope/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      })
    ).status
  ).toBe(404);
});
