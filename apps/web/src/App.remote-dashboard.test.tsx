// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, getByRole, getByTitle, queryByRole, waitFor, within } from "@testing-library/dom";
import { render } from "solid-js/web";
import App from "./App";
import { resetCapabilitiesForTests } from "./lib/capabilities";

const ID = "d".repeat(32);
const NEXT = "e".repeat(32);
const origin = window.location.origin;
const handleOf = (n: number) => String(n).padStart(43, "h");
const meta = { dashboardId: ID, agentId: "agent-7", canWrite: true, canEdit: true, chat: { sessionId: "sess-1" }, annotation: true };

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
let prepareBodies: Array<Record<string, unknown>>;
class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen?: () => void;
  constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send() {}
  close() { this.readyState = 3; }
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  prepareBodies = [];
  history.replaceState({}, "", "/");
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/capabilities") return Response.json({ multiUser: false, extensions: [], agents: [], apps: { available: false }, version: "test" });
    if (path === "/api/relay/dashboard-views") {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      prepareBodies.push(body);
      const n = prepareBodies.length;
      return Response.json({
        handle: handleOf(n), instance: `instance-${n}`, shellUrl: `/api/relay/dashboard-views/${handleOf(n)}/shell`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), gateway: body.gateway, dashboardId: body.dashboardId,
      }, { status: 201 });
    }
    if (path === "/api/relay/dashboard-views/read") {
      return Response.json({ expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "delivered", gateway: "east", dashboardId: prepareBodies.at(-1)!.dashboardId, meta: { ...meta, dashboardId: prepareBodies.at(-1)!.dashboardId } });
    }
    return Response.json([]);
  }));
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  dispose?.();
  root.remove();
  resetCapabilitiesForTests();
  vi.unstubAllGlobals();
});

const shell = () => getByTitle(root, "Dashboard dashboard") as HTMLIFrameElement;
const fromShell = (frame: HTMLIFrameElement, n: number, event: string, extra: Record<string, unknown> = {}) =>
  window.dispatchEvent(new MessageEvent("message", { data: { channel: "yoplai-shell", instance: `instance-${n}`, event, ...extra }, source: frame.contentWindow, origin }));

it("serves the public remote dashboard route, prepares from its query, and follows history changes", async () => {
  history.replaceState({}, "", `/remote-dashboards/east/${ID}?week=3`);
  dispose = render(() => <App />, root);
  await waitFor(() => expect(prepareBodies).toHaveLength(1));
  expect(prepareBodies[0]).toMatchObject({ gateway: "east", dashboardId: ID, query: "week=3" });
  await waitFor(() => expect(shell().getAttribute("src")).toBe(`/api/relay/dashboard-views/${handleOf(1)}/shell`));
  // The address bar holds the public route only.
  expect(location.pathname + location.search).toBe(`/remote-dashboards/east/${ID}?week=3`);
  const frame = shell();
  fromShell(frame, 1, "renderer-loaded");
  fromShell(frame, 1, "renderer-ready");
  await waitFor(() => expect(getByRole(root, "link", { name: "Chat" }).getAttribute("href")).toBe(`/chat/agent-7%40east?session=sess-1&dashboard=${ID}`));

  // A dashboard link of the same gateway moves the route and prepares a fresh view.
  fromShell(frame, 1, "link-request", { href: `${origin}/api/relay/dashboard-views/${NEXT}/?week=4` });
  await waitFor(() => expect(location.pathname + location.search).toBe(`/remote-dashboards/east/${NEXT}?week=4`));
  await waitFor(() => expect(prepareBodies).toHaveLength(2));
  expect(prepareBodies[1]).toMatchObject({ gateway: "east", dashboardId: NEXT, query: "week=4" });
  expect(queryByRole(root, "link", { name: "Chat" })).toBeNull();
  await waitFor(() => expect(shell().getAttribute("src")).toContain(handleOf(2)));
  expect(shell()).not.toBe(frame);

  // Back prepares a new view of the first dashboard. The old frame never returns.
  history.back();
  await waitFor(() => expect(prepareBodies).toHaveLength(3));
  expect(prepareBodies[2]).toMatchObject({ dashboardId: ID, query: "week=3" });
  await waitFor(() => expect(shell().getAttribute("src")).toContain(handleOf(3)));
  expect(queryByRole(root, "link", { name: "Chat" })).toBeNull();
});

it("shows a visible failure with Reload on the public route when the gateway refuses", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/capabilities") return Response.json({ multiUser: false, extensions: [], agents: [], apps: { available: false }, version: "test" });
    if (path === "/api/relay/dashboard-views") return Response.json({ error: "unknown_gateway" }, { status: 404 });
    return Response.json([]);
  });
  history.replaceState({}, "", `/remote-dashboards/west/${ID}`);
  dispose = render(() => <App />, root);
  await waitFor(() => expect(getByRole(root, "alert").textContent).toContain("No linked gateway has this name."));
  fireEvent.click(getByRole(root, "button", { name: "Reload" }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path) === "/api/relay/dashboard-views")).toHaveLength(2));
});

it("shows the Agents heading in the toolbar with the sidebar toggle", async () => {
  history.replaceState({}, "", "/agents");
  dispose = render(() => <App />, root);
  await waitFor(() => {
    const toolbar = within(getByRole(root, "banner"));
    expect(toolbar.getByRole("heading", { name: "Agents", level: 1 })).toBeTruthy();
    expect(toolbar.getByRole("button", { name: "Toggle sidebar" })).toBeTruthy();
  });
  expect(within(root).getAllByRole("heading", { name: "Agents", level: 1 })).toHaveLength(1);
});
