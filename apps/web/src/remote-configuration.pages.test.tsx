// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { render } from "solid-js/web";
import { Suspense, createRoot, type JSX } from "solid-js";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { createFakeGateways, createFakePopup, relayPrefix, type FakeAnswer } from "./remote-gateway.fixture";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "./lib/capabilities";
import { OAUTH_POLL_INTERVAL_MS } from "./lib/oauth-popup-flow";
import { refreshScheduleAlerts } from "./lib/schedule-alerts";
import { EditAgent } from "./pages/EditAgent";
import { Dashboards } from "./pages/Dashboards";
import { ScheduleAlertsBanner } from "./components/ScheduleAlertsBanner";
import type { DashboardRow } from "./api/dashboards";
import type { ExtensionCatalogEntry } from "./api/extensions";

vi.mock("./auth/client", () => ({ useSession: () => () => ({ isPending: false, data: null }) }));

const east = relayPrefix("east");
const agent = "assistant%40east";
const PROVIDER_URL = "https://provider.example.test/authorize?state=abc";

const remoteCapabilities = {
  version: 2, extensions: { scheduler: true }, agents: ["assistant"], multiUser: true, forkedAgents: false,
  enableCronMonitoring: true, user: { id: "remote-alice", name: "Alice", email: "alice@example.test", role: "admin" },
};

function entry(partial: Partial<ExtensionCatalogEntry> = {}): ExtensionCatalogEntry {
  return {
    id: "exa", displayName: "Exa", description: "Exa web search", builtIn: false, enabled: true, configured: true,
    missingConfig: [], configurable: true, managedAtRoot: false, configJsonSchema: null, requiredSecrets: [],
    advancedConfigFields: [], configValues: {}, configRoutePath: null, oauth: null, tier: "toggle-only", ...partial,
  };
}

const row = (id: string, partial: Partial<DashboardRow> = {}): DashboardRow => ({
  id, agentId: "assistant", agentName: "Assistant", title: `Title ${id}`, slug: `${id}.html`, link: `/d/${id}`,
  chatHref: null, params: [], linksTo: [], updatedAt: null, publishedAt: null, legacy: false, isOwner: true,
  shared: false, ownerName: "Alice", mode: "write", pinned: false, shares: [], ...partial,
});

let gateways: ReturnType<typeof createFakeGateways>;
let container: HTMLElement;
let dispose: (() => void) | undefined;
let history: ReturnType<typeof createMemoryHistory>;
let popup: ReturnType<typeof createFakePopup>;
let open: MockInstance<typeof window.open>;
const tick = () => vi.advanceTimersByTimeAsync(0);
const text = () => container.textContent ?? "";
const button = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim().startsWith(name));
const link = (name: string) => Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find((item) => item.textContent?.includes(name));

function mount(path: string) {
  history = createMemoryHistory();
  history.set({ value: path, replace: true });
  dispose = render(() => (
    <MemoryRouter history={history} root={(props: { children?: JSX.Element }) => <Suspense>{props.children}</Suspense>}>
      <Route path="/agents/:agentId/edit" component={EditAgent} />
      <Route path="/dashboards" component={Dashboards} />
      <Route path="/banner/:agentId" component={BannerPage} />
    </MemoryRouter>
  ), container);
}

function BannerPage() {
  return <ScheduleAlertsBanner agentId="assistant@east" gateway="east" />;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  setCapabilitiesForTests({ extensions: {}, multiUser: false });
  gateways = createFakeGateways();
  gateways.on("GET", "/api/agents", { json: [
    { id: "assistant", name: "Local Assistant" },
    { id: "assistant@east", name: "East Assistant", gateway: "east" },
  ] });
  gateways.on("GET", `${east}/api/capabilities`, { json: remoteCapabilities });
  gateways.on("GET", `${east}/api/top-extensions`, { json: { extensions: [], mcp: [], system: { extensions: [], mcp: [] } } });
  gateways.on("GET", new RegExp(`^${east}/api/mcp/servers\\?agent=${agent}`), { json: { canConfigureTeam: true, servers: [] } });
  gateways.on("GET", `${east}/api/agents/${agent}/extensions`, { json: { extensions: [entry({ displayName: "East Exa" })] } });
  vi.stubGlobal("fetch", gateways.fetchMock);
  popup = createFakePopup();
  open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCapabilitiesForTests();
});

