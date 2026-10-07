// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { Agent } from "../api/types";
import type { AgentDashboard } from "../api/agents";
import type { AgentFork, Team } from "../api/teams";

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
  fetchAgentExtensionsMock,
  patchAgentExtensionMock,
  useSessionMock,
  useParamsMock,
  navigateMock,
} = vi.hoisted(() => ({
  fetchPoolMock: vi.fn(),
  fetchAgentsMock: vi.fn(),
  fetchAgentDashboardsMock: vi.fn(),
  fetchSchedulesMock: vi.fn(),
  fetchPoolActionsMock: vi.fn(),
  fetchTeamsMock: vi.fn(),
  fetchForksMock: vi.fn(),
  setForkTeamsMock: vi.fn(),
  fetchAgentExtensionsMock: vi.fn(),
  patchAgentExtensionMock: vi.fn(),
  useSessionMock: vi.fn(),
  useParamsMock: vi.fn(),
  navigateMock: vi.fn(),
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

vi.mock("../api/schedules", () => ({
  fetchSchedules: fetchSchedulesMock,
  updateSchedule: vi.fn(),
}));

vi.mock("../api/teams", () => ({
  fetchTeams: fetchTeamsMock,
  fetchForks: fetchForksMock,
  fetchPoolActions: fetchPoolActionsMock,
  setForkTeams: setForkTeamsMock,
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
  A: (props: { href: string; class?: string; children: unknown }) => {
    const a = document.createElement("a");
    a.setAttribute("href", props.href);
    if (props.class) a.className = props.class;
    appendChildren(a, props.children);
    return a;
  },
  useParams: () => useParamsMock(),
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

async function mountEdit(agentId: string) {
  useParamsMock.mockReturnValue({ agentId });
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
  setCapabilitiesForTests({ forkedAgents: true });
  fetchPoolMock.mockReset();
  fetchAgentsMock.mockReset().mockResolvedValue([]);
  fetchAgentDashboardsMock.mockReset().mockResolvedValue([]);
  fetchSchedulesMock.mockReset().mockResolvedValue([]);
  fetchPoolActionsMock.mockReset().mockResolvedValue([]);
  fetchTeamsMock.mockReset().mockResolvedValue([] as Team[]);
  fetchForksMock.mockReset().mockResolvedValue([] as AgentFork[]);
  fetchAgentExtensionsMock.mockReset().mockResolvedValue([]);
  patchAgentExtensionMock.mockReset();
  setForkTeamsMock.mockReset();
  useSessionMock.mockReset();
  useParamsMock.mockReset();
  navigateMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  container.remove();
  resetCapabilitiesForTests();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("EditAgent", () => {
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
    fetchAgentExtensionsMock.mockResolvedValue([]);
    await mountEdit("scribe");

    expect(navigateMock).not.toHaveBeenCalledWith("/", { replace: true });
    expect(container.querySelector(".edit-agent")).not.toBeNull();
    expect(fetchAgentExtensionsMock).toHaveBeenCalledWith("scribe");
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
    expect(container.textContent).toContain("report.html");
    expect(container.textContent).toContain("Updated");
    expect(container.querySelector<HTMLAnchorElement>(".edit-agent-dashboard a")?.getAttribute("href")).toBe("https://yoplai.test/d/stable-link");
    container.querySelector<HTMLButtonElement>(".edit-agent-dashboard button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeText).toHaveBeenCalledWith("https://yoplai.test/d/stable-link");
  });

  it("nests parameter dashboards under every parent, stops cycles, and lists unreachable dashboards", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent({ id: "scribe" })]);
    const dashboard = (slug: string, params: string[], linksTo: string[]) => ({
      title: slug, slug: `${slug}.html`, params, linksTo: linksTo.map((link) => `${link}.html`),
      updatedAt: "2026-09-25T10:00:00.000Z", link: `/d/${slug}`,
    });
    fetchAgentDashboardsMock.mockResolvedValue([
      dashboard("clients", [], ["client", "csm", "missing"]),
      dashboard("csm", [], ["client"]),
      dashboard("client", ["id"], ["qbr", "clients", "client"]),
      dashboard("qbr", ["id"], ["client"]),
      dashboard("orphan", ["name"], ["orphan-child"]),
      dashboard("orphan-child", ["id"], ["orphan"]),
    ]);
    await mountEdit("scribe");
    openTab("Dashboards");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const panel = container.querySelector(".edit-agent-dashboards")!;
    const roots = panel.querySelectorAll(":scope > ul:first-of-type > li");
    expect(roots).toHaveLength(2);
    for (const root of roots) {
      expect(root.querySelector(":scope > .edit-agent-dashboard-row strong")?.textContent)
        .toMatch(/^(clients|csm)$/);
      const child = root.querySelector(":scope > ul > li")!;
      expect(child.querySelector(":scope > .edit-agent-dashboard-row strong")?.textContent).toBe("client");
      expect(child.querySelectorAll("li")).toHaveLength(1);
      expect(child.querySelector(":scope > ul > li > .edit-agent-dashboard-row strong")?.textContent).toBe("qbr");
      expect(child.querySelector("a, button")).toBeNull();
      expect(child.textContent).toContain("Opened from within the parent dashboard.");
      expect(child.textContent).toContain("client.html");
      expect(child.textContent).not.toContain("Updated");
    }
    expect(panel.querySelectorAll("a")).toHaveLength(2);
    expect(panel.querySelectorAll("button")).toHaveLength(2);
    expect(panel.querySelector("h2")?.textContent).toBe("Needs parameters");
    const orphans = panel.querySelectorAll(":scope > ul:last-of-type > li");
    expect(orphans).toHaveLength(2);
    for (const orphan of orphans) {
      expect(orphan.textContent).toContain("Opened from another dashboard with parameters.");
      expect(orphan.querySelector("a, button")).toBeNull();
    }
  });

  it("shows Needs parameters when no dashboard can be opened without arguments", async () => {
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
    expect(panel.textContent).toContain("Needs parameters");
    expect(panel.textContent).toContain("Client");
    expect(panel.querySelector("a, button")).toBeNull();
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

  it("keeps tabs usable during a pending dashboard request and renders the tree when it resolves", async () => {
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
      { title: "Clients", slug: "clients.html", params: [], linksTo: ["client.html"], updatedAt: "2026-09-25T10:00:00.000Z", link: "/d/clients" },
      { title: "Client", slug: "client.html", params: ["id"], linksTo: [], updatedAt: "2026-09-25T10:00:00.000Z", link: "/d/client" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).not.toContain("Loading dashboards…");
    const child = container.querySelector(".edit-agent-dashboard-children > li")!;
    expect(child.textContent).toContain("Client");
    expect(child.querySelector("a, button")).toBeNull();
    expect(container.querySelector(".edit-agent-dashboard-actions a")?.getAttribute("href")).toBe("/d/clients");
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

  it("sets explicit teams for a never-forked agent", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchForksMock.mockResolvedValue([]);
    fetchTeamsMock.mockResolvedValue([{ id: "t1", name: "Red" } as Team]);
    setForkTeamsMock.mockResolvedValue(fork({ sourcePoolId: "scribe", teamId: "t1" }));
    await mountEdit("scribe");

    const section = container.querySelector(".edit-agent-team");
    expect(section).not.toBeNull();

    const pill = container.querySelectorAll<HTMLButtonElement>(".edit-agent-team-pill")[1]!;
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
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchForksMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([fork({ sourcePoolId: "scribe", teamId: "t1" })]);
    fetchTeamsMock.mockResolvedValue([{ id: "t1", name: "Red" } as Team]);
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

    container.querySelectorAll<HTMLButtonElement>(".edit-agent-team-pill")[1]!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector<HTMLButtonElement>(".edit-agent-team-button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchAgentExtensionsMock).toHaveBeenCalledTimes(2);
  });

  it("replaces an already-forked agent's explicit team list", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchForksMock.mockResolvedValue([
      fork({ sourcePoolId: "scribe", teamId: "t1" }),
    ]);
    fetchTeamsMock.mockResolvedValue([
      { id: "t1", name: "Red" } as Team,
      { id: "t2", name: "Blue" } as Team,
    ]);
    setForkTeamsMock.mockResolvedValue(fork({ sourcePoolId: "scribe", teamId: "t2" }));
    await mountEdit("scribe");

    const section = container.querySelector(".edit-agent-team");
    const pills = container.querySelectorAll<HTMLButtonElement>(".edit-agent-team-pill");
    expect(pills[1]!.classList.contains("selected")).toBe(true);
    expect(section?.textContent).toContain("Red");

    pills[1]!.click();
    pills[2]!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const button = container.querySelector<HTMLButtonElement>(
      ".edit-agent-team-button"
    )!;
    expect(button.textContent).toBe("Save");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setForkTeamsMock).toHaveBeenCalledWith("scribe", { mode: "list", teamIds: ["t2"] });
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
    expect(checked).toEqual(["CRM configured", "Exa configured", "Notion configured", "Gmail configured"]);
    const adds = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("a.edit-agent-ext-add")
    ).map((el) => el.getAttribute("href"));
    expect(adds).toEqual([
      "/agents/scribe/extensions/mailer",
      "/agents/scribe/extensions/jira",
      "/agents/scribe/extensions/drive",
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
      id: "mcp",
      displayName: "MCP",
      description: "File-based MCP config",
      builtIn: false,
      enabled: true,
      configured: false,
      missingConfig: ["servers"],
      configJsonSchema: null,
      requiredSecrets: [],
      advancedConfigFields: [],
      configRoutePath: "/agents/scribe/extensions/mcp/configure",
      tier: "bespoke-route",
    }]);
    await mountEdit("scribe");

    expect(container.querySelector<HTMLAnchorElement>(".edit-agent-ext-open")?.getAttribute("href"))
      .toBe("/agents/scribe/extensions/mcp/configure");
  });

  it("does not render team controls for a non-admin", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([]);
    await mountEdit("scribe");

    expect(container.querySelector(".edit-agent-team")).toBeNull();
  });
});
