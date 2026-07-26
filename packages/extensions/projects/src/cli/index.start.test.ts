import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => ({
  ApiClient: vi.fn(),
}));

import { ApiClient } from "./client.js";
import { buildStartRequestBody, program } from "./index.js";

describe("yoplai projects start request body mapping", () => {
  it("sends subagentTemplate when --subagent is provided (server applies defaults)", () => {
    const { body, errors } = buildStartRequestBody({
      subagent: "Worker",
    });

    expect(errors).toEqual([]);
    expect(body).toEqual({
      subagentTemplate: "Worker",
    });
  });

  it("allows non-locked fields with subagent (slug/name/custom prompt flow)", () => {
    const { body, errors } = buildStartRequestBody({
      subagent: "Worker",
      slug: "worker-sidebar-recent",
      name: "Worker Sidebar Recent",
    });

    expect(errors).toEqual([]);
    expect(body).toEqual({
      subagentTemplate: "Worker",
      slug: "worker-sidebar-recent",
      name: "Worker Sidebar Recent",
    });
  });

  it("rejects locked subagent overrides without escape hatch", () => {
    const { body, errors } = buildStartRequestBody({
      subagent: "Coordinator",
      agent: "codex",
    });

    expect(body).toEqual({
      subagentTemplate: "Coordinator",
    });
    expect(errors).toEqual([
      "Subagent profile locked. Use --allow-overrides to override.",
    ]);
  });

  it("lets explicit options override subagent defaults with escape hatch", () => {
    const { body, errors } = buildStartRequestBody({
      subagent: "Coordinator",
      allowOverrides: true,
      agent: "codex",
      model: "gpt-5.2",
      promptRole: "reviewer",
      mode: "worktree",
      includePostRun: true,
    });

    expect(errors).toEqual([]);
    expect(body).toMatchObject({
      subagentTemplate: "Coordinator",
      runAgent: "cli:codex",
      model: "gpt-5.2",
      promptRole: "reviewer",
      runMode: "worktree",
      includePostRun: true,
    });
    expect(body).not.toHaveProperty("allowOverrides");
  });

  it("accepts gpt-5.4 for codex runs", () => {
    const { body, errors } = buildStartRequestBody({
      agent: "codex",
      model: "gpt-5.4",
    });

    expect(errors).toEqual([]);
    expect(body).toMatchObject({
      runAgent: "cli:codex",
      model: "gpt-5.4",
    });
  });

  it("passes subagent and agent to server without local resolution", () => {
    const { body, errors } = buildStartRequestBody({
      subagent: "Worker",
      allowOverrides: true,
      agent: "pi",
    });

    expect(errors).toEqual([]);
    expect(body).toMatchObject({
      subagentTemplate: "Worker",
      runAgent: "cli:pi",
    });
    expect(body).not.toHaveProperty("allowOverrides");
  });

  it("maps include/exclude toggles with exclude precedence", () => {
    const { body, errors } = buildStartRequestBody({
      includeDefaultPrompt: true,
      excludeDefaultPrompt: true,
      includeRoleInstructions: true,
      excludePostRun: true,
    });

    expect(errors).toEqual([]);
    expect(body).toMatchObject({
      includeDefaultPrompt: false,
      includeRoleInstructions: true,
      includePostRun: false,
    });
  });

  it("returns validation error for invalid prompt-role", () => {
    const { body, errors } = buildStartRequestBody({
      promptRole: "also-bad",
    });

    expect(body).toEqual({});
    expect(errors).toEqual([
      "Invalid --prompt-role value. Use coordinator|worker|reviewer|legacy.",
    ]);
  });

  it("works without --subagent (plain start)", () => {
    const { body, errors } = buildStartRequestBody({
      agent: "codex",
      model: "gpt-5.4",
    });

    expect(errors).toEqual([]);
    expect(body).toEqual({
      runAgent: "cli:codex",
      model: "gpt-5.4",
    });
    expect(body).not.toHaveProperty("subagentTemplate");
  });
});

describe("yoplai projects start command", () => {
  const apiClientMock = vi.mocked(ApiClient);
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    apiClientMock.mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints the friendly line when the server responds with type "native"', async () => {
    const startProject = vi.fn(async () => ({
      type: "native",
      sessionKey: "sess-123",
    }));
    apiClientMock.mockImplementation(
      () => ({ startProject }) as unknown as InstanceType<typeof ApiClient>
    );

    await program.parseAsync(["start", "PRO-1"], { from: "user" });

    expect(logSpy).toHaveBeenCalledWith(
      "Started Yoplai run (sessionKey: sess-123)"
    );
  });

  it('prints the friendly line when the server responds with legacy type "aihub"', async () => {
    const startProject = vi.fn(async () => ({
      type: "aihub",
      sessionKey: "sess-456",
    }));
    apiClientMock.mockImplementation(
      () => ({ startProject }) as unknown as InstanceType<typeof ApiClient>
    );

    await program.parseAsync(["start", "PRO-1"], { from: "user" });

    expect(logSpy).toHaveBeenCalledWith(
      "Started Yoplai run (sessionKey: sess-456)"
    );
  });
});
