// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Suspense, type JSX } from "solid-js";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { createFakeGateways, relayPrefix, type FakeAnswer } from "./remote-gateway.fixture";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "./lib/capabilities";
import { AccountConnections } from "./pages/AccountConnections";

vi.mock("./auth/client", () => ({ useSession: () => () => ({ isPending: false, data: { user: { id: "local-user" } } }) }));
vi.mock("./components/LeftNavShell", () => ({ LeftNavShell: (props: { children?: JSX.Element }) => <div>{props.children}</div> }));

const east = relayPrefix("east");
const west = relayPrefix("west");
const caps = (overrides: Record<string, unknown> = {}) => ({
  version: 2, extensions: {}, agents: [], multiUser: true, enableCronMonitoring: false,
  user: { id: "remote-alice", name: "Alice", role: "user" }, ...overrides,
});
const pairing = (slackUserId: string, workspaceId = "T1") => ({ workspaceId, slackUserId, pairedAt: 1_700_000_000_000 });

let gateways: ReturnType<typeof createFakeGateways>;
let container: HTMLElement;
let dispose: (() => void) | undefined;
let history: ReturnType<typeof createMemoryHistory>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = () => container.textContent ?? "";
const button = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === name);
const unpairButtons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === "Unpair");
const select = () => container.querySelector<HTMLSelectElement>('select[aria-label="Gateway"]')!;
const choose = (name: string) => { select().value = name; select().dispatchEvent(new Event("change", { bubbles: true })); };
const log = () => gateways.log();
const writes = () => gateways.requests.filter((request) => request.method !== "GET");

function mount(path: string) {
  history = createMemoryHistory();
  history.set({ value: path, replace: true });
  dispose = render(() => (
    <MemoryRouter history={history} root={(props: { children?: JSX.Element }) => <Suspense>{props.children}</Suspense>}>
      <Route path="/account/connections" component={AccountConnections} />
      <Route path="/elsewhere" component={() => <h1>Elsewhere</h1>} />
    </MemoryRouter>
  ), container);
}

