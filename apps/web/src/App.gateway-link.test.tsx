// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findByRole, getByRole, waitFor } from "@testing-library/dom";
import { render } from "solid-js/web";
import App from "./App";
import { resetCapabilitiesForTests } from "./lib/capabilities";

const REQUEST_ID = "r".repeat(43);
const user = { id: "user-1", name: "Alice", email: "alice@example.test", approved: true };

// The sign-in client is a stand-in: the test decides whether a session exists. Everything else is the real app.
const sessionState = vi.hoisted(() => ({ current: { data: null as unknown, isPending: false } }));
vi.mock("./auth/client", () => ({
  useSession: () => () => sessionState.current,
  signIn: { social: vi.fn(), email: vi.fn() },
  signUp: { email: vi.fn() },
  signOut: vi.fn(),
}));

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
let calls: string[];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sessionState.current = { data: { user, session: { id: "session-1" } }, isPending: false };
  calls = [];
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), location.origin).pathname;
    calls.push(path);
    if (path === "/api/capabilities") return Response.json({ multiUser: true, extensions: {}, agents: [], apps: { available: false }, version: 2, authMethods: { google: false, emailAndPassword: true }, user: { id: user.id } });
    if (path === `/api/auth/gateway-link/requests/${REQUEST_ID}`) {
      return Response.json({ requestId: REQUEST_ID, status: "pending", deviceLabel: "Work laptop", expiresAt: new Date(Date.now() + 300_000).toISOString(), account: { email: user.email, name: user.name }, replaces: null, replaceConflict: false, nonce: "nonce" });
    }
    if (path === "/api/auth/gateway-link/links") {
      return Response.json({ links: [{ id: "link-1", deviceLabel: "Work laptop", status: "active", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), revokedAt: null }] });
    }
    return Response.json([]);
  }));
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  root.remove();
  resetCapabilitiesForTests();
  vi.unstubAllGlobals();
});

it("shows the consent page of a signed-in user at /gateway-link", async () => {
  history.replaceState({}, "", `/gateway-link?request=${REQUEST_ID}`);
  dispose = render(() => <App />, root);
  expect(await findByRole(root, "heading", { name: "Link a device" })).toBeTruthy();
  await waitFor(() => expect(getByRole(root, "button", { name: "Approve" })).toBeTruthy());
  expect(getByRole(root, "button", { name: "Refuse" })).toBeTruthy();
  expect(root.textContent).toContain("Work laptop");
  expect(getByRole(root, "link", { name: "Manage linked devices" }).getAttribute("href")).toBe("/account/gateway-links");
  // The page only reads. It makes no answer call on its own.
  expect(calls.some((path) => path.endsWith("/approve") || path.endsWith("/deny"))).toBe(false);
});

it("sends a signed-out user to sign in and keeps the request for the return", async () => {
  sessionState.current = { data: null, isPending: false };
  history.replaceState({}, "", `/gateway-link?request=${REQUEST_ID}`);
  dispose = render(() => <App />, root);
  await waitFor(() => expect(location.pathname).toBe("/login"));
  expect(new URLSearchParams(location.search).get("returnTo")).toBe(`/gateway-link?request=${REQUEST_ID}`);
});

it("lists linked devices at /account/gateway-links", async () => {
  history.replaceState({}, "", "/account/gateway-links");
  dispose = render(() => <App />, root);
  expect(await findByRole(root, "heading", { name: "Linked devices" })).toBeTruthy();
  expect(await findByRole(root, "button", { name: "Revoke Work laptop" })).toBeTruthy();
});
