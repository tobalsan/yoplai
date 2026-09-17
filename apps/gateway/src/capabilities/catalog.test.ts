import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, Extension } from "@yoplai/shared";
import { buildCapabilityCatalog, listReachableMcpTools } from "./catalog.js";

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
