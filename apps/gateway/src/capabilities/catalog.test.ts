import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, Extension, GatewayConfig } from "@yoplai/shared";
import {
  buildCapabilityCatalog,
  listReachableMcpTools,
  resolveWebBaseUrl,
} from "./catalog.js";

const agent = (id: string, extensions: Record<string, unknown> = {}) =>
  ({ id, workspace: `/tmp/${id}`, extensions }) as AgentConfig;

function extension(overrides: Partial<Extension>): Extension {
  return {
    id: "calendar",
    displayName: "Calendar",
    description: "Create and update events.",
    dependencies: [],
    routePrefixes: [],
    configSchema: {} as Extension["configSchema"],
    validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes: () => {},
    start: async () => {},
    stop: async () => {},
    capabilities: () => [],
    getDiscoveryTools: () => [
      {
        name: "calendar.create",
        description: "Create an event.",
        parameters: {},
        execute: () => {},
      },
    ],
    ...overrides,
  };
}

describe("buildCapabilityCatalog", () => {
  it("lists tools without resolving secrets and excludes factory extensions", async () => {
    const catalog = await buildCapabilityCatalog({
      callingAgentId: "support",
      webBaseUrl: "https://cloudi-fi.example",
      agents: [
        agent("support"),
        agent("casey", { zendesk: { enabled: true } }),
      ],
      extensions: [
        extension({
          id: "zendesk",
          displayName: "Zendesk",
          requiredSecrets: ["apiKey"],
          getDiscoveryTools: () => [
            {
              name: "zendesk.search",
              description: "Search tickets.",
              parameters: {},
              execute: () => {},
            },
          ],
        }),
        extension({ id: "internal", factory: true }),
        extension({ id: "mcp" }),
        extension({
          id: "broken",
          getDiscoveryTools: () => {
            throw new Error("no config");
          },
        }),
        extension({
          id: "slack",
          getDiscoveryTools: undefined,
          getAgentTools: () => [
            {
              name: "slack.send",
              description: "Send a message.",
              parameters: {},
              execute: () => {},
            },
          ],
        }),
      ],
      mcpServers: [
        {
          agentId: "casey",
          name: "sheets",
          config: { command: "sheets-mcp" },
          tools: [{ name: "sheets.list", description: "List sheets." }],
        },
      ],
    });

    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "zendesk",
          enableTier: "settings-page",
          enabledOnAgents: ["casey"],
          requiredSecrets: ["apiKey"],
          tools: [{ name: "zendesk.search", description: "Search tickets." }],
          settingsUrl:
            "https://cloudi-fi.example/agents/support/extensions/zendesk/config",
        }),
        expect.objectContaining({
          id: "broken",
          tools: [],
          enableTier: "self-enable",
        }),
        expect.objectContaining({
          id: "mcp:sheets",
          kind: "mcp-server",
          enabledOnAgents: ["casey"],
          connection: { command: "sheets-mcp" },
          tools: [{ name: "sheets.list", description: "List sheets." }],
        }),
        expect.objectContaining({ id: "slack", enableTier: "settings-page" }),
      ])
    );
    expect(catalog.map((entry) => entry.id)).not.toContain("internal");
  });

  it("links OAuth without a bespoke route to extension details", async () => {
    const catalog = await buildCapabilityCatalog({
      callingAgentId: "support",
      webBaseUrl: "https://cloudi-fi.example",
      agents: [agent("support")],
      extensions: [
        extension({
          id: "gmail",
          oauth: { provider: "google", scopes: ["gmail.modify"] },
        }),
      ],
    });

    expect(catalog[0]).toMatchObject({
      settingsPath: "/agents/support/extensions/gmail/config",
      connectPath: "/agents/support/extensions/gmail",
      connectUrl: "https://cloudi-fi.example/agents/support/extensions/gmail",
    });
  });

  it("derives the MCP auth hint from server config shape", async () => {
    const catalog = await buildCapabilityCatalog({
      callingAgentId: "support",
      webBaseUrl: "https://cloudi-fi.example",
      agents: [agent("support")],
      extensions: [],
      mcpServers: [
        {
          agentId: "support",
          name: "oauth-server",
          config: { url: "https://mcp.example.test" },
        },
        {
          agentId: "support",
          name: "headers-server",
          config: {
            url: "https://mcp.example.test",
            headers: { Authorization: "Bearer token" },
          },
        },
        {
          agentId: "support",
          name: "command-server",
          config: { command: "some-mcp" },
        },
      ],
    });

    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mcp:oauth-server",
          auth: "oauth",
          connectPath: "/agents/support/edit",
          connectUrl: "https://cloudi-fi.example/agents/support/edit",
        }),
        expect.objectContaining({
          id: "mcp:headers-server",
          auth: "headers",
        }),
        expect.objectContaining({
          id: "mcp:command-server",
          auth: "none",
        }),
      ])
    );
    expect(
      catalog.find((entry) => entry.id === "mcp:headers-server")?.connectPath
    ).toBeUndefined();
    expect(
      catalog.find((entry) => entry.id === "mcp:command-server")?.connectPath
    ).toBeUndefined();
  });
});

describe("resolveWebBaseUrl", () => {
  it("uses server.baseUrl, stripped of a trailing slash", () => {
    expect(
      resolveWebBaseUrl({
        server: { baseUrl: "https://cloudi-fi.example/" },
      } as GatewayConfig)
    ).toBe("https://cloudi-fi.example");
  });

  it("falls back to http://localhost:<ui.port ?? 3000> when no baseUrl is set", () => {
    expect(resolveWebBaseUrl({} as GatewayConfig)).toBe(
      "http://localhost:3000"
    );
    expect(resolveWebBaseUrl({ ui: { port: 4100 } } as GatewayConfig)).toBe(
      "http://localhost:4100"
    );
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("listReachableMcpTools", () => {
  it("uses the Streamable HTTP initialization handshake", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: {} }), {
          headers: { "Mcp-Session-Id": "session-1" },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              tools: [{ name: "sheets.list", description: "List sheets." }],
            },
          })
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listReachableMcpTools({ url: "https://mcp.example.test" })
    ).resolves.toEqual([{ name: "sheets.list", description: "List sheets." }]);

    expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body as string)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(fetchMock.mock.calls[2]?.[1].headers).toMatchObject({
      "Mcp-Session-Id": "session-1",
    });
  });
});
