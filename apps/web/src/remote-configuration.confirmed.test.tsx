// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Suspense, type JSX } from "solid-js";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { createFakeGateways, relayPrefix } from "./remote-gateway.fixture";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "./lib/capabilities";
import { renderExtensionRoutes } from "./lib/web-route-registry";
import { ExtensionDetails } from "./pages/ExtensionDetails";
import { SchedulesPanel } from "./pages/SchedulesPanel";
import type { ExtensionCatalogEntry } from "./api/extensions";

vi.mock("./components/LeftNavShell", () => ({ LeftNavShell: (props: { children?: JSX.Element }) => <div>{props.children}</div> }));
vi.mock("./auth/client", () => ({ useSession: () => () => ({ isPending: false, data: null }) }));

const east = relayPrefix("east");
const agent = "assistant%40east";

const caps = (overrides: Record<string, unknown> = {}) => ({
  version: 2, extensions: { scheduler: true }, agents: ["assistant"], multiUser: true, enableCronMonitoring: true,
  user: { id: "remote-alice", name: "Alice", email: "alice@example.test", role: "admin" }, ...overrides,
});
const webhooksEntry = (): ExtensionCatalogEntry => ({
  id: "webhooks", displayName: "Webhooks", description: "Inbound webhooks", builtIn: true, enabled: false, configured: false,
  missingConfig: [], configurable: true, managedAtRoot: false, configJsonSchema: null, requiredSecrets: [], advancedConfigFields: [],
  configValues: {}, configRoutePath: "/agents/assistant/extensions/webhooks", oauth: null, tier: "bespoke-route",
});

let gateways: ReturnType<typeof createFakeGateways>;
let container: HTMLElement;
let dispose: (() => void) | undefined;
let history: ReturnType<typeof createMemoryHistory>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = () => container.textContent ?? "";
const button = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim().startsWith(name));
const link = (name: string) => Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find((item) => item.textContent?.includes(name));
const nonReads = () => gateways.requests.filter((request) => request.method !== "GET");

function mount(path: string, panel?: { gateway?: string }) {
  history = createMemoryHistory();
  history.set({ value: path, replace: true });
  dispose = render(() => (
    <MemoryRouter history={history} root={(props: { children?: JSX.Element }) => <Suspense>{props.children}</Suspense>}>
      {renderExtensionRoutes()}
      <Route path="/agents/:agentId/extensions/:extensionId" component={() => <ExtensionDetails />} />
      <Route path="/schedules" component={() => <SchedulesPanel agentId="assistant@east" agentName="East Assistant" gateway={panel?.gateway ?? "east"} />} />
    </MemoryRouter>
  ), container);
}

