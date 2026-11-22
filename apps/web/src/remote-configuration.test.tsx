// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Suspense, type JSX } from "solid-js";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { createFakeGateways, relayPrefix } from "./remote-gateway.fixture";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "./lib/capabilities";
import { renderExtensionRoutes } from "./lib/web-route-registry";
import { ExtensionDetails } from "./pages/ExtensionDetails";
import { ScheduleRuns } from "./pages/ScheduleRuns";
import { ScheduleRunTrace } from "./pages/ScheduleRunTrace";
import { selectScope } from "./components/CredentialScopeTabs.testing";
import type { ExtensionCatalogEntry } from "./api/extensions";

vi.mock("./auth/client", () => ({ useSession: () => () => ({ isPending: false, data: null }) }));
vi.mock("./components/LeftNavShell", () => ({ LeftNavShell: (props: { children?: JSX.Element }) => <div>{props.children}</div> }));

const east = relayPrefix("east");
const west = relayPrefix("west");

const remoteCapabilities = {
  version: 2,
  extensions: { scheduler: true, webhooks: true },
  agents: ["assistant"],
  multiUser: true,
  enableCronMonitoring: true,
  user: { id: "remote-alice", name: "Alice", role: "admin" },
};

function entry(partial: Partial<ExtensionCatalogEntry> = {}): ExtensionCatalogEntry {
  return {
    id: "exa", displayName: "Exa", description: "Exa web search", builtIn: false, enabled: false, configured: true,
    missingConfig: [], configurable: true, managedAtRoot: false, configJsonSchema: null, requiredSecrets: [],
    advancedConfigFields: [], configValues: {}, configRoutePath: null, oauth: null, tier: "toggle-only", ...partial,
  };
}

let gateways: ReturnType<typeof createFakeGateways>;
let container: HTMLElement;
let dispose: (() => void) | undefined;
let history: ReturnType<typeof createMemoryHistory>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = () => container.textContent ?? "";
const link = (name: string) => Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find((item) => item.textContent?.includes(name));
const button = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim().startsWith(name));

function mount(path: string) {
  history = createMemoryHistory();
  history.set({ value: path, replace: true });
  dispose = render(() => (
    <MemoryRouter history={history} root={(props) => <Suspense>{props.children}</Suspense>}>
      <Route path="/agents/:agentId/extensions/:extensionId" component={() => <ExtensionDetails />} />
      <Route path="/agents/:agentId/schedules/:jobId/runs" component={ScheduleRuns} />
      <Route path="/agents/:agentId/schedules/:jobId/runs/:runId" component={ScheduleRunTrace} />
      <Route path="/review-away" component={() => <h1>Other page</h1>} />
      {renderExtensionRoutes((Component) => <Component />)}
    </MemoryRouter>
  ), container);
}
const go = (path: string) => history.set({ value: path });

