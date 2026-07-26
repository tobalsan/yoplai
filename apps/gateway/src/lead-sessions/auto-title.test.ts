import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import {
  clearProjectsContext,
  setProjectsContext,
} from "../../../../packages/extensions/projects/src/context.js";
import { createProject } from "../../../../packages/extensions/projects/src/projects/store.js";
import { createLeadSession } from "../../../../packages/extensions/projects/src/lead-sessions/store.js";
import {
  autoTitleLeadSession,
  normalizeGeneratedTitle,
  resetAutoTitleDepsForTests,
  resolveAutoTitleModel,
} from "../../../../packages/extensions/projects/src/lead-sessions/auto-title.js";

let tmpDir: string | undefined;

const agent = {
  id: "pom",
  name: "Pom",
  workspace: "/tmp",
  model: { provider: "anthropic", model: "claude-opus" },
} as AgentConfig;

function model(id: string, input: number, output: number): Model<Api> {
  return {
    id,
    name: id,
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input, output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  } as Model<Api>;
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-3-5-haiku",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-auto-title-"));
  const projectsRoot = path.join(tmpDir, "projects");
  const config = {
    agents: [agent],
    extensions: { projects: { enabled: true, root: projectsRoot } },
    projects: { root: projectsRoot },
  } as unknown as GatewayConfig;
  const emitted: Array<{ event: string; payload: unknown }> = [];
  setProjectsContext({
    getConfig: () => config,
    getDataDir: () => path.join(tmpDir!, ".yoplai"),
    reloadConfig: () => undefined,
    getAgents: () => [agent],
    getAgent: (id: string) => (id === agent.id ? agent : undefined),
    isAgentActive: (id: string) => id === agent.id,
    isAgentStreaming: () => false,
    resolveWorkspaceDir: () => tmpDir!,
    runAgent: vi.fn(),
    getSubagentTemplates: () => [],
    resolveSessionId: async () => undefined,
    getSessionEntry: async () => undefined,
    clearSessionEntry: async () => undefined,
    restoreSessionUpdatedAt: () => {},
    deleteSession: () => {},
    invalidateHistoryCache: async () => {},
    getSessionHistory: async () => [],
    subscribe: () => () => {},
    emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { config, projectsRoot, emitted };
}

afterEach(async () => {
  resetAutoTitleDepsForTests();
  clearProjectsContext();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("lead session auto-title", () => {
  it("resolves configured autoTitleModel verbatim", () => {
    const config = {
      agents: [agent],
      extensions: { sessions: { autoTitleModel: "anthropic/custom-haiku" } },
    } as unknown as GatewayConfig;

    expect(
      resolveAutoTitleModel(config, { getAvailableModels: () => [] })
    ).toBe("anthropic/custom-haiku");
  });

  it("picks the cheapest available Anthropic Haiku model", () => {
    const warn = vi.fn();

    expect(
      resolveAutoTitleModel(
        { agents: [agent], extensions: {} } as GatewayConfig,
        {
          warn,
          getAvailableModels: () => [
            model("claude-3-5-haiku", 2, 2),
            model("claude-3-haiku", 1, 1),
          ],
        }
      )
    ).toBe("anthropic/claude-3-haiku");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once and returns null when no Haiku model is available", () => {
    const warn = vi.fn();
    const config = { agents: [agent], extensions: {} } as GatewayConfig;
    const deps = {
      warn,
      getAvailableModels: () => [model("claude-sonnet", 1, 1)],
    };

    expect(resolveAutoTitleModel(config, deps)).toBeNull();
    expect(resolveAutoTitleModel(config, deps)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refuses Opus or thinking title models", () => {
    const warn = vi.fn();

    expect(
      resolveAutoTitleModel(
        {
          agents: [agent],
          extensions: { sessions: { autoTitleModel: "anthropic/claude-opus" } },
        } as unknown as GatewayConfig,
        { warn, getAvailableModels: () => [] }
      )
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("truncates generated titles on word boundaries", () => {
    expect(normalizeGeneratedTitle("Short clean title.")).toBe(
      "Short clean title"
    );
    expect(
      normalizeGeneratedTitle(
        "This title is intentionally longer than sixty characters by several words"
      )
    ).toBe("This title is intentionally longer than sixty characters by");
  });

  it("generates and writes a title without locking it", async () => {
    const { config, projectsRoot, emitted } = await setup();
    const project = await createProject(config, {
      title: "Auto title",
      pitch: "Test",
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;
    const created = await createLeadSession(config, project.data.id, {
      agentId: "pom",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await fs.appendFile(
      path.join(
        projectsRoot,
        project.data.path,
        "sessions",
        created.data.transcriptRef,
        "history.jsonl"
      ),
      [
        JSON.stringify({
          type: "history",
          agentId: "pom",
          sessionId: created.data.transcriptRef,
          timestamp: Date.now(),
          role: "user",
          content: [{ type: "text", text: "Help plan the release" }],
        }),
        JSON.stringify({
          type: "history",
          agentId: "pom",
          sessionId: created.data.transcriptRef,
          timestamp: Date.now(),
          role: "assistant",
          content: [{ type: "text", text: "We should split risk first." }],
        }),
        "",
      ].join("\n"),
      "utf8"
    );

    const updated = await autoTitleLeadSession({
      config,
      projectDir: path.join(projectsRoot, project.data.path),
      session: created.data,
      deps: {
        getAvailableModels: () => [model("claude-3-5-haiku", 1, 1)],
        completeSimple: async () => assistant("Release risk planning"),
      },
    });

    expect(updated?.title).toBe("Release risk planning");
    expect(updated?.titleLocked).toBe(false);
    expect(emitted).toMatchObject([
      {
        event: "lead_session.changed",
        payload: {
          kind: "updated",
          session: { title: "Release risk planning" },
        },
      },
    ]);
  });

  it("skips writing when titleLocked is true at write time", async () => {
    const { config, projectsRoot } = await setup();
    const project = await createProject(config, {
      title: "Locked title",
      pitch: "Test",
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;
    const created = await createLeadSession(config, project.data.id, {
      agentId: "pom",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const projectDir = path.join(projectsRoot, project.data.path);
    await fs.appendFile(
      path.join(
        projectDir,
        "sessions",
        created.data.transcriptRef,
        "history.jsonl"
      ),
      `${JSON.stringify({
        type: "history",
        agentId: "pom",
        sessionId: created.data.transcriptRef,
        timestamp: Date.now(),
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      })}\n${JSON.stringify({
        type: "history",
        agentId: "pom",
        sessionId: created.data.transcriptRef,
        timestamp: Date.now(),
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      })}\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(projectDir, "lead-sessions.json"),
      `${JSON.stringify([{ ...created.data, title: "Manual", titleLocked: true }], null, 2)}\n`,
      "utf8"
    );

    const updated = await autoTitleLeadSession({
      config,
      projectDir,
      session: created.data,
      deps: {
        getAvailableModels: () => [model("claude-3-5-haiku", 1, 1)],
        completeSimple: async () => assistant("Generated title"),
      },
    });

    expect(updated).toBeNull();
  });

  it("leaves New session when the model errors", async () => {
    const { config, projectsRoot } = await setup();
    const project = await createProject(config, {
      title: "Failure title",
      pitch: "Test",
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;
    const created = await createLeadSession(config, project.data.id, {
      agentId: "pom",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const projectDir = path.join(projectsRoot, project.data.path);
    await fs.appendFile(
      path.join(
        projectDir,
        "sessions",
        created.data.transcriptRef,
        "history.jsonl"
      ),
      `${JSON.stringify({
        type: "history",
        agentId: "pom",
        sessionId: created.data.transcriptRef,
        timestamp: Date.now(),
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      })}\n${JSON.stringify({
        type: "history",
        agentId: "pom",
        sessionId: created.data.transcriptRef,
        timestamp: Date.now(),
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      })}\n`,
      "utf8"
    );

    await expect(
      autoTitleLeadSession({
        config,
        projectDir,
        session: created.data,
        deps: {
          getAvailableModels: () => [model("claude-3-5-haiku", 1, 1)],
          completeSimple: async () => {
            throw new Error("model unavailable");
          },
        },
      })
    ).resolves.toBeNull();
    const raw = await fs.readFile(
      path.join(projectDir, "lead-sessions.json"),
      "utf8"
    );
    expect(JSON.parse(raw)[0].title).toBe("New session");
  });
});
