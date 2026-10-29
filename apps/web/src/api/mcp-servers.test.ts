import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedMcpServers, fetchMcpServer, fetchMcpServers, fetchMcpServersFast, removeMcpServer, refreshMcpServerIcon, refreshMcpCatalogIcon } from "./mcp-servers";

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


it("refreshes a user server icon and updates its cached card without losing the list", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [{ name: "docs", iconUrl: "https://old.test/icon.png" }, { name: "notes" }], canConfigureTeam: false })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "updated", server: { name: "docs", iconUrl: "https://new.test/icon.png" } })));
  vi.stubGlobal("fetch", fetch);
  await fetchMcpServersFast("refresh agent");
  expect(await refreshMcpServerIcon("refresh agent", "docs / notes")).toEqual({ status: "updated", server: { name: "docs", iconUrl: "https://new.test/icon.png" } });
  expect(fetch.mock.calls[1]?.[0]).toBe("/api/mcp/servers/icon/refresh?agent=refresh%20agent&server=docs%20%2F%20notes");
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  expect(cachedMcpServers("refresh agent")?.servers).toEqual([{ name: "docs", iconUrl: "https://new.test/icon.png" }, { name: "notes" }]);
});


it("refreshes a catalog icon with an encoded name and returns every status", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "not_connected", server: { name: "docs / notes", url: "https://docs.test/mcp", iconUrl: "https://docs.test/favicon.ico" } })));
  vi.stubGlobal("fetch", fetch);
  expect(await refreshMcpCatalogIcon("docs / notes")).toEqual({ status: "not_connected", server: { name: "docs / notes", url: "https://docs.test/mcp", iconUrl: "https://docs.test/favicon.ico" } });
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/mcp/catalog/icon/refresh?server=docs%20%2F%20notes");
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
});


it.each([
  ["user", () => refreshMcpServerIcon("error-agent", "docs")],
  ["catalog", () => refreshMcpCatalogIcon("docs")],
])("reports the response text for a failed %s icon refresh", async (_kind, refresh) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Refresh denied", { status: 403 })));
  await expect(refresh()).rejects.toThrow("Refresh denied");
});

it("keeps a refreshed icon in the cache when an earlier live check finishes later", async () => {
  const old = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [{ name: "docs", iconUrl: "https://old.test/icon.png" }], canConfigureTeam: false })))
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "updated", server: { name: "docs", iconUrl: "https://new.test/icon.png" } }))));
  await fetchMcpServersFast("icon-race");
  const checking = fetchMcpServer("icon-race", "docs");
  await refreshMcpServerIcon("icon-race", "docs");
  old.resolve(new Response(JSON.stringify({ servers: [{ name: "docs", iconUrl: "https://old.test/icon.png" }] })));
  await checking;
  expect(cachedMcpServers("icon-race")?.servers[0]?.iconUrl).toBe("https://new.test/icon.png");
});
