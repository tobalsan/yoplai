import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import {
  completeMaintenance,
  resetMaintenanceCompletionDepsForTests,
  setMaintenanceCompletionDepsForTests,
  sessionHeaders,
} from "./completion.js";

import { draftProjectInstructions } from "./project-instructions.js";

const agent = {
  id: "assistant",
  name: "Assistant",
  workspace: "/tmp/assistant",
  model: { provider: "agent-provider", model: "agent-model" },
} as AgentConfig;

function config(maintenance?: { provider: string; model: string }): GatewayConfig {
  return { agents: [agent], extensions: {}, ...(maintenance ? { maintenance } : {}) } as GatewayConfig;
}

function runtime(model: unknown = { provider: "maintenance-provider", id: "maintenance-model" }) {
  return {
    getModel: vi.fn(() => model),
    completeSimple: vi.fn(async () => ({ content: [{ type: "text", text: "topic" }] })),
  };
}

function params() {
  return {
    agentId: agent.id,
    system: "Return a label",
    prompt: "A conversation",
    maxTokens: 32,
    timeoutMs: 20,
  };
}

afterEach(() => resetMaintenanceCompletionDepsForTests());

describe("sessionHeaders", () => {
  it("tags opencode requests with the session id", () => {
    expect(sessionHeaders({ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go" }, "s1"))
      .toEqual({ "x-opencode-session": "s1", "x-opencode-client": "yoplai" });
    expect(sessionHeaders({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, "s1")).toBeUndefined();
    expect(sessionHeaders({ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go" }, undefined)).toBeUndefined();
  });
});

describe("completeMaintenance", () => {
  it("passes session headers to the completion", async () => {
    const modelRuntime = runtime({ provider: "opencode-go", id: "m", baseUrl: "https://opencode.ai/zen/go" });
    const completeSimple = vi.fn(async () => ({ content: [{ type: "text", text: "topic" }] }));

    await completeMaintenance({ ...params(), sessionId: "s1" }, {
      getConfig: () => config({ provider: "opencode-go", model: "m" }),
      getAgent: () => agent,
      createRuntime: async () => modelRuntime as never,
      completeSimple: completeSimple as never,
    });

    expect(completeSimple).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      headers: { "x-opencode-session": "s1", "x-opencode-client": "yoplai" },
    }));
  });

  it("uses the configured maintenance model", async () => {
    const modelRuntime = runtime();
    const completeSimple = vi.fn(async (_model: unknown, _context: unknown, _options: Record<string, unknown>) => ({ content: [{ type: "text", text: "  Session topic  " }] }));

    await expect(completeMaintenance(params(), {
      getConfig: () => config({ provider: "maintenance-provider", model: "maintenance-model" }),
      getAgent: () => agent,
      createRuntime: async () => modelRuntime as never,
      completeSimple: completeSimple as never,
    })).resolves.toBe("Session topic");

    expect(modelRuntime.getModel).toHaveBeenCalledWith("maintenance-provider", "maintenance-model");
    expect(completeSimple).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ systemPrompt: "Return a label" }), expect.objectContaining({ maxRetries: 0 }));
    expect(completeSimple.mock.calls[0][2]).not.toHaveProperty("temperature");
  });

  it.each([
    ["Use the board plan.\n\n- The project", "Use the board plan."],
    ["# Role\n\n- The project", "Q3 deck"],
  ])("discards the last block of a project draft cut short by the token limit", async (text, expected) => {
    const deps = {
      getConfig: () => config(),
      getAgent: () => agent,
      createRuntime: async () => runtime({ provider: "agent-provider", id: "agent-model", baseUrl: "http://localhost" }) as never,
      completeSimple: async () => ({ stopReason: "length", content: [{ type: "text", text }] }) as never,
    };
    setMaintenanceCompletionDepsForTests(deps);
    await expect(draftProjectInstructions("Q3 deck", agent.id, "p1")).resolves.toBe(expected);
    await expect(completeMaintenance(params())).resolves.toBe(text);
  });

  it("falls back to the session agent model", async () => {
    const modelRuntime = runtime({ provider: "agent-provider", id: "agent-model" });

    await completeMaintenance(params(), {
      getConfig: () => config(),
      getAgent: () => agent,
      createRuntime: async () => modelRuntime as never,
      completeSimple: async () => ({ content: [{ type: "text", text: "topic" }] }) as never,
    });

    expect(modelRuntime.getModel).toHaveBeenCalledWith("agent-provider", "agent-model");
  });

  it("warns once when the model cannot be resolved", async () => {
    const warn = vi.fn();
    const modelRuntime = {
      ...runtime(),
      getModel: vi.fn(() => undefined),
    };
    const deps = {
      getConfig: () => config({ provider: "missing", model: "model" }),
      getAgent: () => agent,
      createRuntime: async () => modelRuntime as never,
      warn,
    };

    await expect(completeMaintenance(params(), deps)).resolves.toBeNull();
    await expect(completeMaintenance(params(), deps)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns null for timeout and provider failures", async () => {
    const warn = vi.fn();
    const modelRuntime = runtime();
    const deps = {
      getConfig: () => config({ provider: "maintenance-provider", model: "maintenance-model" }),
      getAgent: () => agent,
      createRuntime: async () => modelRuntime as never,
      warn,
    };

    await expect(completeMaintenance({ ...params(), timeoutMs: 1 }, {
      ...deps,
      completeSimple: () => new Promise<never>(() => {}),
    })).resolves.toBeNull();
    await expect(completeMaintenance(params(), {
      ...deps,
      completeSimple: async () => ({ stopReason: "error", errorMessage: "provider down", content: [] }) as never,
    })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("times out while the model runtime is still initializing", async () => {
    const warn = vi.fn();

    await expect(completeMaintenance({ ...params(), timeoutMs: 1 }, {
      getConfig: () => config({ provider: "maintenance-provider", model: "maintenance-model" }),
      getAgent: () => agent,
      createRuntime: () => new Promise<never>(() => {}),
      warn,
    })).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(
      "[maintenance] completion failed",
      expect.objectContaining({ error: expect.stringContaining("timed out") })
    );
  });
});
