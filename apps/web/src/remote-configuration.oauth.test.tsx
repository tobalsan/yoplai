// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { render } from "solid-js/web";
import { Suspense, type JSX } from "solid-js";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { createFakeGateways, createFakePopup, relayPrefix } from "./remote-gateway.fixture";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "./lib/capabilities";
import { activeScope, selectScope } from "./components/CredentialScopeTabs.testing";
import { ExtensionDetails } from "./pages/ExtensionDetails";
import { McpServerDetails } from "./pages/McpServerDetails";
import { OAUTH_FLOW_TIMEOUT_MS, OAUTH_POLL_INTERVAL_MS } from "./lib/oauth-popup-flow";
import type { ExtensionCatalogEntry } from "./api/extensions";

vi.mock("./auth/client", () => ({ useSession: () => () => ({ isPending: false, data: null }) }));
vi.mock("./components/LeftNavShell", () => ({ LeftNavShell: (props: { children?: JSX.Element }) => <div>{props.children}</div> }));

const east = relayPrefix("east");
const agent = "assistant%40east";
const PROVIDER_URL = "https://provider.example.test/authorize?state=abc";

const remoteCapabilities = {
  version: 2, extensions: { scheduler: true }, agents: ["assistant"], multiUser: true,
  enableCronMonitoring: true, user: { id: "remote-alice", name: "Alice", role: "admin" },
};

const server = (partial: Record<string, unknown> = {}) => ({
  name: "docs", type: "http", url: "https://docs.test/mcp", auth: "oauth", state: "disconnected",
  personalState: "disconnected", teamState: "disconnected", readOnly: false, ...partial,
});

let gateways: ReturnType<typeof createFakeGateways>;
let container: HTMLElement;
let dispose: (() => void) | undefined;
let history: ReturnType<typeof createMemoryHistory>;
let personal: "disconnected" | "connected" | "needs_reconnect";
let popup: ReturnType<typeof createFakePopup>;
let open: MockInstance<typeof window.open>;
const tick = () => vi.advanceTimersByTimeAsync(0);
const text = () => container.textContent ?? "";
const button = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim().startsWith(name));