describe("Edit page of a remote agent", () => {
  it("loads the catalog, MCP list, and Top flags from its gateway, and never reads the local flags", async () => {
    mount(`/agents/${agent}/edit`);
    await vi.waitFor(() => expect(text()).toContain("East Exa"));
    expect(text()).toContain("East Assistant");
    expect(gateways.log()).toEqual(expect.arrayContaining([
      `GET ${east}/api/top-extensions`,
      `GET ${east}/api/agents/${agent}/extensions`,
    ]));
    expect(gateways.requests.map((request) => request.url)).not.toContain("/api/top-extensions");
    expect(gateways.localConfigurationRequests()).toEqual([]);
    expect(gateways.unexpected).toEqual([]);
  });

  it("hides a system extension of the remote gateway from a remote admin who is not a superadmin, using remote Top flags", async () => {
    gateways.on("GET", `${east}/api/top-extensions`, { json: { extensions: [], mcp: [], system: { extensions: ["exa"], mcp: [] } } });
    mount(`/agents/${agent}/edit`);
    await vi.waitFor(() => expect(text()).toContain("East Assistant"));
    await vi.waitFor(() => expect(gateways.log()).toContain(`GET ${east}/api/top-extensions`));
    await tick();
    expect(text()).not.toContain("East Exa");
  });

  it("links an extension card to the qualified agent and a bespoke page to the qualified agent route", async () => {
    gateways.on("GET", `${east}/api/agents/${agent}/extensions`, { json: { extensions: [
      entry({ id: "exa", displayName: "East Exa" }),
      entry({ id: "webhooks", displayName: "East Hooks", tier: "bespoke-route", configRoutePath: "/agents/assistant/extensions/webhooks" }),
    ] } });
    mount(`/agents/${agent}/edit`);
    await vi.waitFor(() => expect(text()).toContain("East Hooks"));
    expect(link("East Exa")?.getAttribute("href")).toBe(`/agents/${agent}/extensions/exa`);
    expect(link("East Hooks")?.getAttribute("href")).toBe(`/agents/${agent}/extensions/webhooks`);
  });

  it("shows a missing permission read and keeps control of the remote rights off", async () => {
    gateways.on("GET", `${east}/api/capabilities`, { status: 500, json: { error: "boom" } });
    mount(`/agents/${agent}/edit`);
    await vi.waitFor(() => expect(text()).toContain("Could not read your permissions on east."));
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("makes no call and shows a retry when the gateway of the agent is not known", async () => {
    gateways.on("GET", "/api/agents", { status: 500, json: [] });
    mount(`/agents/${agent}/edit`);
    await vi.waitFor(() => expect(text()).toContain("This agent is unavailable"));
    expect(gateways.requests.map((request) => request.url)).toEqual(["/api/agents"]);
  });

  describe("pool and team controls of a remote gateway", () => {
    const fork = { sourcePoolId: "assistant", forkAgentId: "assistant-fork", teamId: null, createdBy: "u", createdAt: "x", assignedBy: null, assignedAt: null, public: false, assignment: { mode: "list", teamIds: [] } };
    const team = { id: "t1", name: "Team One", description: null, color: "#000", icon: "x", allUsers: false, private: false, memberCount: 1, canManage: true, createdBy: "u", createdAt: "x" };

    beforeEach(() => {
      gateways.on("GET", `${east}/api/capabilities`, { json: { ...remoteCapabilities, forkedAgents: true, user: { ...remoteCapabilities.user, role: "superadmin" } } });
      gateways.on("GET", `${east}/api/pool`, { json: [{ id: "assistant", name: "Pool Assistant" }] });
      gateways.on("GET", `${east}/api/teams`, { json: { teams: [team] } });
      gateways.on("GET", `${east}/api/admin/forks`, { json: { forks: [fork] } });
      gateways.on("GET", `${east}/api/agents/assistant-fork%40east/extensions`, { json: { extensions: [] } });
      gateways.on("GET", new RegExp(`^${east}/api/mcp/servers\\?agent=assistant-fork%40east`), { json: { canConfigureTeam: true, servers: [] } });
    });

    it("loads the pool, teams, and forks of the gateway and saves a team assignment and visibility there with the raw pool ID", async () => {
      gateways.on("PUT", `${east}/api/admin/forks/assistant/teams`, { json: { fork: { ...fork, assignment: { mode: "list", teamIds: ["t1"] } } } });
      gateways.on("PATCH", `${east}/api/admin/forks/assistant/visibility`, { json: { fork: { ...fork, public: true } } });
      mount(`/agents/${agent}/edit`);
      await vi.waitFor(() => expect(text()).toContain("Pool Assistant"));
      await vi.waitFor(() => expect(button("Team One")).toBeDefined());
      button("Team One")!.click();
      await tick();
      button("Save")!.click();
      await vi.waitFor(() => expect(gateways.requests.find((request) => request.method === "PUT")?.body).toEqual({ mode: "list", teamIds: ["t1"] }));
      await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('button[aria-label="Agent visibility"]')).not.toBeNull());
      container.querySelector<HTMLButtonElement>('button[aria-label="Agent visibility"]')!.click();
      await vi.waitFor(() => expect(gateways.log()).toContain(`PATCH ${east}/api/admin/forks/assistant/visibility`));
      // The extension catalog of the runnable fork loads with the qualified fork ID.
      expect(gateways.log()).toContain(`GET ${east}/api/agents/assistant-fork%40east/extensions`);
      expect(gateways.localConfigurationRequests()).toEqual([]);
    });

    it("shows no blank page when the pool of the gateway fails, and uses the agent of the merged list", async () => {
      gateways.on("GET", `${east}/api/pool`, { status: 502, json: { error: "gateway_offline" } });
      mount(`/agents/${agent}/edit`);
      await vi.waitFor(() => expect(text()).toContain("East Assistant"));
      expect(text()).toContain("Back to agents");
      expect(button("Team One")).toBeUndefined();
    });
  });

  describe("custom MCP server", () => {
    async function openAdd() {
      mount(`/agents/${agent}/edit`);
      await vi.waitFor(() => expect(button("Add custom extension")).toBeDefined());
      await vi.waitFor(() => expect(button("Add custom extension")?.disabled).toBe(false));
      button("Add custom extension")!.click();
      await tick();
      const input = container.querySelector<HTMLInputElement>('input[type="url"]')!;
      input.value = "https://docs.test/mcp";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const addUrl = `${east}/api/mcp/servers?agent=${agent}`;

    it("opens the window before the add, uses the grant from the add result, and starts no second grant", async () => {
      gateways.on("POST", addUrl, () => ({ json: { server: { name: "docs", type: "http", auth: "oauth", state: "disconnected", readOnly: false }, authorizationUrl: PROVIDER_URL } }));
      let personal = "disconnected";
      gateways.on("GET", `${east}/api/mcp/oauth/status?agent=${agent}&scope=personal`, () => ({ json: { servers: [{ name: "docs", auth: "oauth", state: personal }] } }));
      await openAdd();
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(popup.location.href).toBe(PROVIDER_URL));
      const add = gateways.requests.find((request) => request.method === "POST" && request.url === addUrl)!;
      expect(add.body).toEqual({ url: "https://docs.test/mcp", credentialScope: "personal" });
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.invocationCallOrder[0]).toBeLessThan(gateways.fetchMock.mock.invocationCallOrder[gateways.requests.indexOf(add)]);
      expect(gateways.log()).not.toContain("POST /api/relay/oauth/start");
      personal = "connected";
      await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
      await vi.waitFor(() => expect(popup.closed).toBe(true));
      expect(text()).not.toContain("Finish the sign-in");
    });

    it("closes the blank window and refreshes the list when the add needs no sign-in", async () => {
      gateways.on("POST", addUrl, { json: { server: { name: "docs", type: "http", auth: "none", state: "connected", readOnly: false } } });
      await openAdd();
      const reads = () => gateways.log().filter((line) => line === `GET ${east}/api/mcp/servers?agent=${agent}&live=0`).length;
      const before = reads();
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(popup.closed).toBe(true));
      expect(popup.location.href).toBe("");
      await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
      expect(gateways.log()).not.toContain("POST /api/relay/oauth/start");
    });

    it("shows an add error, closes the window, and reads the remote list again before a retry", async () => {
      gateways.on("POST", addUrl, { status: 502, text: "Relay refused the answer" });
      await openAdd();
      const reads = () => gateways.log().filter((line) => line === `GET ${east}/api/mcp/servers?agent=${agent}&live=0`).length;
      const before = reads();
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(text()).toContain("Relay refused the answer"));
      expect(popup.closed).toBe(true);
      await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
      expect(button("Add and connect")?.disabled).toBe(false);
    });

    it("shows a blocked window and does not add the server", async () => {
      open.mockReturnValue(null);
      await openAdd();
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(text()).toContain("blocked the sign-in window"));
      expect(gateways.requests.some((request) => request.method === "POST")).toBe(false);
      // The dialog stays usable for a retry.
      await vi.waitFor(() => expect(button("Add and connect")?.disabled).toBe(false));
    });
  });

  describe("dashboards tab", () => {
    const rows = [row("east-dash", { agentId: "assistant@east", chatHref: "/chat/assistant?session=s1&dashboard=east-dash" }), row("east-legacy", { agentId: "assistant@east", legacy: true, isOwner: false, ownerName: null })];

    async function openDashboards() {
      mount(`/agents/${agent}/edit`);
      await vi.waitFor(() => expect(button("Dashboards")).toBeDefined());
      button("Dashboards")!.click();
      await vi.waitFor(() => expect(text()).toContain("Title east-dash"));
    }

    it("links open, chat, and copy to local routes of the gateway and never to the remote paths", async () => {
      gateways.on("GET", `${east}/api/agents/${agent}/dashboards`, { json: rows });
      await openDashboards();
      const open = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).filter((item) => item.textContent?.includes("Open"));
      expect(open[0].getAttribute("href")).toBe("/remote-dashboards/east/east-dash");
      expect(link("Chat")?.getAttribute("href")).toBe(`/chat/${agent}?session=s1&dashboard=east-dash`);
      expect(container.querySelector('a[href^="/d/"]')).toBeNull();
      expect(container.querySelector(`a[href="/chat/assistant?session=s1&dashboard=east-dash"]`)).toBeNull();
      const written = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText: written }, configurable: true });
      button("Copy link")!.click();
      await tick();
      expect(written).toHaveBeenCalledWith(`${window.location.origin}/remote-dashboards/east/east-dash`);
    });

    it("claims and opens sharing through the gateway, with its recipients", async () => {
      gateways.on("GET", `${east}/api/agents/${agent}/dashboards`, { json: rows });
      gateways.on("POST", `${east}/api/dashboards/east-legacy/claim`, { json: { dashboard: row("east-legacy") } });
      gateways.on("GET", `${east}/api/dashboards/recipients`, { json: { users: [{ id: "bob", name: "Bob", email: "bob@example.test" }] } });
      gateways.on("PATCH", `${east}/api/dashboards/east-dash/sharing`, { json: { dashboard: row("east-dash") } });
      await openDashboards();
      button("Claim")!.click();
      await vi.waitFor(() => expect(button("Claim dashboard")).toBeDefined());
      button("Claim dashboard")!.click();
      await vi.waitFor(() => expect(gateways.log()).toContain(`POST ${east}/api/dashboards/east-legacy/claim`));
      button("Manage access")!.click();
      await vi.waitFor(() => expect(gateways.log()).toContain(`GET ${east}/api/dashboards/recipients`));
      expect(gateways.localConfigurationRequests()).toEqual([]);
    });
  });

  describe("my connections tab", () => {
    it("lists and disconnects connections of the remote agent through the gateway, with the remote requester", async () => {
      gateways.on("GET", `${east}/api/agents/${agent}/connections`, { json: { connections: [
        { kind: "oauth", id: "google", name: "Google", personal: true, team: false },
        { kind: "extension", id: "exa", name: "Exa", personal: true, team: true },
      ] } });
      gateways.on("GET", `${east}/api/mcp/oauth/status?agent=${agent}&scope=team`, { json: { servers: [{ name: "docs", auth: "oauth", state: "disconnected" }] } });
      gateways.on("GET", `${east}/api/mcp/oauth/status?agent=${agent}&scope=personal`, { json: { servers: [{ name: "docs", auth: "oauth", state: "connected" }] } });
      gateways.on("DELETE", new RegExp(`^${east}/api/agents/${agent}/connections/`), { json: { ok: true } });
      gateways.on("POST", `${east}/api/mcp/oauth/disconnect?agent=${agent}&server=docs&scope=personal`, { json: { ok: true } });
      mount(`/agents/${agent}/edit`);
      await vi.waitFor(() => expect(button("My connections")).toBeDefined());
      button("My connections")!.click();
      await vi.waitFor(() => expect(text()).toContain("Google"));
      await vi.waitFor(() => expect(text()).toContain("Docs"));
      // The remote requester has an account, so the personal MCP status was read.
      expect(gateways.log()).toContain(`GET ${east}/api/mcp/oauth/status?agent=${agent}&scope=personal`);
      container.querySelector<HTMLButtonElement>('button[aria-label="Disconnect your personal Google connection"]')!.click();
      await vi.waitFor(() => expect(gateways.log()).toContain(`DELETE ${east}/api/agents/${agent}/connections/oauth/google`));
      await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('button[aria-label="Disconnect your personal Docs connection"]')?.disabled).toBe(false));
      container.querySelector<HTMLButtonElement>('button[aria-label="Disconnect your personal Docs connection"]')!.click();
      await vi.waitFor(() => expect(gateways.log()).toContain(`POST ${east}/api/mcp/oauth/disconnect?agent=${agent}&server=docs&scope=personal`));
      expect(gateways.localConfigurationRequests()).toEqual([]);
    });
  });

  describe("scheduled jobs tab", () => {
    const job = (partial: Record<string, unknown> = {}) => ({
      id: "job-1", agentId: "assistant@east", name: "Digest", credentialMode: "team", ownerUserId: "remote-alice",
      createdByUserId: "remote-alice", schedule: { cron: "0 8 * * *", tz: "UTC" }, payload: { message: "Send digest" }, enabled: true, ...partial,
    });

    it("lists and changes jobs through the gateway and links runs to the qualified agent", async () => {
      gateways.on("GET", `${east}/api/schedules?agent=${agent}`, { json: [job()] });
      gateways.on("PATCH", `${east}/api/schedules/${agent}/job-1`, { json: job({ enabled: false }) });
      mount(`/agents/${agent}/edit`);
      await vi.waitFor(() => expect(button("Scheduled jobs")).toBeDefined());
      button("Scheduled jobs")!.click();
      await vi.waitFor(() => expect(text()).toContain("Digest"));
      expect(link("Digest")?.getAttribute("href")).toBe(`/agents/${agent}/schedules/job-1/runs`);
      container.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
      await vi.waitFor(() => expect(gateways.log()).toContain(`PATCH ${east}/api/schedules/${agent}/job-1`));
      expect(gateways.localConfigurationRequests()).toEqual([]);
    });
  });
});

