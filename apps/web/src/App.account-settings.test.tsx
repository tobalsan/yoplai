// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findByRole, findByText, getByRole, queryByRole, waitFor } from "@testing-library/dom";
import { render } from "solid-js/web";
import App from "./App";
import { resetCapabilitiesForTests } from "./lib/capabilities";

const user = { id: "user-1", name: "Alice", email: "alice@example.test" };
vi.mock("./auth/client", () => ({
  useSession: () => () => ({ data: { user, session: { id: "session-1" } }, isPending: false }),
  signOut: vi.fn(),
}));

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
let multiUser: boolean;
let enabled: boolean;
let save: (setting: boolean, signal?: AbortSignal | null) => Promise<Response>;
let chatReads: boolean[];
let suggestionsRequested: boolean;

beforeEach(() => {
  multiUser = false;
  enabled = false;
  chatReads = [];
  suggestionsRequested = false;
  save = async (setting) => {
    enabled = setting;
    return Response.json({ enabled });
  };
  localStorage.clear();
  sessionStorage.clear();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), location.origin).pathname;
    if (path === "/api/capabilities") return Response.json({ multiUser, extensions: {}, agents: [], apps: { available: false }, version: 2, ...(multiUser ? { user } : {}) });
    if (path === "/api/me/durable-mode") {
      if (init?.method === "PUT") return save(JSON.parse(String(init.body)).enabled, init.signal);
      return Response.json({ enabled });
    }
    if (path === "/api/agents/sage") {
      chatReads.push(enabled);
      return Response.json({ id: "sage", name: "Sage", ...(enabled ? { durable: true } : {}) });
    }
    if (path === "/api/agents/sage/history") {
      return Response.json({
        sessionId: enabled ? "durable-main" : "old-chat",
        messages: [
          { role: "user", timestamp: 1, content: [{ type: "text", text: "Check the seedlings" }] },
          { role: "assistant", timestamp: 2, content: [{ type: "text", text: enabled ? "Durable transcript" : "Legacy transcript" }] },
        ],
      });
    }
    if (path === "/api/agents/sage/suggestions") suggestionsRequested = true;
    return Response.json([]);
  }));
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  dispose?.();
  root.remove();
  resetCapabilitiesForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(path: string) {
  history.replaceState({}, "", path);
  dispose = render(() => <App />, root);
}

it("loads the setting, saves changes and reverts a failed save with an error toast", async () => {
  mount("/account/settings");
  const control = await findByRole<HTMLButtonElement>(root, "switch", { name: "Durable mode" });
  await waitFor(() => expect(control.disabled).toBe(false));
  expect(control.getAttribute("aria-checked")).toBe("false");
  control.click();
  await waitFor(() => expect(control.disabled).toBe(false));
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(enabled).toBe(true);

  save = async () => new Response(null, { status: 500 });
  control.click();
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(await findByText(root, "Could not save Durable mode. Try again.")).toBeTruthy();
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(control.disabled).toBe(false);
  getByRole(root, "button", { name: "×" }).click();
});

it("reverts a stalled save when it times out and accepts another change", async () => {
  enabled = true;
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  mount("/account/settings");
  const control = await findByRole<HTMLButtonElement>(root, "switch", { name: "Durable mode" });
  await waitFor(() => expect(control.disabled).toBe(false));
  expect(control.getAttribute("aria-checked")).toBe("true");

  const recover = save;
  save = (_setting, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  control.click();
  expect(control.disabled).toBe(true);
  deadline.abort(new DOMException("Timed out", "TimeoutError"));
  expect(await findByText(root, "Could not save Durable mode. Try again.")).toBeTruthy();
  await waitFor(() => expect(control.getAttribute("aria-checked")).toBe("true"));

  save = recover;
  control.click();
  await waitFor(() => expect(control.disabled).toBe(false));
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(enabled).toBe(false);
  getByRole(root, "button", { name: "×" }).click();
});

it.each([false, true])("opens account settings through the sidebar with multi-user mode %s", async (mode) => {
  multiUser = mode;
  mount("/agents");
  const toggle = await findByRole(root, "button", { name: "Account menu" });
  toggle.click();
  const menu = await findByRole(root, "menu");
  expect(Boolean(queryByRole(menu, "menuitem", { name: "Logout" }))).toBe(mode);
  expect(Boolean(queryByRole(menu, "menuitem", { name: "Linked devices" }))).toBe(mode);
  (await findByRole(menu, "menuitem", { name: "Account settings" })).click();
  expect(await findByRole(root, "heading", { name: "Account settings" })).toBeTruthy();
  await waitFor(() => expect(location.pathname).toBe("/account/settings"));
});

it("loads the updated chat detail when opened while the setting is saving", async () => {
  mount("/account/settings");
  const control = await findByRole<HTMLButtonElement>(root, "switch", { name: "Durable mode" });
  const apply = save;
  let settle!: () => void;
  save = (setting) => new Promise((resolve) => { settle = () => resolve(apply(setting)); });
  control.click();

  history.pushState({}, "", "/chat/sage");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await waitFor(() => expect(suggestionsRequested).toBe(true));
  settle();
  expect(await findByText(root, "Durable transcript")).toBeTruthy();
  expect(chatReads).toEqual([true]);
});