function mount(path: string) {
  history = createMemoryHistory();
  history.set({ value: path, replace: true });
  dispose = render(() => (
    <MemoryRouter history={history} root={(props) => <Suspense>{props.children}</Suspense>}>
      <Route path="/agents/:agentId/extensions/:extensionId" component={() => <ExtensionDetails />} />
      <Route path="/agents/:agentId/mcp-servers/:serverName" component={McpServerDetails} />
      <Route path="/review-away" component={() => <h1>Other page</h1>} />
    </MemoryRouter>
  ), container);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  setCapabilitiesForTests({ extensions: {}, multiUser: false });
  personal = "disconnected";
  gateways = createFakeGateways();
  gateways.on("GET", "/api/agents", { json: [
    { id: "assistant", name: "Local Assistant" },
    { id: "assistant@east", name: "East Assistant", gateway: "east" },
    { id: "other@east", name: "Other East", gateway: "east" },
  ] });
  gateways.on("GET", `${east}/api/capabilities`, { json: remoteCapabilities });
  gateways.on("GET", new RegExp(`^${east}/api/mcp/servers\\?agent=${agent}`), () => ({ json: { canConfigureTeam: true, servers: [server({ personalState: personal, state: personal })] } }));
  gateways.on("GET", `${east}/api/mcp/oauth/status?agent=${agent}&scope=personal`, () => ({ json: { servers: [{ name: "docs", auth: "oauth", state: personal }] } }));
  gateways.on("GET", `${east}/api/mcp/oauth/status?agent=${agent}&scope=team`, { json: { servers: [{ name: "docs", auth: "oauth", state: "disconnected" }] } });
  gateways.on("POST", "/api/relay/oauth/start", { json: { authorizationUrl: PROVIDER_URL } });
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

async function connectMcp() {
  mount(`/agents/${agent}/mcp-servers/docs`);
  await vi.waitFor(() => expect(button("Connect Docs")).toBeDefined());
  button("Connect Docs")!.click();
  await tick();
}

describe("MCP sign-in of a remote agent", () => {
  it("opens the window in the click, starts through the relay with explicit scope, and confirms from fresh remote status", async () => {
    await connectMcp();
    expect(open).toHaveBeenCalledTimes(1);
    const startIndex = gateways.order.findIndex((line) => line === "fetch POST /api/relay/oauth/start");
    expect(startIndex).toBeGreaterThan(-1);
    expect(gateways.requests.find((request) => request.url === "/api/relay/oauth/start")).toMatchObject({
      body: { gateway: "east", agentId: "assistant@east", scope: "personal", kind: "mcp", server: "docs" },
      headers: { "content-type": "application/json" },
    });
    await vi.waitFor(() => expect(popup.location.href).toBe(PROVIDER_URL));
    expect(text()).toContain("Finish the sign-in in the new window.");
    personal = "connected";
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(button("Disconnect")).toBeDefined());
    expect(popup.closed).toBe(true);
    expect(text()).not.toContain("Finish the sign-in");
    // The page never navigates itself, never sends a return path, and never leaves the relay.
    expect(gateways.localConfigurationRequests([/^\/api\/agents$/, /^\/api\/relay\/oauth\/start$/])).toEqual([]);
    expect(JSON.stringify(gateways.requests.map((request) => request.body))).not.toContain("returnTo");
  });

  it("shows a blocked window and makes no start request", async () => {
    open.mockReturnValue(null);
    await connectMcp();
    await vi.waitFor(() => expect(text()).toContain("blocked the sign-in window"));
    expect(gateways.log()).not.toContain("POST /api/relay/oauth/start");
    expect(button("Connect Docs")?.disabled).toBe(false);
  });

  it("shows a start refusal and closes the blank window", async () => {
    gateways.on("POST", "/api/relay/oauth/start", { status: 403, json: { error: "remote_oauth_denied" } });
    await connectMcp();
    await vi.waitFor(() => expect(text()).toContain("The remote gateway refused this action."));
    expect(popup.closed).toBe(true);
  });

  it("does not report success when the window closes with no new connection", async () => {
    await connectMcp();
    await vi.waitFor(() => expect(popup.location.href).toBe(PROVIDER_URL));
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(text()).toContain("The sign-in window closed before the connection finished."));
    expect(button("Disconnect")).toBeUndefined();
    expect(button("Connect Docs")?.disabled).toBe(false);
  });

  it("times out with a visible message and closes the window", async () => {
    await connectMcp();
    await vi.waitFor(() => expect(popup.location.href).toBe(PROVIDER_URL));
    await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS + OAUTH_POLL_INTERVAL_MS * 2);
    await vi.waitFor(() => expect(text()).toContain("did not finish in time"));
    expect(popup.closed).toBe(true);
  });

  it("lets Cancel end the wait and close the window", async () => {
    await connectMcp();
    await vi.waitFor(() => expect(button("Cancel")).toBeDefined());
    button("Cancel")!.click();
    await tick();
    expect(popup.closed).toBe(true);
    expect(text()).not.toContain("Finish the sign-in");
  });

  it("ends the flow when the page moves to another agent, so a late connection finishes nothing there", async () => {
    await connectMcp();
    await vi.waitFor(() => expect(popup.location.href).toBe(PROVIDER_URL));
    gateways.on("GET", new RegExp(`^${east}/api/mcp/servers\\?agent=other%40east`), { json: { canConfigureTeam: true, servers: [server()] } });
    history.set({ value: "/agents/other%40east/mcp-servers/docs" });
    await tick();
    expect(popup.closed).toBe(true);
    personal = "connected";
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS * 3);
    expect(gateways.log().filter((line) => line.includes("oauth/status?agent=other%40east"))).toEqual([]);
    expect(text()).not.toContain("Finish the sign-in");
  });

  it("ignores a message from any window and decides only from remote status", async () => {
    await connectMcp();
    await vi.waitFor(() => expect(popup.location.href).toBe(PROVIDER_URL));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "yoplai-oauth", extension: "mcp", status: "connected" }, origin: "https://elsewhere.example.test" }));
    await tick();
    expect(button("Disconnect")).toBeUndefined();
    expect(text()).toContain("Finish the sign-in in the new window.");
  });

  it("uses the selected team scope in the start request", async () => {
    mount(`/agents/${agent}/mcp-servers/docs`);
    await vi.waitFor(() => expect(button("Connect Docs")).toBeDefined());
    selectScope(container, "team");
    await tick();
    button("Connect Docs")!.click();
    await tick();
    expect(gateways.requests.find((request) => request.url === "/api/relay/oauth/start")?.body).toMatchObject({ scope: "team", kind: "mcp" });
  });

  it("disconnects, refreshes the icon, and removes only through the named gateway", async () => {
    personal = "connected";
    gateways.on("POST", new RegExp(`^${east}/api/mcp/`), { json: { ok: true, server: server(), status: "unchanged" } });
    mount(`/agents/${agent}/mcp-servers/docs`);
    await vi.waitFor(() => expect(button("Disconnect")).toBeDefined());
    button("Disconnect")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`POST ${east}/api/mcp/oauth/disconnect?agent=${agent}&server=docs&scope=personal`));
    button("Refresh icon")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`POST ${east}/api/mcp/servers/icon/refresh?agent=${agent}&server=docs`));
    await vi.waitFor(() => expect(text()).toContain("No new icon found"));
    button("Remove server")!.click();
    await vi.waitFor(() => expect(button("Confirm remove")).toBeDefined());
    button("Confirm remove")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`POST ${east}/api/mcp/servers/remove?agent=${agent}&server=docs`));
    await vi.waitFor(() => expect(history.get()).toBe(`/agents/${agent}/edit`));
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });
});

