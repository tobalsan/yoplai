// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAllByRole, getByRole, getByText, getByTitle, queryByRole } from "@testing-library/dom";
import { render } from "solid-js/web";
import { Suspense } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { ChatView } from "./ChatView";
import { ToolbarOnlyShell } from "./ChatView.test-shell";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";
import { getDurableMode } from "../api/durable-mode";

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
const requests: string[] = [];
const wsMessages: Array<{ type: string; clientSendId?: string; message?: string }> = [];
class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send(payload: string) { wsMessages.push(JSON.parse(payload)); }
  close() { this.readyState = 3; }
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  requests.length = 0;
  wsMessages.length = 0;
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
    if (path.startsWith("/api/agents/sessions")) return Response.json({ items: [] });
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
    <Route path="/chat/:agentId" component={() => <Suspense><ToolbarOnlyShell><ChatView /></ToolbarOnlyShell></Suspense>} />
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

it("keeps a linked dashboard active beside saved frames through the real reload route", async () => {
  vi.stubGlobal("innerWidth", 1280);
  const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1000, right: 1000 } as DOMRect);
  history.replaceState({}, "", "/chat/sage?session=saved-session&dashboard=garden");
  sessionStorage.setItem("yoplai.chat-panel-tabs.v1:sage:saved-session", JSON.stringify({
    tabs: [
      { key: "yoplai\nui://yoplai/dashboard\nweather", frame: { id: "weather", title: "Weather" } },
      { key: "yoplai\nui://yoplai/dashboard\ngarden", frame: { id: "garden", title: "Garden" } },
    ],
    active: "yoplai\nui://yoplai/dashboard\nweather",
  }));
  try {
    dispose = render(() => <Router><Route path="/chat/:agentId" component={() => <Suspense><ToolbarOnlyShell><ChatView /></ToolbarOnlyShell></Suspense>} /></Router>, root);
    await vi.waitFor(() => expect(getByRole(root, "tab", { name: "Weather" })).toBeDefined());
    expect(getByRole(root, "tab", { name: "Dashboard" }).getAttribute("aria-selected")).toBe("true");
    expect(getAllByRole(root, "tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Weather", "Dashboard"]);
    expect(getByTitle(root, "Dashboard dashboard").getAttribute("src")).toBe("/d/garden");
    expect(location.search).toBe("?session=saved-session");
  } finally { measure.mockRestore(); }
});

it("restores Main with a rotated classic key and admits one rapid composer submission", async () => {
  setCapabilitiesForTests({ multiUser: true, user: { id: "main-router" } });
  history.replaceState({}, "", "/chat/sage");
  localStorage.setItem("yoplai:sessionKey:sage", "web-greenhouse");
  const fetchStub = vi.mocked(fetch);
  const fallback = fetchStub.getMockImplementation()!;
  fetchStub.mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/me/durable-mode") return Response.json({ enabled: true });
    if (path === "/api/agents/sage") return Response.json({ id: "sage", name: "Sage", durable: true });
    if (path === "/api/agents/sage/threads") return Response.json([]);
    if (path === "/api/agents/sage/feed?limit=50") {
      requests.push(path);
      return Response.json({
        items: [
          { id: "m_1", role: "user", timestamp: 1, text: "Check the greenhouse", sender: "Avery" },
          { id: "m_2", role: "assistant", timestamp: 2, text: "The seedlings are ready.", toolCallCount: 0 },
        ],
        hasBefore: false, hasAfter: false, live: null,
      });
    }
    return fallback(input, init);
  });
  await getDurableMode();
  dispose = render(() => <Router>
    <Route path="/chat/:agentId" component={() => <Suspense><ToolbarOnlyShell><ChatView /></ToolbarOnlyShell></Suspense>} />
  </Router>, root);
  await vi.waitFor(() => expect(root.textContent).toContain("The seedlings are ready."));
  expect(root.textContent).toContain("Check the greenhouse");
  expect(requests).toContain("/api/agents/sage/feed?limit=50");
  expect(requests.some((path) => path.includes("/history?"))).toBe(false);
  expect(queryByRole(root, "button", { name: "Start a new chat" })).toBeNull();

  const composer = getByRole(root, "textbox") as HTMLTextAreaElement;
  const send = () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  composer.value = "Water the basil";
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  send();
  send();
  await vi.waitFor(() => expect(wsMessages.filter((message) => message.type === "send")).toEqual([
    expect.objectContaining({ message: "Water the basil", sessionId: "durable-main", clientSendId: expect.any(String) }),
  ]));
});

