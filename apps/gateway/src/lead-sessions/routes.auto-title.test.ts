import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, GatewayConfig, RunAgentParams } from "@yoplai/shared";
import {
  clearProjectsContext,
  setProjectsContext,
} from "../../../../packages/extensions/projects/src/context.js";
import { registerProjectRoutes } from "../../../../packages/extensions/projects/src/index.js";
import {
  resetAutoTitleDepsForTests,
  setAutoTitleDepsForTests,
} from "../../../../packages/extensions/projects/src/lead-sessions/auto-title.js";

let tmpDir: string;
let projectsRoot: string;
let api: Hono;
let emitted: Array<{ event: string; payload: unknown }>;
let runAgent: ReturnType<typeof vi.fn>;

const agent = {
  id: "pom",
  name: "Pom",
  workspace: "/tmp",
  model: { provider: "anthropic", model: "claude-opus" },
} as AgentConfig;

const titleModel = {
  id: "claude-3-5-haiku",
  name: "Claude Haiku",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-title-routes-"));
  projectsRoot = path.join(tmpDir, "projects");
  emitted = [];
  const config = {
    agents: [agent],
    extensions: { projects: { enabled: true, root: projectsRoot } },
    projects: { root: projectsRoot },
  } as unknown as GatewayConfig;
  runAgent = vi.fn(async (params: RunAgentParams) => ({
    payloads: [{ text: `assistant reply to ${params.message}` }],
    meta: { durationMs: 1, sessionId: params.sessionKey ?? "session" },
  }));
  setProjectsContext({
    getConfig: () => config,
    getDataDir: () => path.join(tmpDir, ".yoplai"),
    reloadConfig: () => undefined,
    getAgents: () => [agent],
    getAgent: (id: string) => (id === agent.id ? agent : undefined),
    isAgentActive: (id: string) => id === agent.id,
    isAgentStreaming: () => false,
    resolveWorkspaceDir: () => tmpDir,
    runAgent,
    getSubagentTemplates: () => [],
    resolveSessionId: async () => undefined,
    getSessionEntry: async () => undefined,
    clearSessionEntry: async () => undefined,
    restoreSessionUpdatedAt: () => {},
    deleteSession: () => {},
    invalidateHistoryCache: async () => {},
    getSessionHistory: async () => [],
    registerDeliverySink: () => () => {},
    getDeliverySink: () => undefined,
    subscribe: () => () => {},
    emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  setAutoTitleDepsForTests({
    getAvailableModels: () => [titleModel as never],
    completeSimple: async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "First planning exchange" }],
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
      }) as never,
  });

  api = new Hono();
  registerProjectRoutes(api);
});

afterEach(async () => {
  resetAutoTitleDepsForTests();
  clearProjectsContext();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createProject(): Promise<{ id: string; path: string }> {
  const res = await api.request("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Lead Sessions", pitch: "Test" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; path: string };
}

async function createLeadSession(projectId: string) {
  const res = await api.request(`/projects/${projectId}/lead-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: "pom" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; transcriptRef: string };
}

async function waitForTitleEvent() {
  for (let index = 0; index < 50; index += 1) {
    const found = emitted.find((item) => {
      const payload = item.payload as { session?: { title?: string } };
      return (
        item.event === "lead_session.changed" &&
        payload.session?.title === "First planning exchange"
      );
    });
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for auto-title event");
}

describe("lead session route auto-title", () => {
  it("responds before the async title job and then emits an updated title", async () => {
    const project = await createProject();
    const created = await createLeadSession(project.id);

    const sendRes = await api.request(`/lead-sessions/${created.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "help plan this slice" }),
    });

    expect(sendRes.status).toBe(200);
    const payload = (await sendRes.json()) as { session: { title: string } };
    expect(payload.session.title).toBe("New session");
    await expect(waitForTitleEvent()).resolves.toMatchObject({
      payload: {
        type: "lead_session_changed",
        kind: "updated",
        session: { id: created.id, title: "First planning exchange" },
      },
    });
  });

  it("preserves a manual rename made while the first assistant turn is pending", async () => {
    const project = await createProject();
    const created = await createLeadSession(project.id);
    let releaseRun: (() => void) | undefined;
    runAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRun = () =>
            resolve({
              payloads: [{ text: "assistant reply" }],
              meta: { durationMs: 1, sessionId: created.transcriptRef },
            });
        })
    );

    const sendPromise = api.request(`/lead-sessions/${created.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "first prompt" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const renameRes = await api.request(`/lead-sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Manual title" }),
    });
    expect(renameRes.status).toBe(200);
    releaseRun?.();
    const sendRes = await sendPromise;
    expect(sendRes.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const listRes = await api.request(`/projects/${project.id}/lead-sessions`);
    const list = (await listRes.json()) as {
      items: Array<{ id: string; title: string; titleLocked: boolean }>;
    };
    expect(list.items[0]).toMatchObject({
      id: created.id,
      title: "Manual title",
      titleLocked: true,
    });
    expect(
      emitted.some((item) => {
        const payload = item.payload as { session?: { title?: string } };
        return payload.session?.title === "First planning exchange";
      })
    ).toBe(false);
  });
});
