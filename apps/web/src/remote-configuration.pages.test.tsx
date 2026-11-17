// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { render } from "solid-js/web";
import { Suspense, createRoot, type JSX } from "solid-js";
import { MemoryRouter, Route, createMemoryHistory, useParams } from "@solidjs/router";
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
const west = relayPrefix("west");
const agent = "assistant%40east";
const PROVIDER_URL = "https://provider.example.test/authorize?state=abc";

const remoteCapabilities = {
  version: 2, extensions: { scheduler: true, mcp: true }, agents: ["assistant"], multiUser: true, forkedAgents: false,
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
      <Route path="/banner/:agentId/:gateway" component={BannerPage} />
      <Route path="/review-away" component={() => <h1>Other page</h1>} />
    </MemoryRouter>
  ), container);
}

function BannerPage() {
  const params = useParams<{ agentId: string; gateway: string }>();
  return <ScheduleAlertsBanner agentId={decodeURIComponent(params.agentId)} gateway={params.gateway === "local" ? undefined : params.gateway} />;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  setCapabilitiesForTests({ extensions: { mcp: true }, multiUser: false });
  gateways = createFakeGateways();
  gateways.on("GET", "/api/agents", { json: [
    { id: "assistant", name: "Local Assistant" },
    { id: "assistant@east", name: "East Assistant", gateway: "east" },
    { id: "assistant@west", name: "West Assistant", gateway: "west" },
  ] });
  gateways.on("GET", `${east}/api/capabilities`, { json: remoteCapabilities });
  gateways.on("GET", `${west}/api/capabilities`, { json: remoteCapabilities });
  // The configured gateways. "quiet" has no visible agent, and it still appears in every selector.
  gateways.on("GET", "/api/relay/gateways", { json: { gateways: [{ name: "east" }, { name: "west" }, { name: "quiet" }] } });
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

  it("reads the permissions again on Retry and keeps the page, without navigation", async () => {
    let answer: { status: number; json: unknown } = { status: 500, json: { error: "boom" } };
    gateways.on("GET", `${east}/api/capabilities`, () => answer);
    mount(`/agents/${agent}/edit`);
    await vi.waitFor(() => expect(text()).toContain("Could not read your permissions on east."));
    answer = { status: 200, json: remoteCapabilities };
    button("Retry")!.click();
    await vi.waitFor(() => expect(text()).not.toContain("Could not read your permissions"));
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
    const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]');

    const added = (name: string) => ({ json: { server: { name, type: "http", auth: "none", state: "connected", readOnly: false } } });
    const listReads = () => gateways.log().filter((line) => line === `GET ${east}/api/mcp/servers?agent=${agent}&live=0`).length;
    const queuePosts = (url: string) => {
      const waiting: ((answer: FakeAnswer) => void)[] = [];
      gateways.on("POST", url, () => new Promise<FakeAnswer>((resolve) => { waiting.push(resolve); }));
      return waiting;
    };
    const addAgain = async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="url"]')!;
      input.value = "https://docs.test/mcp-two";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      button("Add and connect")!.click();
    };
    const localEdit = () => {
      gateways.on("GET", "/api/agents/assistant/extensions", { json: { extensions: [entry({ displayName: "Local Exa" })] } });
      gateways.on("GET", /^\/api\/mcp\/servers\?agent=assistant/, { json: { servers: [], canConfigureTeam: true } });
      gateways.on("GET", "/api/top-extensions", { json: { extensions: [], mcp: [], system: { extensions: [], mcp: [] } } });
    };

    it("frees the local add after a success without a redirect, so a second add works", async () => {
      localEdit();
      gateways.on("POST", "/api/mcp/servers?agent=assistant", added("docs"));
      mount("/agents/assistant/edit");
      await vi.waitFor(() => expect(button("Add custom extension")?.disabled).toBe(false));
      button("Add custom extension")!.click();
      await tick();
      const input = container.querySelector<HTMLInputElement>('input[type="url"]')!;
      input.value = "https://docs.test/mcp";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(text()).toContain("Added Docs."));
      button("Add custom extension")!.click();
      await tick();
      expect(submit()?.disabled).toBe(false);
      await addAgain();
      await vi.waitFor(() => expect(gateways.requests.filter((request) => request.method === "POST").length).toBe(2));
    });

    it("frees the remote add after a success that needs no sign-in, so a second add works", async () => {
      gateways.on("POST", addUrl, added("docs"));
      await openAdd();
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(text()).toContain("Added Docs."));
      button("Add custom extension")!.click();
      await tick();
      expect(submit()?.disabled).toBe(false);
    });

    it("ends the add on Cancel, reads the list, and ignores the late answer", async () => {
      const posts = queuePosts(addUrl);
      await openAdd();
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(posts.length).toBe(1));
      const before = listReads();
      button("Cancel")!.click();
      // The submitted add may still run on the server, so the list is read before another add.
      await vi.waitFor(() => expect(listReads()).toBeGreaterThan(before));
      await vi.waitFor(() => expect(submit()?.disabled).toBe(false));
      expect(popup.closed).toBe(true);
      posts[0](added("late"));
      await tick();
      await tick();
      expect(text()).not.toContain("Added Late.");
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(submit()?.disabled).toBe(false);
    });

    it("keeps another add off when the list read after Cancel fails, and frees it after a working read", async () => {
      const posts = queuePosts(addUrl);
      await openAdd();
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(posts.length).toBe(1));
      gateways.on("GET", `${east}/api/mcp/servers?agent=${agent}&live=0`, { status: 502, json: { error: "gateway_offline" } });
      button("Cancel")!.click();
      await vi.waitFor(() => expect(text()).toContain("The server list could not be read"));
      expect(submit()?.disabled).toBe(true);
      gateways.on("GET", `${east}/api/mcp/servers?agent=${agent}&live=0`, { json: { canConfigureTeam: true, servers: [] } });
      button("Read list")!.click();
      await vi.waitFor(() => expect(submit()?.disabled).toBe(false));
    });

    it("gives a new attempt on the same target its own record, so the old late answer changes nothing", async () => {
      const posts = queuePosts(addUrl);
      await openAdd();
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(posts.length).toBe(1));
      button("Cancel")!.click();
      await vi.waitFor(() => expect(submit()?.disabled).toBe(false));
      popup.closed = false;
      await addAgain();
      await vi.waitFor(() => expect(posts.length).toBe(2));
      posts[0](added("late"));
      await tick();
      await tick();
      expect(text()).not.toContain("Added Late.");
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
      posts[1](added("docs"));
      await vi.waitFor(() => expect(text()).toContain("Added Docs."));
    });

    it("ignores the answer of an earlier visit when the page returns to the same agent", async () => {
      const posts = queuePosts(addUrl);
      localEdit();
      await openAdd();
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(posts.length).toBe(1));
      history.set({ value: "/agents/assistant/edit" });
      await vi.waitFor(() => expect(text()).toContain("Local Exa"));
      history.set({ value: `/agents/${agent}/edit` });
      await vi.waitFor(() => expect(button("Add custom extension")?.disabled).toBe(false));
      posts[0](added("late"));
      await tick();
      await tick();
      expect(text()).not.toContain("Added Late.");
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(popup.location.href).toBe("");
    });

    it("starts nothing after the page closes during a remote add", async () => {
      const posts = queuePosts(addUrl);
      await openAdd();
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(posts.length).toBe(1));
      history.set({ value: "/review-away" });
      await vi.waitFor(() => expect(text()).toContain("Other page"));
      const before = gateways.requests.length;
      posts[0]({ json: { server: { name: "late", type: "http", auth: "oauth", state: "disconnected", readOnly: false }, authorizationUrl: PROVIDER_URL } });
      await tick();
      await tick();
      expect(gateways.requests.length).toBe(before);
      expect(popup.location.href).not.toBe(PROVIDER_URL);
    });

    it("starts no redirect and no refresh after the page closes during a local add", async () => {
      localEdit();
      const posts = queuePosts("/api/mcp/servers?agent=assistant");
      const assign = vi.fn();
      vi.stubGlobal("location", { href: "http://localhost/agents/assistant/edit", pathname: "/agents/assistant/edit", search: "", hash: "", assign });
      mount("/agents/assistant/edit");
      await vi.waitFor(() => expect(button("Add custom extension")?.disabled).toBe(false));
      button("Add custom extension")!.click();
      await tick();
      const input = container.querySelector<HTMLInputElement>('input[type="url"]')!;
      input.value = "https://docs.test/mcp";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(posts.length).toBe(1));
      history.set({ value: "/review-away" });
      await vi.waitFor(() => expect(text()).toContain("Other page"));
      const before = gateways.requests.length;
      posts[0]({ json: { server: { name: "late", type: "http", auth: "oauth", state: "disconnected", readOnly: false }, authorizationUrl: PROVIDER_URL } });
      await tick();
      await tick();
      expect(assign).not.toHaveBeenCalled();
      expect(gateways.requests.length).toBe(before);
    });

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

    it("keeps another add off until the list read of the same target settles, and shows an unknown state when it fails", async () => {
      gateways.on("POST", addUrl, { status: 502, text: "Relay refused the answer" });
      await openAdd();
      let releaseList: (() => void) | undefined;
      gateways.on("GET", `${east}/api/mcp/servers?agent=${agent}&live=0`, () => new Promise((resolve) => { releaseList = () => resolve({ status: 502, json: { error: "gateway_offline" } }); }));
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(text()).toContain("Relay refused the answer"));
      await vi.waitFor(() => expect(releaseList).toBeDefined());
      expect(submit()?.disabled).toBe(true);
      releaseList!();
      await vi.waitFor(() => expect(text()).toContain("The server list could not be read"));
      // The state stays unknown. The button stays off, and the add is not sent again.
      expect(submit()?.disabled).toBe(true);
      const adds = () => gateways.requests.filter((request) => request.method === "POST" && request.url === addUrl).length;
      expect(adds()).toBe(1);
      // A working read frees the dialog again.
      gateways.on("GET", `${east}/api/mcp/servers?agent=${agent}&live=0`, { json: { canConfigureTeam: true, servers: [] } });
      button("Read list")!.click();
      await vi.waitFor(() => expect(submit()?.disabled).toBe(false));
      expect(text()).not.toContain("The server list could not be read");
    });

    it("does not read the list of another target after an add error of the old target", async () => {
      let fail: (() => void) | undefined;
      gateways.on("POST", addUrl, () => new Promise((resolve) => { fail = () => resolve({ status: 502, text: "Relay refused the answer" }); }));
      gateways.on("GET", "/api/agents/assistant/extensions", { json: { extensions: [entry({ displayName: "Local Exa" })] } });
      gateways.on("GET", /^\/api\/mcp\/servers\?agent=assistant/, { json: { servers: [], canConfigureTeam: true } });
      gateways.on("GET", "/api/top-extensions", { json: { extensions: [], mcp: [], system: { extensions: [], mcp: [] } } });
      await openAdd();
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(fail).toBeDefined());
      history.set({ value: "/agents/assistant/edit" });
      await vi.waitFor(() => expect(text()).toContain("Local Exa"));
      const reads = () => gateways.log().filter((line) => line.startsWith("GET /api/mcp/servers?agent=assistant")).length;
      const before = reads();
      fail!();
      await tick();
      await tick();
      expect(reads()).toBe(before);
      expect(text()).not.toContain("Relay refused the answer");
      expect(gateways.log().filter((line) => line === `GET ${east}/api/mcp/servers?agent=${agent}&live=0`).length).toBeLessThanOrEqual(1);
    });

    it("closes the add dialog and ignores a late failure from a changed target", async () => {
      let finish: (() => void) | undefined;
      gateways.on("POST", addUrl, () => new Promise((resolve) => { finish = () => resolve({ json: { server: { name: "late", type: "http", auth: "none", state: "connected", readOnly: false } } }); }));
      gateways.on("GET", "/api/agents/assistant/extensions", { json: { extensions: [entry({ displayName: "Local Exa" })] } });
      gateways.on("GET", /^\/api\/mcp\/servers\?agent=assistant/, { json: { servers: [], canConfigureTeam: true } });
      gateways.on("GET", "/api/top-extensions", { json: { extensions: [], mcp: [], system: { extensions: [], mcp: [] } } });
      await openAdd();
      button("Add and connect")!.click();
      await vi.waitFor(() => expect(finish).toBeDefined());
      history.set({ value: "/agents/assistant/edit" });
      await vi.waitFor(() => expect(text()).toContain("Local Exa"));
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      finish!();
      await tick();
      await tick();
      expect(text()).not.toContain("Added Late.");
      expect(popup.location.href).toBe("");
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
    it("ignores a late disconnect error of the old agent and keeps the connections of the new agent usable", async () => {
      setCapabilitiesForTests({ extensions: { mcp: true }, multiUser: true });
      let fail: (() => void) | undefined;
      gateways.on("GET", `${east}/api/agents/${agent}/connections`, { json: { connections: [{ kind: "oauth", id: "google", name: "Google", personal: true, team: false }] } });
      gateways.on("GET", `${east}/api/mcp/oauth/status?agent=${agent}&scope=team`, { json: { servers: [] } });
      gateways.on("GET", `${east}/api/mcp/oauth/status?agent=${agent}&scope=personal`, { json: { servers: [] } });
      gateways.on("DELETE", `${east}/api/agents/${agent}/connections/oauth/google`, () => new Promise((resolve) => { fail = () => resolve({ status: 403, json: { error: "forbidden" } }); }));
      gateways.on("GET", "/api/agents/assistant/connections", { json: { connections: [{ kind: "oauth", id: "notion", name: "Notion", personal: true, team: false }] } });
      gateways.on("GET", "/api/mcp/oauth/status?agent=assistant&scope=team", { json: { servers: [] } });
      gateways.on("GET", /^\/api\/mcp\/servers\?agent=assistant/, { json: { servers: [], canConfigureTeam: true } });
      gateways.on("GET", "/api/agents/assistant/extensions", { json: { extensions: [] } });
      gateways.on("GET", "/api/top-extensions", { json: { extensions: [], mcp: [], system: { extensions: [], mcp: [] } } });
      mount(`/agents/${agent}/edit`);
      await vi.waitFor(() => expect(button("My connections")).toBeDefined());
      button("My connections")!.click();
      await vi.waitFor(() => expect(text()).toContain("Google"));
      container.querySelector<HTMLButtonElement>('button[aria-label="Disconnect your personal Google connection"]')!.click();
      await vi.waitFor(() => expect(fail).toBeDefined());
      history.set({ value: "/agents/assistant/edit" });
      await vi.waitFor(() => expect(button("My connections")).toBeDefined());
      button("My connections")!.click();
      await vi.waitFor(() => expect(text()).toContain("Notion"));
      fail!();
      await tick();
      await tick();
      expect(text()).not.toContain("Failed to disconnect personal connection");
      expect(container.querySelector<HTMLButtonElement>('button[aria-label="Disconnect your personal Notion connection"]')?.disabled).toBe(false);
    });

    it("ignores the old disconnect error after the page returns to the same agent", async () => {
      let fail: (() => void) | undefined;
      gateways.on("GET", `${east}/api/agents/${agent}/connections`, { json: { connections: [{ kind: "oauth", id: "google", name: "Google", personal: true, team: false }] } });
      gateways.on("GET", `${east}/api/mcp/oauth/status?agent=${agent}&scope=team`, { json: { servers: [] } });
      gateways.on("GET", `${east}/api/mcp/oauth/status?agent=${agent}&scope=personal`, { json: { servers: [] } });
      gateways.on("DELETE", `${east}/api/agents/${agent}/connections/oauth/google`, () => new Promise((resolve) => { fail = () => resolve({ status: 403, json: { error: "forbidden" } }); }));
      gateways.on("GET", "/api/agents/assistant/connections", { json: { connections: [] } });
      gateways.on("GET", "/api/mcp/oauth/status?agent=assistant&scope=team", { json: { servers: [] } });
      gateways.on("GET", /^\/api\/mcp\/servers\?agent=assistant/, { json: { servers: [], canConfigureTeam: true } });
      gateways.on("GET", "/api/agents/assistant/extensions", { json: { extensions: [] } });
      gateways.on("GET", "/api/top-extensions", { json: { extensions: [], mcp: [], system: { extensions: [], mcp: [] } } });
      mount(`/agents/${agent}/edit`);
      await vi.waitFor(() => expect(button("My connections")).toBeDefined());
      button("My connections")!.click();
      await vi.waitFor(() => expect(text()).toContain("Google"));
      container.querySelector<HTMLButtonElement>('button[aria-label="Disconnect your personal Google connection"]')!.click();
      await vi.waitFor(() => expect(fail).toBeDefined());
      history.set({ value: "/agents/assistant/edit" });
      await vi.waitFor(() => expect(gateways.log()).toContain("GET /api/agents/assistant/connections"));
      await vi.waitFor(() => expect(text()).toContain("No connections are configured"));
      history.set({ value: `/agents/${agent}/edit` });
      await vi.waitFor(() => expect(text()).toContain("Google"));
      fail!();
      await tick();
      await tick();
      // The API text of a failed disconnect is "Failed to disconnect personal connection".
      expect(text()).not.toContain("Failed to disconnect personal connection");
      expect(container.querySelector<HTMLButtonElement>('button[aria-label="Disconnect your personal Google connection"]')?.disabled).toBe(false);
    });

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

    it("keeps no job of the old gateway after a failed read on a second remote gateway, and sends no action for it", async () => {
      setCapabilitiesForTests({ extensions: { scheduler: true, mcp: true }, multiUser: false, enableCronMonitoring: true });
      gateways.on("GET", `${east}/api/schedules?agent=${agent}`, { json: [job({ name: "East Digest" })] });
      gateways.on("GET", `${west}/api/schedules?agent=assistant%40west`, { status: 502, json: { error: "gateway_offline" } });
      gateways.on("GET", `${west}/api/agents/assistant%40west/extensions`, { json: { extensions: [] } });
      gateways.on("GET", new RegExp(`^${west}/api/mcp/servers`), { json: { servers: [], canConfigureTeam: true } });
      gateways.on("GET", `${west}/api/top-extensions`, { json: { extensions: [], mcp: [], system: { extensions: [], mcp: [] } } });
      mount(`/agents/${agent}/edit?tab=schedules`);
      await vi.waitFor(() => expect(text()).toContain("East Digest"));
      history.set({ value: "/agents/assistant%40west/edit?tab=schedules" });
      await vi.waitFor(() => expect(text()).toContain("Failed to fetch scheduled jobs"));
      expect(text()).not.toContain("East Digest");
      expect(container.querySelector('[role="switch"]')).toBeNull();
      expect(gateways.requests.filter((request) => request.method !== "GET")).toEqual([]);
    });

    it("clears remote jobs when the local list fails, and sends no action with a remote job ID", async () => {
      setCapabilitiesForTests({ extensions: { scheduler: true, mcp: true }, multiUser: false, enableCronMonitoring: true });
      gateways.on("GET", `${east}/api/schedules?agent=${agent}`, { json: [job({ name: "East Digest" })] });
      gateways.on("GET", "/api/schedules?agent=assistant", { status: 403, json: {} });
      gateways.on("GET", "/api/agents/assistant/extensions", { json: { extensions: [] } });
      gateways.on("GET", /^\/api\/mcp\/servers\?agent=assistant/, { json: { servers: [], canConfigureTeam: true } });
      gateways.on("GET", "/api/top-extensions", { json: { extensions: [], mcp: [], system: { extensions: [], mcp: [] } } });
      mount(`/agents/${agent}/edit?tab=schedules`);
      await vi.waitFor(() => expect(text()).toContain("East Digest"));
      history.set({ value: "/agents/assistant/edit?tab=schedules" });
      await vi.waitFor(() => expect(text()).toContain("Failed to fetch scheduled jobs"));
      expect(text()).not.toContain("East Digest");
      expect(container.querySelector('[role="switch"]')).toBeNull();
      expect(gateways.requests.filter((request) => request.method !== "GET")).toEqual([]);
    });

    it("drops an open delete dialog and a pending action when the agent changes", async () => {
      setCapabilitiesForTests({ extensions: { scheduler: true, mcp: true }, multiUser: false, enableCronMonitoring: true });
      gateways.on("GET", `${east}/api/schedules?agent=${agent}`, { json: [job({ name: "East Digest" })] });
      gateways.on("GET", "/api/schedules?agent=assistant", { json: [] });
      gateways.on("GET", "/api/agents/assistant/extensions", { json: { extensions: [] } });
      gateways.on("GET", /^\/api\/mcp\/servers\?agent=assistant/, { json: { servers: [], canConfigureTeam: true } });
      gateways.on("GET", "/api/top-extensions", { json: { extensions: [], mcp: [], system: { extensions: [], mcp: [] } } });
      mount(`/agents/${agent}/edit?tab=schedules`);
      await vi.waitFor(() => expect(text()).toContain("East Digest"));
      container.querySelector<HTMLButtonElement>('button[aria-label="Delete East Digest"]')!.click();
      await vi.waitFor(() => expect(container.querySelector('[role="alertdialog"]')).not.toBeNull());
      history.set({ value: "/agents/assistant/edit?tab=schedules" });
      await vi.waitFor(() => expect(text()).not.toContain("East Digest"));
      expect(container.querySelector('[role="alertdialog"]')).toBeNull();
      expect(gateways.requests.filter((request) => request.method !== "GET")).toEqual([]);
    });

    it("ignores a late schedule change of the old gateway", async () => {
      setCapabilitiesForTests({ extensions: { scheduler: true, mcp: true }, multiUser: false, enableCronMonitoring: true });
      let fail: (() => void) | undefined;
      gateways.on("GET", `${east}/api/schedules?agent=${agent}`, { json: [job({ name: "East Digest" })] });
      gateways.on("PATCH", `${east}/api/schedules/${agent}/job-1`, () => new Promise((resolve) => { fail = () => resolve({ status: 403, json: { error: "team_requires_admin" } }); }));
      gateways.on("GET", "/api/schedules?agent=assistant", { json: [] });
      gateways.on("GET", "/api/agents/assistant/extensions", { json: { extensions: [] } });
      gateways.on("GET", /^\/api\/mcp\/servers\?agent=assistant/, { json: { servers: [], canConfigureTeam: true } });
      gateways.on("GET", "/api/top-extensions", { json: { extensions: [], mcp: [], system: { extensions: [], mcp: [] } } });
      mount(`/agents/${agent}/edit?tab=schedules`);
      await vi.waitFor(() => expect(text()).toContain("East Digest"));
      container.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
      await vi.waitFor(() => expect(fail).toBeDefined());
      history.set({ value: "/agents/assistant/edit?tab=schedules" });
      await vi.waitFor(() => expect(text()).not.toContain("East Digest"));
      fail!();
      await tick();
      await tick();
      expect(text()).not.toContain("Only admins can pause");
      expect(text()).not.toContain("Failed to update scheduled job");
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
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["This computer", "east", "west", "quiet"]);
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

  it("ignores a late delete answer after the page moved to another gateway", async () => {
    let fail: (() => void) | undefined;
    gateways.on("DELETE", `${east}/api/dashboards/shared-id`, () => new Promise((resolve) => { fail = () => resolve({ status: 403, json: { error: "forbidden" } }); }));
    mount("/dashboards?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("East board"));
    button("Delete")!.click();
    await tick();
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === "Delete").pop()!.click();
    await vi.waitFor(() => expect(fail).toBeDefined());
    history.set({ value: "/dashboards" });
    await vi.waitFor(() => expect(text()).toContain("Local board"));
    button("Delete")!.click();
    await tick();
    fail!();
    await tick();
    await tick();
    // The old answer neither shows its error in the new dialog nor closes it.
    expect(document.body.textContent).not.toContain("Dashboard request failed (403)");
    expect(document.body.textContent).toContain("Delete dashboard");
  });

  it("ignores the old delete error after the page returns to the same gateway", async () => {
    let fail: (() => void) | undefined;
    gateways.on("DELETE", `${east}/api/dashboards/shared-id`, () => new Promise((resolve) => { fail = () => resolve({ status: 403, json: { error: "forbidden" } }); }));
    mount("/dashboards?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("East board"));
    button("Delete")!.click();
    await tick();
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === "Delete").pop()!.click();
    await vi.waitFor(() => expect(fail).toBeDefined());
    history.set({ value: "/dashboards" });
    await vi.waitFor(() => expect(text()).toContain("Local board"));
    history.set({ value: "/dashboards?gateway=east" });
    await vi.waitFor(() => expect(text()).toContain("East board"));
    button("Delete")!.click();
    await tick();
    fail!();
    await tick();
    await tick();
    // The API text of a failed delete is "Dashboard request failed (403)". The new visit shows none of it.
    expect(document.body.textContent).not.toContain("Dashboard request failed (403)");
    expect(document.body.textContent).toContain("Delete dashboard");
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
    mount("/banner/assistant%40east/east");
    createRoot(() => { void refreshScheduleAlerts("east"); });
    await vi.waitFor(() => expect(text()).toContain("Digest is paused"));
    expect(link("Reconnect")?.getAttribute("href")).toBe(`/agents/${agent}/extensions/google`);
    button("Resume")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`PATCH ${east}/api/schedules/${agent}/job-1`));
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("ignores the old resume error after the banner returns to the same agent", async () => {
    gateways.on("GET", `${east}/api/schedule-alerts`, { json: [alert] });
    let fail: (() => void) | undefined;
    gateways.on("PATCH", `${east}/api/schedules/${agent}/job-1`, () => new Promise((resolve) => { fail = () => resolve({ status: 500, json: {} }); }));
    gateways.on("GET", "/api/schedule-alerts", { json: [] });
    mount("/banner/assistant%40east/east");
    createRoot(() => { void refreshScheduleAlerts("east"); });
    await vi.waitFor(() => expect(button("Resume")).toBeDefined());
    button("Resume")!.click();
    await vi.waitFor(() => expect(fail).toBeDefined());
    history.set({ value: "/banner/other/local" });
    await tick();
    history.set({ value: "/banner/assistant%40east/east" });
    await vi.waitFor(() => expect(button("Resume")).toBeDefined());
    fail!();
    await tick();
    await tick();
    // The API text is "Failed to update scheduled job". The new visit shows none of it, and Resume stays on.
    expect(text()).not.toContain("Failed to update scheduled job");
    expect(button("Resume")?.disabled).toBe(false);
  });

  it("does not show an alert of the local gateway for the remote agent", async () => {
    gateways.on("GET", "/api/schedule-alerts", { json: [{ ...alert, agentId: "assistant@east" }] });
    gateways.on("GET", `${east}/api/schedule-alerts`, { json: [] });
    mount("/banner/assistant%40east/east");
    createRoot(() => { void refreshScheduleAlerts(); void refreshScheduleAlerts("east"); });
    await tick();
    expect(text()).not.toContain("Digest is paused");
  });
});
