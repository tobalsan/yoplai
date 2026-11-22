import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentConfigRoutes } from "./config-routes.js";

const state = vi.hoisted(() => ({
  agents: [] as Array<Record<string, unknown>>,
  reloads: 0,
  requester: { access: { create: true, edit: true }, staff: true },
}));

vi.mock("../config/index.js", () => ({
  getAgent: (id: string) => state.agents.find((agent) => agent.id === id),
  isAgentActive: () => true,
  resolveWorkspaceDir: (dir: string) => dir,
}));
vi.mock("../extensions/reload.js", () => ({
  reloadAfterExtensionWrite: async () => { state.reloads += 1; },
}));

let workspace: string;
const yaml = "id: alpha\nname: Alpha\nmodel:\n  provider: anthropic\n  model: claude-old\n";

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-"));
  await fs.writeFile(path.join(workspace, "agent.yaml"), yaml);
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "Be brief.");
  state.agents = [{ id: "alpha", name: "Alpha", model: { provider: "anthropic", model: "claude-old" }, workspace, globalSkills: false }];
  state.reloads = 0;
  state.requester = { access: { create: true, edit: true }, staff: true };
});
afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

function app() {
  const api = new Hono();
  api.route("/api/agents", createAgentConfigRoutes({
    requester: async () => state.requester,
    listModels: async () => [{ provider: "anthropic", model: "claude-new" }],
  }));
  return api;
}
const patch = (body: unknown) => app().request("/api/agents/alpha/config", {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("agent config routes", () => {
  it("reads the editable config with its access", async () => {
    const body = await (await app().request("/api/agents/alpha/config")).json();
    expect(body).toMatchObject({
      id: "alpha", name: "Alpha", globalSkills: false,
      model: { provider: "anthropic", model: "claude-old" }, instructions: "Be brief.",
      access: { create: true, edit: true },
    });
  });

  it("hides the model and instructions from a non-staff reader", async () => {
    state.requester = { access: { create: false, edit: false }, staff: false };
    const body = await (await app().request("/api/agents/alpha/config")).json();
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("instructions");
  });

  it("refuses a write when editing is off", async () => {
    state.requester = { access: { create: false, edit: false }, staff: true };
    const response = await patch({ name: "Beta" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "agent_config_disabled" });
    expect(await fs.readFile(path.join(workspace, "agent.yaml"), "utf8")).toBe(yaml);
  });

  it("saves name, model, skills flag, and instructions", async () => {
    const response = await patch({ name: "Beta", model: { provider: "anthropic", model: "claude-new" }, globalSkills: true, instructions: "Be kind." });
    expect(response.status).toBe(200);
    const saved = await fs.readFile(path.join(workspace, "agent.yaml"), "utf8");
    expect(saved).toContain("name: Beta");
    expect(saved).toContain("model: claude-new");
    expect(saved).toContain("globalSkills: true");
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Be kind.");
    expect(state.reloads).toBe(1);
    expect(await response.json()).toMatchObject({ id: "alpha", access: { edit: true } });
  });

  it("rejects a model outside the list", async () => {
    const response = await patch({ model: { provider: "anthropic", model: "unknown" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "unavailable_model" });
  });

  it("rejects a reserved prefix and an empty patch", async () => {
    expect((await patch({ name: "$env:TOKEN" })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ unknown: true })).status).toBe(400);
  });
});