describe("Dashboards page", () => {
  const eastRows = { owned: [row("shared-id", { agentId: "assistant@east", chatHref: "/chat/assistant?dashboard=shared-id&new=1", title: "East board" })], shared: [] };
  const localRows = { owned: [row("shared-id", { title: "Local board" })], shared: [] };
  const answer = (value: unknown): FakeAnswer => ({ json: value });

  beforeEach(() => {
    gateways.on("GET", "/api/dashboards", answer(localRows));
    gateways.on("GET", `${east}/api/dashboards`, answer(eastRows));
  });

  it("shows the local dashboards by default and the dashboards of the named gateway after the choice", async () => {
    mount("/dashboards");
    await vi.waitFor(() => expect(text()).toContain("Local board"));
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Gateway"]')!;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["This computer", "east"]);
    select.value = "east";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(text()).toContain("East board"));
    expect(text()).not.toContain("Local board");
    expect(history.get()).toBe("/dashboards?gateway=east");
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(text()).toContain("Local board"));
    expect(text()).not.toContain("East board");
  });

  it("opens a dashboard of the gateway through the trusted route and the chat of the qualified agent", async () => {
    mount("/dashboards?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("East board"));
    expect(link("Open")?.getAttribute("href")).toBe("/remote-dashboards/east/shared-id");
    expect(link("Chat")?.getAttribute("href")).toBe(`/chat/${agent}?dashboard=shared-id&new=1`);
    expect(container.querySelector('a[href^="/d/"]')).toBeNull();
  });

  it("pins, shares, and deletes with the gateway, even when the dashboard ID is the same as a local ID", async () => {
    gateways.on("PUT", `${east}/api/dashboards/shared-id/pin`, { json: { ok: true, pinned: true } });
    gateways.on("GET", `${east}/api/dashboards/recipients`, { json: { users: [] } });
    gateways.on("PATCH", `${east}/api/dashboards/shared-id/sharing`, { json: { dashboard: row("shared-id") } });
    gateways.on("DELETE", `${east}/api/dashboards/shared-id`, { json: { ok: true } });
    mount("/dashboards?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("East board"));
    container.querySelector<HTMLButtonElement>("button[aria-pressed]")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`PUT ${east}/api/dashboards/shared-id/pin`));
    button("Manage access")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`GET ${east}/api/dashboards/recipients`));
    await tick();
    const general = document.querySelector<HTMLSelectElement>('select[aria-label="General access"]')!;
    general.value = "all";
    general.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === "Save")!.click();
    await vi.waitFor(() => expect(gateways.requests.find((request) => request.url === `${east}/api/dashboards/shared-id/sharing`)?.body).toEqual({ shares: [{ kind: "all", mode: "read" }] }));
    await vi.waitFor(() => expect(document.querySelector('select[aria-label="General access"]')).toBeNull());
    button("Delete")!.click();
    await tick();
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === "Delete").pop()!;
    confirm.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`DELETE ${east}/api/dashboards/shared-id`));
    expect(gateways.requests.filter((request) => request.method !== "GET").every((request) => request.url.startsWith(east))).toBe(true);
  });

  it("ignores a pin answer that arrives after the page moved to another gateway", async () => {
    let finish: (() => void) | undefined;
    gateways.on("PUT", `${east}/api/dashboards/shared-id/pin`, () => new Promise<FakeAnswer>((resolve) => { finish = () => resolve({ json: { ok: true, pinned: true } }); }));
    mount("/dashboards?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("East board"));
    container.querySelector<HTMLButtonElement>("button[aria-pressed]")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    history.set({ value: "/dashboards" });
    await vi.waitFor(() => expect(text()).toContain("Local board"));
    finish!();
    await tick();
    expect(container.querySelector<HTMLButtonElement>("button[aria-pressed]")?.getAttribute("aria-pressed")).toBe("false");
    expect(text()).not.toContain("Pinned");
  });

  it("shows a gateway failure and no rows, and never falls back to the local list", async () => {
    gateways.on("GET", `${east}/api/dashboards`, { status: 502, json: { error: "gateway_offline" } });
    mount("/dashboards?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("Unable to load dashboards."));
    expect(text()).not.toContain("Local board");
    expect(gateways.requests.map((request) => request.url)).not.toContain("/api/dashboards");
  });
});

