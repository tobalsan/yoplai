// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, getByRole, queryByRole, within } from "@testing-library/dom";
import { createSignal, splitProps } from "solid-js";
import { render } from "solid-js/web";
import { defaultAvatarSources } from "../lib/default-avatar.fixture";

// matchMedia must exist before theme.ts module-level code runs
window.matchMedia = () => ({ matches: false }) as MediaQueryList;

const [pathname, setPathname] = createSignal("/projects");
const fetchProjectsMock = vi.fn<() => Promise<unknown[]>>();
const fetchAgentsMock = vi.fn();
const fetchAgentSessionsMock = vi.fn(async () => ({ items: [] as unknown[] }));
const fetchChatProjectsMock = vi.fn(async () => ({ items: [] as { id: string; name: string; createdAt: number; updatedAt: number }[] }));
const moveChatToProjectMock = vi.fn(async () => {});
const createChatProjectMock = vi.fn(async () => ({ id: "created" }));
const renameChatProjectMock = vi.fn(async () => {});
const deleteChatProjectMock = vi.fn(async () => {});
const navigateMock = vi.fn();
const pinAgentSessionMock = vi.fn(async () => {});
const archiveAgentSessionMock = vi.fn(async () => {});
const fetchTopExtensionsMock = vi.fn(async () => ({ extensions: ["exa"], mcp: [] as string[] }));
const showToastMock = vi.fn();
const useSessionMock = vi.fn<() => () => {
  data: { user: { name: string; email: string } | null };
}>(() => () => ({ data: { user: null } }));
let actualRouter = false;

function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
}

class UnauthenticatedError extends Error {
  constructor() {
    super("Unauthenticated");
    this.name = "UnauthenticatedError";
  }
}

vi.mock("../api", () => ({
  fetchProjects: fetchProjectsMock,
  fetchAgents: fetchAgentsMock,
  fetchAgentSessions: fetchAgentSessionsMock,
  deleteAgentSession: vi.fn(),
  renameAgentSession: vi.fn(),
  pinAgentSession: pinAgentSessionMock,
  archiveAgentSession: archiveAgentSessionMock,
  UnauthenticatedError,
}));

vi.mock("../api/chat-projects", () => ({
  fetchChatProjects: fetchChatProjectsMock,
  createChatProject: createChatProjectMock,
  renameChatProject: renameChatProjectMock,
  deleteChatProject: deleteChatProjectMock,
  moveChatToProject: moveChatToProjectMock,
}));

vi.mock("../api/top-extensions", () => ({
  EMPTY_TOP_EXTENSIONS: { extensions: [], mcp: [] },
  fetchTopExtensions: fetchTopExtensionsMock,
}));

vi.mock("../lib/toast", () => ({
  showToast: showToastMock,
}));

vi.mock("../auth/client", () => ({ useSession: useSessionMock, signOut: vi.fn() }));

vi.mock("@solidjs/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solidjs/router")>();
  return {
  ...actual,
  A: (props: Parameters<typeof actual.A>[0]) => {
    if (actualRouter) return <actual.A {...props} />;
    const [, anchorProps] = splitProps(props, ["state"]);
    return <a {...anchorProps} />;
  },
  useLocation: () => actualRouter ? actual.useLocation() : ({
    get pathname() {
      return pathname();
    },
    search: "",
  }),
  useNavigate: () => actualRouter ? actual.useNavigate() : navigateMock,
  };
});

const { AgentSidebar, positionSidebarMenu } = await import("./AgentSidebar");
const { LeftNavShell } = await import("./LeftNavShell");
const { setSidebarCollapsedPersistent } = await import("../lib/layout");
const { refreshScheduleAlerts } = await import("../lib/schedule-alerts");
const { Router, Route } = await import("@solidjs/router");
const { SessionSearch } = await import("./SessionSearch");
const { connectPromptRequest, clearConnectPromptRequest } = await import("../onboarding/state");
const { resetCapabilitiesForTests, setCapabilitiesForTests } = await import(
  "../lib/capabilities"
);

async function openSidebarMenu(container: HTMLElement, label = "Session menu") {
  container.querySelector<HTMLElement>('[aria-label="' + label + '"]')!.click();
  await vi.advanceTimersByTimeAsync(1);
}

