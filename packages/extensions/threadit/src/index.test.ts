import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@yoplai/shared";

const starts = vi.hoisted(() => [] as Array<{ agentId: string; baseUrl: string }>);
vi.mock("./poller.js", () => ({
  ThreaditPoller: class {
    constructor(options: { agentId: string; config: { baseUrl: string } }) {
      starts.push({ agentId: options.agentId, baseUrl: options.config.baseUrl });
    }
    start = vi.fn();
    stop = vi.fn(async () => {});
  },
}));

import { threaditExtension } from "./index.js";

function context(root: unknown, agents: Array<Record<string, unknown>>, active = true) {
  return {
    getConfig: () => ({ extensions: { threadit: root } }),
    getAgents: () => agents,
    getAgent: (id: string) => agents.find((a) => a.id === id),
    isAgentActive: (id: string) => active && id !== "idle",
    registerDeliverySink: () => () => undefined,
  } as unknown as ExtensionContext;
}

describe("threadit extension", () => {
  beforeEach(() => starts.splice(0));

  it("validates config and accepts the per-agent marker", () => {
    expect(threaditExtension.validateConfig({})).toEqual({ valid: true, errors: [] });
    expect(threaditExtension.validateConfig({ _perAgent: true })).toEqual({ valid: true, errors: [] });
    expect(threaditExtension.validateConfig({ pollIntervalMs: 10 }).valid).toBe(false);
    expect(threaditExtension.validateConfig({ baseUrl: "http://x" }).valid).toBe(true);
  });

  it("starts one poller per active agent with a threadit config, with or without a token", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await threaditExtension.start(
      context({ baseUrl: "http://root/" }, [
        { id: "a", extensions: { threadit: { token: "t" } } },
        { id: "b", extensions: { threadit: { token: "t", baseUrl: "http://own" } } },
        { id: "c", extensions: { threadit: { token: "t", enabled: false } } },
        { id: "d" },
        { id: "e", extensions: { threadit: {} } },
        { id: "idle", extensions: { threadit: { token: "t" } } },
      ])
    );
    expect(starts).toEqual([
      { agentId: "a", baseUrl: "http://root" },
      { agentId: "b", baseUrl: "http://own" },
      { agentId: "e", baseUrl: "http://root" },
    ]);
    await threaditExtension.stop();
  });

  it("creates the missing poller after a config reload and keeps the old one", async () => {
    const agents: Array<Record<string, unknown>> = [
      { id: "a", extensions: { threadit: { token: "t" } } },
      { id: "b" },
    ];
    await threaditExtension.start(context({ baseUrl: "http://root" }, agents));
    expect(starts.map((s) => s.agentId)).toEqual(["a"]);
    agents[1] = { id: "b", extensions: { threadit: { token: "t" } } };
    await threaditExtension.onConfigReload?.();
    await threaditExtension.onConfigReload?.();
    expect(starts.map((s) => s.agentId)).toEqual(["a", "b"]);
    await threaditExtension.stop();
  });

  it("keeps one poller when the agent disables and re-enables threadit", async () => {
    const agents: Array<Record<string, unknown>> = [
      { id: "a", extensions: { threadit: { token: "t" } } },
    ];
    await threaditExtension.start(context({ baseUrl: "http://root" }, agents));
    agents[0] = { id: "a", extensions: { threadit: { token: "t", enabled: false } } };
    await threaditExtension.onConfigReload?.();
    agents[0] = { id: "a", extensions: { threadit: { token: "t" } } };
    await threaditExtension.onConfigReload?.();
    expect(starts.map((s) => s.agentId)).toEqual(["a"]);
    await threaditExtension.stop();
  });
});
