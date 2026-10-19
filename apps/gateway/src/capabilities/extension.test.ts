import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAgentTool } from "@yoplai/shared";
import { createAccessResolver } from "../../../../packages/extensions/multi-user/src/access.js";
import { ASSIGNMENTS_TO_TEAMS_MIGRATION, initializeMultiUserDatabase, migrateAssignmentsToTeams } from "../../../../packages/extensions/multi-user/src/db.js";
import { createForkStore } from "../../../../packages/extensions/multi-user/src/forks.js";
import { createMembershipStore } from "../../../../packages/extensions/multi-user/src/membership.js";
import { setMultiUserRuntime, type MultiUserRuntime } from "../../../../packages/extensions/multi-user/src/runtime-state.js";

const loadCapabilityCatalog = vi.fn();
const readMcpServerSources = vi.fn();
const updateAgentExtensionConfig = vi.fn();
const mergeMcpServerConfig = vi.fn();
const reloadExtensions = vi.fn();
const logInfo = vi.fn();
const getSessionHistory = vi.fn();
let multiUserEnabled = false;

vi.mock("./catalog.js", () => ({
  loadCapabilityCatalog,
  readMcpServerSources,
}));
vi.mock("./mcp-config.js", () => ({ mergeMcpServerConfig }));
vi.mock("../extensions/agent-config-writer.js", () => ({
  updateAgentExtensionConfig,
}));
vi.mock("../config/index.js", () => ({
  resolveWorkspaceDir: (workspace: string) => workspace,
  reloadConfig: () => config,
  setLoadedConfig: vi.fn(),
}));
vi.mock("../config/validate.js", () => ({
  resolveStartupConfig: async () => config,
}));
vi.mock("../extensions/registry.js", () => ({
  isExtensionLoaded: () => multiUserEnabled,
  reloadExtensions,
}));
vi.mock("../logging.js", () => ({ logInfo }));
vi.mock("../agents/index.js", () => ({ getSessionHistory }));

const config = {
  agents: [{ id: "support", workspace: "/tmp/support", extensions: {} }],
  pool: [],
};
const context = {
  agent: config.agents[0],
  config,
  sessionId: "session",
  userId: "user",
};

function tool(name: string, agent = config.agents[0]) {
  return (
    capabilityDiscoveryExtension.getAgentTools!(
      agent as never
    ) as ExtensionAgentTool[]
  ).find((candidate) => candidate.name === name)!;
}

const { capabilityDiscoveryExtension } = await import("./extension.js");