beforeEach(() => {
  localStorage.clear();
  setCapabilitiesForTests({ extensions: {}, multiUser: false, enableCronMonitoring: false });
  gateways = createFakeGateways();
  gateways.on("GET", "/api/agents", { json: [
    { id: "assistant", name: "Local Assistant" },
    { id: "assistant@east", name: "East Assistant", gateway: "east" },
    { id: "assistant@west", name: "West Assistant", gateway: "west" },
  ] });
  gateways.on("GET", `${east}/api/capabilities`, { json: remoteCapabilities });
  gateways.on("GET", `${west}/api/capabilities`, { json: { ...remoteCapabilities, extensions: {}, enableCronMonitoring: false, user: undefined, multiUser: false } });
  vi.stubGlobal("fetch", gateways.fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCapabilitiesForTests();
});

describe("extension page of a remote agent", () => {
  it("reads and changes the extension through the relay only, and returns to the qualified agent", async () => {
    gateways.on("GET", `${east}/api/agents/assistant%40east/extensions`, { json: { extensions: [entry({ displayName: "Remote Exa" })] } });
    gateways.on("PATCH", `${east}/api/agents/assistant%40east/extensions/exa`, { json: { extensions: [entry({ displayName: "Remote Exa", enabled: true })] } });
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("Remote Exa"));
    expect(link("Back to agent")?.getAttribute("href")).toBe("/agents/assistant%40east/edit");
    button("Enable")!.click();
    await vi.waitFor(() => expect(button("Disable")).toBeDefined());
    expect(gateways.log()).toContain(`PATCH ${east}/api/agents/assistant%40east/extensions/exa`);
    expect(gateways.localConfigurationRequests()).toEqual([]);
    expect(gateways.unexpected).toEqual([]);
  });

  it("keeps a local agent and a remote agent with the same extension apart in one session", async () => {
    gateways.on("GET", "/api/agents/assistant/extensions", { json: { extensions: [entry({ displayName: "Local Exa" })] } });
    gateways.on("GET", `${east}/api/agents/assistant%40east/extensions`, { json: { extensions: [entry({ displayName: "East Exa" })] } });
    gateways.on("GET", `${west}/api/agents/assistant%40west/extensions`, { json: { extensions: [entry({ displayName: "West Exa" })] } });
    mount("/agents/assistant/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("Local Exa"));
    go("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("East Exa"));
    expect(text()).not.toContain("Local Exa");
    go("/agents/assistant%40west/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("West Exa"));
    expect(text()).not.toContain("East Exa");
    expect(gateways.unexpected).toEqual([]);
  });

  it("makes no configuration call and shows a retry when the agent cannot be resolved", async () => {
    let listing = 500;
    gateways.on("GET", "/api/agents", () => ({ status: listing, json: [{ id: "assistant@east", name: "East Assistant", gateway: "east" }] }));
    gateways.on("GET", `${east}/api/agents/assistant%40east/extensions`, { json: { extensions: [entry({ displayName: "East Exa" })] } });
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("This agent is unavailable"));
    expect(gateways.log().filter((line) => line.includes("/extensions"))).toEqual([]);
    listing = 200;
    button("Retry")!.click();
    await vi.waitFor(() => expect(text()).toContain("East Exa"));
  });

  it("does not treat an agent that is not in the list as local", async () => {
    mount("/agents/ghost%40east/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("This agent is unavailable"));
    expect(gateways.requests.map((request) => request.url)).toEqual(["/api/agents"]);
  });

  it("links a bespoke config page to the qualified agent, not to the raw remote agent", async () => {
    // The remote loads the module, so its bespoke page opens from the link.
    gateways.on("GET", `${east}/api/capabilities`, { json: { ...remoteCapabilities, extensions: { ...remoteCapabilities.extensions, notes: true } } });
    gateways.on("GET", `${east}/api/agents/assistant%40east/extensions`, { json: { extensions: [entry({ id: "notes", displayName: "Notes", tier: "bespoke-route", configRoutePath: "/agents/assistant/extensions/notes/settings" })] } });
    mount("/agents/assistant%40east/extensions/notes");
    await vi.waitFor(() => expect(text()).toContain("Notes"));
    expect(link("Configure")?.getAttribute("href")).toBe("/agents/assistant%40east/extensions/notes/settings");
  });
});

describe("refusals and late answers of a remote gateway", () => {
  it("shows a refused remote change and makes no local change", async () => {
    gateways.on("GET", `${east}/api/agents/assistant%40east/extensions`, { json: { extensions: [entry({ displayName: "East Exa" })] } });
    gateways.on("PATCH", `${east}/api/agents/assistant%40east/extensions/exa`, { status: 403, json: { error: "forbidden" } });
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(button("Enable")).toBeDefined());
    button("Enable")!.click();
    await vi.waitFor(() => expect(text()).toContain("Failed to update extension"));
    expect(button("Enable")).toBeDefined();
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("shows an offline gateway as a load error, not as an empty extension list", async () => {
    gateways.on("GET", `${east}/api/agents/assistant%40east/extensions`, { status: 502, json: { error: "gateway_offline" } });
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("Failed to load extension."));
    expect(text()).not.toContain("Extension not found.");
  });

  it("drops a late extension answer of the old gateway after the page moved to another agent", async () => {
    let finishEast: (() => void) | undefined;
    gateways.on("GET", `${east}/api/agents/assistant%40east/extensions`, () => new Promise((resolve) => {
      finishEast = () => resolve({ json: { extensions: [entry({ displayName: "East Exa" })] } });
    }));
    gateways.on("GET", `${west}/api/agents/assistant%40west/extensions`, { json: { extensions: [entry({ displayName: "West Exa" })] } });
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(finishEast).toBeDefined());
    go("/agents/assistant%40west/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("West Exa"));
    finishEast!();
    await tick();
    await tick();
    expect(text()).toContain("West Exa");
    expect(text()).not.toContain("East Exa");
  });

  it("drops a late webhook change of the old agent after the page moved to a local agent", async () => {
    setCapabilitiesForTests({ extensions: { webhooks: true }, multiUser: false });
    const hook = { name: "triage", credentialMode: "team", enabled: true, url: "https://east.example.test/hook" };
    let finish: (() => void) | undefined;
    gateways.on("GET", `${east}/api/agents/assistant%40east/webhooks`, { json: [hook] });
    gateways.on("PATCH", `${east}/api/agents/assistant%40east/webhooks/triage`, () => new Promise((resolve) => { finish = () => resolve({ json: { ...hook, enabled: false } }); }));
    gateways.on("GET", "/api/agents/assistant/webhooks", { json: [{ ...hook, url: "https://local.example.test/hook" }] });
    mount("/agents/assistant%40east/extensions/webhooks");
    await vi.waitFor(() => expect(container.querySelector('[role="switch"]')).not.toBeNull());
    container.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    go("/agents/assistant/extensions/webhooks");
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe("https://local.example.test/hook"));
    finish!();
    await tick();
    await tick();
    expect(container.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe("https://local.example.test/hook");
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  });
});

describe("webhook page route", () => {
  const hooks = [{ name: "triage", credentialMode: "team", enabled: true, url: "https://east.example.test/hooks/assistant/triage/secret" }];

  it("opens for a remote agent when only the remote gateway loads webhooks", async () => {
    gateways.on("GET", `${east}/api/agents/assistant%40east/webhooks`, { json: hooks });
    gateways.on("PATCH", `${east}/api/agents/assistant%40east/webhooks/triage`, { json: { ...hooks[0], enabled: false } });
    mount("/agents/assistant%40east/extensions/webhooks");
    await vi.waitFor(() => expect(text()).toContain("Webhooks"));
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe(hooks[0].url));
    expect(link("Back to agent")?.getAttribute("href")).toBe("/agents/assistant%40east/edit");
    container.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`PATCH ${east}/api/agents/assistant%40east/webhooks/triage`));
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("does not use the local extension list for a remote agent", async () => {
    setCapabilitiesForTests({ extensions: { webhooks: true }, multiUser: false });
    gateways.on("GET", `${west}/api/agents/assistant%40west/extensions`, { json: { extensions: [entry({ id: "webhooks", displayName: "Webhooks on west", tier: "toggle-only" })] } });
    mount("/agents/assistant%40west/extensions/webhooks");
    // The west gateway does not load webhooks. The generic page opens, and no webhook call goes out.
    await vi.waitFor(() => expect(text()).toContain("Webhooks on west"));
    expect(gateways.log().filter((line) => line.includes("/webhooks"))).toEqual([]);
  });

  it("opens the generic page for a local agent while the local gateway has no webhooks", async () => {
    gateways.on("GET", "/api/agents/assistant/extensions", { json: { extensions: [entry({ id: "webhooks", displayName: "Local hooks", tier: "toggle-only" })] } });
    mount("/agents/assistant/extensions/webhooks");
    await vi.waitFor(() => expect(text()).toContain("Local hooks"));
    expect(gateways.log().filter((line) => line.includes("/webhooks"))).toEqual([]);
  });

  it("keeps webhooks of equal agent IDs on two gateways apart", async () => {
    setCapabilitiesForTests({ extensions: { webhooks: true }, multiUser: false });
    gateways.on("GET", `${east}/api/agents/assistant%40east/webhooks`, { json: [{ ...hooks[0], url: "https://east.example.test/hook" }] });
    gateways.on("GET", "/api/agents/assistant/webhooks", { json: [{ ...hooks[0], url: "https://local.example.test/hook" }] });
    mount("/agents/assistant/extensions/webhooks");
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe("https://local.example.test/hook"));
    go("/agents/assistant%40east/extensions/webhooks");
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe("https://east.example.test/hook"));
  });
});

