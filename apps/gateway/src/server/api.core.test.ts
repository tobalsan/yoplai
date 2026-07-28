import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const getAgent = vi.fn();
const getActiveAgents = vi.fn();
const isAgentActive = vi.fn();
const resolveWorkspaceDir = vi.fn((workspace: string) => workspace);
let loadConfigValue: Record<string, unknown> = {
  branding: undefined,
  agentFab: false,
  agents: [],
};

const runAgent = vi.fn();
const getAllSessionsForAgent = vi.fn();
const getAgentStatuses = vi.fn();
const getSessionHistory = vi.fn();
const getFullSessionHistory = vi.fn();
const compactAgentSession = vi.fn();

const resolveSessionId = vi.fn();
const getSessionEntry = vi.fn();
const isAbortTrigger = vi.fn();
const getSessionThinkLevel = vi.fn();
const multiUserState = vi.hoisted(() => ({
  loaded: false,
  agentAccess: true,
  authContext: null as null | {
    user: { id: string; name?: string; role?: string | string[] | null };
    session: { id: string; userId: string };
  },
}));

const reloadConfig = vi.fn(() => loadConfigValue);
const setLoadedConfig = vi.fn();
const resolveStartupConfig = vi.fn(async (config) => config);
const reloadExtensions = vi.fn();

vi.mock("../config/index.js", () => ({
  CONFIG_DIR: "/tmp/yoplai-test",
  getAgent,
  getActiveAgents,
  isAgentActive,
  resolveWorkspaceDir,
  loadConfig: () => loadConfigValue,
  reloadConfig,
  setLoadedConfig,
}));

vi.mock("../config/validate.js", () => ({
  resolveStartupConfig,
}));

vi.mock("../extensions/registry.js", () => ({
  getLoadedExtensions: () => [],
  reloadExtensions,
  isExtensionLoaded: (extensionId: string) =>
    extensionId === "multiUser" && multiUserState.loaded,
  getExtensionRuntime: () => ({
    getCapabilities: () => ({
      extensions: {},
      capabilities: {},
      multiUser: multiUserState.loaded,
      home: undefined,
    }),
  }),
}));

vi.mock("@yoplai/extension-multi-user", () => ({
  getForwardedAuthContext: vi.fn(() => multiUserState.authContext),
  getAgentFilter: vi.fn(() => (agents: unknown[]) => agents),
  hasAgentAccess: vi.fn(async () => multiUserState.agentAccess),
}));

const buildExtensionCatalog = vi.fn();
const resolveExtensionDefinition = vi.fn();

vi.mock("../extensions/catalog.js", () => ({
  buildExtensionCatalog,
  resolveExtensionDefinition,
}));

const updateAgentExtensionConfig = vi.fn();

vi.mock("../extensions/agent-config-writer.js", () => ({
  updateAgentExtensionConfig,
}));

vi.mock("../agents/index.js", () => ({
  runAgent,
  getAllSessionsForAgent,
  getAgentStatuses,
  getSessionHistory,
  getFullSessionHistory,
}));

vi.mock("../agents/compact.js", () => ({
  compactAgentSession,
}));

vi.mock("../sessions/index.js", () => ({
  resolveSessionId,
  getSessionEntry,
  isAbortTrigger,
  getSessionThinkLevel,
}));

vi.mock("../media/upload.js", () => ({
  saveUploadedFile: vi.fn(),
  isAllowedMimeType: vi.fn(() => true),
  resolveUploadMimeType: vi.fn((mimeType: string) => mimeType),
  getAllowedMimeTypes: vi.fn(() => []),
  MAX_UPLOAD_SIZE_BYTES: 25 * 1024 * 1024,
  UploadTooLargeError: class UploadTooLargeError extends Error {},
  UploadTypeError: class UploadTypeError extends Error {},
}));

