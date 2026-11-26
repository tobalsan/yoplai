import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { keeperLimits } from "../durable/keeper.js";
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
    ["````md\n```\n\n  \n````\n\nUse the board plan.\n\n- The project", "````md\n```\n\n  \n````\n\nUse the board plan."],
    ["Use the board plan.\n\n~~~md\nDo not save this.\n\n- The project", "Use the board plan."],
    ["```sh\npnpm test:gateway\n```\nThe project", "```sh\npnpm test:gateway\n```"],
    ["```sh\npnpm test:gateway\n```\n\nThe project", "```sh\npnpm test:gateway\n```"],
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

  it("reports the failure reason and stop reason of each completion", async () => {
    const modelRuntime = runtime();
    const deps = {
      getConfig: () => config({ provider: "maintenance-provider", model: "maintenance-model" }),
      getAgent: () => agent,
      createRuntime: async () => modelRuntime as never,
      warn: vi.fn(),
    };
    const onOutcome = vi.fn();
    const refusal = { stopReason: "error", errorMessage: "The model refused", content: [] };

    // The warning is logged once per message; the outcome reaches the caller every time.
    for (const response of [refusal, refusal, { stopReason: "length", content: [] }, { stopReason: "length", content: [{ type: "text", text: "{" }] }]) {
      await completeMaintenance({ ...params(), onOutcome }, { ...deps, completeSimple: async () => response as never });
    }
    await completeMaintenance({ ...params(), timeoutMs: 1, onOutcome }, { ...deps, completeSimple: () => new Promise<never>(() => {}) });

    expect(deps.warn).toHaveBeenCalledTimes(3);
    expect(onOutcome.mock.calls.map(([outcome]) => outcome)).toEqual([
      { error: "The model refused", stopReason: "error", elapsedMs: expect.any(Number) },
      { error: "The model refused", stopReason: "error", elapsedMs: expect.any(Number) },
      { error: "Maintenance completion returned no text", stopReason: "length", elapsedMs: expect.any(Number) },
      { stopReason: "length", elapsedMs: expect.any(Number) },
      { error: "Maintenance completion timed out after 1ms", stopReason: undefined, elapsedMs: expect.any(Number) },
    ]);
  });

  it("gives reasoning keepers higher output and time limits", () => {
    expect(keeperLimits({ reasoning: true })).toEqual({ maxTokens: 6_000, timeoutMs: 60_000 });
    expect(keeperLimits({ reasoning: false })).toEqual({ maxTokens: 2_000, timeoutMs: 20_000 });
    expect(keeperLimits(undefined)).toEqual({ maxTokens: 2_000, timeoutMs: 20_000 });
  });

  it("returns the recorded DeepSeek keeper reply after 28,114 ms", async () => {
    // Recorded r3-ds-p2-relaxed-120s-8000-03 reply (invented eval data).
    const text = '{"topics":[{"kind":"open","title":"User profile onboarding","note":"USER.md is blank; assistant asked for name, preferred form of address, timezone, and current work. User has not answered.","refs":["m_15"]},{"kind":"decision","title":"Kite seal corrected","note":"User corrected the kite seal after an earlier value; assistant acknowledged the update and did not repeat the seal.","refs":["m_10","m_45","m_48"]},{"kind":"digest","title":"Invented shipment code","note":"Assistant supplied VRT-408 as an invented shipment code in the requested AAA-999 format.","refs":["m_16","m_20"]},{"kind":"digest","title":"Kiln fixture checked","note":"Kiln fixture was read via read_kiln and acknowledged; seal and contents were kept private per instruction.","refs":["m_21","m_24"]},{"kind":"open","title":"Filing requests blocked","note":"Requests to file clock dial, orchard weather, ferry timetable, planetarium, loom, and two invented clippings were acknowledged, but no filing tool or named files are present; actual filing remains pending.","refs":["m_31","m_34","m_49","m_52","m_53","m_56","m_59","m_62","m_63","m_66","m_67","m_70","m_71","m_74"]},{"kind":"open","title":"Lantern inspection pending","note":"Lantern inspection is pending; assistant acknowledged without restating status.","refs":["m_35","m_38"]},{"kind":"digest","title":"Mosaic inventory completed","note":"Mosaic inventory is done; assistant acknowledged without restating status.","refs":["m_39","m_42"]}],"drift":[]}';
    const model = { provider: "opencode-go", id: "deepseek-v4.1-flash", reasoning: true };
    const deps = {
      getConfig: () => config({ provider: model.provider, model: model.id }),
      getAgent: () => agent,
      createRuntime: async () => runtime(model) as never,
      warn: vi.fn(),
      completeSimple: vi.fn(() => new Promise(resolve => setTimeout(() =>
        resolve({ stopReason: "stop", content: [{ type: "text", text }] }), 28_114))) as never,
    };
    vi.useFakeTimers();
    try {
      const old = completeMaintenance({ ...params(), maxTokens: 6_000, timeoutMs: 20_000 }, deps);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(old).resolves.toBeNull();
      const replay = completeMaintenance({ ...params(), ...keeperLimits(model) }, deps);
      await vi.advanceTimersByTimeAsync(28_114);
      await expect(replay).resolves.toBe(text);
      expect(deps.completeSimple).toHaveBeenLastCalledWith(model, expect.anything(), expect.objectContaining({ maxTokens: 6_000 }));
    } finally {
      vi.useRealTimers();
    }
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
