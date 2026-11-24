// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findByRole } from "@testing-library/dom";
import { render } from "solid-js/web";
import App from "./App";
import { resetCapabilitiesForTests } from "./lib/capabilities";

let root: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), location.origin).pathname;
    if (path === "/api/capabilities") return Response.json({ multiUser: false, extensions: {}, agents: [], apps: { available: false }, version: 2, relayLink: { available: true } });
    if (path === "/api/relay/link/metadata") {
      return Response.json({
        gateways: [{ name: "work", remote: "https://remote.example.test", kind: "browser", account: "alice@example.test", deviceLabel: "Work laptop", linkId: "link-1", expiresAt: null, keyState: "active", connection: "connected" }],
      });
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

it("shows the linked gateways of a local gateway at /remote-gateways, and a link control in the sidebar", async () => {
  history.replaceState({}, "", "/remote-gateways");
  dispose = render(() => <App />, root);
  expect(await findByRole(root, "heading", { name: "Linked gateways" })).toBeTruthy();
  expect(await findByRole(root, "button", { name: "Disconnect work" })).toBeTruthy();
  (await findByRole(root, "button", { name: "Account menu" })).click();
  const menu = await findByRole(root, "menu");
  expect(await findByRole(menu, "menuitem", { name: "Link gateway" })).toBeTruthy();
});
