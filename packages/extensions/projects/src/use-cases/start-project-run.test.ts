import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import { clearProjectsContext, setProjectsContext } from "../context.js";
import { startProjectRun } from "./start-project-run.js";

const projectFixture = vi.hoisted(() => ({
  frontmatter: {} as Record<string, unknown>,
}));

vi.mock("../projects/index.js", () => ({
  getProject: async () => ({
    ok: true as const,
    data: {
      id: "PRO-1",
      title: "Test Project",
      path: "PRO-1",
      absolutePath: "/nonexistent/PRO-1",
      docs: { README: "Body" },
      frontmatter: projectFixture.frontmatter,
    },
  }),
  updateProject: async () => ({ ok: true as const, data: {} }),
}));

const config = { agents: [] } as unknown as GatewayConfig;

// agents[0] is the auto-selected fallback, so dispatching "zulu" proves the
// configured runAgent was ignored.
const agents = [
  { id: "zulu", name: "Zulu" },
  { id: "alpha", name: "Alpha" },
];

function setupContext() {
  const runAgent = vi.fn(async () => ({ ok: true as const, data: {} }));
  setProjectsContext({
    getConfig: () => config,
    getSubagentTemplates: () => [],
    getAgents: () => agents,
    getAgent: (id: string) => agents.find((agent) => agent.id === id),
    isAgentActive: () => true,
    runAgent,
  } as never);
  return runAgent;
}

afterEach(() => {
  clearProjectsContext();
  projectFixture.frontmatter = {};
  vi.restoreAllMocks();
});

describe("startProjectRun", () => {
  it("rejects unknown subagent templates before touching project storage", async () => {
    setProjectsContext({
      getConfig: () => config,
      getSubagentTemplates: () => [],
    } as never);

    const result = await startProjectRun(config, "PRO-1", {
      subagentTemplate: "Worker",
    });

    expect(result).toEqual({
      ok: false,
      error: "Unknown subagent template: Worker",
      status: 400,
    });
  });

  it("resolves a yoplai: frontmatter runAgent to that agent", async () => {
    const runAgent = setupContext();
    projectFixture.frontmatter = { runAgent: "yoplai:alpha" };

    const result = await startProjectRun(config, "PRO-1", {});

    expect(result).toEqual({
      ok: true,
      data: {
        ok: true,
        type: "native",
        sessionKey: "project:PRO-1:alpha",
      },
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0][0]).toMatchObject({ agentId: "alpha" });
  });

  it("accepts the legacy aihub: runAgent prefix and warns once", async () => {
    const runAgent = setupContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    projectFixture.frontmatter = { runAgent: "aihub:alpha" };

    const first = await startProjectRun(config, "PRO-1", {});
    const second = await startProjectRun(config, "PRO-1", {});

    expect(first).toEqual({
      ok: true,
      data: { ok: true, type: "native", sessionKey: "project:PRO-1:alpha" },
    });
    expect(second).toEqual(first);
    expect(runAgent.mock.calls.map((call) => call[0].agentId)).toEqual([
      "alpha",
      "alpha",
    ]);
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes("is deprecated")
      )
    ).toHaveLength(1);
  });

  it("treats a bare runAgent as a CLI id", async () => {
    setupContext();

    const result = await startProjectRun(config, "PRO-1", {
      runAgent: "bogus",
    });

    expect(result).toEqual({
      ok: false,
      error: "Unsupported CLI: bogus. Supported CLIs: claude, codex, pi.",
      status: 400,
    });
  });

  it("does not accept the in-memory native: run-list key format as a runAgent prefix", async () => {
    // "native:" is unrecognized, so this falls through to the same
    // auto-selected-fallback path as no runAgent at all (dispatching
    // "zulu", not "alpha") rather than resolving to the requested agent.
    const runAgent = setupContext();
    projectFixture.frontmatter = { runAgent: "native:alpha" };

    const result = await startProjectRun(config, "PRO-1", {});

    expect(result).toEqual({
      ok: true,
      data: {
        ok: true,
        type: "native",
        sessionKey: "project:PRO-1:zulu",
      },
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0][0]).toMatchObject({ agentId: "zulu" });
  });
});
