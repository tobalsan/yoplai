// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getByRole, getByTitle } from "@testing-library/dom";
import { render } from "solid-js/web";
import { Suspense } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { ChatView } from "./ChatView";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
const requests: string[] = [];
class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send() {}
  close() { this.readyState = 3; }
}
beforeEach(() => {
  localStorage.clear();
  requests.length = 0;
  setCapabilitiesForTests({ multiUser: false });
  history.replaceState({}, "", "/dashboards");
  root = document.createElement("div");
  document.body.append(root);
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    requests.push(path);
    if (path === "/api/agents/sage") return Response.json({ id: "sage", name: "Sage", model: { provider: "openai", model: "gpt-4o-mini" } });
    if (path === "/api/agents/sage/suggestions") return Response.json([]);
    if (path === "/api/agents/sessions") return Response.json({ items: [] });
    if (path === "/api/agents/status") return Response.json({ statuses: { sage: "idle" } });
    if (path.includes("/history?")) return Response.json({ messages: [], isStreaming: false, activeTurn: null });
    return Response.json({});
  }));
});
afterEach(() => {
  dispose?.();
  root.remove();
  resetCapabilitiesForTests();
  vi.unstubAllGlobals();
});

it("opens a dashboard Chat link through the real router with a usable fresh composer", async () => {
  dispose = render(() => <Router>
    <Route path="/dashboards" component={() => <a href="/chat/sage?dashboard=garden&new=1">Chat</a>} />
    <Route path="/chat/:agentId" component={() => <Suspense><ChatView /></Suspense>} />
  </Router>, root);
  getByRole(root, "link", { name: "Chat" }).click();
  await vi.waitFor(() => expect(getByTitle(root, "Dashboard dashboard").getAttribute("src")).toBe("/d/garden"));
  expect(location.search).toBe("");
  const composer = getByRole(root, "textbox") as HTMLTextAreaElement;
  composer.value = "Explain the garden dashboard";
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect((getByRole(root, "button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(false));
  expect((getByRole(root, "button", { name: "Attach files" }) as HTMLButtonElement).disabled).toBe(false);
  expect(requests.some((path) => path.includes("/history?") && path.includes("sessionKey=web-"))).toBe(true);
});