describe("core sign-in of a remote agent", () => {
  const google = (partial: Partial<ExtensionCatalogEntry> = {}): ExtensionCatalogEntry => ({
    id: "google", displayName: "Google", description: "Drive", builtIn: false, enabled: true, configured: true, missingConfig: [],
    configurable: true, managedAtRoot: false, configJsonSchema: null, requiredSecrets: [], advancedConfigFields: [], configValues: {},
    configRoutePath: null, oauth: { provider: "google", scopes: ["drive"] }, tier: "toggle-only", ...partial,
  });
  let team: { state: string; connected: boolean; provider: string; scopes?: string[]; connectedAt?: number; canConfigureTeam: boolean };

  beforeEach(() => {
    team = { state: "disconnected", connected: false, provider: "google", canConfigureTeam: true };
    gateways.on("GET", `${east}/api/agents/${agent}/extensions`, { json: { extensions: [google()] } });
    gateways.on("GET", `${east}/api/oauth/google/status?agent=${agent}&scope=team`, () => ({ json: team }));
    gateways.on("GET", `${east}/api/oauth/google/status?agent=${agent}&scope=personal`, { json: { state: "disconnected", connected: false, provider: "google", canConfigureTeam: true } });
  });

  async function connectGoogle() {
    mount(`/agents/${agent}/extensions/google`);
    await vi.waitFor(() => expect(button("Connect Google")).toBeDefined());
    selectScope(container, "team");
    await tick();
    button("Connect Google")!.click();
    await tick();
  }

  it("starts a core grant with explicit scope and the required provider scopes, then confirms the new connection", async () => {
    await connectGoogle();
    expect(gateways.requests.find((request) => request.url === "/api/relay/oauth/start")?.body).toEqual({
      gateway: "east", agentId: "assistant@east", scope: "team", kind: "core", provider: "google", scopes: ["drive"],
    });
    await vi.waitFor(() => expect(popup.location.href).toBe(PROVIDER_URL));
    team = { ...team, state: "connected", connected: true, scopes: ["drive"], connectedAt: 10 };
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(button("Disconnect Google")).toBeDefined());
    expect(popup.closed).toBe(true);
  });

  it("shows a denied grant when the provider did not give the required access", async () => {
    await connectGoogle();
    await vi.waitFor(() => expect(popup.location.href).toBe(PROVIDER_URL));
    team = { ...team, state: "connected", connected: true, scopes: [], connectedAt: 10 };
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(text()).toContain("did not grant the required access"));
    expect(popup.closed).toBe(true);
  });

  it("does not take an old connection for a new grant when the connection time stays the same", async () => {
    team = { ...team, state: "needs_reconnect", connected: false };
    mount(`/agents/${agent}/extensions/google`);
    await vi.waitFor(() => expect(button("Connect Google") ?? button("Reconnect")).toBeDefined());
    selectScope(container, "team");
    await tick();
    button("Reconnect")!.click();
    await tick();
    await vi.waitFor(() => expect(popup.location.href).toBe(PROVIDER_URL));
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(text()).toContain("closed before the connection finished"));
    expect(button("Reconnect")?.disabled).toBe(false);
    expect(text()).not.toContain("Connected as");
  });

  it("starts no status refresh after the page closes during a core disconnect", async () => {
    team = { ...team, state: "connected", connected: true, scopes: ["drive"], connectedAt: 10 };
    let finish: (() => void) | undefined;
    gateways.on("POST", `${east}/api/oauth/google/disconnect?agent=${agent}&scope=team`, () => new Promise((resolve) => { finish = () => resolve({ json: { state: "disconnected", connected: false, provider: "google" } }); }));
    mount(`/agents/${agent}/extensions/google`);
    await vi.waitFor(() => expect(button("Connect Google") ?? button("Disconnect Google")).toBeDefined());
    selectScope(container, "team");
    await vi.waitFor(() => expect(button("Disconnect Google")).toBeDefined());
    button("Disconnect Google")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    history.set({ value: "/review-away" });
    await vi.waitFor(() => expect(text()).toContain("Other page"));
    const before = gateways.requests.length;
    finish!();
    await tick();
    await tick();
    expect(gateways.requests.length).toBe(before);
  });

  it("chooses Just me after the capabilities arrive, even when the team status was ready first", async () => {
    let answerCapabilities!: () => void;
    gateways.on("GET", `${east}/api/capabilities`, () => new Promise((resolve) => { answerCapabilities = () => resolve({ json: remoteCapabilities }); }));
    team = { ...team, state: "connected", connected: true, scopes: ["drive"], connectedAt: 10 };
    gateways.on("GET", `${east}/api/oauth/google/status?agent=${agent}&scope=personal`, { json: { state: "connected", connected: true, provider: "google", scopes: ["drive"], connectedAt: 20, canConfigureTeam: true } });
    gateways.on("POST", `${east}/api/oauth/google/disconnect?agent=${agent}&scope=personal`, { json: { state: "disconnected", connected: false, provider: "google" } });
    mount(`/agents/${agent}/extensions/google`);
    await vi.waitFor(() => expect(answerCapabilities).toBeDefined());
    await tick();
    // No scope is read or chosen before the requester is known.
    expect(gateways.log().filter((line) => line.includes("/oauth/google/status"))).toEqual([]);
    answerCapabilities();
    await vi.waitFor(() => expect(button("Disconnect Google")).toBeDefined());
    expect(activeScope(container)).toBe("personal");
    button("Disconnect Google")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`POST ${east}/api/oauth/google/disconnect?agent=${agent}&scope=personal`));
  });

  it("shows a failed capabilities read with a Retry instead of choosing a scope, and recovers without navigation", async () => {
    let capabilities: { status: number; json: unknown } = { status: 500, json: {} };
    gateways.on("GET", `${east}/api/capabilities`, () => capabilities);
    mount(`/agents/${agent}/extensions/google`);
    await vi.waitFor(() => expect(text()).toContain("Could not read who you are on east."));
    expect(gateways.log().filter((line) => line.includes("/oauth/google/status"))).toEqual([]);
    capabilities = { status: 200, json: remoteCapabilities };
    button("Retry")!.click();
    await vi.waitFor(() => expect(button("Connect Google")).toBeDefined());
    expect(text()).not.toContain("Could not read who you are");
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("names a remote status refusal instead of showing a disconnected grant", async () => {
    gateways.on("GET", `${east}/api/oauth/google/status?agent=${agent}&scope=team`, { status: 403, json: { error: "forbidden" } });
    mount(`/agents/${agent}/extensions/google`);
    await vi.waitFor(() => expect(text()).toContain("OAuth status failed (403)"));
  });
});

