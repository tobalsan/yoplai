// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findByRole, findByText, getByRole, queryByRole, queryByText, waitFor, within } from "@testing-library/dom";
import { render } from "solid-js/web";
import App from "./App";
import { resetCapabilitiesForTests } from "./lib/capabilities";
import { setSidebarCollapsedPersistent } from "./lib/layout";

const { user, auth } = vi.hoisted(() => ({
  auth: { setPending: (_pending: boolean) => {} },
  user: { id: "demo-admin", name: "Demo admin", email: "admin@example.test", approved: true, role: "superadmin" },
}));
vi.mock("./auth/client", async () => {
  const { createSignal } = await import("solid-js");
  const [pending, setPending] = createSignal(false);
  auth.setPending = setPending;
  return { useSession: () => () => ({ data: { user }, isPending: pending() }) };
});

const agent = { id: "demo", name: "Demo agent", description: "Navigation fixture" };
const session = { agentId: "demo", sessionId: "demo-chat", title: "Demo conversation", lastActivity: Date.now() };
const project = { id: "demo-project", name: "Demo project", createdAt: Date.now(), updatedAt: Date.now() };
const skills = { mine: [], sharedWithMe: [], agent: [] };
let multiUser: boolean;
let delayed: { path: string; requested: () => void; response: Promise<Response> } | undefined;
let root: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  multiUser = false;
  auth.setPending(false);
  delayed = undefined;
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState({}, "", "/agents");
  setSidebarCollapsedPersistent(false);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("WebSocket", class {
    static readonly OPEN = 1;
    readonly readyState = 0;
    close() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname, search } = new URL(String(input), location.origin);
    const waiting = delayed;
    if (waiting?.path === pathname + search) {
      delayed = undefined;
      waiting.requested();
      if (!init?.signal) return waiting.response;
      const signal = init.signal;
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        void waiting.response.then(resolve).finally(() => signal.removeEventListener("abort", abort));
      });
    }
    switch (pathname) {
      case "/api/capabilities": return Response.json({ multiUser, user: multiUser ? user : undefined, extensions: {}, agents: [agent.id] });
      case "/api/top-extensions": return Response.json({ extensions: [], mcp: [] });
      case "/api/agents/demo/extensions": return Response.json({ extensions: [] });
      case "/api/agents/demo": return Response.json(agent);
      case "/api/agents": return Response.json([agent]);
      case "/api/agents/sessions": return Response.json({ items: [session] });
      case "/api/chat-projects": return Response.json({ items: [project] });
      case "/api/dashboards": return Response.json({ owned: [], shared: [] });
      case "/api/skills": return Response.json(skills);
      default: return Response.json({});
    }
  }));
  root = document.body.appendChild(document.createElement("div"));
});

afterEach(() => {
  dispose?.();
  root.remove();
  resetCapabilitiesForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the loaded Recent and Projects lists when navigating from Agents to Skills", async () => {
  dispose = render(() => <App />, root);
  const sidebar = within(await findByRole(root, "complementary"));
  const conversation = await sidebar.findByRole("button", { name: "Demo conversation" });
  const projectRow = await sidebar.findByRole("button", { name: "Demo project" });
  const recent = sidebar.getByRole("region", { name: "Recent" });
  const projects = sidebar.getByRole("region", { name: "Projects" });

  sidebar.getByRole("link", { name: "Skills" }).click();
  await findByRole(root, "heading", { name: "Skills" });

  const current = within(getByRole(root, "complementary"));
  expect(current.getByRole("region", { name: "Recent" })).toBe(recent);
  expect(current.getByRole("region", { name: "Projects" })).toBe(projects);
  expect(current.getByRole("button", { name: "Demo conversation" })).toBe(conversation);
  expect(current.getByRole("button", { name: "Demo project" })).toBe(projectRow);
});

