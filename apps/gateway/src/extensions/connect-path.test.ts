import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Extension, GatewayConfig } from "@yoplai/shared";

const loaded = vi.hoisted(() => ({ extensions: [] as Extension[] }));
vi.mock("./registry.js", async (original) => ({
  ...await original<typeof import("./registry.js")>(),
  getLoadedExtensions: () => loaded.extensions,
}));
import { createExtensionContext } from "./context.js";

function extension(overrides: Partial<Extension>): Extension {
  return {
    id: "invented-mail", displayName: "Invented Mail", description: "Fixture", dependencies: [],
    configSchema: z.object({}), routePrefixes: [], validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes() {}, start: async () => {}, stop: async () => {}, capabilities: () => [],
    getDiscoveryTools: async () => [{ name: "mail_search", description: "Search", parameters: {}, execute: async () => ({}) }],
    ...overrides,
  };
}
const context = () => createExtensionContext({} as GatewayConfig);

describe("host reconnect paths", () => {
  it("routes an OAuth extension tool to its agent connect card", async () => {
    loaded.extensions = [extension({ oauth: { provider: "invented", scopes: [] } })];
    await expect(context().resolveConnectPath!("atlas", { toolName: "mail_search" })).resolves.toBe("/agents/atlas/extensions/invented-mail");
  });
  it("routes a token extension tool to its config card", async () => {
    loaded.extensions = [extension({})];
    await expect(context().resolveConnectPath!("atlas", { toolName: "mail_search" })).resolves.toBe("/agents/atlas/extensions/invented-mail/config");
  });

  it("honors an extension-owned config route and encodes the agent id", async () => {
    loaded.extensions = [extension({ oauth: { provider: "invented", scopes: [] }, configRoute: { path: "/agents/:agentId/mail-settings" } })];
    await expect(context().resolveConnectPath!("atlas / north", { toolName: "mail_search" })).resolves.toBe("/agents/atlas%20%2F%20north/mail-settings");
  });

  it("routes MCP tool refusals to that server connect card", async () => {
    loaded.extensions = [];
    await expect(context().resolveConnectPath!("atlas", { toolName: "mcp__invented-mail__search", provider: "mcp" })).resolves.toBe("/agents/atlas/mcp-servers/invented-mail");
  });

  it("matches the sanitized name emitted by Pi for dotted extension tools", async () => {
    loaded.extensions = [extension({
      getDiscoveryTools: async () => [{ name: "mail.search", description: "Search", parameters: {}, execute: async () => ({}) }],
    })];
    await expect(context().resolveConnectPath!("atlas", { toolName: "mail_search" })).resolves.toBe("/agents/atlas/extensions/invented-mail/config");
  });

  it("uses provider hints when tools cannot be discovered", async () => {
    loaded.extensions = [extension({ oauth: { provider: "invented", scopes: [] }, getDiscoveryTools: async () => { throw new Error("not configured"); } })];
    await expect(context().resolveConnectPath!("atlas", { toolName: "unknown_search", provider: "invented" })).resolves.toBe("/agents/atlas/extensions/invented-mail");
  });

  it("uses a refusal display name when the extension exposes no tools", async () => {
    loaded.extensions = [extension({ getDiscoveryTools: undefined })];
    await expect(context().resolveConnectPath!("atlas", { toolName: "unknown_search", displayName: "Invented Mail" })).resolves.toBe("/agents/atlas/extensions/invented-mail/config");
  });

  it("leaves an unknown tool for the scheduler connections-page fallback", async () => {
    loaded.extensions = [extension({})];
    await expect(context().resolveConnectPath!("atlas", { toolName: "unknown_search" })).resolves.toBeUndefined();
  });

});
