import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedMcpServers, fetchMcpServer, fetchMcpServers, removeMcpServer } from "./mcp-servers";

afterEach(() => vi.unstubAllGlobals());

it("fetches only the requested server without replacing the agent's cached list", async () => {
  const all = { servers: [{ name: "webflow" }, { name: "docs" }], canConfigureTeam: true };
  const one = { servers: [{ name: "webflow" }], canConfigureTeam: true };
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(all))).mockResolvedValueOnce(new Response(JSON.stringify(one)));
  vi.stubGlobal("fetch", fetch);
  await fetchMcpServers("cache-isolation");

  expect(await fetchMcpServer("cache-isolation", "webflow")).toEqual(one);
  expect(fetch.mock.calls[1]?.[0]).toBe("/api/mcp/servers?agent=cache-isolation&server=webflow");
  expect(cachedMcpServers("cache-isolation")?.servers.map((server) => server.name)).toEqual(["webflow", "docs"]);
});

describe("removeMcpServer", () => {
  it("explains that only admins can remove on 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Team configuration is unavailable", { status: 403 })));
    await expect(removeMcpServer("scribe", "docs")).rejects.toThrow("Only admins can remove this MCP server.");
  });

  it("keeps the generic message for other failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    await expect(removeMcpServer("scribe", "docs")).rejects.toThrow("Failed to remove MCP server.");
  });
});