function holdResponse(path: string) {
  const requested = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  delayed = { path, requested: requested.resolve, response: response.promise };
  return { requested: requested.promise, release: (body: unknown, status = 200) => response.resolve(Response.json(body, { status })) };
}

it("keeps the Agents page visible until Skills loads without showing the boot splash", async () => {
  multiUser = true;
  const skillsRequest = holdResponse("/api/skills");
  dispose = render(() => <App />, root);
  const source = await findByText(root, agent.name, { exact: true });
  const sidebar = getByRole(root, "complementary");
  await within(sidebar).findByRole("button", { name: "Demo conversation" });
  const splashes: Element[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches(".app:empty")) splashes.push(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  try {
    within(sidebar).getByRole("link", { name: "Skills" }).click();
    await skillsRequest.requested;
    await Promise.resolve();
    expect(splashes).toHaveLength(0);
    expect(source.isConnected, "Agents content remains in the document while Skills loads").toBe(true);
    expect(getByRole(root, "complementary")).toBe(sidebar);
    expect(queryByText(root, "Your skills", { exact: true })).toBeNull();

    skillsRequest.release(skills);
    await findByRole(root, "heading", { name: "Your skills" });
    expect(source.isConnected).toBe(false);
    expect(getByRole(root, "complementary")).toBe(sidebar);
    expect(splashes).toHaveLength(0);
  } finally {
    skillsRequest.release(skills);
    observer.disconnect();
  }
});

it("holds the Agents page while the lazy Admin page loads users", async () => {
  multiUser = true;
  const users = holdResponse("/api/admin/users");
  dispose = render(() => <App />, root);
  const source = await findByRole(root, "link", { name: "Edit Demo agent" });
  const sidebar = getByRole(root, "complementary");

  try {
    within(sidebar).getByRole("link", { name: "Admin" }).click();
    await users.requested;
    expect(source.isConnected).toBe(true);
    expect(getByRole(root, "complementary")).toBe(sidebar);

    users.release({ users: [{ ...user, name: "Admin navigation fixture" }] });
    await findByText(root, "Admin navigation fixture", { exact: true });
    expect(source.isConnected).toBe(false);
  } finally {
    users.release({ users: [] });
  }
});

it("holds Agents while an agent card opens the chat and then swaps the header toolbar", async () => {
  multiUser = true;
  const chat = holdResponse("/api/agents/demo");
  dispose = render(() => <App />, root);
  const card = await findByText(root, agent.name, { exact: true });
  const header = getByRole(root, "button", { name: "Toggle sidebar" }).closest("header")!;
  const sidebar = getByRole(root, "complementary");

  try {
    card.click();
    await chat.requested;
    expect(card.isConnected).toBe(true);
    expect(within(header).getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(getByRole(root, "complementary")).toBe(sidebar);

    chat.release(agent);
    await findByRole(root, "region", { name: "Chat transcript" });
    expect(card.isConnected).toBe(false);
    expect(getByRole(root, "button", { name: "Toggle sidebar" }).closest("header")).toBe(header);
    expect(within(header).getByRole("link", { name: "Go back" })).toBeTruthy();
    expect(within(header).queryByRole("heading", { name: "Agents" })).toBeNull();

    within(sidebar).getByRole("link", { name: "Skills" }).click();
    await findByRole(root, "heading", { name: "Your skills" });
    expect(getByRole(root, "button", { name: "Toggle sidebar" }).closest("header")).toBe(header);
    expect(within(header).queryByRole("link", { name: "Go back" })).toBeNull();
  } finally {
    chat.release(agent);
  }
});

it("shows chat and Recent while the sidebar waits for top extensions", async () => {
  multiUser = true;
  history.replaceState({}, "", "/chat/demo");
  const top = holdResponse("/api/top-extensions");
  dispose = render(() => <App />, root);
  try {
    await top.requested;
    const recent = await findByRole(root, "button", { name: "Demo conversation" });
    const transcript = await findByRole(root, "region", { name: "Chat transcript" });
    top.release({ extensions: ["fixture-extension"], mcp: [] });

    await findByRole(root, "button", { name: "Connect tools" });
    expect(getByRole(root, "button", { name: "Demo conversation" })).toBe(recent);
    expect(getByRole(root, "region", { name: "Chat transcript" })).toBe(transcript);
  } finally {
    top.release({ extensions: [], mcp: [] });
  }
});

it("keeps the chat transcript and Agent Settings drawer visible while models load", async () => {
  multiUser = true;
  history.replaceState({}, "", "/chat/demo");
  const settings = holdResponse("/api/agents/demo/settings");
  dispose = render(() => <App />, root);
  const transcript = await findByRole(root, "region", { name: "Chat transcript" });
  const settingsButton = getByRole(root, "button", { name: "Agent settings" });
  const editableSettings = {
    name: agent.name,
    canEditAgent: true,
    hasCustomAvatar: false,
    skills: { global: [], agent: [], user: [] },
  };

  settingsButton.click();
  await settings.requested;
  const drawer = getByRole(root, "dialog", { name: "Agent settings" });
  expect(within(drawer).getByText("Loading agent settings…")).toBeTruthy();
  const models = holdResponse("/api/agent-management/models");

  try {
    settings.release(editableSettings);
    await models.requested;

    expect(transcript.isConnected, "Chat transcript stays on screen while models load").toBe(true);
    expect(getByRole(root, "dialog", { name: "Agent settings" })).toBe(drawer);
    const modelPicker = within(drawer).getByRole<HTMLButtonElement>("button", { name: /^Model:/ });
    expect(modelPicker.disabled).toBe(true);

    models.release({ models: [] });
    await waitFor(() => expect(modelPicker.disabled).toBe(false));
    within(drawer).getByRole("button", { name: "Close agent settings" }).click();
    expect(queryByRole(root, "dialog", { name: "Agent settings" })).toBeNull();
    expect(getByRole(root, "region", { name: "Chat transcript" })).toBe(transcript);
  } finally {
    models.release({ models: [] });
  }
});

it("keeps Agents visible while archived conversations load", async () => {
  const archive = holdResponse("/api/agents/sessions?includeArchived=1");
  dispose = render(() => <App />, root);
  const source = await findByRole(root, "link", { name: "Edit Demo agent" });
  const loaded = { items: [{ ...session, title: "Archived demo conversation", archived: Date.now() }] };
  try {
    getByRole(root, "button", { name: "Account menu" }).click();
    getByRole(root, "menuitem", { name: "Archive" }).click();
    await archive.requested;
    expect(source.isConnected).toBe(true);

    archive.release(loaded);
    await findByText(root, "Archived demo conversation");
    expect(source.isConnected).toBe(false);
  } finally {
    archive.release(loaded);
  }
});

it("highlights the clicked route immediately and shows progress only for a slow navigation", async () => {
  dispose = render(() => <App />, root);
  await findByRole(root, "link", { name: "Edit Demo agent" });
  const agentsLink = getByRole(root, "link", { name: "Agents" });
  const skillsLink = getByRole(root, "link", { name: "Skills" });
  const skillsRequest = holdResponse("/api/skills");
  const progress = () => queryByRole(root, "progressbar", { name: "Loading page" });

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    skillsLink.click();
    await skillsRequest.requested;
    await Promise.resolve();
    expect(skillsLink.classList.contains("active")).toBe(true);
    expect(agentsLink.classList.contains("active")).toBe(false);

    await vi.advanceTimersByTimeAsync(149);
    expect(progress()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(progress()).toBeTruthy();
    expect(getByRole(root, "link", { name: "Edit Demo agent" })).toBeTruthy();

    skillsRequest.release({ error: "unavailable" }, 503);
    await findByText(root, "Unable to load skills.", { exact: false });
    await waitFor(() => expect(progress()).toBeNull());

    agentsLink.click();
    await findByRole(root, "link", { name: "Edit Demo agent" });
    await vi.advanceTimersByTimeAsync(200);
    expect(progress()).toBeNull();
  } finally {
    skillsRequest.release(skills);
    vi.useRealTimers();
  }
});

it("closes the expanded mobile sidebar after navigating", async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  dispose = render(() => <App />, root);
  const toggle = await findByRole(root, "button", { name: "Toggle sidebar" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.click();

  const sidebar = await findByRole(root, "complementary");
  within(sidebar).getByRole("link", { name: "Skills" }).click();
  await findByRole(root, "heading", { name: "Your skills" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(queryByRole(root, "complementary")).toBeNull();
});

it("keeps the current page and sidebar contents visible during a pending sidebar poll", async () => {
  multiUser = true;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  dispose = render(() => <App />, root);
  const source = await findByRole(root, "link", { name: "Edit Demo agent" });
  const recent = await findByRole(root, "button", { name: "Demo conversation" });
  const poll = holdResponse("/api/agents/sessions");
  try {
    await vi.advanceTimersByTimeAsync(3_000);
    await poll.requested;
    expect(getByRole(root, "link", { name: "Edit Demo agent" })).toBe(source);
    expect(getByRole(root, "button", { name: "Demo conversation" })).toBe(recent);

    poll.release({ items: [session, { ...session, sessionId: "second-chat", title: "Second demo conversation" }] });
    await findByRole(root, "button", { name: "Second demo conversation" });
    expect(getByRole(root, "link", { name: "Edit Demo agent" })).toBe(source);
  } finally {
    poll.release({ items: [session] });
    vi.useRealTimers();
  }
});

it("opens a second destination while the first destination request is hung", async () => {
  const hung = holdResponse("/api/skills");
  dispose = render(() => <App />, root);
  const source = await findByRole(root, "link", { name: "Edit Demo agent" });
  const sidebar = getByRole(root, "complementary");
  try {
    within(sidebar).getByRole("link", { name: "Skills" }).click();
    await hung.requested;
    expect(source.isConnected).toBe(true);

    within(sidebar).getByRole("link", { name: "Dashboards" }).click();
    await findByRole(root, "heading", { name: "Dashboards" });
    expect(getByRole(root, "complementary")).toBe(sidebar);
    expect(source.isConnected).toBe(false);
  } finally {
    hung.release(skills);
  }
});

it("keeps navigation available when opening a chat fails", async () => {
  const chat = holdResponse("/api/agents/demo");
  dispose = render(() => <App />, root);
  const card = await findByText(root, agent.name, { exact: true });
  const sidebar = getByRole(root, "complementary");

  try {
    card.click();
    await chat.requested;
    expect(card.isConnected).toBe(true);
    chat.release({}, 404);

    await findByText(root, "Could not load this page.");
    expect(getByRole(root, "complementary")).toBe(sidebar);
    within(sidebar).getByRole("link", { name: "Skills" }).click();
    await findByRole(root, "heading", { name: "Your skills" });
    expect(queryByText(root, "Could not load this page.")).toBeNull();
  } finally {
    chat.release(agent);
  }
});

it("opens agent settings during an unrelated session refresh on a single-user gateway", async () => {
  const extensions = holdResponse("/api/agents/demo/extensions");
  dispose = render(() => <App />, root);
  const edit = await findByRole(root, "link", { name: "Edit Demo agent" });

  try {
    edit.click();
    await extensions.requested;
    expect(edit.isConnected).toBe(true);
    auth.setPending(true);

    extensions.release({ extensions: [] });
    await waitFor(() => expect(location.pathname).toBe("/agents/demo/edit"));
    expect(getByRole(root, "tab", { name: "Extensions" })).toBeTruthy();
    expect(edit.isConnected).toBe(false);
  } finally {
    auth.setPending(false);
    extensions.release({ extensions: [] });
  }
});