beforeEach(() => {
  localStorage.clear();
  setCapabilitiesForTests({ extensions: {}, multiUser: false });
  gateways = createFakeGateways();
  gateways.on("GET", "/api/relay/gateways", { json: { gateways: [{ name: "east" }, { name: "west" }] } });
  gateways.on("GET", `${east}/api/capabilities`, { json: caps() });
  gateways.on("GET", `${west}/api/capabilities`, { json: caps({ user: { id: "remote-bob", name: "Bob", role: "user" } }) });
  gateways.on("GET", "/api/slack/pairings", { json: { pairings: [pairing("ULOCAL")] } });
  gateways.on("GET", "/api/surface-links", { json: { links: [] } });
  gateways.on("GET", `${east}/api/surface-links`, { json: { links: [] } });
  gateways.on("GET", `${west}/api/surface-links`, { json: { links: [] } });
  gateways.on("GET", `${east}/api/slack/pairings`, { json: { pairings: [pairing("UEAST")] } });
  gateways.on("GET", `${west}/api/slack/pairings`, { json: { pairings: [pairing("UWEST")] } });
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

describe("Slack pairings of a chosen gateway", () => {
  it("starts on Local with the cookie user, and reads the linked gateway after an explicit choice", async () => {
    mount("/account/connections");
    await vi.waitFor(() => expect(text()).toContain("Slack user ULOCAL"));
    expect(Array.from(select().options).map((option) => option.textContent)).toEqual(["This computer", "east", "west"]);
    choose("east");
    await vi.waitFor(() => expect(text()).toContain("Slack user UEAST"));
    expect(text()).not.toContain("ULOCAL");
    expect(history.get()).toBe("/account/connections?gateway=east");
    // The remote read goes through the relay only, and no local pairing read repeats.
    expect(log().filter((line) => line === "GET /api/slack/pairings")).toHaveLength(1);
    expect(gateways.unexpected).toEqual([]);
  });

  it("unpairs through the gateway with the opaque identifiers unchanged, and reads the list again", async () => {
    const odd = pairing("U:odd@id", "T/1 x");
    gateways.on("GET", `${east}/api/slack/pairings`, { json: { pairings: [odd] } });
    gateways.on("DELETE", `${east}/api/slack/pairings/${encodeURIComponent("T/1 x")}/${encodeURIComponent("U:odd@id")}`, { json: { ok: true } });
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(unpairButtons()).toHaveLength(1));
    unpairButtons()[0].click();
    await vi.waitFor(() => expect(writes().map((request) => `${request.method} ${request.url}`)).toEqual([`DELETE ${east}/api/slack/pairings/${encodeURIComponent("T/1 x")}/${encodeURIComponent("U:odd@id")}`]));
    await vi.waitFor(() => expect(log().filter((line) => line === `GET ${east}/api/slack/pairings`).length).toBe(2));
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("makes no call for a gateway that is not configured, and never falls back to Local", async () => {
    mount("/account/connections?gateway=nowhere");
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('The gateway "nowhere" is not linked.'));
    expect(log().filter((line) => line.includes("slack"))).toEqual([]);
    expect(unpairButtons()).toHaveLength(0);
  });

  it("shows that linked gateways are off on a gateway that keeps its relay disabled, with no call", async () => {
    gateways.on("GET", "/api/relay/gateways", { status: 403, json: { error: "relay_unavailable" } });
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Linked gateways are not available"));
    expect(log().filter((line) => line.includes("slack"))).toEqual([]);
  });

  it("shows an explicit message and calls nothing when the remote has no multi-user account", async () => {
    gateways.on("GET", `${east}/api/capabilities`, { json: caps({ multiUser: false, user: undefined }) });
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toBe("No pairings on this gateway. It has no multi-user sign-in."));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(log().filter((line) => line.includes("slack"))).toEqual([]);
    expect(text()).not.toContain("Sign in to manage");
  });

  it("shows neutral text when the remote answers multi_user_required, and no local identity", async () => {
    gateways.on("GET", `${east}/api/slack/pairings`, { status: 409, json: { error: "multi_user_required" } });
    gateways.on("GET", `${east}/api/surface-links`, { status: 409, json: { error: "multi_user_required" } });
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toBe("No pairings on this gateway."));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(unpairButtons()).toHaveLength(0);
  });

  it("hides the Slack section when the remote has no Slack extension", async () => {
    gateways.on("GET", `${east}/api/slack/pairings`, { status: 404, json: { error: "extension_disabled" } });
    gateways.on("GET", `${east}/api/surface-links`, { status: 404, json: { error: "extension_disabled" } });
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toBe("No pairings on this gateway."));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("h2")).toBeNull();
  });

  it("keeps a 404 with another code as an error", async () => {
    gateways.on("GET", `${east}/api/slack/pairings`, { status: 404, json: { error: "unknown_gateway" } });
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe("Failed to load Slack pairings"));
  });

  it("shows Retry when the remote capabilities fail, and reads after a good retry", async () => {
    let failing = true;
    gateways.on("GET", `${east}/api/capabilities`, () => failing ? { status: 502, json: { error: "gateway_offline" } } : { json: caps() });
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(button("Retry")).toBeDefined());
    expect(log().filter((line) => line.includes("slack"))).toEqual([]);
    failing = false;
    button("Retry")!.click();
    await vi.waitFor(() => expect(text()).toContain("Slack user UEAST"));
  });

  it("keeps the owner of each gateway apart and returns to the same gateway with its own list", async () => {
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("Slack user UEAST"));
    choose("west");
    await vi.waitFor(() => expect(text()).toContain("Slack user UWEST"));
    expect(text()).not.toContain("UEAST");
    choose("east");
    await vi.waitFor(() => expect(text()).toContain("Slack user UEAST"));
    expect(text()).not.toContain("UWEST");
  });

  it("ignores a late list of an earlier gateway after the page moved on", async () => {
    let release: (() => void) | undefined;
    gateways.on("GET", `${east}/api/slack/pairings`, () => new Promise<FakeAnswer>((resolve) => { release = () => resolve({ json: { pairings: [pairing("UEAST")] } }); }));
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(release).toBeDefined());
    choose("west");
    await vi.waitFor(() => expect(text()).toContain("Slack user UWEST"));
    release!();
    await tick();
    expect(text()).not.toContain("UEAST");
  });

  it("ignores a late unpair answer after the page moved to another gateway, and changes nothing there", async () => {
    let fail: (() => void) | undefined;
    gateways.on("DELETE", `${east}/api/slack/pairings/T1/UEAST`, () => new Promise<FakeAnswer>((resolve) => { fail = () => resolve({ status: 502, json: { error: "gateway_offline" } }); }));
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(unpairButtons()).toHaveLength(1));
    unpairButtons()[0].click();
    await vi.waitFor(() => expect(fail).toBeDefined());
    choose("west");
    await vi.waitFor(() => expect(text()).toContain("Slack user UWEST"));
    fail!();
    await tick(); await tick();
    expect(text()).not.toContain("The remote gateway is offline.");
    expect(log().filter((line) => line === `GET ${east}/api/slack/pairings`)).toHaveLength(1);
    expect(unpairButtons()[0].disabled).toBe(false);
  });

  it("starts nothing after the page closes during an unpair", async () => {
    let finish: (() => void) | undefined;
    gateways.on("DELETE", `${east}/api/slack/pairings/T1/UEAST`, () => new Promise<FakeAnswer>((resolve) => { finish = () => resolve({ json: { ok: true } }); }));
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(unpairButtons()).toHaveLength(1));
    unpairButtons()[0].click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    history.set({ value: "/elsewhere" });
    await vi.waitFor(() => expect(text()).toContain("Elsewhere"));
    const reads = log().filter((line) => line === `GET ${east}/api/slack/pairings`).length;
    finish!();
    await tick(); await tick();
    expect(log().filter((line) => line === `GET ${east}/api/slack/pairings`).length).toBe(reads);
  });

  it("reads the same gateway after a failed unpair, and keeps the controls off until the read works", async () => {
    gateways.on("DELETE", `${east}/api/slack/pairings/T1/UEAST`, { status: 502, json: { error: "gateway_offline" } });
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(unpairButtons()).toHaveLength(1));
    let reading = false;
    gateways.on("GET", `${east}/api/slack/pairings`, () => reading ? { json: { pairings: [pairing("UEAST")] } } : { status: 502, json: { error: "gateway_offline" } });
    unpairButtons()[0].click();
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("The remote gateway is offline."));
    await vi.waitFor(() => expect(button("Retry")).toBeDefined());
    expect(writes()).toHaveLength(1);
    // No pairing control works while the list is unknown, and no second DELETE goes out.
    expect(unpairButtons()).toHaveLength(0);
    reading = true;
    button("Retry")!.click();
    await vi.waitFor(() => expect(unpairButtons()).toHaveLength(1));
    expect(unpairButtons()[0].disabled).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  it("keeps Unpair off and sends no second DELETE while the recovery read is still pending", async () => {
    gateways.on("GET", `${east}/api/slack/pairings`, { json: { pairings: [pairing("UEAST"), pairing("UEAST2")] } });
    gateways.on("DELETE", new RegExp(`^${east}/api/slack/pairings/`), { status: 502, json: { error: "gateway_offline" } });
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(unpairButtons()).toHaveLength(2));
    // The recovery read never ends during the checks below.
    let release: (() => void) | undefined;
    gateways.on("GET", `${east}/api/slack/pairings`, () => new Promise<FakeAnswer>((resolve) => { release = () => resolve({ json: { pairings: [pairing("UEAST"), pairing("UEAST2")] } }); }));
    unpairButtons()[0].click();
    await vi.waitFor(() => expect(release).toBeDefined());
    await tick(); await tick();
    // The old list is still visible, and every control is off.
    expect(unpairButtons()).toHaveLength(2);
    for (const control of unpairButtons()) expect(control.disabled).toBe(true);
    for (const control of unpairButtons()) control.click();
    await tick();
    expect(writes()).toHaveLength(1);
    // A good read ends the lock.
    release!();
    await vi.waitFor(() => expect(unpairButtons().every((control) => !control.disabled)).toBe(true));
    expect(writes()).toHaveLength(1);
  });

  it("keeps Unpair off after a recovery read that fails, until one read works", async () => {
    gateways.on("DELETE", `${east}/api/slack/pairings/T1/UEAST`, { status: 502, json: { error: "gateway_offline" } });
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(unpairButtons()).toHaveLength(1));
    let readable = false;
    gateways.on("GET", `${east}/api/slack/pairings`, () => readable ? { json: { pairings: [pairing("UEAST")] } } : { status: 502, json: { error: "gateway_offline" } });
    unpairButtons()[0].click();
    await vi.waitFor(() => expect(button("Retry")).toBeDefined());
    button("Retry")!.click();
    await vi.waitFor(() => expect(button("Retry")).toBeDefined());
    expect(unpairButtons()).toHaveLength(0);
    expect(writes()).toHaveLength(1);
    readable = true;
    button("Retry")!.click();
    await vi.waitFor(() => expect(unpairButtons()).toHaveLength(1));
    expect(unpairButtons()[0].disabled).toBe(false);
  });

  it("keeps the unpair error and Retry when the recovery read says Slack is unavailable", async () => {
    gateways.on("DELETE", `${east}/api/slack/pairings/T1/UEAST`, { status: 502, json: { error: "gateway_offline" } });
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(unpairButtons()).toHaveLength(1));
    gateways.on("GET", `${east}/api/slack/pairings`, { status: 503, json: { error: "slack_unavailable" } });
    unpairButtons()[0].click();
    await vi.waitFor(() => expect(button("Retry")).toBeDefined());
    expect(text()).toContain("The remote gateway is offline.");
    expect(text()).not.toContain("No pairings on this gateway.");
    expect(unpairButtons()).toHaveLength(0);
    expect(writes()).toHaveLength(1);
  });

  it("keeps the list that the recovery read returns, with the error message, after a failed unpair", async () => {
    gateways.on("DELETE", `${east}/api/slack/pairings/T1/UEAST`, { status: 403, json: { error: "forbidden" } });
    mount("/account/connections?gateway=east");
    await vi.waitFor(() => expect(unpairButtons()).toHaveLength(1));
    unpairButtons()[0].click();
    await vi.waitFor(() => expect(text()).toContain("The remote gateway refused this action."));
    await vi.waitFor(() => expect(log().filter((line) => line === `GET ${east}/api/slack/pairings`).length).toBe(2));
    expect(unpairButtons()).toHaveLength(1);
    expect(unpairButtons()[0].disabled).toBe(false);
  });
});
