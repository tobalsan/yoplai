import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { GatewayConfigSchema, type GatewayConfig } from "@yoplai/shared";
import { clearConfigCacheForTests, setLoadedConfig } from "../config/index.js";
import {
  createRuntimeSubagentHandlers,
  createSubagentHandlers,
  printSubagentProfiles,
  registerSubagentCommands,
} from "./subagent.js";

vi.mock("./user-token.js", () => ({
  loadCachedToken: vi.fn(() => null),
}));

function stubConsoleLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
    lines.push(String(line ?? ""));
  });
  return lines;
}

function setTestConfig(extensions?: GatewayConfig["extensions"]): void {
  setLoadedConfig(
    GatewayConfigSchema.parse({
      agents: [],
      extensions,
    })
  );
}

let previousApiUrl: string | undefined;

beforeEach(() => {
  previousApiUrl = process.env.YOPLAI_API_URL;
});

afterEach(() => {
  if (previousApiUrl === undefined) delete process.env.YOPLAI_API_URL;
  else process.env.YOPLAI_API_URL = previousApiUrl;
  clearConfigCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("subagent CLI handlers", () => {
  it("spawn posts to subagent endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ slug: "alpha" }), { status: 201 });
    };

    const handlers = createSubagentHandlers({
      baseUrl: "http://localhost:4000",
      fetchImpl,
    });

    await handlers.spawn({
      projectId: "pro-1",
      slug: "alpha",
      cli: "codex",
      prompt: "hi",
      mode: "main-run",
    });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      "http://localhost:4000/api/projects/PRO-1/subagents"
    );
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body.slug).toBe("alpha");
    expect(body.cli).toBe("codex");
    expect(body.prompt).toBe("hi");
    expect(body.mode).toBe("main-run");
  });

  it("logs requests include cursor", async () => {
    const calls: Array<{ url: string }> = [];
    const fetchImpl = async (url: string) => {
      calls.push({ url });
      return new Response(JSON.stringify({ cursor: 10, events: [] }), {
        status: 200,
      });
    };

    const handlers = createSubagentHandlers({
      baseUrl: "http://localhost:4000",
      fetchImpl,
    });

    await handlers.logs({ projectId: "pro-2", slug: "beta", since: 123 });
    expect(calls[0].url).toBe(
      "http://localhost:4000/api/projects/PRO-2/subagents/beta/logs?since=123"
    );
  });

  it("kill posts to kill endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ slug: "gamma" }), { status: 200 });
    };

    const handlers = createSubagentHandlers({
      baseUrl: "http://localhost:4000",
      fetchImpl,
    });

    await handlers.kill({ projectId: "pro-3", slug: "gamma" });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      "http://localhost:4000/api/projects/PRO-3/subagents/gamma/kill"
    );
    expect(calls[0].init?.method).toBe("POST");
  });
});

describe("runtime subagents CLI handlers", () => {
  it("start posts to runtime endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "sar_1" }), { status: 201 });
    };

    const handlers = createRuntimeSubagentHandlers({
      baseUrl: "http://localhost:4000",
      fetchImpl,
    });

    await handlers.start({
      cli: "codex",
      cwd: "/repo",
      prompt: "hi",
      label: "worker-a",
      parent: "agent-session:lead:main",
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://localhost:4000/api/subagents");
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body).toMatchObject({
      cli: "codex",
      cwd: "/repo",
      prompt: "hi",
      label: "worker-a",
      parent: "agent-session:lead:main",
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
  });

  it("list encodes runtime filters", async () => {
    const calls: Array<{ url: string }> = [];
    const fetchImpl = async (url: string) => {
      calls.push({ url });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };

    const handlers = createRuntimeSubagentHandlers({
      baseUrl: "http://localhost:4000",
      fetchImpl,
    });

    await handlers.list({
      parent: "board:main",
      status: "running",
      includeArchived: true,
    });

    expect(calls[0].url).toBe(
      "http://localhost:4000/api/subagents?parent=board%3Amain&status=running&includeArchived=true"
    );
  });

  it("sends Authorization header when YOPLAI_TOKEN is set", async () => {
    vi.stubEnv("YOPLAI_TOKEN", "test-token-123");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };

    const handlers = createRuntimeSubagentHandlers({
      baseUrl: "http://localhost:4000",
      fetchImpl,
    });

    await handlers.list({});

    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
      "Bearer test-token-123"
    );
  });

  it("omits Authorization header when no token is available", async () => {
    vi.stubEnv("YOPLAI_TOKEN", "");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };

    const handlers = createRuntimeSubagentHandlers({
      baseUrl: "http://localhost:4000",
      fetchImpl,
    });

    await handlers.list({});

    expect(new Headers(calls[0].init?.headers).get("authorization")).toBeNull();
  });
});

describe("runtime subagents profiles CLI", () => {
  it("outputs configured profiles", async () => {
    setTestConfig({
      subagents: {
        profiles: [
          {
            name: "Worker",
            cli: "codex",
            model: "gpt-5.3-codex",
            type: "worker",
            runMode: "worktree",
          },
        ],
      },
    });
    const lines = stubConsoleLog();
    const program = new Command();
    program.exitOverride();
    process.env.YOPLAI_API_URL = "http://localhost:4000";
    registerSubagentCommands(program);

    await program.parseAsync(["node", "yoplai", "subagents", "profiles"]);

    expect(lines).toEqual(["Worker  codex  gpt-5.3-codex  worker  worktree"]);
  });

  it("outputs raw profile JSON", () => {
    setTestConfig({
      subagents: {
        profiles: [
          {
            name: "Reviewer",
            cli: "claude",
            model: "claude-sonnet",
            type: "reviewer",
            runMode: "none",
          },
        ],
      },
    });
    const lines = stubConsoleLog();

    printSubagentProfiles(true);

    expect(JSON.parse(lines[0])).toEqual([
      {
        name: "Reviewer",
        cli: "claude",
        model: "claude-sonnet",
        type: "reviewer",
        runMode: "none",
      },
    ]);
  });

  it("includes legacy top-level Merger profiles", () => {
    setLoadedConfig(
      GatewayConfigSchema.parse({
        agents: [],
        subagents: [
          {
            name: "Merger",
            cli: "codex",
            model: "gpt-5.5",
            reasoning: "medium",
            type: "merger",
            runMode: "worktree",
          },
        ],
      })
    );
    const lines = stubConsoleLog();

    printSubagentProfiles(false);

    expect(lines).toEqual(["Merger  codex  gpt-5.5  merger  worktree"]);
  });

  it("handles missing or empty profiles", () => {
    setTestConfig();
    const missingLines = stubConsoleLog();

    printSubagentProfiles(false);

    expect(missingLines).toEqual(["No profiles configured"]);
    vi.restoreAllMocks();

    setTestConfig({ subagents: { profiles: [] } });
    const emptyLines = stubConsoleLog();

    printSubagentProfiles(false);

    expect(emptyLines).toEqual(["No profiles configured"]);
  });
});