describe("capability discovery tools", () => {
  it("lists the catalog and emits one structured dead-end log", async () => {
    loadCapabilityCatalog.mockResolvedValue([
      {
        id: "sheets",
        displayName: "Sheets",
        description: "Edit spreadsheets.",
        kind: "extension",
        tools: [{ name: "sheets.write", description: "Write a cell." }],
        enableTier: "self-enable",
        settingsPath: "/agents/support/extensions/sheets/config",
        enabledOnAgents: [],
        enabled: false,
      },
    ]);

    await expect(
      tool("capabilities.list").execute(
        { need: "write a spreadsheet" },
        context as never
      )
    ).resolves.toHaveLength(1);
    expect(logInfo).toHaveBeenCalledWith(
      "missing_capability_lookup",
      expect.objectContaining({
        agentId: "support",
        need: "write a spreadsheet",
        outcome: "self-enable",
      })
    );
  });

  it("refuses secret-bearing capabilities without touching configuration", async () => {
    loadCapabilityCatalog.mockResolvedValue([
      {
        id: "zendesk",
        displayName: "Zendesk",
        description: "Search tickets.",
        kind: "extension",
        tools: [],
        enableTier: "settings-page",
        settingsPath: "/agents/support/extensions/zendesk/config",
        enabledOnAgents: [],
        enabled: false,
        requiredSecrets: ["apiKey"],
      },
    ]);

    await expect(
      tool("capabilities.enable").execute(
        { id: "zendesk", kind: "extension" },
        context as never
      )
    ).resolves.toEqual({
      outcome: "refused",
      reason: "This capability requires settings configured by an admin.",
      settingsPath: "/agents/support/extensions/zendesk/config",
      requiredSecrets: ["apiKey"],
    });
    expect(updateAgentExtensionConfig).not.toHaveBeenCalled();
  });

  it("requires a later user confirmation before self-enabling", async () => {
    loadCapabilityCatalog.mockResolvedValue([
      {
        id: "sheets",
        displayName: "Sheets",
        description: "Edit spreadsheets.",
        kind: "extension",
        tools: [],
        enableTier: "self-enable",
        settingsPath: "/agents/support/extensions/sheets/config",
        enabledOnAgents: [],
        enabled: false,
      },
    ]);

    await expect(
      tool("capabilities.enable").execute(
        { id: "sheets", kind: "extension" },
        context as never
      )
    ).resolves.toMatchObject({ outcome: "refused" });
    expect(updateAgentExtensionConfig).not.toHaveBeenCalled();
  });

  it("arms every self-enable capability on list, not just the top-3 matches, so a later yes enables it", async () => {
    const topMatchesContext = { ...context, sessionId: "session-top3" };
    loadCapabilityCatalog.mockResolvedValue([
      {
        id: "sheets",
        displayName: "Sheets",
        description: "Edit spreadsheets.",
        kind: "extension",
        tools: [],
        enableTier: "self-enable",
        settingsPath: "/agents/support/extensions/sheets/config",
        enabledOnAgents: [],
        enabled: false,
      },
      {
        id: "calendar",
        displayName: "Calendar",
        description: "Create events.",
        kind: "extension",
        tools: [],
        enableTier: "self-enable",
        settingsPath: "/agents/support/extensions/calendar/config",
        enabledOnAgents: [],
        enabled: false,
      },
    ]);
    // "spreadsheet" only matches "sheets" in topMatches; "calendar" is not
    // one of the top-3 matches for this need.
    await tool("capabilities.list").execute(
      { need: "spreadsheet" },
      topMatchesContext as never
    );
    getSessionHistory.mockResolvedValue([
      { role: "user", content: "yes", timestamp: Date.now() + 1 },
    ]);

    await expect(
      tool("capabilities.enable").execute(
        { id: "calendar", kind: "extension" },
        topMatchesContext as never
      )
    ).resolves.toMatchObject({ outcome: "enabled" });
    expect(updateAgentExtensionConfig).toHaveBeenCalledWith(
      "/tmp/support",
      "calendar",
      { enabled: true }
    );
  });

  it("accepts confirmation in the message that triggered the list, when it names the capability", async () => {
    const triggerContext = { ...context, sessionId: "session-trigger" };
    loadCapabilityCatalog.mockResolvedValue([
      {
        id: "mcp:claap",
        displayName: "Claap",
        description: "Meeting notes and recordings.",
        kind: "mcp-server",
        tools: [],
        enableTier: "self-enable",
        settingsPath: "/agents/support/edit",
        enabledOnAgents: [],
        enabled: false,
      },
    ]);
    readMcpServerSources.mockResolvedValue([
      { agentId: "support", name: "claap", config: { command: "claap-mcp" } },
    ]);
    // The message that triggered the list is also the latest user message
    // (no later one exists), and it names the capability explicitly.
    getSessionHistory.mockResolvedValue([
      {
        role: "user",
        content: "Yes, enable claap for meeting notes",
        timestamp: Date.now() - 1_000,
      },
    ]);

    await tool("capabilities.list").execute(
      { need: "meeting notes" },
      triggerContext as never
    );

    await expect(
      tool("capabilities.enable").execute(
        { id: "mcp:claap", kind: "mcp-server" },
        triggerContext as never
      )
    ).resolves.toMatchObject({ outcome: "enabled" });
  });

  it("refuses enable when capabilities.list has never been called in this session", async () => {
    const noListContext = { ...context, sessionId: "session-no-list" };
    loadCapabilityCatalog.mockResolvedValue([
      {
        id: "sheets",
        displayName: "Sheets",
        description: "Edit spreadsheets.",
        kind: "extension",
        tools: [],
        enableTier: "self-enable",
        settingsPath: "/agents/support/extensions/sheets/config",
        enabledOnAgents: [],
        enabled: false,
      },
    ]);
    getSessionHistory.mockResolvedValue([
      { role: "user", content: "yes, enable sheets", timestamp: Date.now() },
    ]);
    const callsBefore = updateAgentExtensionConfig.mock.calls.length;

    await expect(
      tool("capabilities.enable").execute(
        { id: "sheets", kind: "extension" },
        noListContext as never
      )
    ).resolves.toMatchObject({ outcome: "refused" });
    expect(updateAgentExtensionConfig.mock.calls.length).toBe(callsBefore);
  });

  it("refuses a triggering-message yes that names a different capability", async () => {
    const wrongNameContext = { ...context, sessionId: "session-wrong-name" };
    loadCapabilityCatalog.mockResolvedValue([
      {
        id: "mcp:claap",
        displayName: "Claap",
        description: "Meeting notes and recordings.",
        kind: "mcp-server",
        tools: [],
        enableTier: "self-enable",
        settingsPath: "/agents/support/edit",
        enabledOnAgents: [],
        enabled: false,
      },
    ]);
    getSessionHistory.mockResolvedValue([
      {
        role: "user",
        content: "yes, enable notion",
        timestamp: Date.now() - 1_000,
      },
    ]);

    await tool("capabilities.list").execute(
      { need: "meeting notes" },
      wrongNameContext as never
    );
    const callsBefore = updateAgentExtensionConfig.mock.calls.length;

    await expect(
      tool("capabilities.enable").execute(
        { id: "mcp:claap", kind: "mcp-server" },
        wrongNameContext as never
      )
    ).resolves.toMatchObject({ outcome: "refused" });
    expect(updateAgentExtensionConfig.mock.calls.length).toBe(callsBefore);
  });

  it("enables a confirmed self-enable extension and reloads it live", async () => {
    loadCapabilityCatalog.mockResolvedValue([
      {
        id: "sheets",
        displayName: "Sheets",
        description: "Edit spreadsheets.",
        kind: "extension",
        tools: [],
        enableTier: "self-enable",
        settingsPath: "/agents/support/extensions/sheets/config",
        enabledOnAgents: [],
        enabled: false,
        connectPath: "/agents/support/extensions/sheets",
      },
    ]);
    await tool("capabilities.list").execute(
      { need: "spreadsheet" },
      context as never
    );
    getSessionHistory.mockResolvedValue([
      { role: "user", content: "yes, enable it", timestamp: Date.now() + 1 },
    ]);

    await expect(
      tool("capabilities.enable").execute(
        { id: "sheets", kind: "extension" },
        context as never
      )
    ).resolves.toMatchObject({
      outcome: "enabled",
      connectPath: "/agents/support/extensions/sheets",
    });
    expect(updateAgentExtensionConfig).toHaveBeenCalledWith(
      "/tmp/support",
      "sheets",
      { enabled: true }
    );
    expect(reloadExtensions).toHaveBeenCalledWith(config);
    expect(logInfo).toHaveBeenCalledWith(
      "capability_enable",
      expect.objectContaining({
        agentId: "support",
        userId: "user",
        capabilityId: "sheets",
        kind: "extension",
        outcome: "enabled",
      })
    );
  });

  it("attaches a confirmed MCP server already enabled on another agent", async () => {
    loadCapabilityCatalog.mockResolvedValue([
      {
        id: "mcp:sheets",
        displayName: "Sheets",
        description: "MCP server",
        kind: "mcp-server",
        tools: [],
        enableTier: "self-enable",
        settingsPath: "/agents/support/edit",
        enabledOnAgents: ["casey"],
        enabled: false,
      },
    ]);
    readMcpServerSources.mockResolvedValue([
      { agentId: "casey", name: "sheets", config: { command: "sheets-mcp" } },
    ]);
    await tool("capabilities.list").execute(
      { need: "sheets" },
      context as never
    );
    getSessionHistory.mockResolvedValue([
      { role: "user", content: "go ahead", timestamp: Date.now() + 1 },
    ]);

    await expect(
      tool("capabilities.enable").execute(
        { id: "mcp:sheets", kind: "mcp-server" },
        context as never
      )
    ).resolves.toMatchObject({ outcome: "enabled" });

    expect(mergeMcpServerConfig).toHaveBeenCalledWith(
      "/tmp/support",
      "sheets",
      { command: "sheets-mcp" }
    );
    expect(updateAgentExtensionConfig).toHaveBeenCalledWith(
      "/tmp/support",
      "mcp",
      { enabled: true }
    );
    expect(reloadExtensions).toHaveBeenCalledWith(config);
  });

  it("logs a capability_enable outcome for a refused enable too", async () => {
    loadCapabilityCatalog.mockResolvedValue([
      {
        id: "zendesk",
        displayName: "Zendesk",
        description: "Search tickets.",
        kind: "extension",
        tools: [],
        enableTier: "settings-page",
        settingsPath: "/agents/support/extensions/zendesk/config",
        enabledOnAgents: [],
        enabled: false,
        requiredSecrets: ["apiKey"],
      },
    ]);

    await tool("capabilities.enable").execute(
      { id: "zendesk", kind: "extension" },
      context as never
    );

    expect(logInfo).toHaveBeenCalledWith(
      "capability_enable",
      expect.objectContaining({
        capabilityId: "zendesk",
        kind: "extension",
        outcome: "refused",
      })
    );
  });

  it("scores matches on id/displayName/description/tools and excludes an unrelated capability", async () => {
    loadCapabilityCatalog.mockResolvedValue([
      {
        id: "googleDrive",
        displayName: "Google Drive",
        description: "Read and organize files in Google Drive, including Docs and Sheets.",
        kind: "extension",
        tools: [
          {
            name: "googleDrive.readDoc",
            description: "Read a Google Doc's content and headings.",
          },
        ],
        enableTier: "self-enable",
        settingsPath: "/agents/support/extensions/googleDrive/config",
        enabledOnAgents: [],
        enabled: false,
      },
      {
        id: "gsheets",
        displayName: "Google Sheets",
        description: "Edit spreadsheets.",
        kind: "extension",
        tools: [],
        enableTier: "self-enable",
        settingsPath: "/agents/support/extensions/gsheets/config",
        enabledOnAgents: [],
        enabled: false,
      },
      {
        id: "discord",
        displayName: "Discord",
        description: "Send and read chat messages in Discord channels.",
        kind: "extension",
        tools: [
          { name: "discord.listChannels", description: "List channels." },
        ],
        enableTier: "self-enable",
        settingsPath: "/agents/support/extensions/discord/config",
        enabledOnAgents: [],
        enabled: false,
      },
    ]);

    await tool("capabilities.list").execute(
      {
        need: "Read a Google Doc from Google Drive and list its section headings",
      },
      { ...context, sessionId: "session-topmatches" } as never
    );

    expect(logInfo).toHaveBeenCalledWith(
      "missing_capability_lookup",
      expect.objectContaining({
        matchedCapabilityIds: expect.not.arrayContaining(["discord"]),
      })
    );
  });
});

