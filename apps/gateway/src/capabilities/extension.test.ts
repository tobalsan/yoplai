import { describe, expect, it, vi } from "vitest";
import type { ExtensionAgentTool } from "@yoplai/shared";

const loadCapabilityCatalog = vi.fn();
const readMcpServerSources = vi.fn();
const updateAgentExtensionConfig = vi.fn();
const mergeMcpServerConfig = vi.fn();
const reloadExtensions = vi.fn();
const logInfo = vi.fn();
const getSessionHistory = vi.fn();

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
  isExtensionLoaded: () => false,
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

function tool(name: string) {
  return (
    capabilityDiscoveryExtension.getAgentTools!(
      config.agents[0] as never
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

  it("limits confirmation to capabilities suggested for the stated need", async () => {
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
    await tool("capabilities.list").execute(
      { need: "spreadsheet" },
      context as never
    );
    getSessionHistory.mockResolvedValue([
      { role: "user", content: "yes", timestamp: Date.now() + 1 },
    ]);

    await expect(
      tool("capabilities.enable").execute(
        { id: "calendar", kind: "extension" },
        context as never
      )
    ).resolves.toMatchObject({ outcome: "refused" });
    expect(updateAgentExtensionConfig).not.toHaveBeenCalledWith(
      "/tmp/support",
      "calendar",
      { enabled: true }
    );
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
        settingsPath: "/agents/support/extensions/mcp",
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
});
