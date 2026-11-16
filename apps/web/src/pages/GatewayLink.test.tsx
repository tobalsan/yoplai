// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { waitFor, within } from "@testing-library/dom";
import type { GatewayLinkConsentView } from "@yoplai/shared";

const api = vi.hoisted(() => ({
  fetchGatewayLinkConsent: vi.fn(),
  approveGatewayLink: vi.fn(),
  denyGatewayLink: vi.fn(),
  openLocalCallback: vi.fn(),
}));
vi.mock("../api/gateway-link", async (original) => ({ ...(await original<typeof import("../api/gateway-link")>()), ...api }));

import { GatewayLinkApiError } from "../api/gateway-link";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";
import { GatewayLink } from "./GatewayLink";

const view = (overrides: Partial<GatewayLinkConsentView> = {}): GatewayLinkConsentView => ({
  requestId: "request-1",
  status: "pending",
  deviceLabel: "Work laptop",
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  account: { email: "alice@example.test", name: "Alice" },
  replaces: null,
  replaceConflict: false,
  nonce: "nonce-1",
  ...overrides,
});

let root: HTMLDivElement;
let dispose: (() => void) | undefined;

function mount(location = "/gateway-link?request=request-1") {
  const history = createMemoryHistory();
  history.set({ value: location, replace: true });
  dispose = render(
    () => (
      <MemoryRouter history={history} root={(props: { children?: JSX.Element }) => <Suspense>{props.children}</Suspense>}>
        <Route path="/gateway-link" component={GatewayLink} />
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

describe("GatewayLink consent page", () => {
  it("shows who asks and what the key can do, and approves only after the user clicks", async () => {
    api.fetchGatewayLinkConsent.mockResolvedValue(view());
    api.approveGatewayLink.mockResolvedValue("http://127.0.0.1:4555/api/relay/link/callback#code=c&state=s");
    const screen = mount();
    expect(await screen.findByRole("heading", { name: "Link a device" })).toBeTruthy();
    expect(screen.getByText("Work laptop")).toBeTruthy();
    expect(screen.getByText("alice@example.test")).toBeTruthy();
    expect(screen.getByText(/full access of your account/i)).toBeTruthy();
    expect(api.fetchGatewayLinkConsent).toHaveBeenCalledWith("request-1");
    // The page never approves on its own.
    expect(api.approveGatewayLink).not.toHaveBeenCalled();
    expect(api.openLocalCallback).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "Approve" }).click();
    await waitFor(() => expect(api.openLocalCallback).toHaveBeenCalledWith("http://127.0.0.1:4555/api/relay/link/callback#code=c&state=s"));
    expect(api.approveGatewayLink).toHaveBeenCalledWith("request-1", "nonce-1");
    expect(api.denyGatewayLink).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Returning to the gateway");
  });

  it("refuses with the denial callback and never approves", async () => {
    api.fetchGatewayLinkConsent.mockResolvedValue(view());
    api.denyGatewayLink.mockResolvedValue("http://127.0.0.1:4555/api/relay/link/callback#error=access_denied&state=s");
    const screen = mount();
    (await screen.findByRole("button", { name: "Refuse" })).click();
    await waitFor(() => expect(api.openLocalCallback).toHaveBeenCalledWith(expect.stringContaining("error=access_denied")));
    expect(api.denyGatewayLink).toHaveBeenCalledWith("request-1", "nonce-1");
    expect(api.approveGatewayLink).not.toHaveBeenCalled();
  });

  it("links to the owner list of linked devices", async () => {
    api.fetchGatewayLinkConsent.mockResolvedValue(view());
    const screen = mount();
    const link = await screen.findByRole("link", { name: "Manage linked devices" });
    expect(link.getAttribute("href")).toBe("/account/gateway-links");
  });

  it("says when a request replaces a link of the account", async () => {
    api.fetchGatewayLinkConsent.mockResolvedValue(view({ replaces: { id: "link-1", deviceLabel: "Old laptop" } }));
    const screen = mount();
    expect(await screen.findByText(/replaces your link for Old laptop/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks approval when the request names a link of another account", async () => {
    api.fetchGatewayLinkConsent.mockResolvedValue(view({ replaceConflict: true }));
    const screen = mount();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("another account");
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Refuse" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ["expired", /expired/],
    ["used", /already used/],
    ["denied", /refused/],
    ["approved", /approved/],
  ] as const)("offers no answer for a %s request", async (status, text) => {
    api.fetchGatewayLinkConsent.mockResolvedValue(view({ status }));
    const screen = mount();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refuse" })).toBeNull();
  });

  it("shows the reason and lets the user try again when the answer fails", async () => {
    api.fetchGatewayLinkConsent.mockResolvedValue(view());
    api.approveGatewayLink.mockRejectedValueOnce(new GatewayLinkApiError("rate_limited", 429));
    const screen = mount();
    (await screen.findByRole("button", { name: "Approve" })).click();
    expect((await screen.findByRole("alert")).textContent).toContain("Too many attempts");
    expect(api.openLocalCallback).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows a failed read of the request", async () => {
    api.fetchGatewayLinkConsent.mockRejectedValue(new GatewayLinkApiError("not_found", 404));
    const screen = mount();
    expect((await screen.findByRole("alert")).textContent).toContain("does not exist or has expired");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("asks for a request when the address has none, and reads nothing", async () => {
    const screen = mount("/gateway-link");
    expect((await screen.findByRole("alert")).textContent).toContain("needs a link request");
    expect(api.fetchGatewayLinkConsent).not.toHaveBeenCalled();
  });

  it("says so on a gateway with no multi-user sign-in", async () => {
    setCapabilitiesForTests({ multiUser: false });
    const screen = mount();
    expect((await screen.findByRole("alert")).textContent).toContain("multi-user");
    expect(api.fetchGatewayLinkConsent).not.toHaveBeenCalled();
  });
});
