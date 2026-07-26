import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayConfigSchema, type ExtensionContext, type GatewayConfig } from "@yoplai/shared";

const instances = vi.hoisted(() => [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; config: unknown }>);
vi.mock("./service.js", () => ({
  IrcService: class {
    start = vi.fn();
    stop = vi.fn();
    send = vi.fn();
    nick = "bot";
    constructor(public config: unknown) { instances.push(this); }
  },
}));

import { ircExtension } from "./index.js";

function context(config: GatewayConfig): ExtensionContext {
  return {
    getConfig: () => config,
    getAgents: () => config.agents,
    getAgent: (id: string) => config.agents.find((agent) => agent.id === id),
    isAgentActive: () => true,
  } as unknown as ExtensionContext;
}

const agent = {
  id: "main", name: "Main", workspace: ".",
  model: { provider: "anthropic", model: "claude" },
  irc: { host: "agent.example", nick: "agent-bot", channels: { "#agent": { mode: "reply-all" as const } }, dm: { enabled: true } },
};

describe("IRC extension lifecycle", () => {
  beforeEach(() => instances.splice(0));

  it("accepts rootless per-agent activation markers", () => {
    expect(ircExtension.validateConfig({})).toEqual({ valid: true, errors: [] });
    expect(ircExtension.validateConfig({ _perAgent: true })).toEqual({ valid: true, errors: [] });
  });

  it("starts root and active per-agent services and stops all", async () => {
    const config = GatewayConfigSchema.parse({ version: 2, agents: [agent], extensions: { irc: { host: "root.example", nick: "root-bot", channels: { "#root": { agent: "main" } } } } });
    await ircExtension.start(context(config));
    expect(instances).toHaveLength(2);
    expect(instances[1]?.config).toMatchObject({ channels: ["#agent"] });
    expect(instances.every((instance) => instance.start.mock.calls.length === 1)).toBe(true);
    await ircExtension.stop();
    expect(instances.every((instance) => instance.stop.mock.calls.length === 1)).toBe(true);
  });
});
