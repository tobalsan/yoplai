// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { Agent } from "../api/types";
import type { AgentFork, Team } from "../api/teams";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  fetchPoolMock,
  fetchAgentsMock,
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
}));

vi.mock("../api/extensions", () => ({
  fetchAgentExtensions: fetchAgentExtensionsMock,
  patchAgentExtension: patchAgentExtensionMock,
  autoFormPath: (agentId: string, extensionId: string) =>
    `/agents/${agentId}/extensions/${extensionId}/config`,
  detailsPath: (agentId: string, extensionId: string) =>
    `/agents/${agentId}/extensions/${extensionId}`,
}));

vi.mock("../api/teams", () => ({
  fetchTeams: fetchTeamsMock,
  fetchForks: fetchForksMock,
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

beforeEach(() => {
  setCapabilitiesForTests({ forkedAgents: true });
  fetchPoolMock.mockReset();
  fetchAgentsMock.mockReset().mockResolvedValue([]);
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

    const toggle = container.querySelector<HTMLButtonElement>(
      ".edit-agent-ext-item button.edit-agent-ext-state"
    )!;
    expect(toggle.disabled).toBe(true);

    container.querySelectorAll<HTMLButtonElement>(".edit-agent-team-pill")[1]!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector<HTMLButtonElement>(".edit-agent-team-button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchAgentExtensionsMock).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector<HTMLButtonElement>(
        ".edit-agent-ext-item button.edit-agent-ext-state"
      )?.disabled
    ).toBe(false);
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

  it("lists extensions with on/off toggle state for an admin", async () => {
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
      {
        id: "mailer",
        displayName: "Mailer",
        description: "Email tools",
        builtIn: true,
        enabled: false,
        configJsonSchema: null,
        requiredSecrets: [],
        tier: "toggle-only",
      },
    ]);
    await mountEdit("scribe");

    expect(fetchAgentExtensionsMock).toHaveBeenCalledWith("scribe");
    const items = container.querySelectorAll(".edit-agent-ext-item");
    expect(items.length).toBe(2);

    const names = Array.from(
      container.querySelectorAll(".edit-agent-ext-name")
    ).map((el) => el.textContent);
    expect(names).toEqual(["CRM", "Mailer"]);

    // The state is a clickable switch reflecting enabled via aria-checked.
    const toggles = container.querySelectorAll<HTMLButtonElement>(
      ".edit-agent-ext-item button.edit-agent-ext-state"
    );
    expect(toggles.length).toBe(2);
    expect(toggles[0].getAttribute("role")).toBe("switch");
    expect(toggles[0].getAttribute("aria-checked")).toBe("true");
    expect(toggles[0].getAttribute("aria-label")).toBe("Enable CRM");
    expect(toggles[1].getAttribute("aria-checked")).toBe("false");
    expect(toggles[1].getAttribute("aria-label")).toBe("Enable Mailer");
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
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("/agents/scribe/extensions/crm");
    // The name/desc still render inside the link, and the toggle stays a
    // separate sibling so clicking it never navigates.
    expect(link.querySelector(".edit-agent-ext-name")?.textContent).toBe(
      "CRM"
    );
    expect(link.contains(container.querySelector(".edit-agent-ext-state"))).toBe(
      false
    );
  });

  it("toggles an extension and persists via patchAgentExtension", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([
      {
        id: "crm",
        displayName: "CRM",
        description: "CRM tools",
        builtIn: false,
        enabled: false,
        configJsonSchema: null,
        requiredSecrets: [],
        tier: "toggle-only",
      },
    ]);
    // Server returns the refreshed catalog with the flipped state.
    patchAgentExtensionMock.mockResolvedValue([
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

    const toggle = container.querySelector<HTMLButtonElement>(
      ".edit-agent-ext-item button.edit-agent-ext-state"
    )!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "crm", {
      enabled: true,
    });
    // UI reflects the server-confirmed state.
    const after = container.querySelector<HTMLButtonElement>(
      ".edit-agent-ext-item button.edit-agent-ext-state"
    )!;
    expect(after.getAttribute("aria-checked")).toBe("true");
  });

  it("locks root-managed extensions without sending a patch", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([
      {
        id: "slack",
        displayName: "Slack",
        description: "Slack channel",
        builtIn: true,
        enabled: true,
        configurable: true,
        managedAtRoot: true,
        configJsonSchema: null,
        requiredSecrets: [],
        advancedConfigFields: [],
        configValues: {},
        configRoutePath: null,
        tier: "toggle-only",
      },
    ]);
    await mountEdit("scribe");

    const toggle = container.querySelector<HTMLButtonElement>(
      ".edit-agent-ext-item button.edit-agent-ext-state"
    )!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.disabled).toBe(true);
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(patchAgentExtensionMock).not.toHaveBeenCalled();
  });

  it("disables extension enable toggles until a fork exists", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([
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
    ]);
    await mountEdit("scribe");

    const toggle = container.querySelector<HTMLButtonElement>(
      ".edit-agent-ext-item button.edit-agent-ext-state"
    )!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe(
      "The agent must be assigned to a team to enable this extension"
    );

    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(patchAgentExtensionMock).not.toHaveBeenCalled();
  });

  it("shows a missing-folder tooltip when a fork row exists without an agent", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchForksMock.mockResolvedValue([
      fork({ sourcePoolId: "scribe", teamId: "t1" }),
    ]);
    fetchAgentExtensionsMock.mockResolvedValue([
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
    ]);
    await mountEdit("scribe");

    const toggle = container.querySelector<HTMLButtonElement>(
      ".edit-agent-ext-item button.edit-agent-ext-state"
    )!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe("Agent folder missing");
  });

  it("redirects to the bespoke config route when enabling a bespoke-route extension", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([
      {
        id: "mcp",
        displayName: "MCP",
        description: "File-based MCP config",
        builtIn: false,
        enabled: false,
        configJsonSchema: null,
        requiredSecrets: [],
        advancedConfigFields: [],
        configRoutePath: "/agents/scribe/extensions/mcp",
        tier: "bespoke-route",
      },
    ]);
    patchAgentExtensionMock.mockResolvedValue([
      {
        id: "mcp",
        displayName: "MCP",
        description: "File-based MCP config",
        builtIn: false,
        enabled: true,
        configJsonSchema: null,
        requiredSecrets: [],
        advancedConfigFields: [],
        configRoutePath: "/agents/scribe/extensions/mcp",
        tier: "bespoke-route",
      },
    ]);
    await mountEdit("scribe");

    container
      .querySelector<HTMLButtonElement>(
        ".edit-agent-ext-item button.edit-agent-ext-state"
      )!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "mcp", {
      enabled: true,
    });
    expect(navigateMock).toHaveBeenCalledWith("/agents/scribe/extensions/mcp");
  });

  it("redirects to the auto-form path when enabling an auto-form extension", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    const entry = {
      id: "exa",
      displayName: "Exa",
      description: "Search",
      builtIn: true,
      configJsonSchema: {
        type: "object",
        properties: { apiKey: { type: "string" } },
      },
      requiredSecrets: ["apiKey"],
      advancedConfigFields: [],
      configRoutePath: null,
      tier: "auto-form" as const,
    };
    fetchAgentExtensionsMock.mockResolvedValue([{ ...entry, enabled: false }]);
    patchAgentExtensionMock.mockResolvedValue([{ ...entry, enabled: true }]);
    await mountEdit("scribe");

    container
      .querySelector<HTMLButtonElement>(
        ".edit-agent-ext-item button.edit-agent-ext-state"
      )!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "exa", {
      enabled: true,
    });
    expect(navigateMock).toHaveBeenCalledWith(
      "/agents/scribe/extensions/exa/config"
    );
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
    expect(link.getAttribute("href")).toBe("/agents/scribe/extensions/exa/config");
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

  it("disables a needs-configuration extension inline", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    const entry = {
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
      tier: "auto-form" as const,
    };
    fetchAgentExtensionsMock.mockResolvedValue([entry]);
    patchAgentExtensionMock.mockResolvedValue([{ ...entry, enabled: false }]);
    await mountEdit("scribe");

    container.querySelector<HTMLButtonElement>(".edit-agent-ext-state")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "exa", {
      enabled: false,
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("flips a toggle-only extension inline with no redirect", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    const entry = {
      id: "crm",
      displayName: "CRM",
      description: "CRM tools",
      builtIn: false,
      configJsonSchema: null,
      requiredSecrets: [],
      advancedConfigFields: [],
      configRoutePath: null,
      tier: "toggle-only" as const,
    };
    fetchAgentExtensionsMock.mockResolvedValue([{ ...entry, enabled: false }]);
    patchAgentExtensionMock.mockResolvedValue([{ ...entry, enabled: true }]);
    await mountEdit("scribe");

    container
      .querySelector<HTMLButtonElement>(
        ".edit-agent-ext-item button.edit-agent-ext-state"
      )!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "crm", {
      enabled: true,
    });
    // Toggle-only never redirects into a config surface.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("does not redirect when disabling a bespoke-route extension", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    const entry = {
      id: "mcp",
      displayName: "MCP",
      description: "File-based MCP config",
      builtIn: false,
      configJsonSchema: null,
      requiredSecrets: [],
      advancedConfigFields: [],
      configRoutePath: "/agents/scribe/extensions/mcp",
      tier: "bespoke-route" as const,
    };
    fetchAgentExtensionsMock.mockResolvedValue([{ ...entry, enabled: true }]);
    patchAgentExtensionMock.mockResolvedValue([{ ...entry, enabled: false }]);
    await mountEdit("scribe");

    container
      .querySelector<HTMLButtonElement>(
        ".edit-agent-ext-item button.edit-agent-ext-state"
      )!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "mcp", {
      enabled: false,
    });
    // Turning a config surface off must not redirect into it.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("shows an error when a toggle fails to persist", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([
      {
        id: "crm",
        displayName: "CRM",
        description: "CRM tools",
        builtIn: false,
        enabled: false,
        configJsonSchema: null,
        requiredSecrets: [],
        tier: "toggle-only",
      },
    ]);
    patchAgentExtensionMock.mockRejectedValue(new Error("nope"));
    await mountEdit("scribe");

    container
      .querySelector<HTMLButtonElement>(
        ".edit-agent-ext-item button.edit-agent-ext-state"
      )!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector(".edit-agent-ext-error")?.textContent).toBe(
      "nope"
    );
    // State stays off since the write failed.
    expect(
      container
        .querySelector(".edit-agent-ext-item button.edit-agent-ext-state")
        ?.getAttribute("aria-checked")
    ).toBe("false");
  });

  it("does not render team controls for a non-admin", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent({ id: "scribe" })]);
    fetchAgentExtensionsMock.mockResolvedValue([]);
    await mountEdit("scribe");

    expect(container.querySelector(".edit-agent-team")).toBeNull();
  });
});