beforeEach(() => {
  localStorage.clear();
  setCapabilitiesForTests({ extensions: { webhooks: true }, multiUser: false });
  gateways = createFakeGateways();
  gateways.on("GET", "/api/agents", { json: [
    { id: "assistant", name: "Local Assistant" },
    { id: "assistant@east", name: "East Assistant", gateway: "east" },
  ] });
  gateways.on("GET", `${east}/api/capabilities`, { json: caps() });
  gateways.on("GET", `${east}/api/agents/${agent}/extensions`, { json: { extensions: [webhooksEntry()] } });
  gateways.on("GET", `${east}/api/agents/${agent}/webhooks`, { json: [] });
  vi.stubGlobal("fetch", gateways.fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCapabilitiesForTests();
});

describe("Webhooks page of a remote agent", () => {
  it("shows an unavailable state, with no link to the same closed route, when the remote does not load Webhooks", async () => {
    // The local gateway loads Webhooks. Only the remote capabilities decide for the remote agent.
    mount(`/agents/${agent}/extensions/webhooks`);
    await vi.waitFor(() => expect(text()).toContain("not available"));
    expect(link("Configure")).toBeUndefined();
    expect(container.querySelector('a[href*="/extensions/webhooks"]')).toBeNull();
    expect(gateways.log().some((entry) => entry.includes("/webhooks"))).toBe(false);
    // The page enables nothing as a side effect.
    expect(nonReads()).toEqual([]);
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("shows Retry when the remote capabilities fail, and opens the page after a read that works", async () => {
    let failing = true;
    gateways.on("GET", `${east}/api/capabilities`, () => failing ? { status: 502, json: { error: "gateway_offline" } } : { json: caps({ extensions: { webhooks: true } }) });
    mount(`/agents/${agent}/extensions/webhooks`);
    await vi.waitFor(() => expect(button("Retry")).toBeDefined());
    expect(link("Configure")).toBeUndefined();
    expect(gateways.log().some((entry) => entry.includes("/webhooks"))).toBe(false);
    failing = false;
    button("Retry")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`GET ${east}/api/agents/${agent}/webhooks`));
    expect(nonReads()).toEqual([]);
  });

  it("opens the remote page when the remote loads Webhooks and the local gateway does not", async () => {
    setCapabilitiesForTests({ extensions: {}, multiUser: false });
    gateways.on("GET", `${east}/api/capabilities`, { json: caps({ extensions: { webhooks: true } }) });
    mount(`/agents/${agent}/extensions/webhooks`);
    await vi.waitFor(() => expect(gateways.log()).toContain(`GET ${east}/api/agents/${agent}/webhooks`));
    expect(text()).not.toContain("not available");
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("shows an unavailable state for a local agent when the local gateway does not load Webhooks", async () => {
    setCapabilitiesForTests({ extensions: {}, multiUser: false });
    gateways.on("GET", "/api/agents/assistant/extensions", { json: { extensions: [webhooksEntry()] } });
    mount("/agents/assistant/extensions/webhooks");
    await vi.waitFor(() => expect(text()).toContain("not available"));
    expect(link("Configure")).toBeUndefined();
  });

  it("keeps the Configure link on the generic page where the remote loads the extension", async () => {
    gateways.on("GET", `${east}/api/capabilities`, { json: caps({ extensions: { webhooks: true } }) });
    mount(`/agents/${agent}/extensions/other`);
    gateways.on("GET", `${east}/api/agents/${agent}/extensions`, { json: { extensions: [{ ...webhooksEntry(), id: "other", displayName: "Other" }] } });
    await vi.waitFor(() => expect(text()).toContain("Other"));
    // The extension "other" has no remote module, so the page shows the state and no link.
    await vi.waitFor(() => expect(text()).toContain("not available"));
    expect(link("Configure")).toBeUndefined();
  });
});

describe("Mine credentials of a remote scheduled job", () => {
  const job = (partial: Record<string, unknown> = {}) => ({
    id: "job-1", agentId: "assistant@east", name: "Digest", credentialMode: "team", createdByUserId: "other",
    schedule: { cron: "0 8 * * *", tz: "UTC" }, payload: { message: "Send digest" }, enabled: true, ...partial,
  });
  const mine = () => container.querySelector<HTMLButtonElement>('[role="radiogroup"] [role="radio"]:nth-of-type(1)');
  const radio = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((item) => item.textContent?.trim() === label);

  beforeEach(() => {
    setCapabilitiesForTests({ extensions: { scheduler: true }, multiUser: false, enableCronMonitoring: true });
    gateways.on("GET", `${east}/api/schedules?agent=${agent}`, { json: [job()] });
  });

  it("disables Mine and sends nothing when the remote confirmed no user", async () => {
    gateways.on("GET", `${east}/api/capabilities`, { json: caps({ multiUser: false, user: undefined }) });
    mount("/schedules");
    await vi.waitFor(() => expect(text()).toContain("Digest"));
    await vi.waitFor(() => expect(radio("Mine")?.disabled).toBe(true));
    radio("Mine")!.click();
    await tick();
    expect(nonReads()).toEqual([]);
    // The Team control still works for a single-user gateway.
    expect(radio("Team")?.disabled).toBe(false);
    void mine;
  });

  it("does not copy the local identity to a remote page", async () => {
    setCapabilitiesForTests({ extensions: { scheduler: true }, multiUser: true, enableCronMonitoring: true, user: { id: "local-bob", role: "admin" } } as never);
    gateways.on("GET", `${east}/api/capabilities`, { json: caps({ multiUser: false, user: undefined }) });
    mount("/schedules");
    await vi.waitFor(() => expect(text()).toContain("Digest"));
    await vi.waitFor(() => expect(radio("Mine")?.disabled).toBe(true));
  });

  it("allows Mine for a confirmed remote user and sends the owner mode through the relay", async () => {
    gateways.on("PATCH", `${east}/api/schedules/${agent}/job-1`, { json: job({ credentialMode: "owner", ownerUserId: "remote-alice" }) });
    mount("/schedules");
    await vi.waitFor(() => expect(text()).toContain("Digest"));
    await vi.waitFor(() => expect(radio("Mine")?.disabled).toBe(false));
    radio("Mine")!.click();
    await vi.waitFor(() => expect(nonReads()).toHaveLength(1));
    expect(nonReads()[0]).toMatchObject({ method: "PATCH", url: `${east}/api/schedules/${agent}/job-1`, body: { credentialMode: "owner" } });
  });

  it("shows the message of a refused userless owner mode", async () => {
    gateways.on("PATCH", `${east}/api/schedules/${agent}/job-1`, { status: 403, json: { error: "owner_requires_user", message: "Owner credentials need a signed-in user." } });
    mount("/schedules");
    await vi.waitFor(() => expect(text()).toContain("Digest"));
    await vi.waitFor(() => expect(radio("Mine")?.disabled).toBe(false));
    radio("Mine")!.click();
    await vi.waitFor(() => expect(text()).toContain("Owner credentials need a signed-in user."));
    expect(text()).not.toContain("Failed to update scheduled job");
  });
});
