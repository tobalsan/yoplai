// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Suspense, type JSX } from "solid-js";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { createFakeGateways, relayPrefix, type FakeAnswer } from "./remote-gateway.fixture";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "./lib/capabilities";
import { ICON_REFRESH_TIMEOUT_MS } from "./api/mcp-servers";
import { useScheduleAlerts } from "./lib/schedule-alerts";
import { ScheduleAlertDot } from "./components/ScheduleAlertDot";
import AdminExtensionsPage from "./pages/admin/Extensions";
import AdminMcpServersPage from "./pages/admin/McpServers";

vi.mock("./auth/client", () => ({ useSession: () => () => ({ isPending: false, data: null }) }));

const east = relayPrefix("east");
const west = relayPrefix("west");

const caps = (overrides: Record<string, unknown> = {}) => ({
  version: 2, extensions: { scheduler: true }, agents: [], multiUser: true, forkedAgents: false,
  enableCronMonitoring: true, user: { id: "remote-root", name: "Root", role: "superadmin" }, ...overrides,
});
const top = (extensions: string[], candidates = ["exa"]) => ({
  extensions, mcp: [], system: { extensions: [], mcp: [] },
  candidates: { extensions: candidates.map((id) => ({ id, displayName: `Ext ${id}`, description: "" })), mcp: [] },
});

