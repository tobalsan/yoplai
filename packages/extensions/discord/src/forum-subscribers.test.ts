import { describe, expect, it } from "vitest";
import {
  AgentConfigSchema,
  AgentYamlConfigSchema,
  type ExtensionContext,
} from "@yoplai/shared";
import { clearDiscordContext, setDiscordContext } from "./context.js";
import { getForumSubscribers } from "./forum-subscribers.js";

function agent(
  id: string,
  discord?: { forumChannels?: string[] }
): ReturnType<typeof AgentConfigSchema.parse> {
  return AgentConfigSchema.parse({
    id,
    name: id,
    workspace: `~/agents/${id}`,
    model: { provider: "anthropic", model: "claude" },
    ...(discord ? { discord } : {}),
  });
}

describe("discord forum subscribers", () => {
  it("accepts subscription-only discord config in agent.yaml", () => {
    const parsed = AgentYamlConfigSchema.parse({
      id: "alpha",
      name: "Alpha",
      model: { provider: "anthropic", model: "claude" },
      discord: {
        forumChannels: ["forum-1"],
      },
    });

    expect(parsed.discord?.forumChannels).toEqual(["forum-1"]);
  });

  it("returns no subscribers for agents with no discord block", () => {
    expect(getForumSubscribers("forum-1", [agent("alpha")])).toEqual([]);
  });

  it("returns multiple agents subscribed to one channel", () => {
    const alpha = agent("alpha", { forumChannels: ["forum-1"] });
    const beta = agent("beta", { forumChannels: ["forum-1"] });
    const gamma = agent("gamma", { forumChannels: ["forum-2"] });

    expect(getForumSubscribers("forum-1", [alpha, beta, gamma])).toEqual([
      alpha,
      beta,
    ]);
  });

  it("returns one agent subscribed to multiple channels", () => {
    const alpha = agent("alpha", { forumChannels: ["forum-1", "forum-2"] });

    expect(getForumSubscribers("forum-1", [alpha])).toEqual([alpha]);
    expect(getForumSubscribers("forum-2", [alpha])).toEqual([alpha]);
  });

  it("walks loaded agents from the Discord context by default", () => {
    const alpha = agent("alpha", { forumChannels: ["forum-1"] });
    const beta = agent("beta", { forumChannels: ["forum-2"] });

    setDiscordContext({
      getAgents: () => [alpha, beta],
    } as ExtensionContext);

    try {
      expect(getForumSubscribers("forum-1")).toEqual([alpha]);
    } finally {
      clearDiscordContext();
    }
  });
});
