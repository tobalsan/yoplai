import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGateways, relayPrefix } from "../remote-gateway.fixture";
import { disconnectOAuth, fetchOAuthStatus, readOAuthStatus, startRemoteOAuth } from "./oauth";
import { fetchAgentExtensions, patchAgentExtension, removeTeamExtensionCredentials, fetchOAuthScopeState } from "./extensions";
import { disconnectAgentConnection, disconnectMcpConnection, fetchAgentConnections, fetchAgentMcpConnections } from "./connections";
import { addMcpServer, cachedMcpServers, disconnectMcpServer, fetchMcpServer, fetchMcpServerConfig, fetchMcpServers, fetchMcpServersFast, refreshMcpServerIcon, removeMcpServer, saveMcpServerConfig, saveMcpServerLabel, setSharedMcpServer } from "./mcp-servers";
import { deleteSchedule, fetchScheduleAlerts, fetchScheduleRuns, fetchScheduleRunTrace, fetchSchedules, updateSchedule } from "./schedules";
import { fetchWebhooks, updateWebhook } from "./webhooks";
import { claimDashboard, deleteDashboard, fetchDashboardRecipients, fetchDashboards, saveDashboardShares, setDashboardPinned } from "./dashboards";
import { fetchAgentDashboards } from "./agents";
import { fetchForks, fetchTeams, setForkTeams, setForkVisibility } from "./teams";
import { fetchTopExtensions } from "./top-extensions";

const east = relayPrefix("east");
let gateways: ReturnType<typeof createFakeGateways>;

