import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => ({
  ApiClient: vi.fn(),
}));

import { ApiClient } from "./client.js";
import { createProjectsCommand, program } from "./index.js";

describe("yoplai projects status command", () => {
  const apiClientMock = vi.mocked(ApiClient);
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    apiClientMock.mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("lists existing session slugs", async () => {
    const listProjectSubagents = vi.fn(async () => ({
      items: [{ slug: "coordinator" }, { slug: "worker-1" }, { slug: " " }],
    }));
    const getProject = vi.fn();
    apiClientMock.mockImplementation(
      () =>
        ({
          listProjectSubagents,
          getProject,
        }) as unknown as InstanceType<typeof ApiClient>
    );

    await program.parseAsync(["status", "PRO-1", "--list"], { from: "user" });

    expect(listProjectSubagents).toHaveBeenCalledWith("PRO-1", {
      includeArchived: true,
    });
    expect(getProject).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("coordinator\nworker-1");
  });

  it('emits type "native" in the --json shortcut payload', async () => {
    const getProject = vi.fn(async () => ({
      frontmatter: { sessionKeys: { "agent-1": "sess-1" } },
    }));
    const getAgentStatus = vi.fn(async () => ({ isStreaming: false }));
    const getAgentHistory = vi.fn(async () => ({ messages: [] }));
    apiClientMock.mockImplementation(
      () =>
        ({
          getProject,
          getAgentStatus,
          getAgentHistory,
        }) as unknown as InstanceType<typeof ApiClient>
    );

    // Uses a fresh Command instance (not the shared `program`) because
    // commander retains option values across parseAsync calls on the same
    // instance, which would otherwise leak --list/--json between tests.
    const cmd = createProjectsCommand();
    await cmd.parseAsync(["status", "PRO-1", "--json"], { from: "user" });

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          type: "native",
          agentId: "agent-1",
          sessionKey: "sess-1",
          status: "idle",
          messages: [],
        },
        null,
        2
      )
    );
  });
});