describe("schedule history of a remote agent", () => {
  const run = (id: string) => ({ id, jobId: "job-1", agentId: "assistant", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:05.000Z", status: "ok", runKind: "scheduled" });

  it("reads the history through the relay and links each run to the qualified agent", async () => {
    gateways.on("GET", `${east}/api/schedules/assistant%40east/job-1/runs`, { json: { runs: [run("run-east")] } });
    mount("/agents/assistant%40east/schedules/job-1/runs");
    await vi.waitFor(() => expect(link("OK")).toBeDefined());
    expect(link("OK")?.getAttribute("href")).toBe("/agents/assistant%40east/schedules/job-1/runs/run-east");
    expect(link("Back to agent")?.getAttribute("href")).toBe("/agents/assistant%40east/edit");
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("uses the schedule monitoring flag of the remote gateway, not the local flag", async () => {
    // The local gateway has monitoring off. The east gateway has it on, and the west gateway has it off.
    mount("/agents/assistant%40west/schedules/job-1/runs");
    await vi.waitFor(() => expect(text()).toContain("Run history is unavailable."));
    expect(gateways.log().filter((line) => line.includes("/schedules"))).toEqual([]);
  });

  it("keeps runs of the same job ID on two gateways apart and drops old rows after a gateway change", async () => {
    setCapabilitiesForTests({ extensions: { scheduler: true }, multiUser: false, enableCronMonitoring: true });
    gateways.on("GET", `${east}/api/schedules/assistant%40east/job-1/runs`, { json: { runs: [run("run-east")] } });
    gateways.on("GET", "/api/schedules/assistant/job-1/runs", { json: { runs: [run("run-local")] } });
    mount("/agents/assistant/schedules/job-1/runs");
    await vi.waitFor(() => expect(link("OK")?.getAttribute("href")).toContain("run-local"));
    go("/agents/assistant%40east/schedules/job-1/runs");
    await vi.waitFor(() => expect(link("OK")?.getAttribute("href")).toContain("run-east"));
    expect(container.querySelectorAll("a[href*='run-local']")).toHaveLength(0);
  });

  it("shows a failed remote read and keeps no rows of another gateway", async () => {
    setCapabilitiesForTests({ extensions: { scheduler: true }, multiUser: false, enableCronMonitoring: true });
    gateways.on("GET", "/api/schedules/assistant/job-1/runs", { json: { runs: [run("run-local")] } });
    gateways.on("GET", `${east}/api/schedules/assistant%40east/job-1/runs`, { status: 502, json: { error: "gateway_offline" } });
    mount("/agents/assistant/schedules/job-1/runs");
    await vi.waitFor(() => expect(link("OK")).toBeDefined());
    go("/agents/assistant%40east/schedules/job-1/runs");
    await vi.waitFor(() => expect(text()).toContain("Failed to load run history."));
    expect(container.querySelectorAll("a[href*='run-local']")).toHaveLength(0);
  });
});

describe("schedule pages while the next visit loads", () => {
  const run = (id: string, jobId: string) => ({ id, jobId, agentId: "assistant", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:05.000Z", status: "ok", runKind: "scheduled" });
  const trace = (id: string, jobId: string, prompt: string) => ({ run: { ...run(id, jobId), prompt }, messages: [] });
  const localCapabilities = () => setCapabilitiesForTests({ extensions: { scheduler: true }, multiUser: false, enableCronMonitoring: true });

  it("shows no rows of the previous job under the next job while its history is pending", async () => {
    localCapabilities();
    let answerNext!: () => void;
    gateways.on("GET", "/api/schedules/assistant/job-1/runs", { json: { runs: [run("run-one", "job-1")] } });
    gateways.on("GET", "/api/schedules/assistant/job-2/runs", () => new Promise((resolve) => { answerNext = () => resolve({ json: { runs: [run("run-two", "job-2")] } }); }));
    mount("/agents/assistant/schedules/job-1/runs");
    await vi.waitFor(() => expect(link("OK")?.getAttribute("href")).toContain("run-one"));
    go("/agents/assistant/schedules/job-2/runs");
    await vi.waitFor(() => expect(answerNext).toBeDefined());
    expect(text()).toContain("Job: job-2");
    expect(container.querySelectorAll("a[href*='run-one']")).toHaveLength(0);
    expect(link("OK")).toBeUndefined();
    answerNext();
    await vi.waitFor(() => expect(link("OK")?.getAttribute("href")).toContain("run-two"));
  });

  it("shows no transcript of the previous run under the next run while its trace is pending", async () => {
    localCapabilities();
    let answerNext!: () => void;
    gateways.on("GET", "/api/schedules/assistant/job-1/runs/run-one/trace", { json: trace("run-one", "job-1", "Prompt of the first run") });
    gateways.on("GET", "/api/schedules/assistant/job-1/runs/run-two/trace", () => new Promise((resolve) => { answerNext = () => resolve({ json: trace("run-two", "job-1", "Prompt of the second run") }); }));
    mount("/agents/assistant/schedules/job-1/runs/run-one");
    await vi.waitFor(() => expect(text()).toContain("Prompt of the first run"));
    go("/agents/assistant/schedules/job-1/runs/run-two");
    await vi.waitFor(() => expect(answerNext).toBeDefined());
    expect(text()).not.toContain("Prompt of the first run");
    answerNext();
    await vi.waitFor(() => expect(text()).toContain("Prompt of the second run"));
  });

  it("shows a failed capabilities read with a Retry, not an unavailable page, and loads the history after it", async () => {
    let capabilities: { status: number; json: unknown } = { status: 500, json: {} };
    gateways.on("GET", `${east}/api/capabilities`, () => capabilities);
    gateways.on("GET", `${east}/api/schedules/assistant%40east/job-1/runs`, { json: { runs: [run("run-east", "job-1")] } });
    mount("/agents/assistant%40east/schedules/job-1/runs");
    await vi.waitFor(() => expect(text()).toContain("Could not read what the gateway of this agent offers."));
    expect(text()).not.toContain("Run history is unavailable.");
    expect(gateways.log().filter((line) => line.includes("/schedules"))).toEqual([]);
    capabilities = { status: 200, json: remoteCapabilities };
    button("Retry")!.click();
    await vi.waitFor(() => expect(link("OK")?.getAttribute("href")).toContain("run-east"));
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("shows a failed capabilities read with a Retry on the trace page too", async () => {
    let capabilities: { status: number; json: unknown } = { status: 500, json: {} };
    gateways.on("GET", `${east}/api/capabilities`, () => capabilities);
    gateways.on("GET", `${east}/api/schedules/assistant%40east/job-1/runs/run-east/trace`, { json: trace("run-east", "job-1", "Prompt of the east run") });
    mount("/agents/assistant%40east/schedules/job-1/runs/run-east");
    await vi.waitFor(() => expect(text()).toContain("Could not read what the gateway of this agent offers."));
    expect(text()).not.toContain("Run trace is unavailable.");
    capabilities = { status: 200, json: remoteCapabilities };
    button("Retry")!.click();
    await vi.waitFor(() => expect(text()).toContain("Prompt of the east run"));
  });
});

describe("credential actions of a remote agent", () => {
  const secret = (partial: Partial<ExtensionCatalogEntry> = {}) => entry({
    configJsonSchema: { type: "object", properties: { apiKey: { type: "string" } }, required: ["apiKey"] },
    requiredSecrets: ["apiKey"], personalSecretFields: ["apiKey"], canConfigureTeam: true, configValues: { apiKey: "********" },
    tier: "auto-form", enabled: true, ...partial,
  });
  const q = "assistant%40east";

  it("removes personal and team credentials and saves settings through the relay", async () => {
    gateways.on("GET", `${east}/api/agents/${q}/extensions`, { json: { extensions: [secret()] } });
    gateways.on("DELETE", `${east}/api/agents/${q}/connections/extension/exa`, { json: { ok: true } });
    gateways.on("DELETE", `${east}/api/agents/${q}/extensions/exa/credentials`, { json: { extensions: [secret({ configValues: {} })] } });
    gateways.on("PATCH", `${east}/api/agents/${q}/extensions/exa`, { json: { extensions: [secret()] } });
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("Exa"));
    await tick();
    selectScope(container, "personal");
    await vi.waitFor(() => expect(button("Remove my credentials")).toBeDefined());
    const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    key.value = "new-secret";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    button("Save configuration")!.click();
    await vi.waitFor(() => expect(gateways.requests.find((request) => request.method === "PATCH")?.body).toMatchObject({ credentialScope: "personal", secrets: { apiKey: "new-secret" } }));
    expect(gateways.log()).toContain(`PATCH ${east}/api/agents/${q}/extensions/exa`);
    await vi.waitFor(() => expect(button("Remove my credentials")?.disabled).toBe(false));
    button("Remove my credentials")!.click();
    await vi.waitFor(() => expect(button("Remove")).toBeDefined());
    button("Remove")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`DELETE ${east}/api/agents/${q}/connections/extension/exa`));
    await vi.waitFor(() => expect(gateways.log().filter((line) => line === `GET ${east}/api/agents/${q}/extensions`).length).toBeGreaterThan(1));
    selectScope(container, "team");
    await vi.waitFor(() => expect(button("Remove team credentials")).toBeDefined());
    await vi.waitFor(() => expect(button("Remove team credentials")?.disabled).toBe(false));
    button("Remove team credentials")!.click();
    await vi.waitFor(() => expect(button("Remove")).toBeDefined());
    button("Remove")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`DELETE ${east}/api/agents/${q}/extensions/exa/credentials`));
    expect(gateways.localConfigurationRequests()).toEqual([]);
    expect(gateways.unexpected).toEqual([]);
  });
});

describe("identity of the extension page", () => {
  const form = (name: string, value: string) => entry({
    displayName: name, tier: "auto-form", enabled: true,
    configJsonSchema: { type: "object", properties: { region: { type: "string", title: "Region" } } },
    configValues: { region: value },
  });
  const region = () => (Array.from(container.getElementsByTagName("label")).find((label) => label.textContent?.includes("Region"))?.control as HTMLInputElement | undefined);
  const eastList = `${east}/api/agents/assistant%40east/extensions`;
  const westList = `${west}/api/agents/assistant%40west/extensions`;

  it("resets the form for another extension of the same agent and keeps the draft out of it", async () => {
    const first = form("First extension", "first-value");
    const second = { ...form("Second extension", "second-value"), id: "other" };
    gateways.on("GET", eastList, { json: { extensions: [first, second] } });
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(region()?.value).toBe("first-value"));
    region()!.value = "first-draft";
    region()!.dispatchEvent(new Event("input", { bubbles: true }));
    go("/agents/assistant%40east/extensions/other");
    await vi.waitFor(() => expect(text()).toContain("Second extension"));
    expect(region()?.value).toBe("second-value");
  });

  it("saves only the extension that is shown after a route change, to its own endpoint", async () => {
    const first = form("First extension", "first-value");
    const second = { ...form("Second extension", "second-value"), id: "other" };
    gateways.on("GET", eastList, { json: { extensions: [first, second] } });
    gateways.on("PATCH", `${eastList}/exa`, { json: { extensions: [first, second] } });
    gateways.on("PATCH", `${eastList}/other`, { json: { extensions: [first, second] } });
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(region()?.value).toBe("first-value"));
    region()!.value = "first-draft";
    region()!.dispatchEvent(new Event("input", { bubbles: true }));
    go("/agents/assistant%40east/extensions/other");
    await vi.waitFor(() => expect(text()).toContain("Second extension"));
    button("Save")!.click();
    await vi.waitFor(() => expect(gateways.requests.some((request) => request.method === "PATCH")).toBe(true));
    const patch = gateways.requests.find((request) => request.method === "PATCH")!;
    expect(patch.url).toBe(`${eastList}/other`);
    expect(JSON.stringify(patch.body)).not.toContain("first-draft");
  });

  it("drops the actions of the old form, so a sign-in save never reaches another extension", async () => {
    const first = { ...form("First extension", "first-value"), oauth: { provider: "google", scopes: ["drive"] } };
    const second = { ...form("Second extension", "second-value"), id: "other" };
    gateways.on("GET", eastList, { json: { extensions: [first, second] } });
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("First extension"));
    go("/agents/assistant%40east/extensions/other");
    await vi.waitFor(() => expect(text()).toContain("Second extension"));
    // The second extension has no sign-in card, and the page keeps no connect action of the first form.
    expect(button("Connect")).toBeUndefined();
    expect(region()?.value).toBe("second-value");
  });

  it("starts no catalog read after the page closes during a personal credential removal", async () => {
    const secretEntry = entry({
      configJsonSchema: { type: "object", properties: { apiKey: { type: "string" } }, required: ["apiKey"] },
      requiredSecrets: ["apiKey"], personalSecretFields: ["apiKey"], canConfigureTeam: true, configValues: { apiKey: "********" },
      tier: "auto-form", enabled: true,
    });
    let finish: (() => void) | undefined;
    gateways.on("GET", eastList, { json: { extensions: [secretEntry] } });
    gateways.on("DELETE", `${east}/api/agents/assistant%40east/connections/extension/exa`, () => new Promise((resolve) => { finish = () => resolve({ json: { ok: true } }); }));
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("Exa"));
    await tick();
    selectScope(container, "personal");
    await vi.waitFor(() => expect(button("Remove my credentials")?.disabled).toBe(false));
    button("Remove my credentials")!.click();
    await vi.waitFor(() => expect(button("Remove")).toBeDefined());
    button("Remove")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    go("/review-away");
    await vi.waitFor(() => expect(text()).toContain("Other page"));
    const before = gateways.requests.length;
    finish!();
    await tick();
    await tick();
    expect(gateways.requests.length).toBe(before);
  });

  it("shows the values of the new gateway, not the form of the old one", async () => {
    gateways.on("GET", eastList, { json: { extensions: [form("East Exa", "east-value")] } });
    gateways.on("GET", westList, { json: { extensions: [form("West Exa", "west-value")] } });
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(region()?.value).toBe("east-value"));
    go("/agents/assistant%40west/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("West Exa"));
    expect(region()?.value).toBe("west-value");
  });

  it("sends no draft of the old gateway to the new one", async () => {
    gateways.on("GET", eastList, { json: { extensions: [form("East Exa", "east-value")] } });
    gateways.on("GET", westList, { json: { extensions: [form("West Exa", "west-value")] } });
    gateways.on("PATCH", `${west}/api/agents/assistant%40west/extensions/exa`, { json: { extensions: [form("West Exa", "west-value")] } });
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(region()?.value).toBe("east-value"));
    region()!.value = "east-draft";
    region()!.dispatchEvent(new Event("input", { bubbles: true }));
    go("/agents/assistant%40west/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("West Exa"));
    button("Save")!.click();
    await vi.waitFor(() => expect(gateways.requests.some((request) => request.method === "PATCH")).toBe(true));
    const patch = gateways.requests.find((request) => request.method === "PATCH")!;
    expect(patch.url).toBe(`${west}/api/agents/assistant%40west/extensions/exa`);
    expect(JSON.stringify(patch.body)).not.toContain("east-draft");
  });

  it("removes every mutation control when the next agent cannot be resolved, and sends no request", async () => {
    gateways.on("GET", eastList, { json: { extensions: [entry({ displayName: "East Exa" })] } });
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(button("Enable")).toBeDefined());
    go("/agents/ghost%40west/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("This agent is unavailable"));
    expect(button("Enable")).toBeUndefined();
    expect(text()).not.toContain("East Exa");
    expect(gateways.requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("ignores a completed mutation of the old gateway", async () => {
    let finish: (() => void) | undefined;
    gateways.on("GET", eastList, { json: { extensions: [entry({ displayName: "East Exa" })] } });
    gateways.on("GET", westList, { json: { extensions: [entry({ displayName: "West Exa" })] } });
    gateways.on("PATCH", `${east}/api/agents/assistant%40east/extensions/exa`, () => new Promise((resolve) => { finish = () => resolve({ json: { extensions: [entry({ displayName: "East Changed", enabled: true })] } }); }));
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(button("Enable")).toBeDefined());
    button("Enable")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    go("/agents/assistant%40west/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("West Exa"));
    finish!();
    await tick();
    await tick();
    expect(text()).toContain("West Exa");
    expect(text()).not.toContain("East Changed");
  });

  it("ignores a late error and keeps the new page usable", async () => {
    let fail: (() => void) | undefined;
    gateways.on("GET", eastList, { json: { extensions: [entry({ displayName: "East Exa" })] } });
    gateways.on("GET", westList, { json: { extensions: [entry({ displayName: "West Exa" })] } });
    gateways.on("PATCH", `${east}/api/agents/assistant%40east/extensions/exa`, () => new Promise((resolve) => { fail = () => resolve({ status: 403, json: { error: "forbidden" } }); }));
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(button("Enable")).toBeDefined());
    button("Enable")!.click();
    await vi.waitFor(() => expect(fail).toBeDefined());
    go("/agents/assistant%40west/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("West Exa"));
    fail!();
    await tick();
    await tick();
    expect(text()).not.toContain("Failed to update extension");
    expect(button("Enable")?.disabled).toBe(false);
  });

  it("ignores the answer of an earlier visit when the page returns to the same agent", async () => {
    let finish: (() => void) | undefined;
    gateways.on("GET", eastList, { json: { extensions: [entry({ displayName: "East Exa" })] } });
    gateways.on("GET", westList, { json: { extensions: [entry({ displayName: "West Exa" })] } });
    gateways.on("PATCH", `${east}/api/agents/assistant%40east/extensions/exa`, () => new Promise((resolve) => { finish = () => resolve({ json: { extensions: [entry({ displayName: "East Changed", enabled: true })] } }); }));
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(button("Enable")).toBeDefined());
    button("Enable")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    go("/agents/assistant%40west/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("West Exa"));
    go("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("East Exa"));
    finish!();
    await tick();
    await tick();
    expect(text()).not.toContain("East Changed");
    expect(button("Enable")?.disabled).toBe(false);
  });

  it("ignores a late credential save of the old gateway and keeps the new form usable", async () => {
    let finish: (() => void) | undefined;
    gateways.on("GET", eastList, { json: { extensions: [form("East Exa", "east-value")] } });
    gateways.on("GET", westList, { json: { extensions: [form("West Exa", "west-value")] } });
    gateways.on("PATCH", `${east}/api/agents/assistant%40east/extensions/exa`, () => new Promise((resolve) => { finish = () => resolve({ json: { extensions: [form("East Saved", "east-saved")] } }); }));
    mount("/agents/assistant%40east/extensions/exa");
    await vi.waitFor(() => expect(region()?.value).toBe("east-value"));
    region()!.value = "east-draft";
    region()!.dispatchEvent(new Event("input", { bubbles: true }));
    button("Save")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    go("/agents/assistant%40west/extensions/exa");
    await vi.waitFor(() => expect(text()).toContain("West Exa"));
    finish!();
    await tick();
    await tick();
    expect(text()).toContain("West Exa");
    expect(text()).not.toContain("East Saved");
    expect(region()?.value).toBe("west-value");
    expect(text()).not.toContain("Saved ✓");
    expect(button("Save")?.disabled).toBe(false);
  });
});
