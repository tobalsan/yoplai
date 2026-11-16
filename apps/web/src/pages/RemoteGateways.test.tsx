// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { fireEvent, within } from "@testing-library/dom";

const api = vi.hoisted(() => ({
  startLink: vi.fn(),
  fetchLinkStatus: vi.fn(),
  cancelLink: vi.fn(),
  fetchLinkRows: vi.fn(),
  disconnectLink: vi.fn(),
  openConsentPage: vi.fn(),
}));
vi.mock("../api/relay-link", async (original) => ({ ...(await original<typeof import("../api/relay-link")>()), ...api }));
vi.mock("../components/LeftNavShell", () => ({ LeftNavShell: (props: { children: unknown }) => props.children }));

import { RelayLinkApiError, type LinkRow } from "../api/relay-link";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";
import { RemoteGateways } from "./RemoteGateways";

const REMOTE = "https://remote.example.test";
const browserRow = (overrides: Partial<LinkRow> = {}): LinkRow => ({
  name: "work",
  remote: REMOTE,
  kind: "browser",
  account: "alice@example.test",
  deviceLabel: "Work laptop",
  linkId: "link-1",
  expiresAt: "2026-04-02T00:00:00.000Z",
  keyState: "active",
  connection: "connected",
  ...overrides,
});
const manualRow: LinkRow = { name: "manual", remote: "https://manual.example.test", kind: "token", account: null, deviceLabel: null, linkId: null, expiresAt: null, keyState: "unknown", connection: "offline" };
const pendingStart = { kind: "pending", attemptId: "a".repeat(43), controlToken: "c".repeat(43), expiresAt: "2026-01-01T00:05:00.000Z", consentUrl: `${REMOTE}/gateway-link?request=req-1` };

let root: HTMLDivElement;
let dispose: (() => void) | undefined;

function mount() {
  const history = createMemoryHistory();
  history.set({ value: "/remote-gateways", replace: true });
  dispose = render(
    () => (
      <MemoryRouter history={history} root={(props: { children?: JSX.Element }) => <Suspense>{props.children}</Suspense>}>
        <Route path="/remote-gateways" component={RemoteGateways} />
      </MemoryRouter>
    ),
    root,
  );
  return within(root);
}

const flush = () => vi.advanceTimersByTimeAsync(1600);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  Object.values(api).forEach((mock) => mock.mockReset());
  api.fetchLinkRows.mockResolvedValue([]);
  setCapabilitiesForTests({ relayLink: { available: true } });
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  root.remove();
  resetCapabilitiesForTests();
  vi.useRealTimers();
});

