// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { waitFor, within } from "@testing-library/dom";
import type { GatewayLinkSummary } from "@yoplai/shared";

const api = vi.hoisted(() => ({ fetchGatewayLinks: vi.fn(), revokeGatewayLink: vi.fn() }));
vi.mock("../api/gateway-link", async (original) => ({ ...(await original<typeof import("../api/gateway-link")>()), ...api }));

import { GatewayLinkApiError } from "../api/gateway-link";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";
import { GatewayLinks } from "./GatewayLinks";

const link = (overrides: Partial<GatewayLinkSummary>): GatewayLinkSummary => ({
  id: "link-1",
  deviceLabel: "Work laptop",
  status: "active",
  createdAt: "2026-01-02T00:00:00.000Z",
  expiresAt: "2026-04-02T00:00:00.000Z",
  revokedAt: null,
  ...overrides,
});

let root: HTMLDivElement;
let dispose: (() => void) | undefined;

function mount() {
  const history = createMemoryHistory();
  history.set({ value: "/account/gateway-links", replace: true });
  dispose = render(
    () => (
      <MemoryRouter history={history} root={(props: { children?: JSX.Element }) => <Suspense>{props.children}</Suspense>}>
        <Route path="/account/gateway-links" component={GatewayLinks} />
      </MemoryRouter>
    ),
    root,
  );
  return within(root);
}

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  setCapabilitiesForTests({ multiUser: true });
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  root.remove();
  resetCapabilitiesForTests();
});

describe("GatewayLinks owner list", () => {
  it("lists each device with its state and a revoke control for a link that can still work", async () => {
    api.fetchGatewayLinks.mockResolvedValue([
      link({}),
      link({ id: "link-2", deviceLabel: "Old desktop", status: "revoked", revokedAt: "2026-02-01T00:00:00.000Z" }),
      link({ id: "link-3", deviceLabel: "Spare", status: "expired" }),
      link({ id: "link-4", deviceLabel: "Stuck", status: "blocked" }),
    ]);
    const screen = mount();
    expect(await screen.findByText("Work laptop")).toBeTruthy();
    expect(screen.getByText("Old desktop")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke Work laptop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke Stuck" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke Old desktop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke Spare" })).toBeNull();
    expect(screen.getByText(/Revoked/)).toBeTruthy();
    expect(screen.getByText(/Expired/)).toBeTruthy();
    expect(screen.getByText(/Blocked/)).toBeTruthy();
  });

  it("revokes a link and reads the list again", async () => {
    api.fetchGatewayLinks.mockResolvedValueOnce([link({})]).mockResolvedValueOnce([link({ status: "revoked", revokedAt: "2026-02-01T00:00:00.000Z" })]);
    api.revokeGatewayLink.mockResolvedValue(link({ status: "revoked" }));
    const screen = mount();
    (await screen.findByRole("button", { name: "Revoke Work laptop" })).click();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke Work laptop" })).toBeNull());
    expect(api.revokeGatewayLink).toHaveBeenCalledWith("link-1");
    expect(api.fetchGatewayLinks).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Revoked/)).toBeTruthy();
  });

  it("shows the reason when a revoke fails and keeps the control", async () => {
    api.fetchGatewayLinks.mockResolvedValue([link({})]);
    api.revokeGatewayLink.mockRejectedValue(new GatewayLinkApiError("origin_not_allowed", 403));
    const screen = mount();
    (await screen.findByRole("button", { name: "Revoke Work laptop" })).click();
    expect((await screen.findByRole("alert")).textContent).toContain("cannot approve link requests");
    expect(screen.getByRole("button", { name: "Revoke Work laptop" })).toBeTruthy();
  });

  it("says when no device is linked", async () => {
    api.fetchGatewayLinks.mockResolvedValue([]);
    const screen = mount();
    expect(await screen.findByText("No device is linked to your account.")).toBeTruthy();
  });

  it("shows a failed read", async () => {
    api.fetchGatewayLinks.mockRejectedValue(new GatewayLinkApiError("unavailable", 503));
    const screen = mount();
    expect((await screen.findByRole("alert")).textContent).toContain("cannot link devices right now");
  });

  it("makes no request on a gateway with no multi-user sign-in", async () => {
    setCapabilitiesForTests({ multiUser: false });
    const screen = mount();
    expect((await screen.findByRole("alert")).textContent).toContain("multi-user");
    expect(api.fetchGatewayLinks).not.toHaveBeenCalled();
  });
});