describe("api core session resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getAgent.mockImplementation((agentId: string) =>
      agentId === "alpha"
        ? {
            id: "alpha",
            name: "Alpha",
            model: { provider: "anthropic", model: "claude" },
          }
        : null
    );
    getActiveAgents.mockReturnValue([]);
    loadConfigValue = {
      branding: undefined,
      agentFab: false,
      agents: [],
    };
    isAgentActive.mockReturnValue(true);
    isAbortTrigger.mockReturnValue(false);
    multiUserState.loaded = false;
    multiUserState.agentAccess = true;
    multiUserState.authContext = null;
    buildExtensionCatalog.mockResolvedValue([]);
    runAgent.mockResolvedValue({
      payloads: [],
      meta: { durationMs: 0, sessionId: "resolved-1" },
    });
    compactAgentSession.mockResolvedValue({
      sessionId: "resolved-1",
      summary: "Compacted summary",
      keptMessages: 8,
    });
    resolveSessionId.mockResolvedValue({
      sessionId: "resolved-1",
      message: "hello",
      isNew: true,
      createdAt: 1,
    });
  });

  it("returns an empty agent list without default resolution errors", async () => {
    const { api } = await import("./api.core.js");

    const response = await api.request(new Request("http://localhost/agents"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("marks the configured default project manager on visible agents", async () => {
    const agents = [
      {
        id: "alpha",
        name: "Alpha",
        model: { provider: "anthropic", model: "claude" },
      },
      {
        id: "beta",
        name: "Beta",
        model: { provider: "anthropic", model: "claude" },
      },
    ];
    getActiveAgents.mockReturnValue(agents);
    loadConfigValue = {
      branding: undefined,
      agentFab: false,
      agents,
      defaultProjectManager: "beta",
    };
    const { api } = await import("./api.core.js");

    const response = await api.request(new Request("http://localhost/agents"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        id: "alpha",
        isDefaultProjectManager: false,
      }),
      expect.objectContaining({
        id: "beta",
        isDefaultProjectManager: true,
      }),
    ]);
  });

  it("redacts model and workspace from non-admin multi-user agent lists", async () => {
    const agents = [
      {
        id: "alpha",
        name: "Alpha",
        model: { provider: "anthropic", model: "claude" },
        workspace: "/tmp/alpha",
      },
    ];
    getActiveAgents.mockReturnValue(agents);
    loadConfigValue = {
      branding: undefined,
      agentFab: false,
      agents,
    };
    multiUserState.loaded = true;
    multiUserState.authContext = {
      user: { id: "user-1", role: "user" },
      session: { id: "session-1", userId: "user-1" },
    };
    const { api } = await import("./api.core.js");

    const response = await api.request(new Request("http://localhost/agents"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.not.objectContaining({
        model: expect.anything(),
        workspace: expect.anything(),
      }),
    ]);
  });

  it("keeps model and workspace for admin multi-user agent lists", async () => {
    const agents = [
      {
        id: "alpha",
        name: "Alpha",
        model: { provider: "anthropic", model: "claude" },
        workspace: "/tmp/alpha",
      },
    ];
    getActiveAgents.mockReturnValue(agents);
    loadConfigValue = {
      branding: undefined,
      agentFab: false,
      agents,
    };
    multiUserState.loaded = true;
    multiUserState.authContext = {
      user: { id: "admin-1", role: "admin" },
      session: { id: "session-1", userId: "admin-1" },
    };
    const { api } = await import("./api.core.js");

    const response = await api.request(new Request("http://localhost/agents"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        model: { provider: "anthropic", model: "claude" },
        workspace: "/tmp/alpha",
      }),
    ]);
  });

  it("returns pool agents without per-user filtering", async () => {
    const pool = [
      {
        id: "gamma",
        name: "Gamma",
        model: { provider: "anthropic", model: "claude" },
      },
    ];
    getActiveAgents.mockReturnValue([]);
    loadConfigValue = {
      branding: undefined,
      agentFab: false,
      agents: [],
      pool,
      forkedAgents: true,
    };
    const { api } = await import("./api.core.js");

    const response = await api.request(new Request("http://localhost/pool"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        id: "gamma",
        name: "Gamma",
      }),
    ]);
  });

  it("does not sort renamed sessions by file mtime", async () => {
    const sessionsDir = "/tmp/yoplai-test/history";
    await fs.rm("/tmp/yoplai-test", { recursive: true, force: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    getActiveAgents.mockReturnValue([
      { id: "alpha", name: "Alpha", avatar: "🦊" },
    ]);
    getSessionEntry.mockResolvedValue(null);
    await fs.writeFile(
      path.join(sessionsDir, "2026-05-29T10-00-00-000Z_alpha-old.jsonl"),
      [
        JSON.stringify({
          type: "history",
          role: "user",
          content: [{ type: "text", text: "old" }],
          timestamp: 1000,
        }),
        JSON.stringify({
          type: "meta",
          key: "title",
          value: "renamed",
          timestamp: 3000,
        }),
      ].join("\n") + "\n"
    );
    await fs.writeFile(
      path.join(sessionsDir, "2026-05-29T10-01-00-000Z_alpha-new.jsonl"),
      JSON.stringify({
        type: "history",
        role: "user",
        content: [{ type: "text", text: "new" }],
        timestamp: 2000,
      }) + "\n"
    );
    const { api } = await import("./api.core.js");

    const response = await api.request(
      new Request("http://localhost/agents/sessions")
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.items.map((item: { sessionId: string }) => item.sessionId)
    ).toEqual(["new", "old"]);
    expect(body.items[1]).toMatchObject({ title: "renamed", avatar: "🦊" });
  });

  it("excludes ephemeral compact sessions from the sidebar listing", async () => {
    const sessionsDir = "/tmp/yoplai-test/history";
    await fs.rm("/tmp/yoplai-test", { recursive: true, force: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    getActiveAgents.mockReturnValue([
      { id: "alpha", name: "Alpha", avatar: "🦊" },
    ]);
    getSessionEntry.mockResolvedValue(null);
    await fs.writeFile(
      path.join(sessionsDir, "2026-05-29T10-00-00-000Z_alpha-real.jsonl"),
      JSON.stringify({
        type: "history",
        role: "user",
        content: [{ type: "text", text: "real" }],
        timestamp: 1000,
      }) + "\n"
    );
    await fs.writeFile(
      path.join(
        sessionsDir,
        "2026-05-29T10-01-00-000Z_alpha-compact:real:abc123.jsonl"
      ),
      [
        JSON.stringify({
          type: "history",
          role: "user",
          content: [{ type: "text", text: "Summarize the conversation" }],
          timestamp: 2000,
        }),
        JSON.stringify({
          type: "history",
          role: "assistant",
          content: [{ type: "text", text: "summary" }],
          timestamp: 2001,
        }),
      ].join("\n") + "\n"
    );
    const { api } = await import("./api.core.js");

    const response = await api.request(
      new Request("http://localhost/agents/sessions")
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.items.map((item: { sessionId: string }) => item.sessionId)
    ).toEqual(["real"]);
  });

  it("rejects unsafe explicit session ids", async () => {
    const { api } = await import("./api.core.js");

    const historyResponse = await api.request(
      new Request("http://localhost/agents/alpha/history?sessionId=../bad")
    );
    const compactResponse = await api.request(
      new Request("http://localhost/agents/alpha/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "../bad" }),
      })
    );
    const dotDotResponse = await api.request(
      new Request("http://localhost/agents/alpha/history?sessionId=..")
    );
    const delimitedDotDotResponse = await api.request(
      new Request("http://localhost/agents/alpha/history?sessionId=foo:..:bar")
    );
    const renameResponse = await api.request(
      new Request("http://localhost/agents/alpha/sessions/..%2Fbad", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "bad" }),
      })
    );

    expect(historyResponse.status).toBe(400);
    expect(dotDotResponse.status).toBe(400);
    expect(delimitedDotDotResponse.status).toBe(400);
    expect(compactResponse.status).toBe(400);
    expect(renameResponse.status).toBe(400);
  });

  it("passes a resolved session through to runAgent", async () => {
    const { api } = await import("./api.core.js");

    const response = await api.request(
      new Request("http://localhost/agents/alpha/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "/new hello",
          sessionKey: "main",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(resolveSessionId).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledWith({
      agentId: "alpha",
      userId: undefined,
      message: "/new hello",
      sessionId: undefined,
      sessionKey: undefined,
      resolvedSession: {
        sessionId: "resolved-1",
        sessionKey: "main",
        message: "hello",
        isNew: true,
      },
      thinkLevel: undefined,
      context: undefined,
      extensionRuntime: expect.any(Object),
      source: "web",
    });
  });

  it("passes web user context to runAgent in multi-user mode", async () => {
    multiUserState.loaded = true;
    multiUserState.authContext = {
      user: { id: "user-1", name: "Thinh" },
      session: { id: "session-1", userId: "user-1" },
    };
    const { api } = await import("./api.core.js");

    const response = await api.request(
      new Request("http://localhost/agents/alpha/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "hello",
          sessionKey: "main",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        context: { kind: "web", name: "Thinh" },
        source: "web",
      })
    );
  });

  it("compacts an explicit web session without resolving main", async () => {
    const { api } = await import("./api.core.js");

    const response = await api.request(
      new Request("http://localhost/agents/alpha/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey: "main", sessionId: "past-1" }),
      })
    );

    expect(response.status).toBe(200);
    expect(getSessionEntry).not.toHaveBeenCalled();
    expect(compactAgentSession).toHaveBeenCalledWith({
      agentId: "alpha",
      sessionKey: "main",
      sessionId: "past-1",
      userId: undefined,
      extensionRuntime: expect.any(Object),
      context: undefined,
    });
  });

  it("compacts the resolved web session", async () => {
    getSessionEntry.mockResolvedValue({
      sessionId: "resolved-1",
      updatedAt: 1,
      createdAt: 1,
    });
    const { api } = await import("./api.core.js");

    const response = await api.request(
      new Request("http://localhost/agents/alpha/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey: "main" }),
      })
    );

    expect(response.status).toBe(200);
    expect(compactAgentSession).toHaveBeenCalledWith({
      agentId: "alpha",
      sessionKey: "main",
      sessionId: "resolved-1",
      userId: undefined,
      extensionRuntime: expect.any(Object),
      context: undefined,
    });
    expect(await response.json()).toEqual({
      sessionId: "resolved-1",
      summary: "Compacted summary",
      keptMessages: 8,
    });
  });

  describe("GET /agents/:id/extensions (catalog)", () => {
    const catalog = [
      {
        id: "acme",
        displayName: "Acme",
        description: "Acme extension",
        builtIn: false,
        enabled: true,
        configJsonSchema: null,
        requiredSecrets: [],
        tier: "toggle-only",
      },
    ];

    it("returns the agent's extension catalog in single-user mode", async () => {
      loadConfigValue = {
        agents: [{ id: "alpha", name: "Alpha" }],
        pool: [],
      };
      buildExtensionCatalog.mockResolvedValue(catalog);
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions")
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        agentId: "alpha",
        extensions: catalog,
      });
      expect(buildExtensionCatalog).toHaveBeenCalledWith(
        loadConfigValue,
        expect.objectContaining({ id: "alpha" }),
        { configurable: true }
      );
    });

    it("resolves the agent from the pool when not an active agent", async () => {
      loadConfigValue = {
        agents: [],
        pool: [
          {
            id: "poolie",
            name: "Poolie",
            extensions: { acme: { enabled: true, region: "pool" } },
          },
        ],
      };
      buildExtensionCatalog.mockResolvedValue(catalog);
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/poolie/extensions")
      );

      expect(response.status).toBe(200);
      expect(buildExtensionCatalog).toHaveBeenCalledWith(
        loadConfigValue,
        expect.not.objectContaining({ extensions: expect.anything() }),
        { configurable: false }
      );
    });

    it("uses an existing fork config instead of pool template config", async () => {
      loadConfigValue = {
        agents: [
          {
            id: "poolie",
            name: "Fork",
            extensions: { acme: { enabled: false, region: "fork" } },
          },
        ],
        pool: [
          {
            id: "poolie",
            name: "Poolie",
            extensions: { acme: { enabled: true, region: "pool" } },
          },
        ],
      };
      buildExtensionCatalog.mockResolvedValue(catalog);
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/poolie/extensions")
      );

      expect(response.status).toBe(200);
      expect(buildExtensionCatalog).toHaveBeenCalledWith(
        loadConfigValue,
        expect.objectContaining({
          id: "poolie",
          extensions: { acme: { enabled: false, region: "fork" } },
        }),
        { configurable: true }
      );
    });

    it("404s for an unknown agent", async () => {
      loadConfigValue = { agents: [], pool: [] };
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/ghost/extensions")
      );

      expect(response.status).toBe(404);
      expect(buildExtensionCatalog).not.toHaveBeenCalled();
    });

    it("allows same-team members in multi-user mode", async () => {
      loadConfigValue = { agents: [{ id: "alpha", name: "Alpha" }], pool: [] };
      multiUserState.loaded = true;
      multiUserState.agentAccess = true;
      multiUserState.authContext = {
        user: { id: "u1", role: "user" },
        session: { id: "s1", userId: "u1" },
      };
      buildExtensionCatalog.mockResolvedValue(catalog);
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions")
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        agentId: "alpha",
        extensions: catalog,
      });
    });

    it("403s for non-members in multi-user mode", async () => {
      loadConfigValue = { agents: [{ id: "alpha", name: "Alpha" }], pool: [] };
      multiUserState.loaded = true;
      multiUserState.agentAccess = false;
      multiUserState.authContext = {
        user: { id: "u1", role: "user" },
        session: { id: "s1", userId: "u1" },
      };
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions")
      );

      expect(response.status).toBe(403);
      expect(buildExtensionCatalog).not.toHaveBeenCalled();
    });

    it("allows admins in multi-user mode", async () => {
      loadConfigValue = { agents: [{ id: "alpha", name: "Alpha" }], pool: [] };
      multiUserState.loaded = true;
      multiUserState.authContext = {
        user: { id: "admin1", role: "admin" },
        session: { id: "s2", userId: "admin1" },
      };
      buildExtensionCatalog.mockResolvedValue(catalog);
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions")
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        agentId: "alpha",
        extensions: catalog,
      });
    });
  });

  describe("PATCH /agents/:id/extensions/:extensionId (write)", () => {
    const catalog = [
      {
        id: "acme",
        displayName: "Acme",
        description: "Acme extension",
        builtIn: false,
        enabled: false,
        configJsonSchema: null,
        requiredSecrets: [],
        tier: "toggle-only",
      },
    ];

    beforeEach(() => {
      reloadConfig.mockImplementation(() => loadConfigValue);
      resolveStartupConfig.mockImplementation(async (config) => config);
      // Default: not a factory extension, so the guard doesn't interfere with
      // tests that aren't specifically exercising it.
      resolveExtensionDefinition.mockResolvedValue(undefined);
    });

    it("updates an extension and returns the refreshed catalog", async () => {
      loadConfigValue = {
        agents: [{ id: "alpha", name: "Alpha", workspace: "/ws/alpha" }],
        pool: [],
      };
      updateAgentExtensionConfig.mockResolvedValue({});
      buildExtensionCatalog.mockResolvedValue(catalog);
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions/acme", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        agentId: "alpha",
        extensionId: "acme",
        extensions: catalog,
      });
      // Wrote to the resolved workspace dir with the parsed patch.
      expect(updateAgentExtensionConfig).toHaveBeenCalledWith(
        "/ws/alpha",
        "acme",
        { enabled: true },
        expect.any(Function)
      );
      // Config cache is invalidated and the newly read config is resolved
      // before it becomes the live runtime config.
      expect(reloadConfig).toHaveBeenCalled();
      expect(resolveStartupConfig).toHaveBeenCalledWith(loadConfigValue);
      expect(setLoadedConfig).toHaveBeenCalledWith(loadConfigValue);
      expect(reloadExtensions).toHaveBeenCalledWith(loadConfigValue);
    });

    it("installs the secret-resolved config after writing", async () => {
      const rawReloaded = {
        agents: [
          {
            id: "alpha",
            name: "Alpha",
            workspace: "/ws/alpha",
            extensions: { acme: { apiKey: "$env:ACME_API_KEY" } },
          },
        ],
        pool: [],
      };
      const resolvedReloaded = {
        ...rawReloaded,
        agents: [
          {
            ...rawReloaded.agents[0],
            extensions: { acme: { apiKey: "secret-value" } },
          },
        ],
      };
      loadConfigValue = rawReloaded;
      reloadConfig.mockReturnValue(rawReloaded);
      resolveStartupConfig.mockResolvedValue(resolvedReloaded);
      updateAgentExtensionConfig.mockResolvedValue({});
      buildExtensionCatalog.mockResolvedValue(catalog);
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions/acme", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secrets: { apiKey: "secret-value" } }),
        })
      );

      expect(response.status).toBe(200);
      expect(setLoadedConfig).toHaveBeenCalledWith(resolvedReloaded);
      expect(reloadExtensions).toHaveBeenCalledWith(resolvedReloaded);
      expect(buildExtensionCatalog).toHaveBeenCalledWith(
        resolvedReloaded,
        resolvedReloaded.agents[0]
      );
    });

    it("passes config and secrets through to the writer", async () => {
      loadConfigValue = {
        agents: [{ id: "alpha", name: "Alpha", workspace: "/ws/alpha" }],
        pool: [],
      };
      updateAgentExtensionConfig.mockResolvedValue({});
      buildExtensionCatalog.mockResolvedValue(catalog);
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions/acme", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: true,
            config: { region: "eu" },
            secrets: { apiKey: "sk-1" },
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(updateAgentExtensionConfig).toHaveBeenCalledWith(
        "/ws/alpha",
        "acme",
        { enabled: true, config: { region: "eu" }, secrets: { apiKey: "sk-1" } },
        expect.any(Function)
      );
    });

    it("rejects writes when no fork exists for a pool agent", async () => {
      loadConfigValue = {
        agents: [],
        pool: [{ id: "poolie", name: "Poolie", workspace: "/ws/poolie" }],
      };
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/poolie/extensions/acme", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        })
      );

      expect(response.status).toBe(404);
      expect(updateAgentExtensionConfig).not.toHaveBeenCalled();
    });

    it("writes to an existing fork instead of the pool template", async () => {
      loadConfigValue = {
        agents: [{ id: "poolie", name: "Fork", workspace: "/ws/poolie-fork" }],
        pool: [{ id: "poolie", name: "Poolie", workspace: "/ws/poolie" }],
      };
      updateAgentExtensionConfig.mockResolvedValue({});
      buildExtensionCatalog.mockResolvedValue(catalog);
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/poolie/extensions/acme", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        })
      );

      expect(response.status).toBe(200);
      expect(updateAgentExtensionConfig).toHaveBeenCalledWith(
        "/ws/poolie-fork",
        "acme",
        { enabled: false },
        expect.any(Function)
      );
    });

    it("allows same-team members to write extension config", async () => {
      loadConfigValue = {
        agents: [{ id: "alpha", name: "Alpha", workspace: "/ws/alpha" }],
        pool: [],
      };
      multiUserState.loaded = true;
      multiUserState.agentAccess = true;
      multiUserState.authContext = {
        user: { id: "u1", role: "user" },
        session: { id: "s1", userId: "u1" },
      };
      updateAgentExtensionConfig.mockResolvedValue({});
      buildExtensionCatalog.mockResolvedValue(catalog);
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions/acme", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        })
      );

      expect(response.status).toBe(200);
      expect(updateAgentExtensionConfig).toHaveBeenCalledWith(
        "/ws/alpha",
        "acme",
        { enabled: true },
        expect.any(Function)
      );
    });

    it("403s when a non-member writes extension config", async () => {
      loadConfigValue = {
        agents: [{ id: "alpha", name: "Alpha", workspace: "/ws/alpha" }],
        pool: [],
      };
      multiUserState.loaded = true;
      multiUserState.agentAccess = false;
      multiUserState.authContext = {
        user: { id: "u1", role: "user" },
        session: { id: "s1", userId: "u1" },
      };
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions/acme", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        })
      );

      expect(response.status).toBe(403);
      expect(updateAgentExtensionConfig).not.toHaveBeenCalled();
    });

    it("404s for an unknown agent", async () => {
      loadConfigValue = { agents: [], pool: [] };
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/ghost/extensions/acme", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        })
      );

      expect(response.status).toBe(404);
      expect(updateAgentExtensionConfig).not.toHaveBeenCalled();
    });

    it("rejects toggling a factory extension", async () => {
      loadConfigValue = {
        agents: [{ id: "alpha", name: "Alpha", workspace: "/ws/alpha" }],
        pool: [],
      };
      resolveExtensionDefinition.mockResolvedValue({
        id: "cloudifi_admin",
        factory: true,
      });
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions/cloudifi_admin", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        })
      );

      expect(response.status).toBe(403);
      expect(updateAgentExtensionConfig).not.toHaveBeenCalled();
    });

    it("403s for non-members in multi-user mode (server-side guard)", async () => {
      loadConfigValue = {
        agents: [{ id: "alpha", name: "Alpha", workspace: "/ws/alpha" }],
        pool: [],
      };
      multiUserState.loaded = true;
      multiUserState.agentAccess = false;
      multiUserState.authContext = {
        user: { id: "u1", role: "user" },
        session: { id: "s1", userId: "u1" },
      };
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions/acme", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        })
      );

      expect(response.status).toBe(403);
      expect(updateAgentExtensionConfig).not.toHaveBeenCalled();
    });

    it("400s on a non-boolean enabled", async () => {
      loadConfigValue = {
        agents: [{ id: "alpha", name: "Alpha", workspace: "/ws/alpha" }],
        pool: [],
      };
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions/acme", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: "yes" }),
        })
      );

      expect(response.status).toBe(400);
      expect(updateAgentExtensionConfig).not.toHaveBeenCalled();
    });

    it("400s when the writer rejects (schema invalid)", async () => {
      loadConfigValue = {
        agents: [{ id: "alpha", name: "Alpha", workspace: "/ws/alpha" }],
        pool: [],
      };
      updateAgentExtensionConfig.mockRejectedValue(
        new Error("agent.yaml would be invalid after update")
      );
      const { api } = await import("./api.core.js");

      const response = await api.request(
        new Request("http://localhost/agents/alpha/extensions/acme", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        })
      );

      expect(response.status).toBe(400);
    });
  });
});
