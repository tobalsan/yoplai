import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayConfigSchema, type ExtensionRunInfo } from "@yoplai/shared";
import { humanChatExtension } from "@yoplai/extension-human-chat";
import { ExtensionRuntime } from "../../../../apps/gateway/src/extensions/runtime.js";

vi.mock("../../../../apps/gateway/src/config/index.js", () => ({
  CONFIG_DIR: "/tmp/yoplai-human-chat-runtime",
  resolveAgentEnv: () => ({}),
  loadConfig: () => ({ agents: [], extensions: {} }),
}));

const config = GatewayConfigSchema.parse({
  version: 2,
  agents: [{
    id: "main",
    name: "Main",
    workspace: ".",
    model: { provider: "anthropic", model: "claude" },
    extensions: { "human-chat": {} },
  }],
});
const agent = config.agents[0];
const runtime = new ExtensionRuntime();
runtime.load([humanChatExtension]);
const longReply = "One. Two. Three. Four. Five. Six.";
const temporaryDirectories: string[] = [];
const configured = (options: Record<string, unknown> | null) => GatewayConfigSchema.parse({
  ...config, agents: [{ ...agent, extensions: { "human-chat": options } }],
}).agents[0];

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "human-chat-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("human-chat through the extension runtime", () => {
  it("provides rules and a reply-mode tool for human turns", async () => {
    const run = { source: "web", sessionId: "s1" };
    expect((await runtime.getTools(agent, config, undefined, run)).map((tool) => tool.name))
      .toEqual(["reply_mode"]);
    expect((await runtime.getPromptContributions(agent, config, undefined, run)).join("\n"))
      .toContain("## Chat replies");
  });

  it("reviews human replies with a nudge and an actionable rewrite hint", async () => {
    const [{ reviewer }] = await runtime.getReplyReviewers(
      agent, config, "/tmp/workspace", "s1", undefined, { source: "web", sessionId: "s1" }
    );
    expect(reviewer.nudge).toContain("Reply on one topic");
    reviewer.begin();
    try {
      expect(await reviewer.review("One. Two. Three. Four. Five. Six.")).toEqual({
        ok: false,
        rewriteHint: expect.stringContaining("5 sentences"),
      });
      expect(await reviewer.review("Here is the short answer.")).toEqual({ ok: true });
    } finally {
      reviewer.end();
    }
  });

  it("keeps long mode in the active turn and resets it for the next turn", async () => {
    const reviewers = () => runtime.getReplyReviewers(
      agent, config, "/tmp/workspace", "long-mode", undefined, { source: "web" }
    );
    const [{ reviewer }] = await reviewers();
    reviewer.begin();
    try {
      await reviewers(); // Looking up another reviewer must not replace the active turn.
      const tool = await runtime.getTool(agent, "reply_mode", config);
      expect(await tool?.execute(
        { mode: "long", type: "steps", note: "install steps for user" },
        { agent, config, sessionId: "long-mode" }
      )).toBe("Long mode on for this reply.");
      expect(await reviewer.review(longReply)).toEqual({ ok: true });

      const [{ reviewer: other }] = await runtime.getReplyReviewers(
        agent, config, "/tmp/workspace", "other-session", undefined, { source: "web" }
      );
      other.begin();
      try {
        expect(await other.review(longReply)).toMatchObject({ ok: false });
      } finally {
        other.end();
      }
    } finally {
      reviewer.end();
    }
    const [{ reviewer: next }] = await reviewers();
    next.begin();
    try {
      expect(await next.review(longReply)).toMatchObject({ ok: false });
    } finally {
      next.end();
    }
  });

  it("offers /topics to list open topics and handles an empty workspace", async () => {
    const directory = await workspace();
    const [command] = await runtime.getChatCommands(
      agent, config, directory, "topics", undefined, { source: "web" }
    );
    expect(command.command).toBe("/topics");
    const context = { agent, config, workspaceDir: directory, sessionId: "topics" };
    expect(await command.run(context)).toBe("No open topics.");
    await fs.mkdir(path.join(directory, "topics"));
    await fs.writeFile(path.join(directory, "topics", "plan.md"),
      `---\ntitle: Delivery\nupdated: ${new Date().toISOString()}\n---\n\n## [ ] First\nx\n\n## [ ] Second\ny\n\n## [x] Done\nz\n`
    );
    expect(await command.run(context)).toBe("Delivery\n> First\n  Second");
  });

  it("records a successful long-mode reason without storing the reply", async () => {
    const directory = await workspace();
    const [{ reviewer }] = await runtime.getReplyReviewers(
      agent, config, directory, "logged", undefined, { source: "web" }
    );
    reviewer.begin();
    try {
      const tool = await runtime.getTool(agent, "reply_mode", config);
      await tool?.execute(
        { mode: "long", type: "steps", note: "install steps for user" },
        { agent, config, sessionId: "logged" }
      );
      const verdict = await reviewer.review(longReply);
      await reviewer.done?.(verdict, { rewritten: false });
      const lines = (await fs.readFile(path.join(directory, "data", "human-chat", "long-mode.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      expect(lines).toEqual([{
        ts: expect.any(String), agent: "main", session: "logged",
        type: "steps", note: "install steps for user", words: 6,
      }]);
    } finally {
      reviewer.end();
    }
  });

  it("records a failed rewrite at the configured log path", async () => {
    const directory = await workspace();
    const log = path.join(directory, "custom", "replies.jsonl");
    const custom = GatewayConfigSchema.parse({
      ...config, agents: [{ ...agent, extensions: { "human-chat": { log } } }],
    }).agents[0];
    const [{ reviewer }] = await runtime.getReplyReviewers(
      custom, config, directory, "failed", undefined, { source: "web" }
    );
    reviewer.begin();
    try {
      const draft = await reviewer.review(longReply);
      await reviewer.done?.(draft, { rewritten: false });
      await expect(fs.access(log)).rejects.toThrow();
      const rewritten = await reviewer.review(`${longReply} Again.`);
      await reviewer.done?.(rewritten, { rewritten: true });
      expect(JSON.parse((await fs.readFile(log, "utf8")).trim())).toEqual({
        ts: expect.any(String), agent: "main", session: "failed",
        event: "rewrite_failed", rules: ["too_many_sentences"],
      });
    } finally {
      reviewer.end();
    }
  });

  it("warns when the log cannot be written and keeps reviewing replies", async () => {
    const directory = await workspace();
    const blocked = path.join(directory, "blocked");
    await fs.writeFile(blocked, "A file cannot contain a log directory.");
    const custom = GatewayConfigSchema.parse({
      ...config, agents: [{ ...agent, extensions: { "human-chat": { log: path.join(blocked, "replies.jsonl") } } }],
    }).agents[0];
    const [{ reviewer }] = await runtime.getReplyReviewers(
      custom, config, directory, "unwritable", undefined, { source: "web" }
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    reviewer.begin();
    try {
      const verdict = await reviewer.review(longReply);
      await expect(reviewer.done?.(verdict, { rewritten: true })).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith("[human-chat] log write failed", {
        agentId: "main", error: expect.any(String),
      });
      expect(await reviewer.review("Here is the short answer.")).toEqual({ ok: true });
    } finally {
      reviewer.end();
      warning.mockRestore();
    }
  });

  it.each(["telegram", "discord", "slack", "mattermost", "irc"])(
    "provides rules and a tool for human turns from %s", async (source) => {
      const run = { source, sessionId: "s1" };
      expect((await runtime.getTools(agent, config, undefined, run)).map((tool) => tool.name))
        .toEqual(["reply_mode"]);
      expect((await runtime.getPromptContributions(agent, config, undefined, run)).join("\n"))
        .toContain("## Chat replies");
    }
  );

  it.each<[string, ExtensionRunInfo | undefined]>([
    ["scheduler", { source: "scheduler" }],
    ["agent sender", { source: "web", sender: { kind: "agent" } }],
    ["background", { source: "web", background: true }],
    ["unknown source", {}],
    ["missing run", undefined],
    ["compaction", { source: "web", sessionId: "compact:1" }],
  ])("skips rules, tools, commands and reply review for %s", async (_name, run) => {
    const session = run?.sessionId ?? "s1";
    expect(await runtime.getTools(agent, config, undefined, run)).toEqual([]);
    expect(await runtime.getPromptContributions(agent, config, undefined, run)).toEqual([]);
    expect(await runtime.getReplyReviewers(agent, config, "/tmp/workspace", session, undefined, run)).toEqual([]);
    expect(await runtime.getChatCommands(agent, config, "/tmp/workspace", session, undefined, run)).toEqual([]);
  });

  it("finds reply_mode for execution without run information", async () => {
    expect((await runtime.getTool(agent, "reply_mode", config))?.name).toBe("reply_mode");
  });

  it("keeps reply_mode directly available when discovery defers other tools", async () => {
    const [tool] = await runtime.getTools(agent, config, undefined, { source: "web" });
    expect(tool.core).toBe(true);
  });

  it.each([undefined, { "human-chat": { enabled: false } }])(
    "stays off without enabled agent configuration: %j", async (extensions) => {
      const off = GatewayConfigSchema.parse({ ...config, agents: [{ ...agent, extensions }] }).agents[0];
      const run = { source: "web", sessionId: "s1" };
      expect(runtime.reviewsReplies(off, config)).toBe(false);
      expect(await runtime.getTools(off, config, undefined, run)).toEqual([]);
      expect(await runtime.getPromptContributions(off, config, undefined, run)).toEqual([]);
      expect(await runtime.getReplyReviewers(off, config, "/tmp/workspace", "s1", undefined, run)).toEqual([]);
      expect(await runtime.getChatCommands(off, config, "/tmp/workspace", "s1", undefined, run)).toEqual([]);
    }
  );

  it("enables a bare human-chat key", async () => {
    const bare = configured(null);
    const run = { source: "web", sessionId: "s1" };
    expect(runtime.reviewsReplies(bare, config)).toBe(true);
    expect((await runtime.getTools(bare, config, undefined, run)).map((tool) => tool.name)).toEqual(["reply_mode"]);
    expect((await runtime.getPromptContributions(bare, config, undefined, run)).join("\n")).toContain("## Chat replies");
  });

  it("applies configured sentence and word limits with their leeways", async () => {
    const options = { max_sentences: 3, sentence_leeway: 1, max_sentence_words: 3, word_leeway: 1 };
    const custom = configured(options);
    const run = { source: "web", sessionId: "limits" };
    const prompts = (await runtime.getPromptContributions(custom, config, undefined, run)).join("\n");
    expect(prompts).toContain("1-3 sentences");
    expect(prompts).toContain("3 words or fewer");
    const [{ reviewer }] = await runtime.getReplyReviewers(custom, config, "/tmp/workspace", "limits", undefined, run);
    expect(reviewer.nudge).toContain("1-3 short sentences");
    reviewer.begin();
    try {
      expect(await reviewer.review("One two three four. Five. Six. Seven.")).toEqual({ ok: true });
    } finally {
      reviewer.end();
    }
    const strict = configured({ ...options, sentence_leeway: 0, word_leeway: 0 });
    const [{ reviewer: strictReviewer }] = await runtime.getReplyReviewers(strict, config, "/tmp/workspace", "limits", undefined, run);
    strictReviewer.begin();
    try {
      expect(await strictReviewer.review("One two three four. Five. Six. Seven.")).toMatchObject({ ok: false });
    } finally {
      strictReviewer.end();
    }
  });

  it("uses default limits for invalid configuration values", async () => {
    const custom = configured({ max_sentences: "x", sentence_leeway: -1, max_sentence_words: 0, word_leeway: "x" });
    const run = { source: "web", sessionId: "invalid-limits" };
    const prompts = (await runtime.getPromptContributions(custom, config, undefined, run)).join("\n");
    expect(prompts).toContain("1-5 sentences");
    expect(prompts).toContain("25 words or fewer");
    const [{ reviewer }] = await runtime.getReplyReviewers(custom, config, "/tmp/workspace", "invalid-limits", undefined, run);
    expect(reviewer.nudge).toContain("1-5 short sentences");
    reviewer.begin();
    try {
      expect(await reviewer.review(longReply)).toMatchObject({ ok: false });
      expect(await reviewer.review("One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix.")).toEqual({ ok: true });
    } finally {
      reviewer.end();
    }
  });

  it("rejects invalid reply modes and explains the valid reason types", async () => {
    const [tool] = await runtime.getTools(agent, config, undefined, { source: "web" });
    await expect(tool.execute({ mode: "long", type: "bogus", note: "a b c" }, { agent, config }))
      .rejects.toThrow(/user_asked, comparison/);
    await expect(tool.execute({ mode: "short", type: "steps", note: "a b c" }, { agent, config }))
      .rejects.toThrow(/mode must be "long"/);
  });

  it.each(["", "two words", undefined, 5])("rejects an invalid long-mode note: %j", async (note) => {
    const [tool] = await runtime.getTools(agent, config, undefined, { source: "web" });
    await expect(tool.execute({ mode: "long", type: "steps", note }, { agent, config })).rejects.toThrow(/note/);
  });

  it("accepts long mode outside an active turn without carrying it into the next turn", async () => {
    const tool = await runtime.getTool(agent, "reply_mode", config);
    expect(await tool?.execute(
      { mode: "long", type: "reference", note: "a b c" },
      { agent, config, sessionId: "not-active" }
    )).toBe("Long mode on for this reply.");
    const [{ reviewer }] = await runtime.getReplyReviewers(agent, config, "/tmp/workspace", "not-active", undefined, { source: "web" });
    reviewer.begin();
    try {
      expect(await reviewer.review(longReply)).toMatchObject({ ok: false });
    } finally {
      reviewer.end();
    }
  });

  it("accepts NO_REPLY without writing a long-mode log", async () => {
    const directory = await workspace();
    const [{ reviewer }] = await runtime.getReplyReviewers(agent, config, directory, "silent", undefined, { source: "web" });
    reviewer.begin();
    try {
      const tool = await runtime.getTool(agent, "reply_mode", config);
      await tool?.execute(
        { mode: "long", type: "steps", note: "install steps for user" },
        { agent, config, sessionId: "silent" }
      );
      const verdict = await reviewer.review("**NO_REPLY**.");
      expect(verdict).toEqual({ ok: true });
      await reviewer.done?.(verdict, { rewritten: false });
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      reviewer.end();
    }
  });
});
