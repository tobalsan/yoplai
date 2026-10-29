// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Suspense } from "solid-js";
import type { Agent } from "../api/types";
import type { AgentDashboard } from "../api/agents";
import type { AgentFork, Team } from "../api/teams";

const byText = <T extends HTMLElement>(selector: string, text: string) =>
  Array.from(document.body.querySelectorAll<T>(selector)).find((element) => element.textContent?.trim() === text)!;

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  fetchPoolMock,
  fetchAgentsMock,
  fetchAgentDashboardsMock,
  fetchSchedulesMock,
  fetchPoolActionsMock,
  fetchTeamsMock,
  fetchForksMock,
  setForkTeamsMock,
  setForkVisibilityMock,
  fetchAgentExtensionsMock,
  fetchMcpServersMock,
  addMcpServerMock,
  removeMcpServerMock,
  disconnectMcpServerMock,
  patchAgentExtensionMock,
  useSessionMock,
  useParamsMock,
  navigateMock,
  useLocationMock,
  fetchTopExtensionsMock,
} = vi.hoisted(() => ({
  fetchPoolMock: vi.fn(),
  fetchAgentsMock: vi.fn(),
  fetchAgentDashboardsMock: vi.fn(),
  fetchSchedulesMock: vi.fn(),
  fetchPoolActionsMock: vi.fn(),
  fetchTeamsMock: vi.fn(),
  fetchForksMock: vi.fn(),
  setForkTeamsMock: vi.fn(),
  setForkVisibilityMock: vi.fn(),
  fetchAgentExtensionsMock: vi.fn(),
  fetchMcpServersMock: vi.fn(),
  addMcpServerMock: vi.fn(),
  removeMcpServerMock: vi.fn(),
  disconnectMcpServerMock: vi.fn(),
  patchAgentExtensionMock: vi.fn(),
  useSessionMock: vi.fn(),
  useParamsMock: vi.fn(),
  useLocationMock: vi.fn((): { state?: { backTo?: string } } => ({ state: undefined })),
  navigateMock: vi.fn(),
  fetchTopExtensionsMock: vi.fn(),
}));

vi.mock("../api/top-extensions", () => ({
  EMPTY_TOP_EXTENSIONS: { extensions: [], mcp: [], system: { extensions: [], mcp: [] } },
  fetchTopExtensions: fetchTopExtensionsMock,
}));

vi.mock("../api", () => ({
  fetchPool: fetchPoolMock,
  fetchAgents: fetchAgentsMock,
  fetchAgentDashboards: fetchAgentDashboardsMock,
}));

vi.mock("../api/extensions", () => ({
  fetchAgentExtensions: fetchAgentExtensionsMock,
  patchAgentExtension: patchAgentExtensionMock,
  detailsPath: (agentId: string, extensionId: string) =>
    `/agents/${agentId}/extensions/${extensionId}`,
}));

vi.mock("../api/mcp-servers", () => ({
  refreshMcpServerIcon: vi.fn(),
  refreshMcpCatalogIcon: vi.fn(),
  cachedMcpServers: () => undefined,
  mcpDisplayName: (name: string, title?: string) => title || name.charAt(0).toUpperCase() + name.slice(1),
  fetchMcpServersFast: fetchMcpServersMock,
  fetchMcpServer: async () => ({ servers: [] }),
  addMcpServer: addMcpServerMock,
  removeMcpServer: removeMcpServerMock,
  disconnectMcpServer: disconnectMcpServerMock,
}));

vi.mock("../api/schedules", () => ({
  fetchSchedules: fetchSchedulesMock,
  updateSchedule: vi.fn(),
}));

vi.mock("../api/teams", () => ({
  fetchTeams: fetchTeamsMock,
  fetchForks: fetchForksMock,
  fetchPoolActions: fetchPoolActionsMock,
  setForkTeams: setForkTeamsMock,
  setForkVisibility: setForkVisibilityMock,
}));

vi.mock("../auth/client", () => ({ useSession: useSessionMock }));

function appendChildren(el: HTMLElement, children: unknown): void {
  if (children == null) return;
  if (Array.isArray(children)) {
    children.forEach((child) => appendChildren(el, child));
    return;
  }
  if (children instanceof Node) {
    el.appendChild(children);
    return;
  }
  el.appendChild(document.createTextNode(String(children)));
}

vi.mock("@solidjs/router", () => ({
  A: (props: { href: string; class?: string; children: unknown; "aria-label"?: string }) => {
    const a = document.createElement("a");
    a.setAttribute("href", props.href);
    if (props["aria-label"]) a.setAttribute("aria-label", props["aria-label"]);
    if (props.class) a.className = props.class;
    appendChildren(a, props.children);
    return a;
  },
  useParams: () => useParamsMock(),
  useLocation: () => useLocationMock(),
  useNavigate: () => navigateMock,
}));

function fork(partial: Partial<AgentFork> & { sourcePoolId: string }): AgentFork {
  return {
    forkAgentId: partial.sourcePoolId,
    teamId: null,
    createdBy: "admin-1",
    createdAt: "now",
    assignedBy: null,
    assignedAt: null,
    public: false,
    ...partial,
    assignment: partial.assignment ?? { mode: "list", teamIds: partial.teamId ? [partial.teamId] : [] },
  };
}

import { EditAgent } from "./EditAgent";
import {
  resetCapabilitiesForTests,
  setCapabilitiesForTests,
} from "../lib/capabilities";

// ── Helpers ───────────────────────────────────────────────────────────────────

function agent(partial: Partial<Agent> & { id: string }): Agent {
  return { name: partial.id, ...partial } as Agent;
}

function setSession(role: string | null) {
  useSessionMock.mockReturnValue(() => ({
    isPending: false,
    data: role ? { user: { role } } : { user: {} },
  }));
}

let container: HTMLElement;
let dispose: () => void;
let assign: ReturnType<typeof vi.fn>;

