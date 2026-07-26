/**
 * Tests for GET /board/agents and POST /board/agents/:runId/kill
 * Issue #13 — §15.4 agents view
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { ExtensionContext } from "@yoplai/shared";
import { boardExtension } from "./index.js";
import { Hono } from "hono";

// ── Helpers ─────────────────────────────────────────────────────────────────

function context(dataDir: string): ExtensionContext {
  return {
    getConfig: () =>
      ({
        agents: [],
        extensions: { board: {} },
        // Scope project root to dataDir so warmup scan is fast and isolated
        projects: { root: path.join(dataDir, "projects") },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    getDataDir: () => dataDir,
    reloadConfig: () => undefined,
    getAgent: () => undefined,
    getAgents: () => [],
    isAgentActive: () => false,
    isAgentStreaming: () => false,
    resolveWorkspaceDir: () => "",
    runAgent: async () => ({
      payloads: [],
      meta: { durationMs: 0, sessionId: "test" },
    }),
    getSubagentTemplates: () => [],
    resolveSessionId: async () => undefined,
    getSessionEntry: async () => undefined,
    clearSessionEntry: async () => undefined,
    restoreSessionUpdatedAt: () => undefined,
    deleteSession: () => undefined,
    invalidateHistoryCache: async () => undefined,
    getSessionHistory: async () => [],
    subscribe: () => () => undefined,
    emit: () => undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

async function buildApp(dataDir: string): Promise<Hono> {
  const app = new Hono().basePath("/api");
  boardExtension.registerRoutes(app);
  await boardExtension.start(context(dataDir));
  return app;
}

function writeRunFiles(
  dataDir: string,
  runId: string,
  opts: {
    projectId?: string;
    sliceId?: string;
    status?: string;
    pid?: number;
    label?: string;
  } = {}
) {
  const dir = path.join(dataDir, "sessions", "subagents", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      id: runId,
      label: opts.label ?? "Worker",
      projectId: opts.projectId,
      sliceId: opts.sliceId,
      cli: "claude",
      cwd: "/tmp",
      prompt: "do the thing",
      createdAt: now,
      archived: false,
    })
  );
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      pid: opts.pid ?? 99999,
      startedAt: now,
      status: opts.status ?? "running",
    })
  );
}

function writeProjectRunFiles(
  dataDir: string,
  slug: string,
  opts: {
    projectId: string;
    sliceId?: string;
    pid?: number;
    source?: "manual" | "orchestrator";
  }
) {
  const dir = path.join(
    dataDir,
    "projects",
    `${opts.projectId}_test`,
    "sessions",
    slug
  );
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      type: "subagent",
      cli: "codex",
      name: "Worker",
      projectId: opts.projectId,
      sliceId: opts.sliceId,
      source: opts.source ?? "orchestrator",
    })
  );
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      supervisor_pid: opts.pid ?? process.pid,
      started_at: now,
      project_id: opts.projectId,
      slice_id: opts.sliceId,
    })
  );
  fs.writeFileSync(path.join(dir, "history.jsonl"), "");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /board/agents", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-board-agents-"));
  });

  afterEach(async () => {
    await boardExtension.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty runs when no subagents exist", async () => {
    const app = await buildApp(tmpDir);
    const res = await app.request("/api/board/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: unknown[] };
    expect(body.runs).toEqual([]);
  });

  it("returns running runs", async () => {
    const app = await buildApp(tmpDir);
    writeRunFiles(tmpDir, "sar_test001", {
      projectId: "PRO-1",
      sliceId: "PRO-1-S01",
      status: "running",
      pid: process.pid,
      label: "Worker",
    });
    const res = await app.request("/api/board/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: Array<{ id: string; projectId?: string; sliceId?: string }>;
    };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].id).toBe("sar_test001");
    expect(body.runs[0].projectId).toBe("PRO-1");
    expect(body.runs[0].sliceId).toBe("PRO-1-S01");
  });

  it("excludes done/error runs from live view", async () => {
    const app = await buildApp(tmpDir);
    writeRunFiles(tmpDir, "sar_done001", { status: "done" });
    writeRunFiles(tmpDir, "sar_error001", { status: "error" });
    // Use current process PID so isProcessAlive returns true for the live run
    writeRunFiles(tmpDir, "sar_live001", {
      status: "running",
      pid: process.pid,
      projectId: "PRO-2",
    });
    const res = await app.request("/api/board/agents");
    const body = (await res.json()) as { runs: Array<{ id: string }> };
    expect(body.runs.map((r) => r.id)).toEqual(["sar_live001"]);
  });

  it("includes runs without sliceId (legacy/no-slice badge)", async () => {
    const app = await buildApp(tmpDir);
    // Use current process PID so isProcessAlive returns true
    writeRunFiles(tmpDir, "sar_legacy001", {
      status: "running",
      pid: process.pid,
      projectId: "PRO-3",
      // no sliceId
    });
    const res = await app.request("/api/board/agents");
    const body = (await res.json()) as { runs: Array<{ sliceId?: string }> };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].sliceId).toBeUndefined();
  });

  it("includes running project-backed orchestrator runs", async () => {
    const app = await buildApp(tmpDir);
    writeProjectRunFiles(tmpDir, "worker", {
      projectId: "PRO-5",
      sliceId: "PRO-5-S01",
    });
    const res = await app.request("/api/board/agents");
    const body = (await res.json()) as {
      runs: Array<{ id: string; projectId?: string; sliceId?: string }>;
    };
    expect(body.runs).toEqual([
      expect.objectContaining({
        id: "PRO-5:worker",
        projectId: "PRO-5",
        sliceId: "PRO-5-S01",
      }),
    ]);
  });
});

describe("POST /board/agents/:runId/kill", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-board-kill-"));
  });

  afterEach(async () => {
    await boardExtension.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 404 for unknown runId", async () => {
    const app = await buildApp(tmpDir);
    const res = await app.request("/api/board/agents/sar_notexist/kill", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("idempotently returns ok for already-done run", async () => {
    const app = await buildApp(tmpDir);
    writeRunFiles(tmpDir, "sar_done_idem", {
      status: "done",
      pid: 99999,
    });
    const res = await app.request("/api/board/agents/sar_done_idem/kill", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("done");
  });

  it("idempotently returns ok for already-interrupted run", async () => {
    const app = await buildApp(tmpDir);
    writeRunFiles(tmpDir, "sar_interrupted_idem", {
      status: "interrupted",
    });
    const res = await app.request(
      "/api/board/agents/sar_interrupted_idem/kill",
      {
        method: "POST",
      }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("sends SIGTERM and marks run as interrupted", async () => {
    const app = await buildApp(tmpDir);
    // Spawn a real subprocess that sleeps so isProcessAlive returns true
    const child = spawn("sleep", ["60"]);
    const childPid = child.pid!;
    writeRunFiles(tmpDir, "sar_running_kill", {
      status: "running",
      pid: childPid,
      label: "Worker",
      projectId: "PRO-4",
    });
    try {
      const res = await app.request("/api/board/agents/sar_running_kill/kill", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        runId: string;
        status: string;
      };
      expect(body.ok).toBe(true);
      expect(body.runId).toBe("sar_running_kill");
      expect(body.status).toBe("interrupted");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("interrupts project-backed orchestrator runs", async () => {
    const app = await buildApp(tmpDir);
    const child = spawn("sleep", ["60"]);
    const childPid = child.pid!;
    writeProjectRunFiles(tmpDir, "worker", {
      projectId: "PRO-6",
      sliceId: "PRO-6-S01",
      pid: childPid,
    });
    try {
      const res = await app.request("/api/board/agents/PRO-6:worker/kill", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        runId: string;
        status: string;
      };
      expect(body).toEqual({
        ok: true,
        runId: "PRO-6:worker",
        status: "interrupted",
      });
    } finally {
      child.kill("SIGKILL");
    }
  });
});