describe("multi-user capability self-enable", () => {
  let db: ReturnType<typeof initializeMultiUserDatabase>;
  let fixtureDir: string;
  let poolAgentIds: string[];

  beforeEach(() => {
    multiUserEnabled = true;
    fixtureDir = fs.mkdtempSync(path.join(process.cwd(), ".capability-test-"));
    db = initializeMultiUserDatabase(path.join(fixtureDir, "auth.db"));
    db.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY, role TEXT);
      INSERT INTO user (id, role) VALUES ('user', 'user'), ('member', 'user');
      INSERT INTO agent_assignments (userId, agentId, assignedBy)
      VALUES ('member', 'legacy', 'member');
    `);
    db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(ASSIGNMENTS_TO_TEAMS_MIGRATION);
    migrateAssignmentsToTeams(db);
    const forks = createForkStore({
      db,
      getPoolAgent: () => null,
      getForksDir: () => { throw new Error("Fixture must not create forks on disk"); },
    });
    const membership = createMembershipStore(db);
    poolAgentIds = [];
    setMultiUserRuntime({
      db,
      forks,
      membership,
      access: createAccessResolver({ membership, forks }),
      getPoolAgentIds: () => poolAgentIds,
    } as MultiUserRuntime);
    updateAgentExtensionConfig.mockClear();
    reloadExtensions.mockClear();
    loadCapabilityCatalog.mockResolvedValue([
      {
        id: "sheets",
        displayName: "Sheets",
        description: "Edit spreadsheets.",
        kind: "extension",
        tools: [],
        enableTier: "self-enable",
        settingsPath: "/agents/support/extensions/sheets/config",
        enabledOnAgents: [],
        enabled: false,
      },
    ]);
    getSessionHistory.mockResolvedValue([
      { role: "user", content: "yes, enable sheets", timestamp: Date.now() - 1_000 },
    ]);
  });

  afterEach(() => {
    setMultiUserRuntime(null);
    multiUserEnabled = false;
    db.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("lets a user enable a capability on a no-pool plain agent", async () => {
    const plainContext = { ...context, sessionId: "no-pool-plain" };
    await tool("capabilities.list").execute(
      { need: "spreadsheet" },
      plainContext as never
    );

    await expect(
      tool("capabilities.enable").execute(
        { id: "sheets", kind: "extension" },
        plainContext as never
      )
    ).resolves.toEqual({
      outcome: "enabled",
      reason: "Capability enabled for this agent.",
    });
    expect(updateAgentExtensionConfig).toHaveBeenCalledTimes(1);
    expect(updateAgentExtensionConfig).toHaveBeenCalledWith(
      "/tmp/support", "sheets", { enabled: true }
    );
    expect(reloadExtensions).toHaveBeenCalledTimes(1);
    expect(reloadExtensions).toHaveBeenCalledWith(config);
  });

  it("refuses a no-pool Private legacy fork for a non-member", async () => {
    const legacyAgent = { ...config.agents[0], id: "legacy", workspace: "/tmp/legacy" };
    const legacyContext = {
      ...context,
      agent: legacyAgent,
      config: { ...config, agents: [config.agents[0], legacyAgent] },
      sessionId: "no-pool-restricted",
    };
    await tool("capabilities.list", legacyAgent).execute(
      { need: "spreadsheet" },
      legacyContext as never
    );

    await expect(
      tool("capabilities.enable", legacyAgent).execute(
        { id: "sheets", kind: "extension" },
        legacyContext as never
      )
    ).resolves.toEqual({
      outcome: "refused",
      reason: "You are not allowed to configure this agent.",
    });
    expect(updateAgentExtensionConfig).not.toHaveBeenCalled();
    expect(reloadExtensions).not.toHaveBeenCalled();
  });

  it("keeps refusing a pooled Private fork for a non-member", async () => {
    poolAgentIds.push("legacy");
    const legacyAgent = { ...config.agents[0], id: "legacy", workspace: "/tmp/legacy" };
    const pooledContext = {
      ...context,
      agent: legacyAgent,
      config: { ...config, agents: [config.agents[0], legacyAgent], pool: [legacyAgent] },
      sessionId: "pooled-restricted",
    };
    await tool("capabilities.list", legacyAgent).execute(
      { need: "spreadsheet" },
      pooledContext as never
    );

    await expect(
      tool("capabilities.enable", legacyAgent).execute(
        { id: "sheets", kind: "extension" },
        pooledContext as never
      )
    ).resolves.toEqual({
      outcome: "refused",
      reason: "You are not allowed to configure this agent.",
    });
    expect(updateAgentExtensionConfig).not.toHaveBeenCalled();
    expect(reloadExtensions).not.toHaveBeenCalled();
  });
});