describe("AgentSidebar", () => {
  it("reorders local and linked agents together and closes gaps when a link is down", async () => {
    setCapabilitiesForTests({ multiUser: true, user: { id: "sidebar-order-dummy" } });
    const localAgents = [
      { id: "maple", name: "Maple", description: "Support" },
      { id: "cedar@local", name: "Cedar", description: "Planning", durable: true },
      { id: "pine", name: "Pine", description: "Inventory" },
    ];
    const allAgents = [
      ...localAgents,
      { id: "birch@remote", name: "Birch", role: "Dock Coordinator", description: "Plans dock arrivals.", gateway: "remote", durable: true },
    ];
    fetchAgentsMock.mockResolvedValue(allAgents);
    const writes: string[][] = [];
    let storedOrder = ["pine", "cedar@local"];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/me/durable-mode")) return Response.json({ enabled: true });
      if (url.endsWith("/me/sidebar-order")) {
        if (init?.method === "PUT") {
          const { agentIds } = JSON.parse(String(init.body));
          writes.push(agentIds);
          storedOrder = agentIds;
        }
        return Response.json({ agentIds: storedOrder });
      }
      return Response.json({ items: [{ timestamp: 1860000000000 }], live: null });
    });
    const container = document.body.appendChild(document.createElement("div"));
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    try {
      const list = () => within(getByRole(container, "region", { name: "Your agents" }));
      const order = () => list().getAllByRole("link").map((link) => link.getAttribute("href"));
      await vi.waitFor(() => expect(order()).toEqual(["/chat/pine", "/chat/cedar%40local", "/chat/maple", "/chat/birch%40remote"]));
      expect(queryByRole(container, "region", { name: "Recent" })).toBeNull();
      expect(list().getByRole("link", { name: /cedar/i }).textContent).toContain("Planning");

      const birchGrip = list().getByRole("button", { name: "Drag Birch to reorder" });
      const cedar = list().getByRole("link", { name: /cedar/i });
      await vi.waitFor(() => expect(birchGrip.getAttribute("draggable")).toBe("true"));
      const transfer = { setData() {}, effectAllowed: "", dropEffect: "" };
      fireEvent.dragStart(birchGrip, { dataTransfer: transfer });
      fireEvent.dragOver(cedar, { dataTransfer: transfer, clientY: -1 });
      fireEvent.drop(cedar, { dataTransfer: transfer, clientY: -1 });
      await vi.waitFor(() => expect(writes[0]).toEqual(["pine", "birch@remote", "cedar@local", "maple"]));
      expect(order()).toEqual(["/chat/pine", "/chat/birch%40remote", "/chat/cedar%40local", "/chat/maple"]);

      const menu = list().getByLabelText("Birch menu");
      menu.click();
      await vi.waitFor(() => expect(getByRole(document.body, "button", { name: "Move down" })).toBeTruthy());
      getByRole(document.body, "button", { name: "Move down" }).click();
      await vi.waitFor(() => expect(writes[1]).toEqual(["pine", "cedar@local", "birch@remote", "maple"]));

      const birch = list().getByRole("link", { name: /birch/i });
      expect(birch.textContent).toContain("Dock Coordinator");
      expect(birch.textContent).not.toContain("Plans dock arrivals.");
      await vi.waitFor(() => expect(birchGrip.getAttribute("draggable")).toBe("true"));
      fireEvent.keyDown(birch, { key: "ArrowUp", altKey: true });
      await vi.waitFor(() => expect(writes[2]).toEqual(["pine", "birch@remote", "cedar@local", "maple"]));

      fetchAgentsMock.mockResolvedValue(localAgents);
      fireEvent.focus(window);
      await vi.waitFor(() => expect(order()).toEqual(["/chat/pine", "/chat/cedar%40local", "/chat/maple"]));

      storedOrder = ["pine", "cedar@local", "maple", "birch@remote"];
      fetchAgentsMock.mockResolvedValue(allAgents);
      fireEvent.focus(window);
      await vi.waitFor(() => expect(order()).toEqual(["/chat/pine", "/chat/cedar%40local", "/chat/maple", "/chat/birch%40remote"]));
    } finally {
      dispose();
      container.remove();
      resetCapabilitiesForTests();
      fetch.mockRestore();
    }
  });

  it("applies and saves themes from the keyboard-navigable account menu", () => {
    setCapabilitiesForTests({ multiUser: false });
    const container = document.body.appendChild(document.createElement("div"));
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    try {
      const toggle = getByRole(container, "button", { name: "Account menu" });
      fireEvent.keyDown(toggle, { key: "ArrowDown" });
      const menu = within(getByRole(container, "menu"));
      const archive = menu.getByRole("menuitem", { name: "Archive" });
      const settings = menu.getByRole("menuitem", { name: "Account settings" });
      const themes = within(menu.getByRole("group", { name: "Theme" }));
      expect(document.activeElement).toBe(archive);
      fireEvent.keyDown(archive, { key: "ArrowDown" });
      expect(document.activeElement).toBe(settings);
      fireEvent.keyDown(settings, { key: "ArrowDown" });

      const light = themes.getByRole("menuitemradio", { name: "Light", checked: false });
      expect(document.activeElement).toBe(light);
      light.click();
      expect(themes.getByRole("menuitemradio", { checked: true })).toBe(light);
      expect(localStorage.getItem("yoplai-theme")).toBe("light");
      expect(document.documentElement.dataset.theme).toBe("light");

      const dark = themes.getByRole("menuitemradio", { name: "Dark", checked: false });
      fireEvent.keyDown(light, { key: "ArrowDown" });
      expect(document.activeElement).toBe(dark);
      dark.click();
      expect(themes.getByRole("menuitemradio", { checked: true })).toBe(dark);
      expect(localStorage.getItem("yoplai-theme")).toBe("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");

      fireEvent.keyDown(dark, { key: "ArrowUp" });
      expect(document.activeElement).toBe(light);
      light.click();
      fireEvent.keyDown(light, { key: "Home" });
      expect(document.activeElement).toBe(archive);
      const system = themes.getByRole("menuitemradio", { name: "System", checked: false });
      fireEvent.keyDown(archive, { key: "End" });
      expect(document.activeElement).toBe(system);
      system.click();
      expect(themes.getByRole("menuitemradio", { checked: true })).toBe(system);
      expect(localStorage.getItem("yoplai-theme")).toBe("system");
      expect(document.documentElement.dataset.theme).toBe("dark");

      fireEvent.keyDown(system, { key: "Escape" });
      expect(queryByRole(container, "menu")).toBeNull();
      expect(document.activeElement).toBe(toggle);
    } finally {
      dispose();
      container.remove();
    }
  });

  it("keeps one toolbar toggle in both sidebar states", () => {
    setSidebarCollapsedPersistent(false);
    const container = document.body.appendChild(document.createElement("div"));
    const dispose = render(() => <LeftNavShell><h1>Agents</h1></LeftNavShell>, container);
    try {
      const toggle = getByRole(container, "button", { name: "Toggle sidebar", expanded: true });
      toggle.click();
      getByRole(container, "button", { name: "Toggle sidebar", expanded: false }).click();
      expect(getByRole(container, "button", { name: "Toggle sidebar", expanded: true })).toBeTruthy();
    } finally {
      dispose();
      setSidebarCollapsedPersistent(false);
      container.remove();
    }
  });

  it("shows the Local account row as the single-user settings entry", () => {
    setCapabilitiesForTests({ multiUser: false });
    const container = document.body.appendChild(document.createElement("div"));
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    try {
      const toggle = getByRole(container, "button", { name: "Account menu" });
      expect(within(toggle).getByText("Local")).toBeTruthy();
      expect(within(toggle).getByText("Single-user mode")).toBeTruthy();
      expect(queryByRole(container, "radiogroup", { name: "Theme" })).toBeNull();
      toggle.click();
      const menu = within(getByRole(container, "menu"));
      expect(menu.getByRole("menuitem", { name: "Account settings" })).toBeTruthy();
      expect(menu.queryByRole("menuitem", { name: "Logout" })).toBeNull();
    } finally {
      dispose();
      container.remove();
    }
  });

  it("shows multi-user themes and Logout below the tour links", async () => {
    useSessionMock.mockReturnValueOnce(() => ({ data: { user: { name: "Test User", email: "test@example.com" } } }));
    setCapabilitiesForTests({ multiUser: true, user: { id: "u1" } });
    setPathname("/chat/scribe");
    const container = document.body.appendChild(document.createElement("div"));
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    try {
      const sidebar = within(container);
      const toggle = await sidebar.findByRole("button", { name: "Account menu" });
      expect(within(toggle).getByText("Test User")).toBeTruthy();
      expect(within(toggle).getByText("test@example.com")).toBeTruthy();
      expect(sidebar.queryByRole("radiogroup", { name: "Theme" })).toBeNull();
      const connect = await sidebar.findByRole("button", { name: "Connect tools" });
      const buttons = sidebar.getAllByRole("button");
      expect(buttons.indexOf(toggle)).toBeGreaterThan(buttons.indexOf(connect));
      expect(buttons.indexOf(toggle)).toBeGreaterThan(buttons.indexOf(sidebar.getByRole("button", { name: "Restart tour" })));

      fireEvent.keyDown(toggle, { key: "ArrowUp" });
      const menu = within(sidebar.getByRole("menu"));
      const themes = within(menu.getByRole("group", { name: "Theme" }));
      expect(themes.getAllByRole("menuitemradio").map((item) => item.textContent?.trim())).toEqual(["Light", "Dark", "System"]);
      expect(document.activeElement).toBe(menu.getByRole("menuitem", { name: "Logout" }));
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      expect(document.activeElement).toBe(themes.getByRole("menuitemradio", { name: "System" }));
    } finally {
      dispose();
      container.remove();
    }
  });

  it.each([["a browser", false, true], ["an Electron user agent without the Yoplai bridge", false, true], ["the Yoplai window", true, false]])("shows the brand text in %s when expected", (_label, marked, visible) => {
    if (marked) document.documentElement.setAttribute("data-yoplai-desktop", "");
    const container = document.body.appendChild(document.createElement("div"));
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    try {
      const home = queryByRole(container, "link", { name: "Yoplai" });
      expect(home?.getAttribute("href") ?? null).toBe(visible ? "/" : null);
      expect(getByRole(container, "navigation", { name: "Primary" })).toBeTruthy();
    } finally {
      dispose();
      document.documentElement.removeAttribute("data-yoplai-desktop");
    }
  });

  it("marks Agents while any actionable credential pause remains", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([{
      agentId: "scribe", jobId: "digest", jobName: "Digest", mode: "owner",
      pausedReason: { kind: "credentials", integration: "Acme Mail", at: "2026-11-07T12:00:00Z" },
    }])));
    await refreshScheduleAlerts();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    try {
      expect(container.querySelector('a[href="/agents"] [aria-label="Jobs paused for credentials"]')).not.toBeNull();
      fetchMock.mockResolvedValue(new Response("[]"));
      await refreshScheduleAlerts();
      expect(container.querySelector('a[href="/agents"] [aria-label="Jobs paused for credentials"]')).toBeNull();
    } finally {
      dispose();
      fetchMock.mockResolvedValue(new Response("[]"));
      await refreshScheduleAlerts();
    }
  });

  afterEach(() => {
    actualRouter = false;
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem("yoplai-theme");
    localStorage.removeItem("yoplai:recent-project-views");
    localStorage.removeItem("yoplai:collapsed-chat-projects");
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("yoplai:chat-read")) localStorage.removeItem(key);
    }
    fetchChatProjectsMock.mockReset();
    fetchChatProjectsMock.mockResolvedValue({ items: [] });
    moveChatToProjectMock.mockReset();
    moveChatToProjectMock.mockResolvedValue(undefined);
    createChatProjectMock.mockReset();
    createChatProjectMock.mockResolvedValue({ id: "created" });
    renameChatProjectMock.mockReset();
    renameChatProjectMock.mockResolvedValue(undefined);
    deleteChatProjectMock.mockReset();
    deleteChatProjectMock.mockResolvedValue(undefined);
    setPathname("/projects");
    pinAgentSessionMock.mockReset();
    pinAgentSessionMock.mockResolvedValue(undefined);
    archiveAgentSessionMock.mockReset();
    archiveAgentSessionMock.mockResolvedValue(undefined);
    showToastMock.mockReset();
    fetchAgentSessionsMock.mockResolvedValue({ items: [] });
    vi.useRealTimers();
    vi.restoreAllMocks();
    fetchProjectsMock.mockReset();
    fetchProjectsMock.mockResolvedValue([]);
    resetCapabilitiesForTests();
    vi.clearAllMocks();
  });

  it.each([
    { trigger: { top: 40, bottom: 60, right: 220 }, size: { width: 160, height: 200 }, viewport: { width: 390, height: 800 }, expected: { left: 60, top: 64 } },
    { trigger: { top: 740, bottom: 760, right: 390 }, size: { width: 180, height: 200 }, viewport: { width: 390, height: 800 }, expected: { left: 202, top: 536 } },
    { trigger: { top: 5, bottom: 25, right: 30 }, size: { width: 160, height: 100 }, viewport: { width: 390, height: 800 }, expected: { left: 8, top: 29 } },
    { trigger: { top: 5, bottom: 25, right: 390 }, size: { width: 374, height: 300 }, viewport: { width: 390, height: 320 }, expected: { left: 8, top: 12 } },
  ])("positions a sidebar menu within the viewport: $expected", ({ trigger, size, viewport, expected }) => {
    expect(positionSidebarMenu(trigger, size, viewport)).toEqual(expected);
  });

  it("keeps row details off the title line and exposes them on keyboard focus", async () => {
    vi.useFakeTimers();
    actualRouter = true;
    const chat = {
      agentId: "alpha", sessionId: "main", title: "Planning a careful release", createdAt: Date.now() - 120000,
      lastActivity: Date.now() - 120000, messageCount: 3, isMain: true, pinned: Date.now(),
    };
    const actualApi = await vi.importActual<typeof import("../api")>("../api");
    const actualProjects = await vi.importActual<typeof import("../api/chat-projects")>("../api/chat-projects");
    fetchAgentSessionsMock.mockImplementation(actualApi.fetchAgentSessions);
    fetchChatProjectsMock.mockImplementation(actualProjects.fetchChatProjects);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => Response.json({
      items: String(input).endsWith("/agents/sessions") ? [chat] : [],
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <Router><Route path="*" component={() => <AgentSidebar collapsed={() => false} />} /></Router>, container);
    await vi.advanceTimersByTimeAsync(1);
    const row = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes(chat.title))!;
    expect(row.textContent?.trim()).toBe(chat.title);
    expect(defaultAvatarSources(row)).toHaveLength(1);
    const description = document.getElementById(row.getAttribute("aria-describedby")!);
    expect(description?.textContent).toContain("2m · alpha");
    expect(description?.textContent).toContain("MAIN");
    expect(description?.textContent).toContain("Pinned");
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    row.focus();
    const tooltip = container.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain(chat.title);
    expect(tooltip?.textContent).toContain("2m · alpha");
    expect(tooltip?.textContent).toContain("MAIN");
    expect(tooltip?.textContent).toContain("Pinned");
    row.blur();
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    dispose();
  });

  it("shows one card after pointer rest and dismisses it when interaction moves on", async () => {
    vi.useFakeTimers();
    actualRouter = true;
    const chat = { agentId: "alpha", sessionId: "hover", title: "Hover details", createdAt: Date.now(), lastActivity: Date.now(), messageCount: 1, isMain: false };
    const actualApi = await vi.importActual<typeof import("../api")>("../api");
    const actualProjects = await vi.importActual<typeof import("../api/chat-projects")>("../api/chat-projects");
    fetchAgentSessionsMock.mockImplementation(actualApi.fetchAgentSessions);
    fetchChatProjectsMock.mockImplementation(actualProjects.fetchChatProjects);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => Response.json({ items: String(input).endsWith("/agents/sessions") ? [chat] : [] }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [collapsed, setCollapsed] = createSignal(false);
    const dispose = render(() => <Router><Route path="*" component={() => <AgentSidebar collapsed={collapsed} />} /></Router>, container);
    await vi.advanceTimersByTimeAsync(1);
    const row = container.querySelector<HTMLButtonElement>(".session-row")!;
    const wrap = row.parentElement!;
    const hover = async () => {
      wrap.dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(449);
      expect(container.querySelector('[role="tooltip"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(container.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
      expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("Hover details");
    };
    await hover();
    wrap.dispatchEvent(new MouseEvent("mouseleave"));
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    wrap.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.advanceTimersByTimeAsync(300);
    wrap.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(150);
    expect(container.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    await hover();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    await hover();
    container.querySelector(".sessions-list")!.dispatchEvent(new Event("scroll"));
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    setCollapsed(true);
    wrap.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.advanceTimersByTimeAsync(450);
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    container.querySelector("aside")!.dispatchEvent(new MouseEvent("mouseenter"));
    await hover();
    container.querySelector("aside")!.dispatchEvent(new MouseEvent("mouseleave"));
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    dispose();
  });

  it("shows unread answers in rows and collapsed projects and updates reads from another tab", async () => {
    vi.useFakeTimers();
    actualRouter = true;
    localStorage.setItem("yoplai:chat-read-init:local", "1");
    localStorage.setItem("yoplai:collapsed-chat-projects", '["work"]');
    const chats = [
      { agentId: "alpha", sessionId: "ordinary-dot", title: "Ordinary answer", createdAt: 1, lastActivity: 1, messageCount: 1, isMain: false, lastWebCompletion: { id: "ordinary-ready", endedAt: 20 } },
      { agentId: "alpha", sessionId: "project-dot", title: "Project answer", projectId: "work", createdAt: 1, lastActivity: 1, messageCount: 1, isMain: false, lastWebCompletion: { id: "project-ready", endedAt: 30 } },
    ];
    const actualApi = await vi.importActual<typeof import("../api")>("../api");
    const actualProjects = await vi.importActual<typeof import("../api/chat-projects")>("../api/chat-projects");
    fetchAgentSessionsMock.mockImplementation(actualApi.fetchAgentSessions);
    fetchChatProjectsMock.mockImplementation(actualProjects.fetchChatProjects);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => Response.json({
      items: String(input).endsWith("/agents/sessions") ? chats : [{ id: "work", name: "Work", createdAt: 1, updatedAt: 1 }],
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <Router><Route path="*" component={() => <AgentSidebar collapsed={() => false} />} /></Router>, container);
    await vi.advanceTimersByTimeAsync(1);
    const projects = container.querySelector('section[aria-label="Projects"]')!;
    expect(projects.querySelector('[role="img"][aria-label="Unread messages"]')).not.toBeNull();
    expect(projects.textContent).not.toContain("Project answer");
    expect(container.querySelectorAll('[role="img"][aria-label="Unread messages"]')).toHaveLength(2);
    getByRole(container, "button", { name: "Work" }).click();
    const projectRow = Array.from(projects.querySelectorAll("button")).find((button) => button.textContent?.includes("Project answer"))!;
    expect(projectRow.querySelector('[role="img"][aria-label="Unread messages"]')).not.toBeNull();
    const readInOtherTab = (sessionId: string, completionId: string) => {
      const key = `yoplai:chat-read:local:alpha:${sessionId}`;
      localStorage.setItem(key, completionId);
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: completionId }));
    };
    readInOtherTab("project-dot", "project-ready");
    expect(projects.querySelector('[role="img"][aria-label="Unread messages"]')).toBeNull();
    expect(container.querySelectorAll('[role="img"][aria-label="Unread messages"]')).toHaveLength(1);
    readInOtherTab("ordinary-dot", "ordinary-ready");
    expect(container.querySelector('[role="img"][aria-label="Unread messages"]')).toBeNull();
    dispose();
  });

  it.each([false, true])("opens Search above Agents without a Sessions header (collapsed=%s)", async (collapsed) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <>
      <AgentSidebar collapsed={() => collapsed} />
      <SessionSearch />
    </>, container);
    const search = Array.from(container.querySelectorAll("button")).find((item) => item.getAttribute("aria-label") === "Search");
    const agents = Array.from(container.querySelectorAll("a")).find((item) => item.textContent === "Agents")!;
    expect(search).toBeDefined();
    expect(search!.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).not.toContain("Sessions");
    search!.click();
    await Promise.resolve();
    const input = container.querySelector('[aria-label="Search chats"]');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(input);
    dispose();
  });

  it("renders sidebar logo and primary navigation links", () => {
    setCapabilitiesForTests({
      extensions: { projects: true },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [collapsed] = createSignal(false);

    const dispose = render(
      () => (
        <AgentSidebar
          collapsed={collapsed}
        />
      ),
      container
    );

    expect(container.textContent).toContain("Yoplai");
    expect(container.textContent).toContain("Projects");
    expect(container.textContent).toContain("Agents");

    dispose();
  });

  it("renders labeled Font Awesome icons instead of abbreviations when collapsed", () => {
    setCapabilitiesForTests({
      extensions: { projects: true, orchestrator: true },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [collapsed] = createSignal(true);

    const dispose = render(
      () => (
        <AgentSidebar
          collapsed={collapsed}
        />
      ),
      container
    );

    const expectedIcons = [
      ["Board", "fa-folder-tree"],
      ["Orchestrator", "fa-diagram-project"],
      ["Agents", "fa-comments"],
    ];
    for (const [label, iconClass] of expectedIcons) {
      const link = container.querySelector(`a[title="${label}"]`);
      expect(link?.textContent).toBe(label);
      expect(link?.querySelector(`.${iconClass}`)?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(container.querySelector(".nav-short")).toBeNull();

    dispose();
  });

  it("does not render recents anymore", async () => {
    setCapabilitiesForTests({
      extensions: { projects: true },
    });
    localStorage.setItem(
      "yoplai:recent-project-views",
      JSON.stringify([{ id: "PRO-1", viewedAt: Date.now() - 60_000 }])
    );
    setPathname("/projects/PRO-2");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const [collapsed] = createSignal(false);

    const dispose = render(
      () => (
        <AgentSidebar
          collapsed={collapsed}
        />
      ),
      container
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(container.querySelector(".sidebar-recent")).toBeNull();

    const stored = JSON.parse(
      localStorage.getItem("yoplai:recent-project-views") ?? "[]"
    );
    expect(stored[0]?.id).toBe("PRO-1");

    dispose();
  });

  it("renders session avatar from configured session data and no new button", async () => {
    fetchAgentSessionsMock.mockResolvedValue({
      items: [
        {
          agentId: "alpha",
          sessionId: "s1",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 1,
          firstUserMessage: "Hello",
          avatar: "🦊",
          isMain: true,
        },
      ],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [collapsed] = createSignal(false);

    const dispose = render(
      () => (
        <AgentSidebar
          collapsed={collapsed}
        />
      ),
      container
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(container.textContent).toContain("🦊");
    expect(container.querySelector('button[aria-label="New project"]')).toBeTruthy();

    dispose();
  });

  it("groups projects before pins/recent, persists collapse and moves chats in/out", async () => {
    vi.useFakeTimers();
    fetchChatProjectsMock.mockResolvedValue({ items: [{ id: "p1", name: "Work", createdAt: 1, updatedAt: 1 }] });
    const items = [
      { agentId: "a", sessionId: "new", lastActivity: 30, firstUserMessage: "New", pinned: null, projectId: "p1" },
      { agentId: "a", sessionId: "pin", lastActivity: 10, firstUserMessage: "Project pin", pinned: 10, projectId: "p1" },
      { agentId: "a", sessionId: "recent", lastActivity: 40, firstUserMessage: "Recent", pinned: null, projectId: null },
      { agentId: "a", sessionId: "global", lastActivity: 20, firstUserMessage: "Global pin", pinned: 20, projectId: null },
    ];
    fetchAgentSessionsMock.mockResolvedValue({ items });
    const container = document.createElement("div");
    document.body.appendChild(container);
    let dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    await vi.advanceTimersByTimeAsync(1);
    expect(Array.from(container.querySelectorAll(".sessions-section")).map((node) => node.getAttribute("aria-label"))).toEqual(["Projects", "Pinned", "Recent"]);
    expect(Array.from(container.querySelectorAll(".session-title-text")).map((node) => node.textContent)).toEqual(["Project pin", "New", "Global pin", "Recent"]);
    const toggle = () => getByRole(container, "button", { name: "Work" });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().querySelector("a")).toBeNull();
    expect(container.querySelector('button[aria-label="Toggle Work"]')).toBeNull();
    toggle().click();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("yoplai:collapsed-chat-projects")).toBe('["p1"]');
    expect(container.querySelector('[aria-label="Projects"]')!.textContent).not.toContain("Project pin");
    dispose();
    dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    await vi.advanceTimersByTimeAsync(1);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    toggle().click();
    const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".session-action"));
    const menu = container.querySelectorAll<HTMLDetailsElement>("details")[1]!;
    menu.querySelector("summary")!.click();
    await vi.advanceTimersByTimeAsync(1);
    buttons().find((button) => button.textContent === "Remove from project")!.click();
    expect(menu.open).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(moveChatToProjectMock).toHaveBeenCalledWith("a", "pin", null);
    await openSidebarMenu(container);
    buttons().find((button) => button.textContent === "Move to project…")!.click();
    container.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(moveChatToProjectMock).toHaveBeenCalledWith("a", "pin", "p1");
    dispose();
  });

  it("opens projects deliberately from the first menu item and marks their row active", async () => {
    vi.useFakeTimers();
    fetchChatProjectsMock.mockResolvedValue({ items: [{ id: "p1", name: "Work", createdAt: 1, updatedAt: 1 }] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    try {
      await vi.advanceTimersByTimeAsync(1);
      const row = getByRole(container, "button", { name: "Work" });
      expect(row.getAttribute("aria-current")).toBeNull();
      expect(row.querySelector('a[href="/p/p1"]')).toBeNull();
      container.querySelector<HTMLElement>('[aria-label="Project menu"]')!.click();
      await vi.advanceTimersByTimeAsync(1);
      const open = getByRole(document.body, "link", { name: "Open" });
      expect(Array.from(open.parentElement!.querySelectorAll("a, button")).map((item) => item.textContent?.trim())).toEqual(["Open", "Rename…", "Delete…"]);
      expect(open.getAttribute("href")).toBe("/p/p1");
      open.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(container.querySelector("details[open]")).not.toBeNull();
      open.addEventListener("click", (event) => event.preventDefault());
      open.click();
      await vi.advanceTimersByTimeAsync(1);
      expect(container.querySelector("details[open]")).toBeNull();
      setPathname("/p/p1");
      expect(row.getAttribute("aria-current")).toBe("page");
    } finally { dispose(); }
  });

  it("keeps one menu open and dismisses it when its row moves or the drawer closes", async () => {
    vi.useFakeTimers();
    fetchChatProjectsMock.mockResolvedValue({ items: [{ id: "p1", name: "Work", createdAt: 1, updatedAt: 1 }] });
    fetchAgentSessionsMock.mockResolvedValue({ items: [{ agentId: "a", sessionId: "one", firstUserMessage: "Chat", lastActivity: 1 }] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [collapsed, setCollapsed] = createSignal(false);
    const dispose = render(() => <AgentSidebar collapsed={collapsed} />, container);
    try {
      await vi.advanceTimersByTimeAsync(1);
      const project = container.querySelector<HTMLElement>('[aria-label="Project menu"]')!;
      const chat = container.querySelector<HTMLElement>('[aria-label="Session menu"]')!;
      project.click();
      await vi.advanceTimersByTimeAsync(1);
      chat.click();
      await vi.advanceTimersByTimeAsync(1);
      expect(container.querySelectorAll("details[open]")).toHaveLength(1);
      expect(project.parentElement!.hasAttribute("open")).toBe(false);
      container.querySelector(".sessions-list")!.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(1);
      expect(container.querySelector("details[open]")).toBeNull();
      project.click();
      await vi.advanceTimersByTimeAsync(1);
      window.dispatchEvent(new Event("resize"));
      await vi.advanceTimersByTimeAsync(1);
      expect(container.querySelector("details[open]")).toBeNull();
      project.click();
      await vi.advanceTimersByTimeAsync(1);
      setCollapsed(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(container.querySelector("details[open]")).toBeNull();
    } finally { dispose(); }
  });

  it("focuses menu actions when opened and returns to the trigger on Escape", async () => {
    vi.useFakeTimers();
    fetchChatProjectsMock.mockResolvedValue({ items: [{ id: "p1", name: "Work", createdAt: 1, updatedAt: 1 }] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    try {
      await vi.advanceTimersByTimeAsync(1);
      const trigger = container.querySelector<HTMLElement>('[aria-label="Project menu"]')!;
      trigger.focus();
      trigger.click();
      await vi.advanceTimersByTimeAsync(1);
      expect(document.activeElement).toBe(getByRole(document.body, "link", { name: "Open" }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(document.activeElement).toBe(trigger);
      expect(container.querySelector("details[open]")).toBeNull();
    } finally { dispose(); }
  });

  it("defers hidden mount and resumes both lists on visibility", async () => {
    vi.useFakeTimers();
    setVisibility("hidden");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchAgentSessionsMock).not.toHaveBeenCalled();
      expect(fetchChatProjectsMock).not.toHaveBeenCalled();
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchAgentSessionsMock).toHaveBeenCalledTimes(1);
      expect(fetchChatProjectsMock).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it("pauses both lists while hidden and preserves visible polling and wake events", async () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const sessions = fetchAgentSessionsMock.mock.calls.length;
      const projects = fetchChatProjectsMock.mock.calls.length;
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(9000);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("chat-projects-changed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchAgentSessionsMock).toHaveBeenCalledTimes(sessions);
      expect(fetchChatProjectsMock).toHaveBeenCalledTimes(projects);
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(9000);
      expect(fetchAgentSessionsMock).toHaveBeenCalledTimes(sessions + 3);
      expect(fetchChatProjectsMock).toHaveBeenCalledTimes(projects + 3);
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchAgentSessionsMock).toHaveBeenCalledTimes(sessions + 4);
      expect(fetchChatProjectsMock).toHaveBeenCalledTimes(projects + 4);
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchAgentSessionsMock).toHaveBeenCalledTimes(sessions + 5);
      expect(fetchChatProjectsMock).toHaveBeenCalledTimes(projects + 5);
    } finally {
      dispose();
    }
  });

  it.each(["create", "rename", "move", "delete"])("gates project refresh after %s completes hidden and refreshes visible mutations", async (mutation) => {
    vi.useFakeTimers();
    setVisibility("visible");
    fetchChatProjectsMock.mockResolvedValue({ items: [{ id: "p1", name: "Work", createdAt: 1, updatedAt: 1 }] });
    fetchAgentSessionsMock.mockResolvedValue({ items: [{ agentId: "a", sessionId: "s1", lastActivity: 1, firstUserMessage: "Chat", projectId: null }] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    const click = (text: string, selector = "button") => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).find((item) => item.textContent?.trim() === text);
      expect(button).toBeDefined();
      button!.click();
    };
    const startMutation = async () => {
      if (mutation === "create") {
        container.querySelector<HTMLButtonElement>('[aria-label="New project"]')!.click();
      } else {
        await openSidebarMenu(container, mutation === "move" ? "Session menu" : "Project menu");
        click(mutation === "rename" ? "Rename…" : mutation === "delete" ? "Delete…" : "Move to project…", ".session-action");
      }
      if (mutation === "create" || mutation === "rename") {
        const input = container.querySelector<HTMLInputElement>('[role="dialog"] input')!;
        input.value = "Updated project";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      click(mutation === "create" ? "Create" : mutation === "rename" ? "Rename" : mutation === "delete" ? "Delete project" : "Work", '[role="dialog"] button, [role="alertdialog"] button');
    };
    try {
      await vi.advanceTimersByTimeAsync(0);
      let finishMutation!: () => void;
      if (mutation === "create") {
        createChatProjectMock.mockImplementationOnce(() => new Promise((resolve) => { finishMutation = () => resolve({ id: "created" }); }));
      } else {
        const mock = mutation === "rename" ? renameChatProjectMock : mutation === "delete" ? deleteChatProjectMock : moveChatToProjectMock;
        mock.mockImplementationOnce(() => new Promise<void>((resolve) => { finishMutation = resolve; }));
      }
      await startMutation();
      expect(finishMutation).toBeDefined();
      const baseline = fetchChatProjectsMock.mock.calls.length;
      setVisibility("hidden");
      finishMutation();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchChatProjectsMock).toHaveBeenCalledTimes(baseline);
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchChatProjectsMock).toHaveBeenCalledTimes(baseline + 1);
      const visibleBaseline = fetchChatProjectsMock.mock.calls.length;
      await startMutation();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchChatProjectsMock.mock.calls.length).toBeGreaterThan(visibleBaseline);
      expect(container.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    } finally {
      dispose();
    }
  });

  it("stops both lists after a handled sessions 401", async () => {
    vi.useFakeTimers();
    setVisibility("visible");
    fetchAgentSessionsMock.mockRejectedValueOnce(new UnauthenticatedError());
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(navigateMock).toHaveBeenCalledWith("/login");
      const sessions = fetchAgentSessionsMock.mock.calls.length;
      const projects = fetchChatProjectsMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(9000);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("chat-projects-changed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchAgentSessionsMock).toHaveBeenCalledTimes(sessions);
      expect(fetchChatProjectsMock).toHaveBeenCalledTimes(projects);
    } finally {
      dispose();
    }
  });

  it("removes polling and every refresh listener on disposal", async () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const sessions = fetchAgentSessionsMock.mock.calls.length;
      const projects = fetchChatProjectsMock.mock.calls.length;
      dispose();
      await vi.advanceTimersByTimeAsync(9000);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("chat-projects-changed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchAgentSessionsMock).toHaveBeenCalledTimes(sessions);
      expect(fetchChatProjectsMock).toHaveBeenCalledTimes(projects);
    } finally {
      dispose();
    }
  });

  it("keeps refreshing chats when project requests hang or fail", async () => {
    vi.useFakeTimers();
    fetchChatProjectsMock.mockImplementationOnce(() => new Promise(() => {}));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    await vi.advanceTimersByTimeAsync(1);
    fetchChatProjectsMock.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchAgentSessionsMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("Unable to load projects");
    dispose();
  });

  it("orders pinned above recent with recency groups and live unpin", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const session = (sessionId: string, lastActivity: number, pinned: number | null) => ({
      agentId: "alpha", sessionId, createdAt: lastActivity, lastActivity,
      messageCount: 1, firstUserMessage: sessionId, isMain: false, pinned,
    });
    const items = [session("Recent chat", now, null), session("Pinned today", now - 1000, now), session("Pinned old", now - 10 * 86400000, now)];
    fetchAgentSessionsMock.mockResolvedValue({ items });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    await vi.advanceTimersByTimeAsync(1);
    const labels = () => Array.from(container.querySelectorAll(".session-title-text")).map((node) => node.textContent);
    expect(labels()).toEqual(["Pinned today", "Pinned old", "Recent chat"]);
    const sections = container.querySelectorAll(".sessions-section:not([aria-label=Projects])");
    expect(sections[0].getAttribute("aria-label")).toBe("Pinned");
    expect(sections[1].getAttribute("aria-label")).toBe("Recent");
    expect(sections[0].querySelectorAll(".sessions-group")).toHaveLength(2);
    expect(sections[1].textContent).not.toContain("Pinned today");
    await openSidebarMenu(container);
    const unpin = Array.from(document.querySelectorAll<HTMLButtonElement>(".session-action")).find((button) => button.textContent?.trim() === "Unpin")!;
    fetchAgentSessionsMock.mockResolvedValue({ items: items.map((item) => ({ ...item, pinned: null })) });
    unpin.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(pinAgentSessionMock).toHaveBeenCalledWith("alpha", "Pinned today", false);
    expect(container.querySelector('[aria-label="Pinned"]')).toBeNull();
    expect(labels()).toEqual(["Recent chat", "Pinned today", "Pinned old"]);
    fetchAgentSessionsMock.mockResolvedValue({ items });
    await vi.advanceTimersByTimeAsync(3000);
    expect(labels()).toEqual(["Pinned today", "Pinned old", "Recent chat"]);
    dispose();
  });

  it("keeps the session menu open and focused across an equivalent poll", async () => {
    vi.useFakeTimers();
    const item = {
      agentId: "alpha", sessionId: "stable", createdAt: Date.now(), lastActivity: Date.now(),
      messageCount: 1, firstUserMessage: "Stable chat", isMain: false, pinned: null,
    };
    fetchAgentSessionsMock.mockResolvedValue({ items: [item] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    await vi.advanceTimersByTimeAsync(1);
    const menu = container.querySelector<HTMLDetailsElement>("details")!;
    await openSidebarMenu(container);
    const action = getByRole(document.body, "button", { name: "Pin" });
    action.focus();
    fetchAgentSessionsMock.mockResolvedValue({ items: [{ ...item }] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(container.querySelector("details")).toBe(menu);
    expect(menu.open).toBe(true);
    expect(document.activeElement).toBe(action);
    await vi.advanceTimersByTimeAsync(60000);
    const row = container.querySelector<HTMLButtonElement>(".session-row")!;
    expect(document.getElementById(row.getAttribute("aria-describedby")!)?.textContent).toContain("1m");
    expect(container.querySelector("details")).toBe(menu);
    expect(menu.open).toBe(true);
    expect(document.activeElement).toBe(action);
    action.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(pinAgentSessionMock).toHaveBeenCalledWith("alpha", "stable", true);
    dispose();
  });

  it("reports pin failure, clears the error on retry, and polls during a hanging pin", async () => {
    vi.useFakeTimers();
    const item = {
      agentId: "alpha", sessionId: "failure", createdAt: Date.now(), lastActivity: Date.now(),
      messageCount: 1, firstUserMessage: "Original chat", isMain: false, pinned: null,
    };
    fetchAgentSessionsMock.mockResolvedValue({ items: [item] });
    pinAgentSessionMock.mockRejectedValueOnce(new Error("Gateway unavailable"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
    await vi.advanceTimersByTimeAsync(1);
    await openSidebarMenu(container);
    getByRole(document.body, "button", { name: "Pin" }).click();
    await vi.advanceTimersByTimeAsync(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Failed to update session pin");
    let finishPin: (() => void) | undefined;
    pinAgentSessionMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finishPin = resolve; }));
    await openSidebarMenu(container);
    getByRole(document.body, "button", { name: "Pin" }).click();
    await vi.advanceTimersByTimeAsync(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    fetchAgentSessionsMock.mockResolvedValue({ items: [{ ...item, title: "Updated while pin waits" }] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(container.querySelector(".session-title-text")?.textContent).toBe("Updated while pin waits");
    expect(fetchAgentSessionsMock).toHaveBeenCalledTimes(2);
    finishPin!();
    await vi.advanceTimersByTimeAsync(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    dispose();
  });

  it("hides component nav links when capabilities disable them", () => {
    setCapabilitiesForTests({ extensions: {} });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [collapsed] = createSignal(false);

    const dispose = render(
      () => (
        <AgentSidebar
          collapsed={collapsed}
        />
      ),
      container
    );

    expect(container.querySelector('a[href="/projects"]')).toBeNull();
    expect(container.textContent).not.toContain("Teams");
    expect(container.textContent).toContain("Agents");

    dispose();
  });

  it("shows Teams in multi-user mode", () => {
    setCapabilitiesForTests({
      multiUser: true,
      extensions: {},
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [collapsed] = createSignal(false);

    const dispose = render(
      () => (
        <AgentSidebar
          collapsed={collapsed}
        />
      ),
      container
    );

    expect(container.textContent).toContain("Teams");
    const teamsLink = container.querySelector('a[title="Teams"]');
    expect(teamsLink?.querySelector(".fa-users")?.getAttribute("aria-hidden")).toBe("true");

    dispose();
  });

  it("navigates to /login and stops polling on 401 from fetchAgentSessions", async () => {
    vi.useFakeTimers();
    fetchAgentSessionsMock.mockRejectedValue(new UnauthenticatedError());

    const container = document.createElement("div");
    document.body.appendChild(container);
    const [collapsed] = createSignal(false);

    const dispose = render(
      () => (
        <AgentSidebar
          collapsed={collapsed}
        />
      ),
      container
    );

    // Let the initial createEffect fetch settle (microtasks + async rejection)
    await vi.advanceTimersByTimeAsync(50);

    expect(navigateMock).toHaveBeenCalledWith("/login");

    navigateMock.mockClear();

    // Advance past several poll intervals — polling must be stopped, no further navigations
    await vi.advanceTimersByTimeAsync(15000);

    expect(navigateMock).not.toHaveBeenCalled();

    dispose();
    vi.useRealTimers();
  });

  it("shows Connect tools after Restart tour on agent chat routes and opens the prompt", async () => {
    setCapabilitiesForTests({
      multiUser: true,
      user: { id: "u1", role: "user" },
      extensions: { projects: true },
    } as never);
    setPathname("/chat/scribe");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [collapsed] = createSignal(false);
    const dispose = render(
      () => <AgentSidebar collapsed={collapsed} />,
      container
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Connect tools"));
    // Both links share one row.
    const labels = Array.from(container.querySelectorAll<HTMLButtonElement>(".tour-links > button.tour-restart")).map(
      (b) => b.textContent?.trim()
    );
    expect(labels).toEqual(["Restart tour", "Connect tools"]);
    container.querySelectorAll<HTMLButtonElement>("button.tour-restart")[1].click();
    expect(connectPromptRequest()?.agentId).toBe("scribe");
    clearConnectPromptRequest();
    dispose();
  });

  it("hides Connect tools when no extension is starred as top", async () => {
    fetchTopExtensionsMock.mockResolvedValueOnce({ extensions: [], mcp: [] });
    setCapabilitiesForTests({
      multiUser: true,
      user: { id: "u1", role: "user" },
      extensions: { projects: true },
    } as never);
    setPathname("/chat/scribe");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [collapsed] = createSignal(false);
    const dispose = render(
      () => <AgentSidebar collapsed={collapsed} />,
      container
    );
    await vi.waitFor(() => expect(fetchTopExtensionsMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain("Restart tour");
    expect(container.textContent).not.toContain("Connect tools");
    dispose();
  });

  it("hides Connect tools outside agent chat routes", () => {
    setCapabilitiesForTests({
      multiUser: true,
      user: { id: "u1", role: "user" },
      extensions: { projects: true },
    } as never);
    localStorage.removeItem("yoplai:collapsed-chat-projects");
    fetchChatProjectsMock.mockReset();
    fetchChatProjectsMock.mockResolvedValue({ items: [] });
    moveChatToProjectMock.mockReset();
    moveChatToProjectMock.mockResolvedValue(undefined);
    setPathname("/projects");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [collapsed] = createSignal(false);
    const dispose = render(
      () => <AgentSidebar collapsed={collapsed} />,
      container
    );
    expect(container.textContent).toContain("Restart tour");
    expect(container.textContent).not.toContain("Connect tools");
    dispose();
  });

  it("shows Archive menu item for non-main session and calls archiveAgentSession", async () => {
    vi.useFakeTimers();
    fetchAgentSessionsMock.mockResolvedValueOnce({
      items: [
        {
          agentId: "alpha",
          sessionId: "s1",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 1,
          firstUserMessage: "Regular chat",
          isMain: false,
          pinned: null,
        },
      ],
    }).mockResolvedValue({ items: [] });
    setPathname("/chat/alpha");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => <AgentSidebar collapsed={() => false} />,
      container
    );
    await vi.advanceTimersByTimeAsync(1);
    await openSidebarMenu(container);
    const actions = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".session-action"));
    expect(actions().find((btn) => btn.textContent?.includes("Archive"))).toBeTruthy();
    actions().find((btn) => btn.textContent?.includes("Archive"))!.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(archiveAgentSessionMock).toHaveBeenCalledWith("alpha", "s1", true);
    expect(container.querySelector(".session-title-text")).toBeNull();
    dispose();
  });

  it("hides Archive menu item for main session", async () => {
    vi.useFakeTimers();
    fetchAgentSessionsMock.mockResolvedValue({
      items: [
        {
          agentId: "alpha",
          sessionId: "main",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 5,
          firstUserMessage: "Main chat",
          isMain: true,
          pinned: null,
        },
      ],
    });
    setPathname("/chat/alpha");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => <AgentSidebar collapsed={() => false} />,
      container
    );
    await vi.advanceTimersByTimeAsync(1);
    await openSidebarMenu(container);
    const actions = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".session-action"));
    expect(actions().find((btn) => btn.textContent?.includes("Archive"))).toBeFalsy();
    dispose();
  });

  it("shows separator before Delete", async () => {
    vi.useFakeTimers();
    fetchAgentSessionsMock.mockResolvedValue({
      items: [
        {
          agentId: "alpha",
          sessionId: "s1",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 1,
          firstUserMessage: "Test chat",
          isMain: false,
          pinned: null,
        },
      ],
    });
    setPathname("/chat/alpha");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => <AgentSidebar collapsed={() => false} />,
      container
    );
    await vi.advanceTimersByTimeAsync(1);
    await openSidebarMenu(container);
    expect(document.querySelector("hr.session-menu-separator")).toBeTruthy();
    dispose();
  });

  it("opens the single-user account menu from the collapsed sidebar", async () => {
    vi.useFakeTimers();
    fetchAgentSessionsMock.mockResolvedValue({ items: [] });
    setPathname("/chat/alpha");
    setCapabilitiesForTests({ multiUser: false });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <AgentSidebar collapsed={() => true} />, container);
    await vi.advanceTimersByTimeAsync(1);
    getByRole(container, "button", { name: "Account menu" }).click();
    const menu = getByRole(container, "menu");
    expect(getByRole(menu, "menuitem", { name: "Archive" }).getAttribute("href")).toBe("/archive");
    expect(getByRole(menu, "menuitem", { name: "Account settings" }).getAttribute("href")).toBe("/account/settings");
    expect(queryByRole(menu, "menuitem", { name: "Logout" })).toBeNull();
    dispose();
    container.remove();
  });

  it("shows a Link gateway entry when the gateway can link, also with no saved gateway, and none otherwise", async () => {
    vi.useFakeTimers();
    fetchAgentSessionsMock.mockResolvedValue({ items: [] });
    setPathname("/chat/alpha");
    const render_ = async (capabilities: Parameters<typeof setCapabilitiesForTests>[0]) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ gateways: [] }), { status: 200 }));
      setCapabilitiesForTests(capabilities);
      const container = document.createElement("div");
      document.body.appendChild(container);
      const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
      await vi.advanceTimersByTimeAsync(5);
      getByRole(container, "button", { name: "Account menu" }).click();
      const link = queryByRole(container, "menuitem", { name: "Link gateway" });
      dispose();
      container.remove();
      return link?.getAttribute("href");
    };
    expect(await render_({ multiUser: false, relayLink: { available: true } })).toBe("/remote-gateways");
    expect(await render_({ multiUser: false, relayLink: { available: false } })).toBeUndefined();
    expect(await render_({ multiUser: false })).toBeUndefined();
  });

  it("shows a Pairings entry for a local user with linked gateways, and no entry for a multi-user gateway or without links", async () => {
    vi.useFakeTimers();
    fetchAgentSessionsMock.mockResolvedValue({ items: [] });
    setPathname("/chat/alpha");
    const render_ = async (multiUser: boolean, answer: Response) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(answer);
      setCapabilitiesForTests({ multiUser });
      const container = document.createElement("div");
      document.body.appendChild(container);
      const dispose = render(() => <AgentSidebar collapsed={() => false} />, container);
      await vi.advanceTimersByTimeAsync(5);
      if (!multiUser) getByRole(container, "button", { name: "Account menu" }).click();
      const link = queryByRole(container, "menuitem", { name: "Pairings" });
      dispose();
      container.remove();
      return link?.getAttribute("href");
    };
    const list = () => new Response(JSON.stringify({ gateways: [{ name: "east side" }, { name: "west" }] }), { status: 200, headers: { "content-type": "application/json" } });
    expect(await render_(false, list())).toBe("/account/connections?gateway=east%20side");
    expect(await render_(false, new Response(JSON.stringify({ error: "relay_unavailable" }), { status: 403 }))).toBeUndefined();
    expect(await render_(false, new Response(JSON.stringify({ gateways: [] }), { status: 200 }))).toBeUndefined();
    expect(await render_(true, list())).toBeUndefined();
  });

  it("closes session menu on outside click", async () => {
    vi.useFakeTimers();
    fetchAgentSessionsMock.mockResolvedValue({
      items: [
        {
          agentId: "alpha",
          sessionId: "s1",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 3,
          firstUserMessage: "Test chat",
          isMain: false,
          pinned: null,
        },
      ],
    });
    setPathname("/chat/alpha");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => <AgentSidebar collapsed={() => false} />,
      container
    );
    await vi.advanceTimersByTimeAsync(1);
    const menu = container.querySelector<HTMLDetailsElement>("details.session-actions");
    expect(menu).toBeTruthy();
    expect(menu!.open).toBe(false);
    // Open menu
    await openSidebarMenu(container);
    expect(menu!.open).toBe(true);
    // Click outside (on document.body which doesn't contain the menu)
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(menu!.open).toBe(false);
    dispose();
  });

  it("closes session menu on Escape key", async () => {
    vi.useFakeTimers();
    fetchAgentSessionsMock.mockResolvedValue({
      items: [
        {
          agentId: "alpha",
          sessionId: "s1",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 3,
          firstUserMessage: "Test chat",
          isMain: false,
          pinned: null,
        },
      ],
    });
    setPathname("/chat/alpha");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => <AgentSidebar collapsed={() => false} />,
      container
    );
    await vi.advanceTimersByTimeAsync(1);
    const menu = container.querySelector<HTMLDetailsElement>("details.session-actions");
    expect(menu).toBeTruthy();
    // Open menu
    await openSidebarMenu(container);
    expect(menu!.open).toBe(true);
    // Press Escape
    const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    document.dispatchEvent(escapeEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(menu!.open).toBe(false);
    dispose();
  });

  it("shows toast on successful archive", async () => {
    vi.useFakeTimers();
    fetchAgentSessionsMock.mockResolvedValue({
      items: [
        {
          agentId: "alpha",
          sessionId: "s1",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 3,
          firstUserMessage: "Archive me",
          isMain: false,
          pinned: null,
        },
      ],
    });
    setPathname("/chat/alpha");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => <AgentSidebar collapsed={() => false} />,
      container
    );
    await vi.advanceTimersByTimeAsync(1);
    await openSidebarMenu(container);
    const archiveButton = Array.from(document.querySelectorAll<HTMLButtonElement>(".session-action")).find(
      (btn) => btn.textContent?.includes("Archive")
    );
    expect(archiveButton).toBeTruthy();
    archiveButton!.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(showToastMock).toHaveBeenCalledWith("Chat archived", "success");
    dispose();
  });
});