describe("schedule alerts of a remote agent", () => {
  const alert = { agentId: "assistant@east", jobId: "job-1", jobName: "Digest", pausedReason: { integration: "Google", connectPath: "/agents/assistant/extensions/google" } };

  it("shows the alerts of its own gateway, links Reconnect to the qualified agent, and resumes through the gateway", async () => {
    gateways.on("GET", `${east}/api/schedule-alerts`, { json: [alert] });
    gateways.on("PATCH", `${east}/api/schedules/${agent}/job-1`, { json: {} });
    mount("/banner/assistant%40east");
    createRoot(() => { void refreshScheduleAlerts("east"); });
    await vi.waitFor(() => expect(text()).toContain("Digest is paused"));
    expect(link("Reconnect")?.getAttribute("href")).toBe(`/agents/${agent}/extensions/google`);
    button("Resume")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`PATCH ${east}/api/schedules/${agent}/job-1`));
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("does not show an alert of the local gateway for the remote agent", async () => {
    gateways.on("GET", "/api/schedule-alerts", { json: [{ ...alert, agentId: "assistant@east" }] });
    gateways.on("GET", `${east}/api/schedule-alerts`, { json: [] });
    mount("/banner/assistant%40east");
    createRoot(() => { void refreshScheduleAlerts(); void refreshScheduleAlerts("east"); });
    await tick();
    expect(text()).not.toContain("Digest is paused");
  });
});
