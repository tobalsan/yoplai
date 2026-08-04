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

let tmpDir: string;
let projectsRoot: string;
let api: Hono;
let emitted: Array<{ event: string; payload: unknown }>;
let runAgentParams: RunAgentParams[];

const agent = {
  id: "pom",
  name: "Pom",
  workspace: "/tmp",
  model: { model: "test" },
} as AgentConfig;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-session-routes-"));
  projectsRoot = path.join(tmpDir, "projects");
  emitted = [];
  runAgentParams = [];
  const config = {
    agents: [agent],
    extensions: { projects: { enabled: true, root: projectsRoot } },
    projects: { root: projectsRoot },
  } as unknown as GatewayConfig;

  setProjectsContext({
    getConfig: () => config,
    getDataDir: () => path.join(tmpDir, ".yoplai"),
    reloadConfig: () => undefined,
    getAgents: () => [agent],
    getAgent: (id: string) => (id === agent.id ? agent : undefined),
    isAgentActive: (id: string) => id === agent.id,
    isAgentStreaming: () => false,
    resolveWorkspaceDir: () => tmpDir,
    runAgent: vi.fn(async (params: RunAgentParams) => {
      runAgentParams.push(params);
      return {
        payloads: [{ text: "assistant reply" }],
        meta: { durationMs: 1, sessionId: params.sessionKey ?? "session" },
      };
    }),
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

  api = new Hono();
  registerProjectRoutes(api);
});

afterEach(async () => {
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

describe("lead session routes", () => {
  it("creates, lists, renames, archives, sends, reads transcript, and deletes", async () => {
    const project = await createProject();

    const createRes = await api.request(
      `/projects/${project.id}/lead-sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "pom", sliceId: "PRO-1-S01" }),
      }
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.title).toBe("New session");
    expect(created.sliceId).toBe("PRO-1-S01");

    const listRes = await api.request(
      `/projects/${project.id}/lead-sessions?sliceId=PRO-1-S01`
    );
    const list = await listRes.json();
    expect(list.items.map((item: { id: string }) => item.id)).toEqual([
      created.id,
    ]);

    const patchRes = await api.request(`/lead-sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed lead" }),
    });
    expect(patchRes.status).toBe(200);
    const renamed = await patchRes.json();
    expect(renamed.titleLocked).toBe(true);

    const sendRes = await api.request(`/lead-sessions/${created.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(sendRes.status).toBe(200);
    expect(runAgentParams[0]?.sessionKey).toBe(created.transcriptRef);

    const transcriptRes = await api.request(
      `/lead-sessions/${created.id}/transcript`
    );
    const transcript = await transcriptRes.json();
    expect(
      transcript.messages.map((msg: { role: string }) => msg.role)
    ).toEqual(["user", "assistant"]);

    const history = await fs.readFile(
      path.join(
        projectsRoot,
        project.path,
        "sessions",
        created.transcriptRef,
        "history.jsonl"
      ),
      "utf8"
    );
    expect(history).toContain("hello");
    expect(history).toContain("assistant reply");

    const archiveRes = await api.request(`/lead-sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(archiveRes.status).toBe(200);
    const archivedListRes = await api.request(
      `/projects/${project.id}/lead-sessions?archived=true&sliceId=PRO-1-S01`
    );
    const archivedList = await archivedListRes.json();
    expect(archivedList.items).toHaveLength(1);

    const deleteRes = await api.request(`/lead-sessions/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
    await expect(
      fs.stat(
        path.join(projectsRoot, project.path, "sessions", created.transcriptRef)
      )
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(emitted.map((item) => item.event)).toContain("lead_session.changed");
  });

  it("refuses to delete migrated legacy sessions", async () => {
    const project = await createProject();
    const patchRes = await api.request(`/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKeys: { pom: "legacy-pom" } }),
    });
    expect(patchRes.status).toBe(200);

    const listRes = await api.request(`/projects/${project.id}/lead-sessions`);
    const list = await listRes.json();
    const legacy = list.items[0];
    expect(legacy.id).toBe(`lead:${project.id}:legacy:pom`);

    const deleteRes = await api.request(`/lead-sessions/${legacy.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(409);

    const afterRes = await api.request(`/projects/${project.id}/lead-sessions`);
    const after = await afterRes.json();
    expect(after.items).toHaveLength(1);
  });
});