describe("MCP configuration of a remote agent", () => {
  it("edits the label and the server config of a remote agent through the relay", async () => {
    gateways.on("GET", new RegExp(`^${east}/api/mcp/servers\\?agent=${agent}`), { json: { canConfigureTeam: true, canEditLabels: true, servers: [server({ auth: "none", state: "connected" })] } });
    gateways.on("GET", `${east}/api/mcp/servers/config?agent=${agent}&server=docs`, { json: { name: "docs", type: "http", editable: true, config: { url: "https://docs.test/mcp" } } });
    gateways.on("POST", `${east}/api/mcp/servers/config?agent=${agent}&server=docs`, (request) => ({ json: { name: "docs", type: "http", editable: true, config: (request.body as { config: unknown }).config } }));
    gateways.on("POST", `${east}/api/mcp/servers/label?agent=${agent}&server=docs`, { json: { ok: true } });
    mount(`/agents/${agent}/mcp-servers/docs`);
    await vi.waitFor(() => expect(container.querySelector("textarea")?.value).toContain("https://docs.test/mcp"));
    const editor = container.querySelector("textarea")!;
    editor.value = JSON.stringify({ url: "https://docs.test/v2" });
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    button("Save")!.click();
    await vi.waitFor(() => expect(gateways.requests.find((request) => request.url === `${east}/api/mcp/servers/config?agent=${agent}&server=docs` && request.method === "POST")?.body).toEqual({ config: { url: "https://docs.test/v2" } }));
    container.querySelector("summary")!.click();
    button("Update name and description")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`POST ${east}/api/mcp/servers/label?agent=${agent}&server=docs`));
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("enables a shared catalog server for the remote agent through the relay", async () => {
    gateways.on("GET", new RegExp(`^${east}/api/mcp/servers\\?agent=${agent}`), { json: { canConfigureTeam: true, servers: [server({ shared: true, enabled: false })] } });
    gateways.on("POST", `${east}/api/mcp/servers/shared?agent=${agent}&server=docs`, (request) => ({ json: { server: server({ shared: true, enabled: (request.body as { enabled: boolean }).enabled }) } }));
    mount(`/agents/${agent}/mcp-servers/docs`);
    await vi.waitFor(() => expect(button("Enable")).toBeDefined());
    button("Enable")!.click();
    await vi.waitFor(() => expect(gateways.requests.find((request) => request.url.includes("/mcp/servers/shared"))?.body).toEqual({ enabled: true }));
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });
});

