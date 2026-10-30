import { describe, expect, it } from "vitest";
import { GatewayConfigSchema, type AgentConfig } from "@yoplai/shared";
import { ExtensionRuntime } from "../extensions/runtime.js";
import { nudgeText, resolveLimits, rulesText } from "human-chat";
import { humanChatExtension, limitsFromConfig, startShapedTurn } from "./index.js";

const config = GatewayConfigSchema.parse({
  version: 2,
  agents: [{ id: "main", name: "Main", workspace: "~/agents/main", model: { provider: "anthropic", model: "claude" }, extensions: { "human-chat": {} } }],
});
const agent = config.agents[0] as AgentConfig;
const runtime = new ExtensionRuntime();
runtime.load([humanChatExtension]);

const names = async (identity?: Record<string, unknown>) =>
  (await runtime.getTools(agent, config, undefined, identity as never)).map((t) => t.name);
const prompts = (identity?: Record<string, unknown>) => runtime.getPromptContributions(agent, config, undefined, identity as never);

describe("human-chat through the extension runtime", () => {
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

describe("human-chat limits", () => {
  const limited = (cfg: Record<string, unknown>) =>
    ({ ...agent, extensions: { "human-chat": cfg } }) as AgentConfig;
  const six = "One. Two. Three. Four. Five. Six.";

  it("parses the limit keys", () => {
    const cfg = {
      max_sentences: 3,
      sentence_leeway: 1,
      max_sentence_words: 10,
      word_leeway: 2,
    };
    expect(limitsFromConfig(cfg)).toEqual({
      maxSentences: 3,
      sentenceLeeway: 1,
      maxSentenceWords: 10,
      wordLeeway: 2,
    });
    expect(
      GatewayConfigSchema.parse({
        version: 2,
        agents: [{ ...agent, extensions: { "human-chat": cfg } }],
      }).agents[0]?.extensions?.["human-chat"]
    ).toMatchObject(cfg);
  });

  it("falls back to defaults for missing or invalid keys", () => {
    const bad = limitsFromConfig({
      max_sentences: "x",
      sentence_leeway: -1,
      max_sentence_words: 0,
    });
    expect(resolveLimits(bad)).toEqual(resolveLimits());
  });

  it("lint uses the limits: fails at defaults, passes with leeway", () => {
    const run = { source: "web", sessionId: "s" } as never;
    const strict = startShapedTurn(limited({}), run, "s", "/tmp/w");
    strict?.holdEvent({ type: "text", data: six });
    expect(strict?.lint().ok).toBe(false);
    const loose = startShapedTurn(
      limited({ sentence_leeway: 1 }),
      run,
      "s",
      "/tmp/w"
    );
    loose?.holdEvent({ type: "text", data: six });
    expect(loose?.lint().ok).toBe(true);
  });

  it("rules and nudge show the configured max", async () => {
    const custom = limited({ max_sentences: 3 });
    const run = { source: "web", sessionId: "s" } as never;
    expect(
      humanChatExtension.getSystemPromptContributions?.(custom, {
        run,
      } as never)
    ).toBe(rulesText({ maxSentences: 3 }));
    expect(rulesText({ maxSentences: 3 })).not.toBe(rulesText());
    expect(startShapedTurn(custom, run, "s", "/tmp/w")?.nudge).toBe(
      nudgeText({ maxSentences: 3 })
    );
  });
});
