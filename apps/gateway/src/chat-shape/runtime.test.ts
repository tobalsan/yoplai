import { describe, expect, it } from "vitest";
import { GatewayConfigSchema, type AgentConfig } from "@yoplai/shared";
import { ExtensionRuntime } from "../extensions/runtime.js";
import { chatShapeExtension } from "./index.js";

const config = GatewayConfigSchema.parse({
  version: 2,
  agents: [{ id: "main", name: "Main", workspace: "~/agents/main", model: { provider: "anthropic", model: "claude" }, extensions: { "chat-shape": {} } }],
});
const agent = config.agents[0] as AgentConfig;
const runtime = new ExtensionRuntime();
runtime.load([chatShapeExtension]);

const names = async (identity?: Record<string, unknown>) =>
  (await runtime.getTools(agent, config, undefined, identity as never)).map((t) => t.name);
const prompts = (identity?: Record<string, unknown>) => runtime.getPromptContributions(agent, config, undefined, identity as never);

describe("chat-shape through the extension runtime", () => {
  it("human turn: rules and reply_mode", async () => {
    const run = { source: "web", sessionId: "s1" };
    expect(await names(run)).toEqual(["reply_mode"]);
    expect((await prompts(run)).join("\n")).toContain("## Chat replies");
  });

  it.each([
    ["scheduler", { source: "scheduler", sessionId: "s1" }],
    ["agent sender", { source: "web", sender: { kind: "agent" }, sessionId: "s1" }],
    ["background", { source: "web", background: true, sessionId: "s1" }],
    ["no source", { sessionId: "s1" }],
    ["no run info", undefined],
  ])("skipped turn (%s): no rules, no tool", async (_name, run) => {
    expect(await names(run)).toEqual([]);
    expect(await prompts(run)).toEqual([]);
  });

  it("finds reply_mode for execution without run info", async () => {
    expect((await runtime.getTool(agent, "reply_mode", config))?.name).toBe("reply_mode");
  });
});