describe("RemoteGateways", () => {
  it("shows the link form with no saved gateway, and an empty list", async () => {
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByRole("textbox", { name: /Remote gateway address/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link gateway" })).toBeTruthy();
    expect(screen.getByText("No gateway is linked.")).toBeTruthy();
  });

  it("hides the form and says why when this gateway cannot receive the callback", async () => {
    setCapabilitiesForTests({ relayLink: { available: false } });
    api.fetchLinkRows.mockResolvedValue([browserRow()]);
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.queryByRole("button", { name: "Link gateway" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("127.0.0.1");
    expect(screen.getByText("work")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link work again" })).toBeNull();
  });

  it("lists each link with account, device, key state, and connection state, and unknown fields for a manual link", async () => {
    api.fetchLinkRows.mockResolvedValue([browserRow({ connection: "replaced" }), manualRow, browserRow({ name: "old", keyState: "expired", connection: "unauthorized" })]);
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getAllByText(/Account: alice@example.test · Device: Work laptop/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Account: unknown · Device: unknown/)).toBeTruthy();
    expect(screen.getByText(/Key state unknown/)).toBeTruthy();
    expect(screen.getByText(/Device link replaced/)).toBeTruthy();
    expect(screen.getByText(/Key expired: link again/)).toBeTruthy();
    expect(screen.getByText(/Device link refused by the remote/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link work again" })).toBeTruthy();
    // A manual link has no browser key, so it has no link-again control.
    expect(screen.queryByRole("button", { name: "Link manual again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect manual" })).toBeTruthy();
  });

  it("starts a link, opens the sign-in page, and shows the linked gateway after approval", async () => {
    api.fetchLinkRows.mockResolvedValueOnce([]).mockResolvedValue([browserRow()]);
    api.startLink.mockResolvedValue(pendingStart);
    api.fetchLinkStatus.mockResolvedValueOnce({ status: "pending", name: "work", remote: REMOTE }).mockResolvedValue({ status: "linked", name: "work", remote: REMOTE });
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: ` ${REMOTE} ` } });
    fireEvent.input(screen.getByRole("textbox", { name: /Name/ }), { target: { value: "work" } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(api.startLink).toHaveBeenCalledWith(REMOTE, "work");
    expect(api.openConsentPage).toHaveBeenCalledWith(pendingStart.consentUrl);
    expect(screen.getByRole("link", { name: "Open the sign-in page" }).getAttribute("href")).toBe(pendingStart.consentUrl);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    await flush();
    await flush();
    expect(screen.getByText("Linked work.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect work" })).toBeTruthy();
    // The page sends the control token to the status route and nothing else secret.
    expect(api.fetchLinkStatus).toHaveBeenCalledWith(pendingStart.attemptId, pendingStart.controlToken);
  });

  it("cancels a pending link", async () => {
    api.startLink.mockResolvedValue(pendingStart);
    api.fetchLinkStatus.mockResolvedValue({ status: "pending", name: "work", remote: REMOTE });
    api.cancelLink.mockResolvedValue({ status: "cancelled", name: "work", remote: REMOTE });
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(api.cancelLink).toHaveBeenCalledWith(pendingStart.attemptId, pendingStart.controlToken);
    expect(screen.getByText("The link was cancelled.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("shows a refusal on the remote", async () => {
    api.startLink.mockResolvedValue(pendingStart);
    api.fetchLinkStatus.mockResolvedValue({ status: "denied", name: "work", remote: REMOTE });
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await flush();
    expect(screen.getByText("The link was refused on the remote gateway.")).toBeTruthy();
  });

  it("tells the user to revoke at the owner page after an unconfirmed key", async () => {
    api.startLink.mockResolvedValue(pendingStart);
    api.fetchLinkStatus.mockResolvedValue({
      status: "uncertain", name: "work", remote: REMOTE,
      message: `The remote gateway may have made a key. Revoke it at ${REMOTE}/account/gateway-links, then link again.`,
      ownerPageUrl: `${REMOTE}/account/gateway-links`,
    });
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Revoke it");
    expect(screen.getByRole("link", { name: /linked devices page/ }).getAttribute("href")).toBe(`${REMOTE}/account/gateway-links`);
  });

  it("shows the recovery note when a fresh start finds an unconfirmed key", async () => {
    api.startLink.mockResolvedValue({ ...pendingStart, recoveryNote: "Revoke the old key first." });
    api.fetchLinkStatus.mockResolvedValue({ status: "pending", name: "work", remote: REMOTE });
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByText("Revoke the old key first.")).toBeTruthy();
  });

  it("links a single-user remote at once with no sign-in page", async () => {
    api.startLink.mockResolvedValue({ kind: "linked", name: "open" });
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(api.openConsentPage).not.toHaveBeenCalled();
    expect(screen.getByText(/Linked open/)).toBeTruthy();
  });

  it("shows the gateway message when the start fails", async () => {
    api.startLink.mockRejectedValue(new RelayLinkApiError("invalid_remote", 400, "The remote gateway must use https://."));
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: "http://x.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByRole("alert").textContent).toContain("must use https://");
  });

  it("links a saved gateway again under its own name", async () => {
    api.fetchLinkRows.mockResolvedValue([browserRow()]);
    api.startLink.mockResolvedValue(pendingStart);
    api.fetchLinkStatus.mockResolvedValue({ status: "pending", name: "work", remote: REMOTE });
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.click(screen.getByRole("button", { name: "Link work again" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(api.startLink).toHaveBeenCalledWith(REMOTE, "work");
  });

  it("disconnects a link, and offers a local-only removal with a warning when the remote does not confirm", async () => {
    api.fetchLinkRows.mockResolvedValue([browserRow()]);
    api.disconnectLink.mockRejectedValueOnce(new RelayLinkApiError("revoke_failed", 502, "The remote gateway did not confirm the revoke. The link stays.")).mockResolvedValueOnce({ name: "work", revoked: "skipped" });
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.queryByRole("button", { name: /from this computer only/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect work" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(api.disconnectLink).toHaveBeenCalledWith("work", false);
    expect(screen.getByRole("alert").textContent).toContain("did not confirm the revoke");
    expect(screen.getByText("The remote key remains valid until revocation or expiry.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove work from this computer only" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(api.disconnectLink).toHaveBeenLastCalledWith("work", true);
    expect(screen.getByText(/Removed work from this computer/)).toBeTruthy();
  });

  it("reads the saved links again after a reload, with no attempt in memory", async () => {
    api.fetchLinkRows.mockResolvedValue([browserRow()]);
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByText("work")).toBeTruthy();
    expect(api.fetchLinkStatus).not.toHaveBeenCalled();
  });

  it("explains a gateway with linked gateways turned off", async () => {
    api.fetchLinkRows.mockRejectedValue(new RelayLinkApiError("relay_unavailable", 403, "Linked gateways are off for this gateway."));
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByText("Linked gateways are off for this gateway.")).toBeTruthy();
  });
});