describe("late answers of MCP controls", () => {
  const other = "other%40east";
  beforeEach(() => {
    gateways.on("GET", new RegExp(`^${east}/api/mcp/servers\\?agent=${other}`), { json: { canConfigureTeam: true, servers: [server({ personalState: "connected", state: "connected" })] } });
    gateways.on("GET", `${east}/api/mcp/oauth/status?agent=${other}&scope=personal`, { json: { servers: [{ name: "docs", auth: "oauth", state: "connected" }] } });
    gateways.on("GET", `${east}/api/mcp/oauth/status?agent=${other}&scope=team`, { json: { servers: [{ name: "docs", auth: "oauth", state: "disconnected" }] } });
  });

  it("does not navigate after the MCP page closes, and starts no refresh or error", async () => {
    personal = "connected";
    let finish: (() => void) | undefined;
    gateways.on("POST", `${east}/api/mcp/servers/remove?agent=${agent}&server=docs`, () => new Promise((resolve) => { finish = () => resolve({ json: { ok: true } }); }));
    mount(`/agents/${agent}/mcp-servers/docs`);
    await vi.waitFor(() => expect(button("Remove server")).toBeDefined());
    button("Remove server")!.click();
    await vi.waitFor(() => expect(button("Confirm remove")).toBeDefined());
    button("Confirm remove")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    history.set({ value: "/review-away" });
    await vi.waitFor(() => expect(text()).toContain("Other page"));
    const before = gateways.requests.length;
    finish!();
    await tick();
    await tick();
    expect(history.get()).toBe("/review-away");
    expect(gateways.requests.length).toBe(before);
  });

  it("starts no list refresh after the page closes during a disconnect", async () => {
    personal = "connected";
    let finish: (() => void) | undefined;
    gateways.on("POST", `${east}/api/mcp/oauth/disconnect?agent=${agent}&server=docs&scope=personal`, () => new Promise((resolve) => { finish = () => resolve({ json: { ok: true } }); }));
    mount(`/agents/${agent}/mcp-servers/docs`);
    await vi.waitFor(() => expect(button("Disconnect")).toBeDefined());
    button("Disconnect")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    history.set({ value: "/review-away" });
    await vi.waitFor(() => expect(text()).toContain("Other page"));
    const before = gateways.requests.length;
    finish!();
    await tick();
    await tick();
    expect(gateways.requests.length).toBe(before);
  });

  it("does not leave the page for the old agent when its remove ends late", async () => {
    personal = "connected";
    let finish: (() => void) | undefined;
    gateways.on("POST", `${east}/api/mcp/servers/remove?agent=${agent}&server=docs`, () => new Promise((resolve) => { finish = () => resolve({ json: { ok: true } }); }));
    mount(`/agents/${agent}/mcp-servers/docs`);
    await vi.waitFor(() => expect(button("Remove server")).toBeDefined());
    button("Remove server")!.click();
    await vi.waitFor(() => expect(button("Confirm remove")).toBeDefined());
    button("Confirm remove")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    history.set({ value: `/agents/${other}/mcp-servers/docs` });
    await vi.waitFor(() => expect(button("Remove server")).toBeDefined());
    finish!();
    await tick();
    await tick();
    expect(history.get()).toBe(`/agents/${other}/mcp-servers/docs`);
    expect(button("Remove server")?.disabled).toBe(false);
  });

  it("ignores a late disconnect error of the old agent and keeps the new page usable", async () => {
    personal = "connected";
    let fail: (() => void) | undefined;
    gateways.on("POST", `${east}/api/mcp/oauth/disconnect?agent=${agent}&server=docs&scope=personal`, () => new Promise((resolve) => { fail = () => resolve({ status: 403, json: { error: "forbidden" } }); }));
    mount(`/agents/${agent}/mcp-servers/docs`);
    await vi.waitFor(() => expect(button("Disconnect")).toBeDefined());
    button("Disconnect")!.click();
    await vi.waitFor(() => expect(fail).toBeDefined());
    history.set({ value: `/agents/${other}/mcp-servers/docs` });
    await vi.waitFor(() => expect(button("Disconnect")).toBeDefined());
    fail!();
    await tick();
    await tick();
    expect(text()).not.toContain("Failed to disconnect MCP server.");
    expect(button("Disconnect")?.disabled).toBe(false);
  });

  it("does not carry an unsaved config draft to the next agent, and sends no old draft", async () => {
    gateways.on("GET", new RegExp(`^${east}/api/mcp/servers\\?agent=(${agent}|${other})`), { json: { canConfigureTeam: true, servers: [server({ auth: "none", state: "connected" })] } });
    gateways.on("GET", `${east}/api/mcp/servers/config?agent=${agent}&server=docs`, { json: { name: "docs", type: "http", editable: true, config: { url: "https://east.test/mcp" } } });
    gateways.on("GET", `${east}/api/mcp/servers/config?agent=${other}&server=docs`, { json: { name: "docs", type: "http", editable: true, config: { url: "https://other.test/mcp" } } });
    gateways.on("POST", `${east}/api/mcp/servers/config?agent=${other}&server=docs`, { json: { name: "docs", type: "http", editable: true, config: {} } });
    mount(`/agents/${agent}/mcp-servers/docs`);
    await vi.waitFor(() => expect(container.querySelector("textarea")?.value).toContain("east.test"));
    const editor = container.querySelector("textarea")!;
    editor.value = JSON.stringify({ url: "https://draft.test/mcp" });
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    history.set({ value: `/agents/${other}/mcp-servers/docs` });
    await vi.waitFor(() => expect(container.querySelector("textarea")?.value).toContain("other.test"));
    button("Save")!.click();
    await vi.waitFor(() => expect(gateways.requests.some((request) => request.method === "POST" && request.url.includes("/mcp/servers/config"))).toBe(true));
    expect(JSON.stringify(gateways.requests.filter((request) => request.method === "POST").map((request) => request.body))).not.toContain("draft.test");
  });
});