beforeEach(() => {
  gateways = createFakeGateways();
  gateways.on("GET", /.*/, { json: { servers: [], extensions: [], connections: [], runs: [], users: [], owned: [], shared: [], forks: [], actions: [], teams: [], state: "disconnected", connected: false } });
  gateways.on("POST", /.*/, { json: { ok: true, server: { name: "docs" }, dashboard: {}, status: "unchanged" } });
  gateways.on("PUT", /.*/, { json: { ok: true, pinned: true, fork: {} } });
  gateways.on("PATCH", /.*/, { json: { ok: true, extensions: [], dashboard: {}, fork: {} } });
  gateways.on("DELETE", /.*/, { json: { ok: true, extensions: [] } });
  vi.stubGlobal("fetch", gateways.fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const urls = () => gateways.requests.map((request) => `${request.method} ${request.url}`);

describe("remote configuration calls", () => {
  it("sends every agent-scoped call of a remote agent through its relay prefix with the qualified ID", async () => {
    const agent = "assistant@east";
    const q = "assistant%40east";
    await fetchAgentExtensions(agent, "east");
    await patchAgentExtension(agent, "exa", { enabled: true }, "east");
    await removeTeamExtensionCredentials(agent, "exa", "east");
    await fetchAgentConnections(agent, "east");
    await disconnectAgentConnection(agent, "oauth", "google", "east");
    await fetchWebhooks(agent, "east");
    await updateWebhook(agent, "hook", { enabled: false }, "east");
    await fetchAgentDashboards(agent, "east");
    await fetchSchedules(agent, "east");
    await updateSchedule(agent, "job", { enabled: true }, "east");
    await deleteSchedule(agent, "job", "east");
    await fetchScheduleRuns(agent, "job", "east");
    await fetchScheduleRunTrace(agent, "job", "run", "east");
    await fetchOAuthStatus(agent, "google", "team", "east");
    await disconnectOAuth(agent, "google", "personal", "east");
    expect(urls()).toEqual([
      `GET ${east}/api/agents/${q}/extensions`,
      `PATCH ${east}/api/agents/${q}/extensions/exa`,
      `DELETE ${east}/api/agents/${q}/extensions/exa/credentials`,
      `GET ${east}/api/agents/${q}/connections`,
      `DELETE ${east}/api/agents/${q}/connections/oauth/google`,
      `GET ${east}/api/agents/${q}/webhooks`,
      `PATCH ${east}/api/agents/${q}/webhooks/hook`,
      `GET ${east}/api/agents/${q}/dashboards`,
      `GET ${east}/api/schedules?agent=${q}`,
      `PATCH ${east}/api/schedules/${q}/job`,
      `DELETE ${east}/api/schedules/${q}/job`,
      `GET ${east}/api/schedules/${q}/job/runs`,
      `GET ${east}/api/schedules/${q}/job/runs/run/trace`,
      `GET ${east}/api/oauth/google/status?agent=${q}&scope=team`,
      `POST ${east}/api/oauth/google/disconnect?agent=${q}&scope=personal`,
    ]);
    expect(gateways.unexpected).toEqual([]);
  });

  it("keeps the local call shapes when no gateway is named", async () => {
    await fetchAgentExtensions("assistant");
    await fetchSchedules("assistant");
    await fetchOAuthStatus("assistant", "google", "team");
    await fetchDashboards();
    expect(urls()).toEqual([
      "GET /api/agents/assistant/extensions",
      "GET /api/schedules?agent=assistant",
      "GET /api/oauth/google/status?agent=assistant&scope=team",
      "GET /api/dashboards",
    ]);
  });

  it("sends every MCP call of a remote agent through its relay prefix and keeps server names unchanged", async () => {
    const q = "assistant%40east";
    const name = "my server/é";
    const n = encodeURIComponent(name);
    await fetchMcpServers("assistant@east", "east");
    await fetchMcpServersFast("assistant@east", name, "east");
    await fetchMcpServer("assistant@east", name, "east");
    await refreshMcpServerIcon("assistant@east", name, "east");
    await removeMcpServer("assistant@east", name, "east");
    await disconnectMcpServer("assistant@east", name, "team", "east");
    await fetchMcpServerConfig("assistant@east", name, "east");
    await saveMcpServerConfig("assistant@east", name, { url: "https://x.test" }, "east");
    await setSharedMcpServer("assistant@east", name, true, "east");
    await saveMcpServerLabel("assistant@east", name, { displayName: "D", description: "E" }, "east");
    await disconnectMcpConnection("assistant@east", name, "east");
    await fetchAgentMcpConnections("assistant@east", true, "east");
    expect(urls()).toEqual([
      `GET ${east}/api/mcp/servers?agent=${q}`,
      `GET ${east}/api/mcp/servers?agent=${q}&live=0&server=${n}`,
      `GET ${east}/api/mcp/servers?agent=${q}&server=${n}`,
      `POST ${east}/api/mcp/servers/icon/refresh?agent=${q}&server=${n}`,
      `POST ${east}/api/mcp/servers/remove?agent=${q}&server=${n}`,
      `POST ${east}/api/mcp/oauth/disconnect?agent=${q}&server=${n}&scope=team`,
      `GET ${east}/api/mcp/servers/config?agent=${q}&server=${n}`,
      `POST ${east}/api/mcp/servers/config?agent=${q}&server=${n}`,
      `POST ${east}/api/mcp/servers/shared?agent=${q}&server=${n}`,
      `POST ${east}/api/mcp/servers/label?agent=${q}&server=${n}`,
      `POST ${east}/api/mcp/oauth/disconnect?agent=${q}&server=${n}&scope=personal`,
      `GET ${east}/api/mcp/oauth/status?agent=${q}&scope=team`,
      `GET ${east}/api/mcp/oauth/status?agent=${q}&scope=personal`,
      `GET ${east}/api/mcp/servers?agent=${q}&live=0`,
    ]);
    expect(gateways.unexpected).toEqual([]);
    expect(gateways.requests.every((request) => request.url.startsWith(`${east}/api/mcp/`))).toBe(true);
  });

  it("keeps the MCP list of equal agent IDs on two gateways apart", async () => {
    gateways.on("GET", `${east}/api/mcp/servers?agent=assistant`, { json: { servers: [{ name: "east-only" }], canConfigureTeam: true } });
    gateways.on("GET", `${relayPrefix("west")}/api/mcp/servers?agent=assistant`, { json: { servers: [{ name: "west-only" }], canConfigureTeam: false } });
    gateways.on("GET", "/api/mcp/servers?agent=assistant", { json: { servers: [{ name: "local-only" }], canConfigureTeam: true } });
    await fetchMcpServers("assistant", "east");
    await fetchMcpServers("assistant", "west");
    await fetchMcpServers("assistant");
    expect(cachedMcpServers("assistant", "east")?.servers[0].name).toBe("east-only");
    expect(cachedMcpServers("assistant", "west")?.servers[0].name).toBe("west-only");
    expect(cachedMcpServers("assistant")?.servers[0].name).toBe("local-only");
  });

  it("sends no return path with a remote MCP add and keeps it for a local add", async () => {
    await addMcpServer("assistant@east", "https://docs.test/mcp", "team", "/agents/assistant@east/edit", "east");
    await addMcpServer("assistant", "https://docs.test/mcp", "personal", "/agents/assistant/edit");
    expect(gateways.requests[0]).toMatchObject({ method: "POST", url: `${east}/api/mcp/servers?agent=assistant%40east`, body: { url: "https://docs.test/mcp", credentialScope: "team" } });
    expect(gateways.requests[0].body).not.toHaveProperty("returnTo");
    expect(gateways.requests[1].body).toMatchObject({ returnTo: "/agents/assistant/edit" });
  });

  it("sends the global dashboard, team, and top-extension calls through the named gateway", async () => {
    await fetchDashboards("east");
    await fetchDashboardRecipients("east");
    await setDashboardPinned("d/1", true, "east");
    await setDashboardPinned("d/1", false, "east");
    await saveDashboardShares("d/1", [{ kind: "all", mode: "read" }], "east");
    await claimDashboard("d/1", "east");
    await deleteDashboard("d/1", "east");
    await fetchTeams("east");
    await fetchForks("east");
    await setForkTeams("agent-1", { mode: "list", teamIds: ["t"] }, "east");
    await setForkVisibility("agent-1", true, "east");
    await fetchTopExtensions("east");
    await fetchScheduleAlerts("east");
    expect(urls()).toEqual([
      `GET ${east}/api/dashboards`,
      `GET ${east}/api/dashboards/recipients`,
      `PUT ${east}/api/dashboards/d%2F1/pin`,
      `DELETE ${east}/api/dashboards/d%2F1/pin`,
      `PATCH ${east}/api/dashboards/d%2F1/sharing`,
      `POST ${east}/api/dashboards/d%2F1/claim`,
      `DELETE ${east}/api/dashboards/d%2F1`,
      `GET ${east}/api/teams`,
      `GET ${east}/api/admin/forks`,
      `PUT ${east}/api/admin/forks/agent-1/teams`,
      `PATCH ${east}/api/admin/forks/agent-1/visibility`,
      `GET ${east}/api/top-extensions`,
      `GET ${east}/api/schedule-alerts`,
    ]);
  });

  it("starts a remote grant with one strict JSON request and returns only the provider address", async () => {
    gateways.on("POST", "/api/relay/oauth/start", { json: { authorizationUrl: "https://provider.example.test/authorize?state=s" } });
    const url = await startRemoteOAuth("east", "assistant@east", "team", { kind: "core", provider: "google", scopes: ["email"] });
    expect(url).toBe("https://provider.example.test/authorize?state=s");
    expect(gateways.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/relay/oauth/start",
      headers: { "content-type": "application/json" },
      body: { gateway: "east", agentId: "assistant@east", scope: "team", kind: "core", provider: "google", scopes: ["email"] },
    });
    await startRemoteOAuth("east", "assistant@east", "personal", { kind: "mcp", server: "docs" });
    expect(gateways.requests[1].body).toEqual({ gateway: "east", agentId: "assistant@east", scope: "personal", kind: "mcp", server: "docs" });
  });

  it("names the refusal of a remote start without exposing the remote body", async () => {
    gateways.on("POST", "/api/relay/oauth/start", { status: 403, json: { error: "remote_oauth_denied", secret: "never shown" } });
    await expect(startRemoteOAuth("east", "a@east", "team", { kind: "core", provider: "google" })).rejects.toThrow("The remote gateway refused this action.");
    gateways.on("POST", "/api/relay/oauth/start", { status: 502, json: { error: "gateway_offline" } });
    await expect(startRemoteOAuth("east", "a@east", "team", { kind: "core", provider: "google" })).rejects.toThrow("The remote gateway is offline.");
    gateways.on("POST", "/api/relay/oauth/start", { json: { nothing: true } });
    await expect(startRemoteOAuth("east", "a@east", "team", { kind: "core", provider: "google" })).rejects.toThrow("no authorization address");
  });

  it("keeps a failed remote status read apart from a disconnected grant, and shows a remote disconnect refusal", async () => {
    gateways.on("GET", `${east}/api/oauth/google/status?agent=a%40east&scope=team`, { status: 403, json: { error: "forbidden" } });
    await expect(readOAuthStatus("a@east", "google", "team", "east")).rejects.toThrow();
    // The old reader reads a refusal as disconnected. A remote page never relies on it.
    expect(await fetchOAuthScopeState("a@east", "google", "team", "east")).toBe("disconnected");
    gateways.on("POST", `${east}/api/oauth/google/disconnect?agent=a%40east&scope=team`, { status: 403, json: { error: "forbidden" } });
    await expect(disconnectOAuth("a@east", "google", "team", "east")).rejects.toThrow("The remote gateway refused this action.");
  });
});
