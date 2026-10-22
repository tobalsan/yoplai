import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedMcpServers, fetchMcpServer, fetchMcpServers, fetchMcpServersFast, removeMcpServer } from "./mcp-servers";

afterEach(() => vi.unstubAllGlobals());

it("loads configuration without live checks and merges a later status into the full cached list", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [{ name: "docs", title: "Docs", status: "pending" }, { name: "notes" }], canConfigureTeam: false })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [{ name: "docs", title: "Live Docs", state: "connected" }], canConfigureTeam: false })));
  vi.stubGlobal("fetch", fetch);
  expect((await fetchMcpServersFast("fast agent")).servers[0]?.title).toBe("Docs");
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/mcp/servers?agent=fast%20agent&live=0");
  await fetchMcpServer("fast agent", "docs");
  expect(cachedMcpServers("fast agent")?.servers).toEqual([{ name: "docs", title: "Live Docs", state: "connected" }, { name: "notes" }]);
});

it("keeps the newest status in the cache when an older request finishes later", async () => {
  const old = Promise.withResolvers<Response>();
  const recent = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [{ name: "docs" }], canConfigureTeam: true })))
    .mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise));
  await fetchMcpServersFast("overlap");
  const first = fetchMcpServer("overlap", "docs");
  const second = fetchMcpServer("overlap", "docs");
  recent.resolve(new Response(JSON.stringify({ servers: [{ name: "docs", state: "connected" }] })));
  await second;
  old.resolve(new Response(JSON.stringify({ servers: [{ name: "docs", state: "unreachable" }] })));
  await first;
  expect(cachedMcpServers("overlap")?.servers).toEqual([{ name: "docs", state: "connected" }]);
});

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
