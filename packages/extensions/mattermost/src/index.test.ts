import { GatewayConfigSchema } from "@yoplai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeContext } from "./test-fakes.js";

const componentStart = vi.fn().mockResolvedValue(undefined);
const agentStart = vi.fn().mockResolvedValue(undefined);
const stop = vi.fn().mockResolvedValue(undefined);
const createMattermostBot = vi.fn();
const createMattermostAgentBot = vi.fn();

vi.mock("./bot.js", () => ({ createMattermostBot, createMattermostAgentBot }));

const agent = {
  id: "main",
  name: "Main",
  workspace: "~/main",
  model: { provider: "anthropic", model: "claude" },
};

describe("mattermost extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    createMattermostBot.mockReturnValue({
      agentId: "mattermost",
      start: componentStart,
      stop,
    });
    createMattermostAgentBot.mockReturnValue({
      agentId: "main",
      start: agentStart,
      stop,
    });
  });

  it("has the expected identity, tools and capabilities", async () => {
    const { mattermostExtension } = await import("./index.js");
    expect(mattermostExtension.id).toBe("mattermost");
    expect(mattermostExtension.capabilities()).toEqual(["mattermost"]);
    const tools = await mattermostExtension.getAgentTools?.({
      id: "main",
    } as never);
    expect(tools?.map((t) => t.name)).toEqual([
      "mattermost.send_message",
      "mattermost.create_thread",
    ]);
    const disabled = await mattermostExtension.getAgentTools?.(
      { id: "main" } as never,
      {
        config: { extensions: { mattermost: { enabled: false } } },
      } as never
    );
    expect(disabled).toEqual([]);
  });

  it("validates the root config with zod and names the bad fields", async () => {
    const { mattermostExtension } = await import("./index.js");
    expect(mattermostExtension.validateConfig({ _perAgent: true }).valid).toBe(
      true
    );
    expect(mattermostExtension.validateConfig({}).valid).toBe(true);
    expect(
      mattermostExtension.validateConfig({
        url: "https://chat.example.test",
        token: "$env:MATTERMOST_BOT_TOKEN",
        channels: { abc: { agent: "main", requireMention: false } },
        dm: { enabled: true, agent: "main" },
        _perAgentFallback: false,
      })
    ).toEqual({ valid: true, errors: [] });
    const bad = mattermostExtension.validateConfig({
      url: "ftp://chat",
      token: 42,
      channels: { abc: {} },
    });
    expect(bad.valid).toBe(false);
    expect(bad.errors.join("\n")).toMatch(/url/);
    expect(bad.errors.join("\n")).toMatch(/token/);
    expect(bad.errors.join("\n")).toMatch(/channels\.abc\.agent/);
  });

  it("starts the shared bot, per-agent bots and the delivery sink", async () => {
    const { mattermostExtension, stopMattermostBots } =
      await import("./index.js");
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          ...agent,
          mattermost: {
            url: "https://chat.example.test",
            token: "agent-token",
          },
        },
      ],
      extensions: {
        mattermost: { url: "https://chat.example.test", token: "shared-token" },
      },
    });
    const ctx = buildFakeContext({ config, dataDir: "/tmp" });
    await mattermostExtension.start(ctx);
    expect(createMattermostBot).toHaveBeenCalledWith(
      config.agents,
      expect.objectContaining({ token: "shared-token" })
    );
    expect(createMattermostAgentBot).toHaveBeenCalledWith(config.agents[0]);
    expect(componentStart).toHaveBeenCalledOnce();
    expect(agentStart).toHaveBeenCalledOnce();
    expect(ctx.sinks.has("mattermost")).toBe(true);

    await mattermostExtension.stop();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(ctx.sinks.has("mattermost")).toBe(false);
    await stopMattermostBots();
  });

  it("keeps the shared bot off when enabled is false", async () => {
    const { mattermostExtension } = await import("./index.js");
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [agent],
      extensions: {
        mattermost: {
          enabled: false,
          url: "https://chat.example.test",
          token: "t",
        },
      },
    });
    await mattermostExtension.start(
      buildFakeContext({ config, dataDir: "/tmp" })
    );
    expect(createMattermostBot).not.toHaveBeenCalled();
    await mattermostExtension.stop();
  });

  it("logs config errors without the submitted values", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => void errors.push(args.join(" "))
    );
    const { mattermostExtension } = await import("./index.js");
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [agent],
      extensions: {},
    });
    const ctx = buildFakeContext({ config, dataDir: "/tmp" });
    (config.extensions as Record<string, unknown>).mattermost = {
      url: "not a url",
      token: "super-secret-token",
    };
    await mattermostExtension.start(ctx);
    expect(errors.join("\n")).toContain("url");
    expect(errors.join("\n")).not.toContain("super-secret-token");
    await mattermostExtension.stop();
  });
});