it("opens Durable Main beside a dashboard and follows memory references to Main and a closed thread", async () => {
  setCapabilitiesForTests({ multiUser: true, user: { id: "memory-browser" } });
  const stub = vi.mocked(fetch);
  const fallback = stub.getMockImplementation()!;
  let closed = true;
  const thread = () => ({ id: "glaze", title: "Glaze", closed, lastActivityAt: 3, generation: 1 });
  const userMessage = { id: "m_1", role: "user", timestamp: 1, text: "Check the cedar rack.", sender: "Avery" };
  const feed = (items: object[]) => Response.json({ items, hasBefore: false, hasAfter: false, live: null });
  stub.mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/me/durable-mode") return Response.json({ enabled: true });
    if (path === "/api/agents/sage") return Response.json({ id: "sage", name: "Sage", durable: true });
    if (path === "/api/agents/sage/dashboards") return Response.json([{ id: "garden", title: "Garden inventory" }]);
    if (path === "/api/agents/sage/threads") return Response.json([thread()]);
    if (path.endsWith("/threads/glaze/reopen")) {
      closed = false;
      return Response.json(thread());
    }
    if (path.includes("/feed?")) {
      requests.push(path);
      return feed(path.includes("thread=glaze") ? [{ ...userMessage, id: "m_3", text: "Try a glaze." }] : [userMessage]);
    }
    if (path.endsWith("/memory")) return Response.json({
      topics: [
        { id: "t_1", kind: "open", title: "Cedar rack", note: "Wait for delivery.", refs: [userMessage], updatedAt: 1 },
        { id: "t_2", kind: "open", title: "Maple crate", note: "Check the weight.", refs: [], updatedAt: null },
        { id: "th_glaze", kind: "digest", title: "Glaze results", note: "Use two coats.", refs: [], updatedAt: null, threadId: "glaze" },
      ],
      plan: { goals: ["Store the cedar"], nextSteps: ["Clear the rack"], updatedAt: 1 },
      gauge: { inputTokens: 7, ceilingTokens: 10 },
    });
    return fallback(input, init);
  });
  dispose = render(() => <Router>
    <Route path="/dashboards" component={() => <a href="/chat/sage?dashboard=garden">Chat</a>} />
    <Route path="/chat/:agentId" component={() => <Suspense><ToolbarOnlyShell><ChatView /></ToolbarOnlyShell></Suspense>} />
  </Router>, root);
  getByRole(root, "link", { name: "Chat" }).click();
  await vi.waitFor(() => expect(getByTitle(root, "Garden inventory dashboard").getAttribute("src")).toBe("/d/garden"));
  expect(getByRole(root, "tab", { name: "Main" }).getAttribute("aria-selected")).toBe("true");
  expect((getByRole(root, "textbox") as HTMLTextAreaElement).placeholder).toContain("Garden inventory");
  await vi.waitFor(() => expect(getByText(root, "Check the cedar rack.")).toBeTruthy());

  getByRole(root, "button", { name: "Memory" }).click();
  await vi.waitFor(() => expect(root.textContent).toContain("Getting full"));
  expect(getByRole(root, "tab", { name: "Garden inventory" })).toBeTruthy();
  expect(root.textContent).toContain("Store the cedar");
  expect(root.textContent).toContain("Clear the rack");
  getByRole(root, "button", { name: /^Cedar rack/ }).click();
  expect(root.textContent).toContain("Wait for delivery.");
  expect(root.textContent).toContain("Avery");
  getByRole(root, "button", { name: /^Maple crate/ }).click();
  expect(root.textContent).toContain("Check the weight.");
  expect(root.textContent).not.toContain("Wait for delivery.");
  getByRole(root, "button", { name: /^Cedar rack/ }).click();
  getByRole(root, "button", { name: "Jump to message m_1" }).click();
  await vi.waitFor(() => {
    expect(location.hash).toBe("#m=m_1");
    expect(requests).toContain("/api/agents/sage/feed?limit=50&around=m_1");
    expect(root.querySelector('[data-feed-message="m_1"].feed-flash')).not.toBeNull();
  });
  const summaries = Array.from(root.querySelectorAll("summary")).find((element) => element.textContent?.trim() === "Summaries")!;
  summaries.click();
  getByRole(root, "button", { name: "Glaze results" }).click();
  getByRole(root, "button", { name: "Open thread for Glaze results" }).click();
  await vi.waitFor(() => expect(location.search).toBe("?thread=glaze"));
  expect(closed).toBe(false);
  await vi.waitFor(() => expect(root.textContent).toContain("Try a glaze."));
});


