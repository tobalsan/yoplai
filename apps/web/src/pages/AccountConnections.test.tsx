// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Suspense, type JSX } from "solid-js";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";

const { useSessionMock, fetchPairingsMock, unpairMock } = vi.hoisted(() => ({
  useSessionMock: vi.fn(),
  fetchPairingsMock: vi.fn(),
  unpairMock: vi.fn(),
}));
vi.mock("../auth/client", () => ({ useSession: useSessionMock }));
vi.mock("../api/gateway", async (original) => ({ ...(await original<typeof import("../api/gateway")>()), fetchGatewayList: () => Promise.resolve({ state: "unavailable" }) }));
vi.mock("../components/LeftNavShell", () => ({ LeftNavShell: (props: { children: unknown }) => props.children }));
vi.mock("../api/connections", () => ({
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
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  dispose?.();
  root.remove();
});

describe("AccountConnections", () => {
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
    expect(root.textContent).toContain("Loading Slack pairings");
    reject(new Error("service unavailable"));
    await tick();
    expect(root.textContent).toContain("service unavailable");
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
});