let gateways: ReturnType<typeof createFakeGateways>;
let container: HTMLElement;
let dispose: (() => void) | undefined;
let history: ReturnType<typeof createMemoryHistory>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = () => container.textContent ?? "";
const button = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim().startsWith(name));
const star = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label$="${label} as top"]`);
const select = () => container.querySelector<HTMLSelectElement>('select[aria-label="Gateway"]')!;
const choose = (name: string) => { select().value = name; select().dispatchEvent(new Event("change", { bubbles: true })); };

function mount(path: string, extra?: () => JSX.Element) {
  history = createMemoryHistory();
  history.set({ value: path, replace: true });
  dispose = render(() => (
    <MemoryRouter history={history} root={(props: { children?: JSX.Element }) => <Suspense>{props.children}</Suspense>}>
      <Route path="/admin/extensions" component={AdminExtensionsPage} />
      <Route path="/admin/mcp-servers" component={AdminMcpServersPage} />
      <Route path="/alerts" component={() => extra?.() ?? <p>none</p>} />
      <Route path="/review-away" component={() => <h1>Other page</h1>} />
    </MemoryRouter>
  ), container);
}

beforeEach(() => {
  localStorage.clear();
  setCapabilitiesForTests({ extensions: { scheduler: true }, multiUser: false });
  gateways = createFakeGateways();
  gateways.on("GET", "/api/relay/gateways", { json: { gateways: [{ name: "east" }, { name: "west" }, { name: "quiet" }, { name: "offline" }] } });
  gateways.on("GET", `${east}/api/capabilities`, { json: caps() });
  gateways.on("GET", `${west}/api/capabilities`, { json: caps({ multiUser: false, user: undefined }) });
  gateways.on("GET", "/api/admin/top-extensions", { json: top(["local-star"], ["exa", "local-only"]) });
  gateways.on("GET", `${east}/api/admin/top-extensions`, { json: top(["exa"]) });
  gateways.on("GET", `${west}/api/admin/top-extensions`, { json: top([]) });
  vi.stubGlobal("fetch", gateways.fetchMock);
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

describe("global extension administration", () => {
  it("lists every configured gateway, also one with no agent or one that is offline, and starts on Local", async () => {
    mount("/admin/extensions");
    await vi.waitFor(() => expect(text()).toContain("Ext local-only"));
    expect(Array.from(select().options).map((option) => option.textContent)).toEqual(["This computer", "east", "west", "quiet", "offline"]);
    expect(select().value).toBe("");
    expect(gateways.log().some((line) => line.includes("/api/relay/gateways/"))).toBe(false);
  });

  it("reads and saves the Top flags of the chosen gateway, and keeps equal extension IDs apart", async () => {
    gateways.on("PUT", `${east}/api/admin/top-extensions`, (request) => ({ json: { ...top([]), ...(request.body as object) } }));
    mount("/admin/extensions");
    await vi.waitFor(() => expect(star("Ext exa")).not.toBeNull());
    expect(star("Ext exa")?.getAttribute("aria-pressed")).toBe("false");
    choose("east");
    await vi.waitFor(() => expect(history.get()).toBe("/admin/extensions?gateway=east"));
    await vi.waitFor(() => expect(star("Ext exa")?.getAttribute("aria-pressed")).toBe("true"));
    expect(text()).not.toContain("Ext local-only");
    star("Ext exa")!.click();
    await vi.waitFor(() => expect(gateways.requests.find((request) => request.method === "PUT")?.url).toBe(`${east}/api/admin/top-extensions`));
    expect(gateways.requests.find((request) => request.method === "PUT")?.body).toMatchObject({ extensions: [] });
    await vi.waitFor(() => expect(star("Ext exa")?.getAttribute("aria-pressed")).toBe("false"));
    // The local flags did not change.
    choose("");
    await vi.waitFor(() => expect(text()).toContain("Ext local-only"));
    expect(gateways.requests.filter((request) => request.method === "PUT").every((request) => request.url.startsWith(east))).toBe(true);
  });

  it("shows the refusal of the remote and no local rows", async () => {
    gateways.on("GET", `${east}/api/admin/top-extensions`, { status: 403, json: { error: "forbidden" } });
    mount("/admin/extensions?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("Only the superadmin can manage top extensions."));
    expect(text()).not.toContain("Ext local-only");
    expect(gateways.requests.map((request) => request.url)).not.toContain("/api/admin/top-extensions");
  });

  it("shows an offline gateway as an error, not as an empty list", async () => {
    gateways.on("GET", `${east}/api/admin/top-extensions`, { status: 502, json: { error: "gateway_offline" } });
    mount("/admin/extensions?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("The remote gateway is offline."));
    expect(text()).not.toContain("No extensions.");
  });

  it("makes no call for a gateway that is not configured, and never falls back to Local", async () => {
    mount("/admin/extensions?gateway=ghost");
    await vi.waitFor(() => expect(text()).toContain('The gateway "ghost" is not linked.'));
    expect(gateways.requests.map((request) => request.url)).toEqual(["/api/relay/gateways"]);
    expect(container.querySelector("button.top-star")).toBeNull();
  });

  it("makes no call for a named gateway while linked gateways are not available", async () => {
    gateways.on("GET", "/api/relay/gateways", { status: 403, json: { error: "relay_unavailable" } });
    mount("/admin/extensions?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("Linked gateways are not available on this gateway."));
    expect(gateways.requests.map((request) => request.url)).toEqual(["/api/relay/gateways"]);
  });

  it("keeps the controls off for a remote requester that is not its superadmin, and for an unknown requester", async () => {
    gateways.on("GET", `${east}/api/capabilities`, { json: caps({ user: { id: "u", role: "user" } }) });
    mount("/admin/extensions?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("Only the superadmin of east can change these flags."));
    expect(star("Ext exa")?.disabled).toBe(true);
    dispose?.();
    container.replaceChildren();
    gateways.on("GET", `${east}/api/capabilities`, { status: 500, json: {} });
    mount("/admin/extensions?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("Could not read your permissions on east."));
    expect(star("Ext exa")?.disabled).toBe(true);
    expect(gateways.requests.filter((request) => request.method === "PUT")).toEqual([]);
  });

  it("lets a single-user remote change its flags, because its linked bearer is its actor", async () => {
    gateways.on("PUT", `${west}/api/admin/top-extensions`, { json: top(["exa"]) });
    mount("/admin/extensions?gateway=west");
    await vi.waitFor(() => expect(star("Ext exa")?.disabled).toBe(false));
    star("Ext exa")!.click();
    await vi.waitFor(() => expect(gateways.requests.some((request) => request.method === "PUT" && request.url === `${west}/api/admin/top-extensions`)).toBe(true));
  });

  it("ignores a late save answer after the page moved to Local, also a late error after a return to the same gateway", async () => {
    let finish: (() => void) | undefined;
    gateways.on("PUT", `${east}/api/admin/top-extensions`, () => new Promise<FakeAnswer>((resolve) => { finish = () => resolve({ status: 403, json: { error: "forbidden" } }); }));
    mount("/admin/extensions?gateway=east");
    await vi.waitFor(() => expect(star("Ext exa")?.disabled).toBe(false));
    star("Ext exa")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    history.set({ value: "/admin/extensions" });
    await vi.waitFor(() => expect(text()).toContain("Ext local-only"));
    history.set({ value: "/admin/extensions?gateway=east" });
    await vi.waitFor(() => expect(star("Ext exa")?.disabled).toBe(false));
    finish!();
    await tick();
    await tick();
    // The old answer shows no error and leaves the new visit usable.
    expect(text()).not.toContain("Only the superadmin can manage top extensions.");
    expect(star("Ext exa")?.disabled).toBe(false);
    expect(star("Ext exa")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("reads the flags after a committed write whose answer failed, and keeps the first change in the next write", async () => {
    // The remote commits the first write, then the relay answer is the actual 502 gateway_offline.
    let remote = top([], ["exa", "notion"]);
    const puts: unknown[] = [];
    gateways.on("GET", `${east}/api/admin/top-extensions`, () => ({ json: remote }));
    gateways.on("PUT", `${east}/api/admin/top-extensions`, (request) => {
      puts.push(request.body);
      remote = { ...remote, ...(request.body as object) } as typeof remote;
      return puts.length === 1 ? { status: 502, json: { error: "gateway_offline" } } : { json: remote };
    });
    mount("/admin/extensions?gateway=east");
    await vi.waitFor(() => expect(star("Ext exa")?.disabled).toBe(false));
    const reads = () => gateways.log().filter((line) => line === `GET ${east}/api/admin/top-extensions`).length;
    const before = reads();
    let releaseRead: (() => void) | undefined;
    gateways.on("GET", `${east}/api/admin/top-extensions`, () => new Promise<FakeAnswer>((resolve) => { releaseRead = () => resolve({ json: remote }); }));
    star("Ext exa")!.click();
    await vi.waitFor(() => expect(text()).toContain("The remote gateway is offline."));
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
    // Every switch stays off while the read of the same gateway is pending.
    expect(star("Ext notion")?.disabled).toBe(true);
    star("Ext notion")!.click();
    await tick();
    expect(puts).toHaveLength(1);
    releaseRead!();
    await vi.waitFor(() => expect(star("Ext notion")?.disabled).toBe(false));
    // The fresh snapshot holds the first change, so the second write keeps it.
    expect(star("Ext exa")?.getAttribute("aria-pressed")).toBe("true");
    star("Ext notion")!.click();
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toMatchObject({ extensions: ["exa", "notion"] });
  });

  it("keeps every switch off with a Read list button when the read after a failed write fails", async () => {
    gateways.on("PUT", `${east}/api/admin/top-extensions`, { status: 502, json: { error: "gateway_offline" } });
    mount("/admin/extensions?gateway=east");
    await vi.waitFor(() => expect(star("Ext exa")?.disabled).toBe(false));
    gateways.on("GET", `${east}/api/admin/top-extensions`, { status: 502, json: { error: "gateway_offline" } });
    star("Ext exa")!.click();
    await vi.waitFor(() => expect(text()).toContain("The flags could not be read after the error"));
    expect(container.querySelector("button.top-star")).toBeNull();
    const puts = () => gateways.requests.filter((request) => request.method === "PUT").length;
    expect(puts()).toBe(1);
    gateways.on("GET", `${east}/api/admin/top-extensions`, { json: top(["exa"]) });
    button("Read list")!.click();
    await vi.waitFor(() => expect(star("Ext exa")?.disabled).toBe(false));
    expect(star("Ext exa")?.getAttribute("aria-pressed")).toBe("true");
    expect(text()).not.toContain("The flags could not be read");
  });

  it("ignores a late read after the visit changed", async () => {
    let finish: (() => void) | undefined;
    gateways.on("PUT", `${east}/api/admin/top-extensions`, { status: 502, json: { error: "gateway_offline" } });
    mount("/admin/extensions?gateway=east");
    await vi.waitFor(() => expect(star("Ext exa")?.disabled).toBe(false));
    gateways.on("GET", `${east}/api/admin/top-extensions`, () => new Promise<FakeAnswer>((resolve) => { finish = () => resolve({ status: 502, json: { error: "gateway_offline" } }); }));
    star("Ext exa")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    history.set({ value: "/admin/extensions" });
    await vi.waitFor(() => expect(text()).toContain("Ext local-only"));
    finish!();
    await tick();
    await tick();
    expect(text()).not.toContain("The flags could not be read");
    expect(container.querySelector<HTMLButtonElement>("button.top-star")?.disabled).toBe(false);
  });

  it("starts nothing after the page closes during a save", async () => {
    let finish: (() => void) | undefined;
    gateways.on("PUT", `${east}/api/admin/top-extensions`, () => new Promise<FakeAnswer>((resolve) => { finish = () => resolve({ json: top([]) }); }));
    mount("/admin/extensions?gateway=east");
    await vi.waitFor(() => expect(star("Ext exa")?.disabled).toBe(false));
    star("Ext exa")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    history.set({ value: "/review-away" });
    await vi.waitFor(() => expect(text()).toContain("Other page"));
    const before = gateways.requests.length;
    finish!();
    await tick();
    await tick();
    expect(gateways.requests.length).toBe(before);
  });
});

describe("MCP catalog administration", () => {
  const server = (name: string, extra: Record<string, unknown> = {}) => ({ name, url: `https://${name}.example.test/mcp`, ...extra });
  const eastCatalog = `${east}/api/mcp/catalog`;
  const field = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const type = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
  const row = (name: string) => container.querySelector<HTMLElement>(`[data-server="${name}"]`);
  const rowButton = (name: string, label: string) => Array.from(row(name)?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent?.trim() === label);

  beforeEach(() => {
    gateways.on("GET", "/api/mcp/catalog", { json: { servers: [server("docs", { displayName: "Local Docs" })] } });
    gateways.on("GET", eastCatalog, { json: { servers: [server("docs", { displayName: "East Docs" })] } });
  });

  it("shows the catalog of the chosen gateway, with equal server names kept apart", async () => {
    mount("/admin/mcp-servers");
    await vi.waitFor(() => expect(text()).toContain("Local Docs"));
    choose("east");
    await vi.waitFor(() => expect(text()).toContain("East Docs"));
    expect(text()).not.toContain("Local Docs");
    expect(history.get()).toBe("/admin/mcp-servers?gateway=east");
  });

  it("adds, edits, refreshes an icon, and removes through the gateway with the server name unchanged", async () => {
    const name = "docs";
    gateways.on("POST", eastCatalog, { json: { server: server("added") } });
    gateways.on("POST", `${eastCatalog}/update?server=${name}`, { json: { server: server(name, { displayName: "Edited" }) } });
    gateways.on("POST", `${eastCatalog}/icon/refresh?server=${name}`, { json: { status: "unchanged", server: server(name) } });
    gateways.on("POST", `${eastCatalog}/remove?server=${name}`, { json: { ok: true } });
    mount("/admin/mcp-servers?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("East Docs"));
    await vi.waitFor(() => expect(button("Add server")?.disabled).toBe(false));
    type(field("Server URL"), "https://new.example.test/mcp");
    button("Add server")!.click();
    await vi.waitFor(() => expect(gateways.requests.find((request) => request.method === "POST" && request.url === eastCatalog)?.body).toMatchObject({ url: "https://new.example.test/mcp" }));
    await vi.waitFor(() => expect(button("Add server")?.disabled).toBe(false));
    rowButton(name, "Edit")!.click();
    await tick();
    type(field(`Name for ${name}`), "Edited");
    rowButton(name, "Save")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`POST ${eastCatalog}/update?server=${name}`));
    await vi.waitFor(() => expect(text()).toContain("Edited"));
    rowButton(name, "Refresh icon")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`POST ${eastCatalog}/icon/refresh?server=${name}`));
    rowButton(name, "Remove")!.click();
    await vi.waitFor(() => expect(text()).toContain("Remove for every agent on east?"));
    rowButton(name, "Confirm remove")!.click();
    await vi.waitFor(() => expect(gateways.log()).toContain(`POST ${eastCatalog}/remove?server=${name}`));
    expect(gateways.requests.filter((request) => request.method !== "GET").every((request) => request.url.startsWith(east))).toBe(true);
  });

  it("shows a refused remove and reads the same list again before another change", async () => {
    gateways.on("POST", `${eastCatalog}/remove?server=docs`, { status: 403, json: { error: "forbidden" } });
    mount("/admin/mcp-servers?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("East Docs"));
    await vi.waitFor(() => expect(rowButton("docs", "Remove")?.disabled).toBe(false));
    rowButton("docs", "Remove")!.click();
    await tick();
    const reads = () => gateways.log().filter((line) => line === `GET ${eastCatalog}`).length;
    const before = reads();
    rowButton("docs", "Confirm remove")!.click();
    await vi.waitFor(() => expect(text()).toContain("The remote gateway refused this action."));
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("keeps another change off when the list read after an error fails, and recovers on a working read", async () => {
    gateways.on("POST", eastCatalog, { status: 502, json: { error: "gateway_offline" } });
    mount("/admin/mcp-servers?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("East Docs"));
    await vi.waitFor(() => expect(button("Add server")?.disabled).toBe(false));
    type(field("Server URL"), "https://new.example.test/mcp");
    gateways.on("GET", eastCatalog, { status: 502, json: { error: "gateway_offline" } });
    button("Add server")!.click();
    await vi.waitFor(() => expect(text()).toContain("The server list could not be read after the error"));
    expect(button("Add server")?.disabled).toBe(true);
    const posts = () => gateways.requests.filter((request) => request.method === "POST").length;
    expect(posts()).toBe(1);
    gateways.on("GET", eastCatalog, { json: { servers: [server("docs", { displayName: "East Docs" }), server("new")] } });
    button("Read list")!.click();
    await vi.waitFor(() => expect(button("Add server")?.disabled).toBe(false));
    expect(text()).not.toContain("The server list could not be read");
    await vi.waitFor(() => expect(row("new")).not.toBeNull());
  });

  it("shows the refusal and an offline gateway as errors, and makes no call for a gateway that is not linked", async () => {
    gateways.on("GET", eastCatalog, { status: 403, json: { error: "forbidden" } });
    mount("/admin/mcp-servers?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("The remote gateway refused this action."));
    expect(text()).not.toContain("Local Docs");
    dispose?.();
    container.replaceChildren();
    gateways.on("GET", eastCatalog, { status: 502, json: { error: "gateway_offline" } });
    mount("/admin/mcp-servers?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("The remote gateway is offline."));
    dispose?.();
    container.replaceChildren();
    const before = gateways.requests.length;
    mount("/admin/mcp-servers?gateway=ghost");
    await vi.waitFor(() => expect(text()).toContain('The gateway "ghost" is not linked.'));
    expect(gateways.requests.slice(before).map((request) => request.url)).toEqual(["/api/relay/gateways"]);
  });

  it("drops the form drafts and the open dialogs when the gateway changes, so nothing reaches Local", async () => {
    mount("/admin/mcp-servers?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("East Docs"));
    type(field("Server URL"), "https://draft.example.test/mcp");
    await vi.waitFor(() => expect(rowButton("docs", "Edit")?.disabled).toBe(false));
    rowButton("docs", "Edit")!.click();
    await tick();
    expect(field("Name for docs")).not.toBeNull();
    history.set({ value: "/admin/mcp-servers" });
    await vi.waitFor(() => expect(text()).toContain("Local Docs"));
    expect(field("Server URL").value).toBe("");
    expect(container.querySelector('input[aria-label="Name for docs"]')).toBeNull();
    expect(gateways.requests.filter((request) => request.method === "POST")).toEqual([]);
  });

  it("ignores a late remove answer after a return to the same gateway", async () => {
    let finish: (() => void) | undefined;
    gateways.on("POST", `${eastCatalog}/remove?server=docs`, () => new Promise<FakeAnswer>((resolve) => { finish = () => resolve({ status: 403, json: { error: "forbidden" } }); }));
    mount("/admin/mcp-servers?gateway=east");
    await vi.waitFor(() => expect(rowButton("docs", "Remove")?.disabled).toBe(false));
    rowButton("docs", "Remove")!.click();
    await tick();
    rowButton("docs", "Confirm remove")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    history.set({ value: "/admin/mcp-servers" });
    await vi.waitFor(() => expect(text()).toContain("Local Docs"));
    history.set({ value: "/admin/mcp-servers?gateway=east" });
    await vi.waitFor(() => expect(text()).toContain("East Docs"));
    const reads = () => gateways.log().filter((line) => line === `GET ${eastCatalog}`).length;
    const before = reads();
    finish!();
    await tick();
    await tick();
    expect(text()).not.toContain("The remote gateway refused this action.");
    expect(reads()).toBe(before);
    expect(rowButton("docs", "Remove")?.disabled).toBe(false);
  });

  it("reads the catalog after the actual relay answer 502 gateway_offline for an icon refresh, with the controls off during the read", async () => {
    gateways.on("POST", `${eastCatalog}/icon/refresh?server=docs`, { status: 502, json: { error: "gateway_offline" } });
    mount("/admin/mcp-servers?gateway=east");
    await vi.waitFor(() => expect(rowButton("docs", "Refresh icon")?.disabled).toBe(false));
    const reads = () => gateways.log().filter((line) => line === `GET ${eastCatalog}`).length;
    const before = reads();
    let releaseRead: (() => void) | undefined;
    gateways.on("GET", eastCatalog, () => new Promise<FakeAnswer>((resolve) => { releaseRead = () => resolve({ json: { servers: [server("docs", { displayName: "East Docs", iconUrl: "https://icons.example.test/new.png" })] } }); }));
    rowButton("docs", "Refresh icon")!.click();
    await vi.waitFor(() => expect(text()).toContain("The remote gateway is offline."));
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
    // Every catalog control stays off while the read of the same catalog is pending.
    expect(rowButton("docs", "Edit")?.disabled).toBe(true);
    expect(rowButton("docs", "Remove")?.disabled).toBe(true);
    expect(button("Add server")?.disabled).toBe(true);
    releaseRead!();
    await vi.waitFor(() => expect(rowButton("docs", "Edit")?.disabled).toBe(false));
    expect(container.querySelector('[data-server="docs"] img')?.getAttribute("src")).toBe("https://icons.example.test/new.png");
  });

  it("keeps the unknown state and Read list after a failed catalog read that follows an icon failure", async () => {
    gateways.on("POST", `${eastCatalog}/icon/refresh?server=docs`, { status: 502, json: { error: "gateway_offline" } });
    mount("/admin/mcp-servers?gateway=east");
    await vi.waitFor(() => expect(rowButton("docs", "Refresh icon")?.disabled).toBe(false));
    gateways.on("GET", eastCatalog, { status: 502, json: { error: "gateway_offline" } });
    rowButton("docs", "Refresh icon")!.click();
    await vi.waitFor(() => expect(text()).toContain("The server list could not be read after the error"));
    expect(button("Add server")?.disabled).toBe(true);
    gateways.on("GET", eastCatalog, { json: { servers: [server("docs", { displayName: "East Docs" })] } });
    button("Read list")!.click();
    await vi.waitFor(() => expect(button("Add server")?.disabled).toBe(false));
  });

  it("drops the icon recovery of an older visit", async () => {
    let finish: (() => void) | undefined;
    gateways.on("POST", `${eastCatalog}/icon/refresh?server=docs`, { status: 502, json: { error: "gateway_offline" } });
    mount("/admin/mcp-servers?gateway=east");
    await vi.waitFor(() => expect(rowButton("docs", "Refresh icon")?.disabled).toBe(false));
    gateways.on("GET", eastCatalog, () => new Promise<FakeAnswer>((resolve) => { finish = () => resolve({ status: 502, json: { error: "gateway_offline" } }); }));
    rowButton("docs", "Refresh icon")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    history.set({ value: "/admin/mcp-servers" });
    await vi.waitFor(() => expect(text()).toContain("Local Docs"));
    finish!();
    await tick();
    await tick();
    expect(text()).not.toContain("The server list could not be read");
    expect(button("Add server")?.disabled).toBe(false);
  });

  it("ends the finite icon deadline as an uncertain outcome, reads the same list, and ignores an older attempt", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    gateways.on("POST", `${eastCatalog}/icon/refresh?server=docs`, () => new Promise<FakeAnswer>(() => undefined));
    mount("/admin/mcp-servers?gateway=east");
    await vi.waitFor(() => expect(rowButton("docs", "Refresh icon")?.disabled).toBe(false));
    const reads = () => gateways.log().filter((line) => line === `GET ${eastCatalog}`).length;
    const before = reads();
    rowButton("docs", "Refresh icon")!.click();
    await vi.advanceTimersByTimeAsync(ICON_REFRESH_TIMEOUT_MS + 1);
    await vi.waitFor(() => expect(text()).toContain("did not answer in time"));
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
  });
});

describe("alert dots of configured gateways", () => {
  const alert = (agentId: string) => ({ agentId, jobId: "job-1", jobName: "Digest", pausedReason: { integration: "Google" } });
  function Alerts() {
    useScheduleAlerts(() => true, () => null);
    return (
      <div>
        <span data-testid="nav"><ScheduleAlertDot /></span>
        <span data-testid="quiet"><ScheduleAlertDot agentId="ghost@quiet" gateway="quiet" /></span>
        <span data-testid="east"><ScheduleAlertDot agentId="ghost@east" gateway="east" /></span>
        <span data-testid="local"><ScheduleAlertDot agentId="ghost@quiet" /></span>
      </div>
    );
  }
  const dot = (id: string) => container.querySelector(`[data-testid="${id}"] [role="img"]`);

  beforeEach(() => {
    gateways.on("GET", "/api/schedule-alerts", { json: [] });
    gateways.on("GET", `${east}/api/schedule-alerts`, { json: [] });
    gateways.on("GET", `${relayPrefix("quiet")}/api/schedule-alerts`, { json: [alert("ghost@quiet")] });
    gateways.on("GET", `${relayPrefix("west")}/api/schedule-alerts`, { json: [] });
    gateways.on("GET", `${relayPrefix("offline")}/api/schedule-alerts`, { status: 502, json: { error: "gateway_offline" } });
  });

  it("shows the dot of a configured gateway with no visible agent, bound to that gateway and agent only", async () => {
    mount("/alerts", () => <Alerts />);
    await vi.waitFor(() => expect(dot("nav")).not.toBeNull());
    expect(dot("quiet")).not.toBeNull();
    // The same qualified ID on another gateway, and the same ID on the local list, show no dot.
    expect(dot("east")).toBeNull();
    expect(dot("local")).toBeNull();
  });

  it("keeps the last known alerts when a gateway is offline, and does not show the dot as a fresh empty list", async () => {
    mount("/alerts", () => <Alerts />);
    await vi.waitFor(() => expect(dot("quiet")).not.toBeNull());
    gateways.on("GET", `${relayPrefix("quiet")}/api/schedule-alerts`, { status: 502, json: { error: "gateway_offline" } });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(gateways.log().filter((line) => line === `GET ${relayPrefix("quiet")}/api/schedule-alerts`).length).toBeGreaterThan(1));
    await tick();
    expect(dot("quiet")).not.toBeNull();
  });

  it("clears the alerts of a denied scope and of a gateway that is no longer configured", async () => {
    mount("/alerts", () => <Alerts />);
    await vi.waitFor(() => expect(dot("quiet")).not.toBeNull());
    gateways.on("GET", `${relayPrefix("quiet")}/api/schedule-alerts`, { status: 403, json: { error: "forbidden" } });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(dot("quiet")).toBeNull());
    gateways.on("GET", `${relayPrefix("quiet")}/api/schedule-alerts`, { json: [alert("ghost@quiet")] });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(dot("quiet")).not.toBeNull());
    gateways.on("GET", "/api/relay/gateways", { json: { gateways: [{ name: "east" }] } });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(dot("quiet")).toBeNull());
    expect(dot("nav")).toBeNull();
  });

  it("does not restore a removed gateway from an older list read that ends later", async () => {
    mount("/alerts", () => <Alerts />);
    await vi.waitFor(() => expect(dot("quiet")).not.toBeNull());
    let finish: ((answer: FakeAnswer) => void) | undefined;
    gateways.on("GET", "/api/relay/gateways", () => new Promise<FakeAnswer>((resolve) => { finish = resolve; }));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(finish).toBeDefined());
    gateways.on("GET", "/api/relay/gateways", { json: { gateways: [{ name: "east" }] } });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(dot("quiet")).toBeNull());
    const quietReads = () => gateways.log().filter((line) => line === `GET ${relayPrefix("quiet")}/api/schedule-alerts`).length;
    const before = quietReads();
    finish!({ json: { gateways: [{ name: "east" }, { name: "quiet" }] } });
    await tick();
    await tick();
    await tick();
    expect(dot("quiet")).toBeNull();
    expect(dot("nav")).toBeNull();
    expect(quietReads()).toBe(before);
  });

  it("does not gate a remote read on the local scheduler flag", async () => {
    setCapabilitiesForTests({ extensions: {}, multiUser: false });
    mount("/alerts", () => <Alerts />);
    await vi.waitFor(() => expect(dot("quiet")).not.toBeNull());
    expect(gateways.log()).not.toContain("GET /api/schedule-alerts");
  });
});