it("starts an empty thread, reports a busy close, and reopens the thread from the menu", async () => {
  setCapabilitiesForTests({ multiUser: true, user: { id: "thread-browser" } });
  const stub = vi.mocked(fetch);
  const fallback = stub.getMockImplementation()!;
  history.replaceState({}, "", "/chat/sage");
  let thread: { id: string; title: string; closed: boolean; lastActivityAt: number; generation: number } | undefined;
  let running = true;
  const closes: string[] = [];
  stub.mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/me/durable-mode") return Response.json({ enabled: true });
    if (path === "/api/agents/sage") return Response.json({ id: "sage", name: "Sage", durable: true });
    if (path === "/api/agents/sage/threads") {
      if (init?.method !== "POST") return Response.json(thread ? [thread] : []);
      expect(JSON.parse(String(init.body))).toEqual({});
      thread = { id: "crate", title: "Maple crate", closed: false, lastActivityAt: 1, generation: 3 };
      return Response.json(thread, { status: 201 });
    }
    if (path.endsWith("/threads/crate/close")) {
      closes.push(String(init?.body));
      if (running) return Response.json({ error: "Stop the thread before closing it" }, { status: 409 });
      thread = { ...thread!, closed: true };
      return Response.json(thread);
    }
    if (path.endsWith("/threads/crate/reopen")) {
      thread = { ...thread!, closed: false, generation: 4 };
      return Response.json(thread);
    }
    if (path.includes("/feed?")) return Response.json({ items: [], hasBefore: false, hasAfter: false, live: null });
    return fallback(input, init);
  });
  dispose = render(() => <Router>
    <Route path="/chat/:agentId" component={() => <Suspense><ToolbarOnlyShell><ChatView /></ToolbarOnlyShell></Suspense>} />
  </Router>, root);
  await vi.waitFor(() => expect(getByRole(root, "tab", { name: "Main" })).toBeTruthy());
  expect(queryByRole(root, "button", { name: "Close Main" })).toBeNull();
  getByRole(root, "button", { name: "New thread" }).click();
  await vi.waitFor(() => expect(location.search).toBe("?thread=crate"));
  const close = () => getByRole(root, "button", { name: "Close Maple crate" }).click();
  close();
  await vi.waitFor(() => expect(getByText(root, "Stop the thread before closing it")).toBeTruthy());
  expect(location.search).toBe("?thread=crate");
  running = false;
  close();
  await vi.waitFor(() => expect(location.search).toBe(""));
  expect(queryByRole(root, "tab", { name: "Maple crate" })).toBeNull();
  getByText(root, "Threads", { selector: "summary" }).click();
  getByRole(root, "button", { name: "Maple crate" }).click();
  await vi.waitFor(() => expect(location.search).toBe("?thread=crate"));
  expect(closes).toEqual(['{"generation":3}', '{"generation":3}']);
});
