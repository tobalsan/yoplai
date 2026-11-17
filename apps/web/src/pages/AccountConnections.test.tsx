// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Suspense, type JSX } from "solid-js";
import { setCapabilitiesForTests, resetCapabilitiesForTests } from "../lib/capabilities";
import { PairingApiError } from "../api/connections";
import { within } from "@testing-library/dom";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";

const { useSessionMock, fetchPairingsMock, unpairMock, fetchMock } = vi.hoisted(() => ({
  useSessionMock: vi.fn(),
  fetchPairingsMock: vi.fn(),
  unpairMock: vi.fn(),
  fetchMock: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock("../auth/client", () => ({ useSession: useSessionMock }));
vi.mock("../api/gateway", async (original) => ({ ...(await original<typeof import("../api/gateway")>()), fetchGatewayList: () => Promise.resolve({ state: "unavailable" }) }));
vi.mock("../components/LeftNavShell", () => ({ LeftNavShell: (props: { children: unknown }) => props.children }));
vi.mock("../api/connections", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api/connections")>(),
  fetchSlackPairings: fetchPairingsMock,
  unpairSlackAccount: unpairMock,
}));

import { AccountConnections } from "./AccountConnections";

function mountPage() {
  const history = createMemoryHistory();
  history.set({ value: "/account/connections", replace: true });
  return render(() => (
    <MemoryRouter history={history} root={(props: { children?: JSX.Element }) => <Suspense>{props.children}</Suspense>}>
      <Route path="/account/connections" component={AccountConnections} />
    </MemoryRouter>
  ), root);
}

let root: HTMLDivElement;
let dispose: () => void;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const pairing = { workspaceId: "T1", slackUserId: "U1", pairedAt: 1000 };

beforeEach(() => {
  fetchPairingsMock.mockReset();
  unpairMock.mockReset();
  fetchMock.mockReset().mockImplementation(async () => Response.json({ links: [] }));
  vi.stubGlobal("fetch", fetchMock);
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  dispose?.();
  root.remove();
  vi.unstubAllGlobals();
  resetCapabilitiesForTests();
});

describe("AccountConnections", () => {
  it("lists linked Threadit and Mattermost accounts and explains how to connect", async () => {
    const [session] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    fetchPairingsMock.mockResolvedValue([]);
    fetchMock.mockResolvedValueOnce(Response.json({ links: [
      { id: "link-threadit", surface: "threadit", scope: "https://board.example.test", externalId: "31", username: "river", linkedAt: 1704067200000 },
      { id: "link-mattermost", surface: "mattermost", scope: "https://chat.example.test", externalId: "user-ember", username: "ember", linkedAt: 1704067200000 },
    ] }));
    dispose = mountPage();
    await tick();
    expect(fetchMock).toHaveBeenCalledWith("/api/surface-links", expect.objectContaining({ credentials: "include" }));
    expect(root.textContent).toContain("Threadit @river");
    expect(root.textContent).toContain("Mattermost @ember");
    expect(root.textContent).toContain("https://board.example.test");
    expect(root.textContent).toContain("Linked");
    expect(root.textContent).toContain("Send !pair to an agent on Threadit or Mattermost to link an account.");
  });

  it("unlinks an account and refreshes the displayed links", async () => {
    const [session] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    fetchPairingsMock.mockResolvedValue([]);
    fetchMock
      .mockResolvedValueOnce(Response.json({ links: [{ id: "link-threadit", surface: "threadit", scope: "https://board.example.test", externalId: "31", username: "river", linkedAt: 1704067200000 }] }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ links: [] }));
    dispose = mountPage();
    await tick();
    expect(root.textContent).toContain("Threadit @river");
    root.querySelector<HTMLButtonElement>("button")!.click();
    await tick();
    expect(fetchMock).toHaveBeenCalledWith("/api/surface-links/link-threadit", expect.objectContaining({ method: "DELETE", credentials: "include" }));
    expect(root.textContent).not.toContain("Threadit @river");
    expect(root.textContent).toContain("No Threadit or Mattermost accounts are linked.");
  });

  it("keeps pending unlink state scoped to the account that started it", async () => {
    const [session, setSession] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    fetchPairingsMock.mockResolvedValue([]);
    let finishAlice!: (response: Response) => void;
    let finishBob!: (response: Response) => void;
    fetchMock
      .mockResolvedValueOnce(Response.json({ links: [{ id: "alice-link", surface: "threadit", scope: "https://board.example.test", externalId: "31", username: "river", linkedAt: 1704067200000 }] }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { finishAlice = resolve; }))
      .mockResolvedValueOnce(Response.json({ links: [{ id: "bob-link", surface: "mattermost", scope: "https://chat.example.test", externalId: "user-ember", username: "ember", linkedAt: 1704067200000 }] }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { finishBob = resolve; }))
      .mockResolvedValueOnce(Response.json({ links: [] }));
    dispose = mountPage();
    await tick();
    root.querySelector<HTMLButtonElement>("button")!.click();
    expect(root.textContent).toContain("Removing…");
    setSession({ data: { user: { id: "bob" } } });
    await tick();
    expect(root.textContent).not.toContain("@river");
    const bobButton = root.querySelector<HTMLButtonElement>("button")!;
    expect(bobButton.disabled).toBe(false);
    bobButton.click();
    finishAlice(Response.json({ ok: true }));
    await tick();
    expect(root.textContent).toContain("Mattermost @ember");
    expect(bobButton.disabled).toBe(true);
    expect(bobButton.textContent).toBe("Removing…");
    finishBob(Response.json({ ok: true }));
    await tick();
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "DELETE").map((call) => call[0])).toEqual([
      "/api/surface-links/alice-link", "/api/surface-links/bob-link",
    ]);
    expect(root.textContent).toContain("No Threadit or Mattermost accounts are linked.");
  });

  it("ignores a late linked-account response after the signed-in account changes", async () => {
    const [session, setSession] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    fetchPairingsMock.mockResolvedValue([]);
    let finishAlice!: (response: Response) => void;
    fetchMock
      .mockReturnValueOnce(new Promise<Response>((resolve) => { finishAlice = resolve; }))
      .mockResolvedValueOnce(Response.json({ links: [{ id: "bob-link", surface: "mattermost", scope: "https://chat.example.test", externalId: "user-ember", username: "ember", linkedAt: 1704067200000 }] }));
    dispose = mountPage();
    setSession({ data: { user: { id: "bob" } } });
    await tick();
    expect(root.textContent).toContain("Mattermost @ember");
    finishAlice(Response.json({ links: [{ id: "alice-link", surface: "threadit", scope: "https://board.example.test", externalId: "31", username: "river", linkedAt: 1704067200000 }] }));
    await tick();
    expect(root.textContent).toContain("Mattermost @ember");
    expect(root.textContent).not.toContain("@river");
  });

  it("keeps Slack usable while a hung linked-account request reaches its actual timeout", async () => {
    const [session] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    fetchPairingsMock.mockResolvedValueOnce([pairing]).mockResolvedValueOnce([]);
    unpairMock.mockResolvedValue(undefined);
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
    }));
    dispose = mountPage();
    await tick();
    expect(root.textContent).toContain("Loading linked accounts…");
    expect(root.textContent).toContain("Slack user U1");
    root.querySelector<HTMLButtonElement>("button")!.click();
    await tick();
    expect(unpairMock).toHaveBeenCalledWith(pairing, undefined);
    expect(root.textContent).toContain("No pairings yet.");
    expect(root.textContent).toContain("Loading linked accounts…");
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull(), { timeout: 10_000 });
    expect(signal?.aborted).toBe(true);
    expect(root.textContent).toContain("No pairings yet.");
    expect(root.textContent).not.toContain("Loading linked accounts…");
  }, 15_000);

  it("shows a failed linked-account response without hiding Slack pairings", async () => {
    const [session] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    fetchPairingsMock.mockResolvedValue([pairing]);
    fetchMock.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
    dispose = mountPage();
    await tick();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("Failed to load linked accounts");
    expect(root.textContent).toContain("Slack user U1");
  });

  it("keeps a linked account visible and usable when unlinking fails", async () => {
    const [session] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    fetchPairingsMock.mockResolvedValue([]);
    fetchMock
      .mockResolvedValueOnce(Response.json({ links: [{ id: "alice-link", surface: "threadit", scope: "https://board.example.test", externalId: "31", username: "river", linkedAt: 1704067200000 }] }))
      .mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
    dispose = mountPage();
    await tick();
    root.querySelector<HTMLButtonElement>("button")!.click();
    await tick();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("Failed to unlink account");
    expect(root.textContent).toContain("Threadit @river");
    expect(root.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("loads and removes the signed-in user's Slack pairing", async () => {
    const [session] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    fetchPairingsMock.mockResolvedValue([pairing]);
    unpairMock.mockResolvedValue(undefined);
    dispose = mountPage();
    await tick();
    expect(root.textContent).toContain("U1");
    root.querySelector("button")!.click();
    await tick();
    expect(unpairMock).toHaveBeenCalledWith(pairing, undefined);
    expect(fetchPairingsMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces loading and request failures", async () => {
    const [session] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    let reject!: (cause: Error) => void;
    fetchPairingsMock.mockReturnValue(new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    dispose = mountPage();
    expect(root.textContent).toContain("Loading");
    reject(new Error("service unavailable"));
    await tick();
    expect(within(root).getByRole("alert").textContent).toBe("service unavailable");
  });

  it("clears prior identity data and ignores a late response after account changes", async () => {
    const [session, setSession] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    let resolveAlice!: (value: unknown) => void;
    fetchPairingsMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveAlice = resolve; }))
      .mockResolvedValueOnce([{ workspaceId: "T2", slackUserId: "U2", pairedAt: 2000 }]);
    dispose = mountPage();
    setSession({ data: { user: { id: "bob" } } });
    await tick();
    expect(root.textContent).toContain("U2");
    resolveAlice([pairing]);
    await tick();
    expect(root.textContent).toContain("U2");
    expect(root.textContent).not.toContain("U1");
  });

  it("shows the Slack section under its own heading", async () => {
    setCapabilitiesForTests({ multiUser: true });
    const [session] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    fetchPairingsMock.mockResolvedValue([]);
    dispose = mountPage();
    await tick();
    expect(within(root).getByRole("heading", { level: 1, name: "Pairings" })).toBeTruthy();
    expect(within(root).getByRole("heading", { level: 2, name: "Slack" })).toBeTruthy();
    expect(root.textContent).toContain("No pairings yet.");
  });

  it("shows neutral text for a local single-user gateway", async () => {
    setCapabilitiesForTests({ multiUser: false });
    const [session] = createSignal({ data: null, isPending: false });
    useSessionMock.mockReturnValue(session);
    dispose = mountPage();
    await tick();
    expect(within(root).getByRole("status").textContent).toBe("No pairings on this gateway. It has no multi-user sign-in.");
    expect(within(root).queryByRole("alert")).toBeNull();
    expect(fetchPairingsMock).not.toHaveBeenCalled();
  });

  it.each([
    [404, "extension_disabled"],
    [503, "slack_unavailable"],
    [409, "multi_user_required"],
  ])("hides the Slack section and keeps the other channel sections for %i %s", async (status, code) => {
    setCapabilitiesForTests({ multiUser: true });
    const [session] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    fetchPairingsMock.mockRejectedValue(new PairingApiError("fixed text", status, code));
    dispose = mountPage();
    await tick();
    expect(within(root).queryByRole("heading", { level: 2, name: "Slack" })).toBeNull();
    expect(within(root).queryByRole("alert")).toBeNull();
    expect(within(root).getByRole("heading", { level: 2, name: "Threadit and Mattermost" })).toBeTruthy();
    expect(within(root).queryByText("No pairings on this gateway.")).toBeNull();
  });

  it("keeps another 404 as an error", async () => {
    setCapabilitiesForTests({ multiUser: true });
    const [session] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    fetchPairingsMock.mockRejectedValue(new PairingApiError("Failed to load Slack pairings", 404, "unknown_gateway"));
    dispose = mountPage();
    await tick();
    expect(within(root).getByRole("alert").textContent).toBe("Failed to load Slack pairings");
    expect(within(root).getByRole("heading", { level: 2, name: "Slack" })).toBeTruthy();
  });
});