function queryAllByText(text: string): Node[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const matches: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent === text) matches.push(node);
  }
  return matches;
}

async function mountEdit(agentId: string) {
  useParamsMock.mockReturnValue({ agentId });
  vi.stubGlobal("location", { href: `http://localhost/agents/${agentId}/edit`, pathname: `/agents/${agentId}/edit`, search: "", hash: "", assign });
  dispose = render(() => <EditAgent />, container);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function openTab(label: string) {
  Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    .find((button) => button.textContent?.trim() === label)!
    .click();
}

beforeEach(() => {
  assign = vi.fn();
  setCapabilitiesForTests({ forkedAgents: true });
  fetchPoolMock.mockReset();
  fetchAgentsMock.mockReset().mockResolvedValue([]);
  fetchAgentDashboardsMock.mockReset().mockResolvedValue([]);
  fetchSchedulesMock.mockReset().mockResolvedValue([]);
  fetchPoolActionsMock.mockReset().mockResolvedValue([]);
  fetchTeamsMock.mockReset().mockResolvedValue([] as Team[]);
  fetchForksMock.mockReset().mockResolvedValue([] as AgentFork[]);
  fetchAgentExtensionsMock.mockReset().mockResolvedValue([]);
  fetchMcpServersMock.mockReset().mockResolvedValue({ servers: [], canConfigureTeam: true });
  addMcpServerMock.mockReset();
  removeMcpServerMock.mockReset();
  disconnectMcpServerMock.mockReset();
  patchAgentExtensionMock.mockReset();
  setForkTeamsMock.mockReset();
  setForkVisibilityMock.mockReset();
  useSessionMock.mockReset();
  useParamsMock.mockReset();
  navigateMock.mockReset();
  useLocationMock.mockReset().mockReturnValue({ state: undefined });
  fetchTopExtensionsMock.mockReset().mockResolvedValue({ extensions: [], mcp: [], system: { extensions: [], mcp: [] } });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  vi.restoreAllMocks();
  dispose?.();
  container.remove();
  resetCapabilitiesForTests();
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("EditAgent", () => {
  it("links back to the agents list by default", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe", name: "Scribe" })]);
    await mountEdit("scribe");
    const back = Array.from(container.querySelectorAll("a")).find((link) => link.textContent?.includes("Back to agents"));
    expect(back?.getAttribute("href")).toBe("/agents");
  });

  it("links back to the chat that opened the settings", async () => {
    setSession("admin");
    useLocationMock.mockReturnValue({ state: { backTo: "/chat/scribe?session=abc" } });
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe", name: "Scribe" })]);
    await mountEdit("scribe");
    const back = Array.from(container.querySelectorAll("a")).find((link) => link.textContent?.includes("Back to chat"));
    expect(back?.getAttribute("href")).toBe("/chat/scribe?session=abc");
  });

  it("renders the target agent name and role for an admin", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([
      agent({ id: "scribe", name: "Scribe", role: "Writer", avatar: "📝" }),
    ]);
    await mountEdit("scribe");

    expect(container.querySelector(".edit-agent-name")?.textContent).toBe(
      "Scribe"
    );
    expect(container.querySelector(".edit-agent-role")?.textContent).toBe(
      "Writer"
    );
    expect(container.querySelector(".avatar-emoji")?.textContent).toBe("📝");
  });

  it("shows a not-found message when the agent id is unknown", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    await mountEdit("ghost");

    expect(container.textContent).toContain("Agent not found");
  });

  it("allows a non-admin to open a team agent edit page", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchPoolActionsMock.mockResolvedValue([{
      poolId: "scribe", action: "chat", chatAgentId: "scribe-fork",
      forked: true, reason: null, teamName: "Writers",
    }]);
    fetchAgentExtensionsMock.mockResolvedValue([]);
    await mountEdit("scribe");

    expect(navigateMock).not.toHaveBeenCalledWith("/", { replace: true });
    expect(container.querySelector(".edit-agent")).not.toBeNull();
    expect(fetchAgentExtensionsMock).toHaveBeenCalledWith("scribe-fork", expect.any(Object));
  });

  it("shows dashboards for the accessible fork with working open and copy links", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchPoolActionsMock.mockResolvedValue([{
      poolId: "scribe", action: "chat", chatAgentId: "scribe-fork",
      forked: true, reason: null, teamName: "Writers",
    }]);
    fetchAgentDashboardsMock.mockResolvedValue([{
      title: "Writing Report", slug: "report.html",
      updatedAt: "2026-09-25T10:00:00.000Z", link: "https://yoplai.test/d/stable-link",
      params: [], linksTo: [],
    }]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await mountEdit("scribe");
    openTab("Dashboards");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchAgentDashboardsMock).toHaveBeenCalledWith("scribe-fork", expect.any(Object));
    expect(container.textContent).toContain("Writing Report");
    expect(container.textContent).not.toContain("report.html");
        expect(byText<HTMLAnchorElement>("a", "Open").getAttribute("href")).toBe("https://yoplai.test/d/stable-link");
    byText<HTMLButtonElement>("button", "Copy link").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeText).toHaveBeenCalledWith("https://yoplai.test/d/stable-link");
  });

  it("lists top dashboards once and parameter pages once with their top-page parents", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    const dashboard = (slug: string, params: string[], linksTo: string[]) => ({
      title: slug, slug: `${slug}.html`, params, linksTo: linksTo.map((link) => `${link}.html`),
      updatedAt: "2026-09-25T10:00:00.000Z", link: `/d/${slug}`,
    });
    fetchAgentDashboardsMock.mockResolvedValue([
      dashboard("clients", [], ["client", "qbr", "csm", "missing"]),
      dashboard("csm", [], ["client"]),
      dashboard("client", ["id"], ["qbr", "clients", "client"]),
      dashboard("qbr", ["id"], ["client"]),
      dashboard("orphan", ["name"], ["orphan-child"]),
    ]);
    await mountEdit("scribe");
    openTab("Dashboards");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const panel = container.querySelector(".edit-agent-dashboards")!;
    const top = panel.querySelectorAll(":scope > ul > li");
    expect(Array.from(top, (li) => li.querySelector("strong")?.textContent)).toEqual(["clients", "csm"]);
    expect(Array.from(panel.querySelectorAll("a")).filter((a) => a.textContent === "Open")).toHaveLength(2);
    const sub = Array.from(panel.querySelectorAll(".edit-agent-subpages li"));
    expect(sub.map((li) => li.querySelector("strong")?.textContent)).toEqual(["client", "qbr", "orphan"]);
    const parents = (li: Element) => Array.from(li.querySelectorAll("a"), (a) => [a.textContent, a.getAttribute("href")]);
    expect(parents(sub[0]!)).toEqual([["clients", "/d/clients"], ["csm", "/d/csm"]]);
    expect(parents(sub[1]!)).toEqual([["clients", "/d/clients"], ["csm", "/d/csm"]]);
    expect(sub[2]!.textContent).toContain("not linked from any top page");
    expect(panel.querySelector(".edit-agent-subpages p")?.textContent).toContain("need dynamic arguments in the URL");
  });

  it("shows parameter pages when no dashboard can be opened without arguments", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentDashboardsMock.mockResolvedValue([{
      title: "Client", slug: "client.html", params: ["id"], linksTo: [],
      updatedAt: "2026-09-25T10:00:00.000Z", link: "/d/client",
    }]);
    await mountEdit("scribe");
    openTab("Dashboards");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const panel = container.querySelector(".edit-agent-dashboards")!;
    expect(panel.textContent).toContain("Detail pages");
    expect(panel.textContent).toContain("Client");
    expect(Array.from(panel.querySelectorAll("a")).filter((a) => a.textContent === "Open")).toHaveLength(0);
    expect(panel.textContent).not.toContain("No dashboards yet.");
  });

  it("loads scheduled jobs for the accessible fork agent", async () => {
    setCapabilitiesForTests({ forkedAgents: true, extensions: { scheduler: true } });
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchPoolActionsMock.mockResolvedValue([{
      poolId: "scribe", action: "chat", chatAgentId: "scribe-fork",
      forked: true, reason: null, teamName: "Writers",
    }]);
    await mountEdit("scribe");
    const schedulesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent?.trim() === "Scheduled jobs");
    schedulesTab!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchSchedulesMock.mock.calls[0]?.[0]).toBe("scribe-fork");
  });

  it("shows an empty dashboard state for an accessible agent", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    await mountEdit("scribe");
    openTab("Dashboards");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchAgentDashboardsMock).toHaveBeenCalledWith("scribe", expect.any(Object));
    expect(container.textContent).toContain("No dashboards yet.");
  });

  it("keeps tabs usable during a pending dashboard request and renders dashboards when it resolves", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    let resolveDashboards!: (dashboards: AgentDashboard[]) => void;
    fetchAgentDashboardsMock.mockReturnValue(new Promise<AgentDashboard[]>((resolve) => {
      resolveDashboards = resolve;
    }));
    await mountEdit("scribe");
    openTab("Dashboards");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain("Loading dashboards…");

    openTab("Extensions");
    expect(container.querySelector(".edit-agent-extensions")).not.toBeNull();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Extensions");
    openTab("Dashboards");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain("Loading dashboards…");

    resolveDashboards([
      { id: "clients", agentId: "scribe", agentName: "Scribe", publishedAt: null, legacy: false, isOwner: false, shared: true, ownerName: "Alice", mode: "read", title: "Clients", slug: "clients.html", params: [], linksTo: ["client.html"], updatedAt: "2026-09-25T10:00:00.000Z", link: "/d/clients" },
      { id: "client", agentId: "scribe", agentName: "Scribe", publishedAt: null, legacy: false, isOwner: false, shared: true, ownerName: "Alice", mode: "read", title: "Client", slug: "client.html", params: ["id"], linksTo: [], updatedAt: "2026-09-25T10:00:00.000Z", link: "/d/client" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).not.toContain("Loading dashboards…");
    const child = container.querySelector(".edit-agent-subpages li")!;
    expect(child.textContent).toContain("Client");
    expect(child.querySelector("a")?.getAttribute("href")).toBe("/d/clients");
    expect(byText<HTMLAnchorElement>("a", "Open").getAttribute("href")).toBe("/d/clients");
  });

  it("shows a dashboard load error", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentDashboardsMock.mockRejectedValue(new Error("network"));
    await mountEdit("scribe");
    openTab("Dashboards");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain("Failed to load dashboards.");
  });

  it("lets the owning admin change visibility and refetches the fork", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchTeamsMock.mockResolvedValue([{ id: "own", name: "Writers", canManage: true } as Team]);
    const owned = fork({ sourcePoolId: "scribe", teamId: "own" });
    fetchForksMock.mockResolvedValueOnce([owned]).mockResolvedValue([{ ...owned, public: true }]);
    setForkVisibilityMock.mockResolvedValue({ ...owned, public: true });
    await mountEdit("scribe");
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Agent visibility"]')!;
    expect(toggle).not.toBeNull();
    expect(toggle.disabled).toBe(false);
    expect(toggle.textContent).toBe("Private");
    expect(toggle.closest("[title]")?.getAttribute("title")).toContain("Click to make it public");
    toggle.click();
    await vi.waitFor(() => expect(setForkVisibilityMock).toHaveBeenCalledWith("scribe", true));
    await vi.waitFor(() => expect(toggle.textContent).toBe("Public"));
    expect(fetchForksMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { role: "user", owned: false, state: "hidden" },
    { role: "admin", owned: false, state: "disabled" },
    { role: "admin", owned: true, state: "enabled" },
    { role: "superadmin", owned: false, state: "enabled" },
  ])("keeps Public visibility $state for $role (owned: $owned)", async ({ role, owned, state }) => {
    setSession(role);
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchTeamsMock.mockResolvedValue([{ id: "own", name: "Writers", canManage: true } as Team]);
    fetchForksMock.mockResolvedValue([fork({ sourcePoolId: "scribe", teamId: owned ? "own" : "foreign", public: true })]);
    fetchPoolActionsMock.mockResolvedValue([{ poolId: "scribe", action: "chat", chatAgentId: "scribe", forked: true, reason: null, teamName: "Writers" }]);
    await mountEdit("scribe");
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Agent visibility"]');
    if (state === "hidden") {
      expect(toggle).toBeNull();
      expect(fetchForksMock).not.toHaveBeenCalled();
    } else {
      expect(toggle).not.toBeNull();
      expect(toggle!.disabled).toBe(state === "disabled");
      expect(toggle!.textContent).toBe("Public");
    }
    if (state === "disabled") {
      toggle!.click();
      expect(setForkVisibilityMock).not.toHaveBeenCalled();
      // A Public agent can still join the admin's own team.
      const own = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((button) => button.textContent === "Writers");
      expect(own?.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("hides team buttons from an admin outside a Private agent's teams", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchTeamsMock.mockResolvedValue([{ id: "own", name: "Writers", canManage: true } as Team]);
    fetchForksMock.mockResolvedValue([fork({ sourcePoolId: "scribe", teamId: "foreign", public: false })]);
    fetchPoolActionsMock.mockResolvedValue([{ poolId: "scribe", action: "none", chatAgentId: null, forked: true, reason: "other_team", teamName: null }]);
    await mountEdit("scribe");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Writers")).toBe(false);
  });

  it("shows visibility when staff open the runnable fork directly", async () => {
    setSession("superadmin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe-fork" })]);
    fetchForksMock.mockResolvedValue([fork({ sourcePoolId: "scribe", forkAgentId: "scribe-fork", public: true })]);
    await mountEdit("scribe-fork");
    expect(container.querySelector('[aria-label="Agent visibility"]')?.textContent).toBe("Public");
  });

  it("sets explicit teams for a never-forked agent", async () => {
    setSession("superadmin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchForksMock.mockResolvedValue([]);
    fetchTeamsMock.mockResolvedValue([{ id: "t1", name: "Red", canManage: true } as Team]);
    setForkTeamsMock.mockResolvedValue(fork({ sourcePoolId: "scribe", teamId: "t1" }));
    await mountEdit("scribe");

    const section = container.querySelector(".edit-agent-team");
    expect(section).not.toBeNull();

    const pill = container.querySelectorAll<HTMLButtonElement>(".edit-agent-team-pill")[0]!;
    pill.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const button = container.querySelector<HTMLButtonElement>(
      ".edit-agent-team-button"
    )!;
    expect(button.textContent).toBe("Save");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setForkTeamsMock).toHaveBeenCalledWith("scribe", { mode: "list", teamIds: ["t1"] });
  });

  it("refetches extensions after assigning an agent to a team", async () => {
    setSession("superadmin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchForksMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([fork({ sourcePoolId: "scribe", teamId: "t1" })]);
    fetchTeamsMock.mockResolvedValue([{ id: "t1", name: "Red", canManage: true } as Team]);
    fetchAgentExtensionsMock
      .mockResolvedValueOnce([
        {
          id: "crm",
          displayName: "CRM",
          description: "CRM tools",
          builtIn: false,
          enabled: false,
          configurable: false,
          configJsonSchema: null,
          requiredSecrets: [],
          advancedConfigFields: [],
          configValues: {},
          configRoutePath: null,
          tier: "toggle-only",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "crm",
          displayName: "CRM",
          description: "CRM tools",
          builtIn: false,
          enabled: false,
          configurable: true,
          configJsonSchema: null,
          requiredSecrets: [],
          advancedConfigFields: [],
          configValues: {},
          configRoutePath: null,
          tier: "toggle-only",
        },
      ]);
    setForkTeamsMock.mockResolvedValue(
      fork({ sourcePoolId: "scribe", teamId: "t1" })
    );
    await mountEdit("scribe");

    container.querySelectorAll<HTMLButtonElement>(".edit-agent-team-pill")[0]!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector<HTMLButtonElement>(".edit-agent-team-button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchAgentExtensionsMock).toHaveBeenCalledTimes(2);
  });

  it("replaces an already-forked agent's explicit team list", async () => {
    setSession("superadmin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchForksMock.mockResolvedValue([
      fork({ sourcePoolId: "scribe", teamId: "t1" }),
    ]);
    fetchTeamsMock.mockResolvedValue([
      { id: "t1", name: "Red", canManage: true } as Team,
      { id: "t2", name: "Blue", canManage: true } as Team,
    ]);
    setForkTeamsMock.mockResolvedValue(fork({ sourcePoolId: "scribe", teamId: "t2" }));
    await mountEdit("scribe");

    const section = container.querySelector(".edit-agent-team");
    const pills = container.querySelectorAll<HTMLButtonElement>(".edit-agent-team-pill");
    expect(pills[0]!.classList.contains("selected")).toBe(true);
    expect(section?.textContent).toContain("Red");

    pills[0]!.click();
    pills[1]!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const button = container.querySelector<HTMLButtonElement>(
      ".edit-agent-team-button"
    )!;
    expect(button.textContent).toBe("Save");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const confirm = container.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(confirm.textContent).toContain("If you remove scribe from Red, members of Red can no longer chat with scribe.");
    expect(setForkTeamsMock).not.toHaveBeenCalled();
    [...confirm.querySelectorAll("button")].find((item) => item.textContent === "Remove")!.click();
    await vi.waitFor(() => expect(setForkTeamsMock).toHaveBeenCalledWith("scribe", { mode: "list", teamIds: ["t2"] }));
    await vi.waitFor(() => expect(container.querySelector('[role="alertdialog"]')).toBeNull());
  });

  it("warns that only a superadmin can reassign an agent left with no team", async () => {
    setSession("superadmin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe", name: "Scribe" })]);
    fetchForksMock.mockResolvedValue([fork({ sourcePoolId: "scribe", teamId: "t1" })]);
    fetchTeamsMock.mockResolvedValue([{ id: "t1", name: "Red", canManage: true } as Team]);
    await mountEdit("scribe");

    container.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    [...container.querySelectorAll("button")].find((item) => item.textContent === "Save")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain("If you remove Scribe from Red, Scribe has no team. Only a superadmin can assign Scribe to a team again.");
    [...container.querySelectorAll("button")].find((item) => item.textContent === "Cancel" && item.closest('[role="alertdialog"]'))!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(setForkTeamsMock).not.toHaveBeenCalled();
  });

  it("limits an admin to their own teams and keeps other teams' links", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchForksMock.mockResolvedValue([]);
    fetchTeamsMock.mockResolvedValue([
      { id: "t1", name: "Red", canManage: true } as Team,
      { id: "t2", name: "Blue", canManage: false } as Team,
    ]);
    setForkTeamsMock.mockResolvedValue(fork({ sourcePoolId: "scribe", teamId: "t1" }));
    await mountEdit("scribe");

    const pills = container.querySelectorAll<HTMLButtonElement>(".edit-agent-team-pill");
    expect(pills).toHaveLength(1);
    expect(pills[0]!.disabled).toBe(false);
    expect(container.textContent).not.toContain("All teams");
    expect(container.querySelector(".edit-agent-team")?.textContent).not.toContain("Blue");
  });

  it("does not render the team controls for a non-admin", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    await mountEdit("scribe");

    expect(container.querySelector(".edit-agent-team")).toBeNull();
  });

  it("shows a checkmark for set-up extensions and a + link otherwise", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    const base = {
      builtIn: false,
      configured: true,
      configJsonSchema: null,
      requiredSecrets: [],
      advancedConfigFields: [],
      configRoutePath: null,
    };
    fetchAgentExtensionsMock.mockResolvedValue([
      { ...base, id: "crm", displayName: "CRM", description: "", enabled: true, tier: "toggle-only" },
      { ...base, id: "mailer", displayName: "Mailer", description: "", enabled: false, tier: "toggle-only" },
      { ...base, id: "exa", displayName: "Exa", description: "", enabled: true, tier: "auto-form", requiredSecrets: ["apiKey"], configValues: { apiKey: "********" } },
      { ...base, id: "jira", displayName: "Jira", description: "", enabled: true, tier: "auto-form", requiredSecrets: ["token"], configValues: {} },
      { ...base, id: "notion", displayName: "Notion", description: "", enabled: false, tier: "auto-form", requiredSecrets: ["token"], configValues: {}, personalSecretFields: ["token"] },
      { ...base, id: "gmail", displayName: "Gmail", description: "", enabled: false, tier: "toggle-only", oauth: { provider: "google", scopes: [] }, oauthConnected: true },
      { ...base, id: "drive", displayName: "Drive", description: "", enabled: true, tier: "toggle-only", oauth: { provider: "google", scopes: [] }, oauthConnected: false },
    ]);
    await mountEdit("scribe");

    expect(container.querySelector(".edit-agent-ext-list [role=switch]")).toBeNull();
    const checked = Array.from(container.querySelectorAll(".edit-agent-ext-check")).map(
      (el) => el.getAttribute("aria-label")
    );
    expect(checked).toEqual(["CRM configured", "Exa configured", "Gmail configured", "Notion configured"]);
    const adds = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("a.edit-agent-ext-add")
    ).map((el) => el.getAttribute("href"));
    expect(adds).toEqual([
      "/agents/scribe/extensions/drive",
      "/agents/scribe/extensions/jira",
      "/agents/scribe/extensions/mailer",
    ]);
  });

  function seedSystemItems(enabled = true) {
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([
      { id: "webhooks", displayName: "Webhooks", description: "Incoming events", enabled, tier: "toggle-only", requiredSecrets: [] },
      { id: "notion", displayName: "Notion", description: "Notes", enabled: false, tier: "auto-form", requiredSecrets: [] },
    ]);
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: false, servers: [
      { name: "email", title: "AIMX Email", type: "http", url: "HTTPS://Email.test/mcp/?agent=scribe", auth: "none", state: enabled ? "connected" : "disconnected", readOnly: true },
      { name: "docs", title: "Public Docs", type: "http", url: "https://docs.test/mcp", auth: "none", state: "connected", readOnly: true },
      { name: "local", title: "Local tools", type: "stdio", auth: "stdio", state: "connected", readOnly: true },
    ] });
    fetchTopExtensionsMock.mockResolvedValue({ extensions: [], mcp: [], system: { extensions: ["webhooks"], mcp: ["https://email.test/mcp"] } });
  }

  it.each([
    { role: "user", enabled: true }, { role: "user", enabled: false },
    { role: "admin", enabled: true }, { role: "admin", enabled: false },
  ])("hides system extensions and MCP servers for $role, enabled=$enabled", async ({ role, enabled }) => {
    setCapabilitiesForTests({ forkedAgents: false, multiUser: true });
    setSession(role);
    seedSystemItems(enabled);
    await mountEdit("scribe");
    expect(container.textContent).not.toContain("Webhooks");
    expect(container.textContent).not.toContain("AIMX Email");
    expect(container.textContent).toContain("Notion");
    expect(container.textContent).toContain("Public Docs");
    expect(container.textContent).toContain("Local tools");
  });

  it("shows system items with badges to a superadmin", async () => {
    setCapabilitiesForTests({ forkedAgents: false, multiUser: true });
    setSession("superadmin");
    seedSystemItems();
    await mountEdit("scribe");
    expect(container.textContent).toContain("Webhooks");
    expect(container.textContent).toContain("AIMX Email");
    expect(container.textContent).toContain("Notion");
    expect(container.textContent).toContain("Public Docs");
    expect(queryAllByText("System")).toHaveLength(2);
  });

  it("shows the empty state when a user's only items are system items", async () => {
    setCapabilitiesForTests({ forkedAgents: false, multiUser: true });
    setSession("user");
    seedSystemItems();
    fetchAgentExtensionsMock.mockResolvedValue([{ id: "webhooks", displayName: "Webhooks", enabled: true, tier: "toggle-only", requiredSecrets: [] }]);
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: false, servers: [
      { name: "email", title: "AIMX Email", type: "http", url: "https://email.test/mcp", auth: "none", state: "connected", readOnly: true },
    ] });
    await mountEdit("scribe");
    expect(container.textContent).toContain("No extensions available.");
    expect(container.textContent).not.toContain("Webhooks");
    expect(container.textContent).not.toContain("AIMX Email");
  });

  it.each(["user", "superadmin"])("ignores system flags in single-user mode for role %s", async (role) => {
    setCapabilitiesForTests({ forkedAgents: false, multiUser: false });
    setSession(role);
    seedSystemItems();
    await mountEdit("scribe");
    expect(container.textContent).toContain("Webhooks");
    expect(container.textContent).toContain("AIMX Email");
    expect(container.textContent).toContain("Notion");
    expect(container.textContent).toContain("Public Docs");
    expect(queryAllByText("System")).toHaveLength(0);
  });

  it("sorts Top extensions and Top MCP servers first, then by name", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    const base = {
      builtIn: false,
      configured: true,
      configJsonSchema: null,
      requiredSecrets: [],
      advancedConfigFields: [],
      configRoutePath: null,
      description: "",
      enabled: true,
      tier: "toggle-only",
    };
    fetchAgentExtensionsMock.mockResolvedValue([
      { ...base, id: "alpha", displayName: "Alpha" },
      { ...base, id: "beta", displayName: "Beta" },
      { ...base, id: "zeta", displayName: "Zeta" },
    ]);
    fetchMcpServersMock.mockResolvedValue({
      canConfigureTeam: true,
      servers: [
        { name: "linear", type: "http", url: "https://mcp.linear.app/mcp/?x=1", auth: "oauth", state: "connected", readOnly: false },
        { name: "aaa", type: "http", url: "https://aaa.example/mcp", auth: "oauth", state: "connected", readOnly: false },
      ],
    });
    fetchTopExtensionsMock.mockResolvedValue({ extensions: ["zeta"], mcp: ["https://mcp.linear.app/mcp"], system: { extensions: [], mcp: [] } });
    await mountEdit("scribe");

    expect(Array.from(container.querySelectorAll(".edit-agent-ext-name")).map((n) => n.textContent)).toEqual([
      "Linear",
      "Zeta",
      "Aaa",
      "Alpha",
      "Beta",
    ]);
  });

  it("links the card body to the extension details page", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([
      {
        id: "crm",
        displayName: "CRM",
        description: "CRM tools",
        builtIn: false,
        enabled: true,
        configJsonSchema: null,
        requiredSecrets: [],
        tier: "toggle-only",
      },
    ]);
    await mountEdit("scribe");

    const link = container.querySelector<HTMLAnchorElement>(
      ".edit-agent-ext-open"
    )!;
    expect(link.getAttribute("href")).toBe("/agents/scribe/extensions/crm");
    expect(link.querySelector(".edit-agent-ext-name")?.textContent).toBe("CRM");
  });

  it("routes a needs-configuration auto-form extension to its config surface", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([{
      id: "exa",
      displayName: "Exa",
      description: "Search",
      builtIn: true,
      enabled: true,
      configured: false,
      missingConfig: ["apiKey"],
      configJsonSchema: { type: "object" },
      requiredSecrets: ["apiKey"],
      advancedConfigFields: [],
      configRoutePath: null,
      tier: "auto-form",
    }]);
    await mountEdit("scribe");

    const link = container.querySelector<HTMLAnchorElement>(".edit-agent-ext-open")!;
    expect(link.getAttribute("href")).toBe("/agents/scribe/extensions/exa");
    expect(link.textContent).toContain("Needs configuration");
  });

  it("routes a needs-configuration bespoke extension to its config surface", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([{
      id: "slack",
      displayName: "Slack",
      description: "Slack config",
      builtIn: false,
      enabled: true,
      configured: false,
      missingConfig: ["servers"],
      configJsonSchema: null,
      requiredSecrets: [],
      advancedConfigFields: [],
      configRoutePath: "/agents/scribe/extensions/slack/configure",
      tier: "bespoke-route",
    }]);
    await mountEdit("scribe");

    expect(container.querySelector<HTMLAnchorElement>(".edit-agent-ext-open")?.getAttribute("href"))
      .toBe("/agents/scribe/extensions/slack/configure");
  });

  it("does not render team controls for a non-admin", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([]);
    await mountEdit("scribe");

    expect(container.querySelector(".edit-agent-team")).toBeNull();
  });

  it("shows one card per existing MCP server beside regular extensions, with an icon fallback", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([
      { id: "mcp", displayName: "MCP", description: "Old hub" },
      { id: "notion", displayName: "Notion", description: "Notes", enabled: false, tier: "auto-form", requiredSecrets: [] },
    ]);
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [
      { name: "docs", type: "http", url: "https://docs.test/mcp", auth: "oauth", state: "disconnected", personalState: "disconnected", teamState: "disconnected", readOnly: true },
      { name: "local", type: "stdio", auth: "stdio", state: "connected", readOnly: true },
    ] });
    await mountEdit("scribe");

    expect(Array.from(container.querySelectorAll(".edit-agent-ext-name")).map((node) => node.textContent)).toEqual(["Docs", "Local", "Notion"]);
    expect(container.querySelector('[aria-label="Set up docs"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="local connected"]')).not.toBeNull();
    expect(container.querySelector('[data-tour-ext="mcp:docs"] a.edit-agent-ext-open')?.getAttribute("href")).toBe("/agents/scribe/mcp-servers/docs");
    expect(container.querySelector('[data-tour-ext="mcp:docs"] a.edit-agent-ext-add')?.getAttribute("href")).toBe("/agents/scribe/mcp-servers/docs");
    expect(container.querySelectorAll('[data-tour-ext^="mcp:"] button').length).toBe(0);
    expect(container.querySelector('[data-tour-ext^="mcp:"] .edit-agent-ext-icon svg')).not.toBeNull();
    expect(container.querySelector('[data-tour-ext^="mcp:"] .edit-agent-ext-icon img')).toBeNull();
  });

  it("shows a loading state until both extensions and MCP servers load, then the ordered list", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([
      { id: "notion", displayName: "Notion", description: "Notes", enabled: false, tier: "auto-form", requiredSecrets: [] },
    ]);
    let resolveMcp: (value: unknown) => void = () => {};
    fetchMcpServersMock.mockReturnValue(new Promise((resolve) => { resolveMcp = resolve; }));
    fetchTopExtensionsMock.mockResolvedValue({ extensions: [], mcp: ["https://docs.test/mcp"], system: { extensions: [], mcp: [] } });
    useParamsMock.mockReturnValue({ agentId: "scribe" });
    dispose = render(() => <Suspense fallback={<p class="suspended">Loading</p>}><EditAgent /></Suspense>, container);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector(".suspended")).toBeNull();
    expect(container.textContent).toContain("Loading agent extensions");
    expect(container.querySelector(".edit-agent-ext-name")).toBeNull();

    resolveMcp({ canConfigureTeam: true, servers: [{ name: "docs", type: "http", url: "https://docs.test/mcp", auth: "oauth", state: "connected", readOnly: false }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).not.toContain("Loading agent extensions");
    expect(Array.from(container.querySelectorAll(".edit-agent-ext-name")).map((node) => node.textContent)).toEqual(["Docs", "Notion"]);
  });

  it("shows extensions without MCP cards when the MCP fetch fails", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([
      { id: "notion", displayName: "Notion", description: "Notes", enabled: false, tier: "auto-form", requiredSecrets: [] },
    ]);
    fetchMcpServersMock.mockRejectedValue(new Error("boom"));
    await mountEdit("scribe");
    expect(container.textContent).not.toContain("Loading agent extensions");
    expect(Array.from(container.querySelectorAll(".edit-agent-ext-name")).map((node) => node.textContent)).toEqual(["Notion"]);
    expect(container.textContent).toContain("Failed to load MCP servers.");
  });

  it("refreshes MCP servers on focus without suspending the page", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([]);
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [
      { name: "docs", type: "http", url: "https://docs.test/mcp", auth: "none", state: "connected", readOnly: true },
    ] });
    useParamsMock.mockReturnValue({ agentId: "scribe" });
    dispose = render(() => <Suspense fallback={<p class="suspended">Loading</p>}><EditAgent /></Suspense>, container);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const card = container.querySelector('[data-tour-ext^="mcp:"]');
    expect(card).not.toBeNull();

    fetchMcpServersMock.mockReturnValue(new Promise(() => {}));
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector(".suspended")).toBeNull();
    expect(container.querySelector('[data-tour-ext^="mcp:"]')).toBe(card);
  });

  it("keeps regular extensions visible when MCP loading fails and can retry", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([
      { id: "notion", displayName: "Notion", description: "Notes", enabled: false, tier: "auto-form", requiredSecrets: [] },
    ]);
    fetchMcpServersMock.mockRejectedValueOnce(new Error("gateway unavailable"));
    await mountEdit("scribe");

    expect(container.querySelector(".edit-agent-ext-name")?.textContent).toBe("Notion");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Failed to load MCP servers");
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [
      { name: "docs", type: "http", auth: "none", state: "connected", readOnly: false },
    ] });
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Retry")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Array.from(container.querySelectorAll(".edit-agent-ext-name")).map((node) => node.textContent)).toEqual(["Docs", "Notion"]);
  });

  it("falls back to the MCP icon when a server icon fails to load", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [
      { name: "docs", type: "http", iconUrl: "https://docs.test/favicon.ico", auth: "none", state: "connected", readOnly: true },
    ] });
    await mountEdit("scribe");
    const icon = container.querySelector<HTMLImageElement>('[data-tour-ext^="mcp:"] .edit-agent-ext-icon img')!;
    expect(icon).not.toBeNull();
    icon.dispatchEvent(new Event("error"));
    expect(container.querySelector('[data-tour-ext^="mcp:"] .edit-agent-ext-icon img')).toBeNull();
    expect(container.querySelector('[data-tour-ext^="mcp:"] .edit-agent-ext-icon svg')).not.toBeNull();
  });

  it("redirects after the add request completes and keeps a canceled server disconnected", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    const pending = Promise.withResolvers<{ server: unknown; authorizationUrl: string }>();
    addMcpServerMock.mockReturnValue(pending.promise);
    const popup = { closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [] });
    await mountEdit("scribe");

    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Add custom extension")!.click();
    const input = container.querySelector<HTMLInputElement>('.mcp-ext-dialog input[type="url"]')!;
    input.value = "https://docs.test/mcp";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLFormElement>(".mcp-ext-dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(open).not.toHaveBeenCalled();
    expect(addMcpServerMock).toHaveBeenCalledWith("scribe", "https://docs.test/mcp", "personal", "/agents/scribe/edit");

    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [
      { name: "docs", type: "http", url: "https://docs.test/mcp", auth: "oauth", state: "disconnected", personalState: "disconnected", readOnly: false },
    ] });
    pending.resolve({ server: { name: "docs" }, authorizationUrl: "https://provider.test/authorize" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(assign).toHaveBeenCalledWith("https://provider.test/authorize");
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('[aria-label="Set up docs"]')).not.toBeNull();
  });

  describe("adding a custom extension", () => {
    async function submitAdd(url: string, scope?: "team", arrange?: () => void) {
      setCapabilitiesForTests({ forkedAgents: false });
      setSession("user");
      fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
      addMcpServerMock.mockResolvedValue({ server: { name: "docs" } });
      arrange?.();
      await mountEdit("scribe");
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Add custom extension")!.click();
      if (scope) {
        container.querySelectorAll<HTMLInputElement>('.mcp-ext-dialog input[name="mcp-scope"]')[1].click();
      }
      const input = container.querySelector<HTMLInputElement>('.mcp-ext-dialog input[type="url"]')!;
      input.value = url;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      container.querySelector<HTMLFormElement>(".mcp-ext-dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it("adds without a popup when no personal connection exists", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
      await submitAdd("https://docs.test/mcp");
      expect(open).not.toHaveBeenCalled();
    });

    it("shows a success toast naming the added server", async () => {
      vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
      await submitAdd("https://docs.test/mcp");
      expect(container.querySelector('[data-testid="toast-success"]')?.textContent).toContain("Added Docs.");
    });

    it("shows no success toast when the add fails", async () => {
      vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
      await submitAdd("https://docs.test/mcp", undefined, () => addMcpServerMock.mockRejectedValue(new Error("nope")));
      expect(container.querySelector('[data-testid="toast-success"]')).toBeNull();
      expect(container.querySelector(".mcp-ext-error")?.textContent).toContain("nope");
    });

    it("warns instead of adding a server whose URL is already configured", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
      await submitAdd("https://docs.test/mcp/", undefined, () => fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [
        { name: "docs", type: "http", url: "https://docs.test/mcp", auth: "none", state: "connected", readOnly: false },
      ] }));
      expect(addMcpServerMock).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="toast-warning"]')?.textContent).toContain("This MCP server has already been added.");
    });

    it("adds without a popup for team scope", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
      await submitAdd("https://docs.test/mcp", "team");
      expect(addMcpServerMock).toHaveBeenCalledWith("scribe", "https://docs.test/mcp", "team", "/agents/scribe/edit");
      expect(open).not.toHaveBeenCalled();
    });
  });

  it("marks an OAuth MCP server set up when only the team connection exists", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [
      { name: "docs", type: "http", auth: "oauth", state: "disconnected", personalState: "disconnected", teamState: "connected", readOnly: false },
    ] });
    await mountEdit("scribe");
    expect(container.querySelector('[aria-label="docs connected"]')).not.toBeNull();
  });

  it("uses the assigned fork for MCP status and add from a pool agent page", async () => {
    setSession("superadmin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchForksMock.mockResolvedValue([fork({ sourcePoolId: "scribe", forkAgentId: "scribe-fork" })]);
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [] });
    addMcpServerMock.mockResolvedValue({ server: { name: "docs" } });
    const popup = { close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    await mountEdit("scribe");
    expect(fetchMcpServersMock).toHaveBeenCalledWith("scribe-fork");

    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Add custom extension")!.click();
    const input = container.querySelector<HTMLInputElement>('.mcp-ext-dialog input[type="url"]')!;
    input.value = "https://docs.test/mcp";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLFormElement>(".mcp-ext-dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(addMcpServerMock).toHaveBeenCalledWith("scribe-fork", "https://docs.test/mcp", "personal", "/agents/scribe/edit");
  });

  it("loads a member's extension catalog from the runnable fork and links to it", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchPoolActionsMock.mockResolvedValue([{
      poolId: "scribe", action: "chat", chatAgentId: "scribe-fork",
      forked: true, reason: null, teamName: "Writers",
    }]);
    fetchAgentExtensionsMock.mockResolvedValue([{
      id: "notion", displayName: "Notion", description: "Notes", enabled: false, tier: "auto-form", requiredSecrets: [],
    }]);
    await mountEdit("scribe");
    expect(fetchAgentExtensionsMock).toHaveBeenCalledWith("scribe-fork", expect.any(Object));
    expect(container.querySelector<HTMLAnchorElement>(".edit-agent-ext-open")?.getAttribute("href")).toBe("/agents/scribe-fork/extensions/notion");
  });

  it("keeps MCP cards and Add visible when the extension catalog fails", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchPoolActionsMock.mockResolvedValue([{
      poolId: "scribe", action: "chat", chatAgentId: "scribe-fork",
      forked: true, reason: null, teamName: "Writers",
    }]);
    fetchAgentExtensionsMock.mockRejectedValue(new Error("forbidden"));
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [
      { name: "docs", type: "http", auth: "none", state: "connected", readOnly: true },
    ] });
    await mountEdit("scribe");
    expect(container.querySelector(".edit-agent-ext-name")?.textContent).toBe("Docs");
    expect(container.textContent).toContain("Failed to load extensions");
    expect(container.querySelector<HTMLButtonElement>(".mcp-ext-add-button")?.disabled).toBe(false);
  });

  it("opens the running fork directly from an MCP connect link", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe-fork", name: "Scribe" })]);
    await mountEdit("scribe-fork");
    expect(container.textContent).not.toContain("Agent not found");
    expect(container.querySelector(".edit-agent-name")?.textContent).toBe("Scribe");
    expect(fetchMcpServersMock).toHaveBeenCalledWith("scribe-fork");
    expect(container.querySelector<HTMLButtonElement>(".mcp-ext-add-button")?.disabled).toBe(false);
  });

  it("does not offer MCP mutation for an unforked pool agent", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    await mountEdit("scribe");
    expect(container.querySelector<HTMLButtonElement>(".mcp-ext-add-button")?.disabled).toBe(true);
    expect(fetchMcpServersMock).not.toHaveBeenCalled();
    // Neither extension fetch starts here, so the initial spinner must still end.
    expect(fetchAgentExtensionsMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Loading agent extensions");
  });
});
