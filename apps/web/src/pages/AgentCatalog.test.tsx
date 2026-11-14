// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { queryAllByText } from "@testing-library/dom";
import type { Agent } from "../api/types";
import type { PoolCatalogEntry } from "../api/teams";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  fetchAgentsMock,
  fetchPoolMock,
  fetchPoolActionsMock,
  subscribeToRealtimeMock,
  useSessionMock,
  fetchMainAgentPreferenceMock,
  saveMainAgentPreferenceMock,
  navigateMock,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  fetchMainAgentPreferenceMock: vi.fn(),
  saveMainAgentPreferenceMock: vi.fn(),
  fetchAgentsMock: vi.fn(),
  fetchPoolMock: vi.fn(),
  fetchPoolActionsMock: vi.fn(),
  subscribeToRealtimeMock: vi.fn(() => () => undefined),
  useSessionMock: vi.fn(),
}));

vi.mock("../api", () => ({
  fetchAgents: fetchAgentsMock,
  fetchPool: fetchPoolMock,
}));

vi.mock("../api/main-agent", () => ({
  fetchMainAgentPreference: fetchMainAgentPreferenceMock,
  saveMainAgentPreference: saveMainAgentPreferenceMock,
}));

vi.mock("../api/teams", () => ({
  fetchPoolActions: fetchPoolActionsMock,
}));
vi.mock("../api/realtime-client", () => ({ subscribeToRealtime: subscribeToRealtimeMock }));

vi.mock("../auth/client", () => ({ useSession: useSessionMock }));

vi.mock("@solidjs/router", () => ({
  A: (props: {
    href: string;
    class?: string;
    children: unknown;
    onClick?: (e: MouseEvent) => void;
  }) => {
    const a = document.createElement("a");
    a.setAttribute("href", props.href);
    if (props.class) a.className = props.class;
    a.textContent = String(props.children ?? "");
    if (props.onClick) {
      a.addEventListener("click", (e) => props.onClick!(e as MouseEvent));
    }
    return a;
  },
  useNavigate: () => navigateMock,
}));

import { AgentCatalog } from "./AgentCatalog";
import { refreshScheduleAlerts } from "../lib/schedule-alerts";
import {
  resetCapabilitiesForTests,
  setCapabilitiesForTests,
} from "../lib/capabilities";

// ── Helpers ───────────────────────────────────────────────────────────────────

function agent(id: string): Agent {
  return { id, name: id } as Agent;
}

function entry(
  poolId: string,
  action: PoolCatalogEntry["action"],
  chatAgentId: string | null = action === "chat" ? poolId : null,
  overrides: Partial<Pick<PoolCatalogEntry, "reason" | "teamName">> = {}
): PoolCatalogEntry {
  return {
    poolId,
    forked: action !== "assign_to_team",
    chatAgentId,
    action,
    reason: overrides.reason ?? (action === "none" ? "unassigned" : null),
    teamName: overrides.teamName ?? null,
  };
}

function setSession(role: string | null) {
  useSessionMock.mockReturnValue(() => ({
    data: role ? { user: { role } } : { user: {} },
  }));
}

let container: HTMLElement;
let dispose: () => void;

async function mountCatalog() {
  dispose = render(() => <AgentCatalog />, container);
  // Let the createResource promises resolve + render.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  fetchAgentsMock.mockReset();
  fetchPoolMock.mockReset();
  fetchPoolActionsMock.mockReset();
  subscribeToRealtimeMock.mockReset();
  subscribeToRealtimeMock.mockReturnValue(() => undefined);
  setCapabilitiesForTests({ forkedAgents: true });
  useSessionMock.mockReset();
  fetchMainAgentPreferenceMock.mockReset();
  fetchMainAgentPreferenceMock.mockResolvedValue({ mainAgentId: null, accessible: false, pickerDismissedAt: null });
  saveMainAgentPreferenceMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  container.remove();
  resetCapabilitiesForTests();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AgentCatalog action states", () => {
  it("marks a remote agent card with its gateway and leaves a local card unmarked", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent("pom"), { id: "pom@ams", name: "Pom (remote)", gateway: "ams" } as Agent]);
    fetchPoolActionsMock.mockResolvedValue([entry("pom", "chat"), entry("pom@ams", "chat")]);
    await mountCatalog();
    const cards = Array.from(container.querySelectorAll(".catalog-card"));
    expect(cards).toHaveLength(2);
    expect(queryAllByText(cards[0] as HTMLElement, "@ams")).toHaveLength(0);
    expect(queryAllByText(cards[1] as HTMLElement, "@ams")).toHaveLength(1);
  });

  it("marks the pool card whose chat fork has a credential alert", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent("scribe"), agent("helper")]);
    fetchPoolActionsMock.mockResolvedValue([entry("scribe", "chat", "scribe-fork"), entry("helper", "chat", "helper-fork")]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      agentId: "scribe-fork", jobId: "digest", jobName: "Digest", mode: "owner",
      pausedReason: { kind: "credentials", integration: "Acme Mail", at: "2026-11-07T12:00:00Z" },
    }])));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await refreshScheduleAlerts();
      await mountCatalog();
      const cards = container.querySelectorAll(".catalog-card");
      expect(cards[0]?.querySelector('[aria-label="Jobs paused for credentials"]')).not.toBeNull();
      expect(cards[1]?.querySelector('[aria-label="Jobs paused for credentials"]')).toBeNull();
    } finally {
      fetchMock.mockResolvedValue(new Response("[]"));
      await refreshScheduleAlerts();
      vi.unstubAllGlobals();
    }
  });

  it("shows a Chat link routed to the fork agent id when action is chat", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent("scribe")]);
    fetchPoolActionsMock.mockResolvedValue([entry("scribe", "chat")]);
    await mountCatalog();

    const chat = container.querySelector<HTMLAnchorElement>(
      ".catalog-chat-link"
    );
    expect(chat).not.toBeNull();
    expect(chat?.getAttribute("href")).toBe("/chat/scribe");
  });

  it("rotates to a fresh non-main session key on every Chat click", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent("scribe")]);
    fetchPoolActionsMock.mockResolvedValue([entry("scribe", "chat")]);
    await mountCatalog();

    const chat = container.querySelector<HTMLAnchorElement>(
      ".catalog-chat-link"
    );
    expect(chat).not.toBeNull();
    localStorage.setItem("yoplai:sessionKey:scribe", "main");

    chat!.click();
    const first = localStorage.getItem("yoplai:sessionKey:scribe");
    expect(first).not.toBe("main");
    expect(first).toMatch(/^web-/);

    chat!.click();
    expect(localStorage.getItem("yoplai:sessionKey:scribe")).not.toBe(first);
  });

  it("uses runnable agents directly when forked-agent mode is disabled", async () => {
    setCapabilitiesForTests({ forkedAgents: false });
    setSession("user");
    fetchAgentsMock.mockResolvedValue([agent("local")]);
    await mountCatalog();

    expect(fetchAgentsMock).toHaveBeenCalledOnce();
    expect(fetchPoolMock).not.toHaveBeenCalled();
    expect(fetchPoolActionsMock).not.toHaveBeenCalled();

    const chat = container.querySelector<HTMLAnchorElement>(
      ".catalog-chat-link"
    );
    expect(chat?.getAttribute("href")).toBe("/chat/local");
  });

  it("hides agents a non-admin cannot chat", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent("scout"), agent("scribe"), agent("helper")]);
    fetchPoolActionsMock.mockResolvedValue([
      entry("scout", "none"),
      entry("scribe", "none", null, { reason: "other_team", teamName: "Green" }),
      entry("helper", "chat"),
    ]);
    await mountCatalog();

    expect(container.querySelectorAll(".catalog-card")).toHaveLength(1);
    expect(container.textContent).not.toContain("Green");
    expect(container.querySelector(".catalog-unavailable")).toBeNull();
  });

  it("hides agents an admin cannot chat but keeps unforked agents to assign", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent("private"), agent("orphan"), agent("broken"), agent("fresh"), agent("helper")]);
    fetchPoolActionsMock.mockResolvedValue([
      entry("private", "none", null, { reason: "other_team" }),
      entry("orphan", "none", null, { reason: "unassigned" }),
      entry("broken", "none", null, { reason: "no_workspace" }),
      entry("fresh", "assign_to_team"),
      entry("helper", "chat"),
    ]);
    await mountCatalog();

    expect(container.querySelectorAll(".catalog-card")).toHaveLength(2);
    expect(container.textContent).toContain("This agent has not been assigned to a team.");
    expect(container.textContent).not.toContain("This agent has no workspace.");
  });

  it("shows the no-workspace message for a superadmin on a broken fork", async () => {
    setSession("superadmin");
    fetchPoolMock.mockResolvedValue([agent("scribe")]);
    fetchPoolActionsMock.mockResolvedValue([
      entry("scribe", "none", null, { reason: "no_workspace", teamName: "Red" }),
    ]);
    await mountCatalog();

    expect(container.textContent).toContain("This agent has no workspace.");
  });

  it("no longer renders inline team assign/move controls", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent("fresh")]);
    fetchPoolActionsMock.mockResolvedValue([entry("fresh", "assign_to_team")]);
    await mountCatalog();

    // Team assignment moved to the Edit-Agent page; cards have no picker.
    expect(container.querySelector(".catalog-assign")).toBeNull();
    expect(container.textContent).not.toContain("Assign to team");
    expect(container.textContent).not.toContain("Move to team");
  });

  it("shows the unassigned message for an admin's assign_to_team card", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent("fresh")]);
    fetchPoolActionsMock.mockResolvedValue([entry("fresh", "assign_to_team")]);
    await mountCatalog();

    expect(container.querySelector(".catalog-unavailable")).not.toBeNull();
    expect(container.textContent).toContain(
      "This agent has not been assigned to a team."
    );
  });

  it("shows an admin an edit icon linking to the agent's edit route", async () => {
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent("scribe")]);
    fetchPoolActionsMock.mockResolvedValue([entry("scribe", "chat")]);
    await mountCatalog();

    const edit = container.querySelector<HTMLAnchorElement>(".catalog-edit");
    expect(edit).not.toBeNull();
    expect(edit?.getAttribute("href")).toBe("/agents/scribe/edit");
  });

  it("shows a team member an edit icon for a chattable agent", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent("scribe")]);
    fetchPoolActionsMock.mockResolvedValue([entry("scribe", "chat")]);
    await mountCatalog();

    const edit = container.querySelector<HTMLAnchorElement>(".catalog-edit");
    expect(edit).not.toBeNull();
    expect(edit?.getAttribute("href")).toBe("/agents/scribe/edit");
  });

  it("refreshes access actions when membership changes in realtime", async () => {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent("scribe")]);
    fetchPoolActionsMock.mockResolvedValue([entry("scribe", "none")]);
    await mountCatalog();
    const calls = subscribeToRealtimeMock.mock.calls as unknown as Array<[
      { onEvent: (event: { type: string; projectId?: string }) => void }
    ]>;
    const options = calls[0]?.[0];
    if (!options) throw new Error("expected realtime subscription");
    options.onEvent({ type: "agent_changed", projectId: "membership" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchPoolActionsMock).toHaveBeenCalledTimes(2);
  });

  it("closes its realtime subscription when unmounted", async () => {
    const unsubscribe = vi.fn();
    subscribeToRealtimeMock.mockReturnValue(unsubscribe);
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent("scribe")]);
    fetchPoolActionsMock.mockResolvedValue([entry("scribe", "chat")]);
    await mountCatalog();
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("AgentCatalog card click", () => {
  it("opens a chat with the fork agent from anywhere on the card except its icons", async () => {
    navigateMock.mockReset();
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent("scribe")]);
    fetchPoolActionsMock.mockResolvedValue([entry("scribe", "chat", "scribe-fork")]);
    fetchMainAgentPreferenceMock.mockResolvedValue({ mainAgentId: null, accessible: false, pickerDismissedAt: null });
    await mountCatalog();

    container.querySelector<HTMLButtonElement>('button[aria-label="Make scribe your main agent"]')!.click();
    expect(navigateMock).not.toHaveBeenCalled();
    Array.from(container.querySelectorAll("div")).find((node) => node.textContent === "scribe")!.click();
    expect(navigateMock).toHaveBeenCalledWith("/chat/scribe-fork");
  });

  it("does not open a chat from a card the user cannot chat", async () => {
    navigateMock.mockReset();
    setSession("admin");
    fetchPoolMock.mockResolvedValue([agent("scribe")]);
    fetchPoolActionsMock.mockResolvedValue([entry("scribe", "assign_to_team")]);
    await mountCatalog();

    Array.from(container.querySelectorAll("div")).find((node) => node.textContent === "scribe")!.click();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});

describe("AgentCatalog main agent", () => {
  const byLabel = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const buttonText = (text: string) => Array.from(container.ownerDocument.querySelectorAll("button")).find((b) => b.textContent === text)!;

  async function mountWithMain(mainAgentId: string | null) {
    setSession("user");
    fetchPoolMock.mockResolvedValue([agent("alpha"), agent("beta"), agent("gamma")]);
    fetchPoolActionsMock.mockResolvedValue([entry("alpha", "chat"), entry("beta", "chat"), entry("gamma", "chat")]);
    fetchMainAgentPreferenceMock.mockResolvedValue({ mainAgentId, accessible: !!mainAgentId, pickerDismissedAt: null });
    await mountCatalog();
  }

  it("lists the main agent first and marks its star pressed", async () => {
    await mountWithMain("gamma");
    const names = Array.from(container.querySelectorAll("button[aria-label$='your main agent']"))
      .map((star) => star.getAttribute("aria-label")!.replace(/^Make | is your main agent$| your main agent$/g, ""));
    expect(names).toEqual(["gamma", "alpha", "beta"]);
    expect(byLabel("gamma is your main agent")?.getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("Make alpha your main agent")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("saves a new main agent only after confirming", async () => {
    await mountWithMain("gamma");
    saveMainAgentPreferenceMock.mockResolvedValue({ mainAgentId: "beta", accessible: true, pickerDismissedAt: null });
    byLabel("Make beta your main agent")!.click();
    expect(document.body.textContent).toContain("Make beta your main agent?");
    expect(saveMainAgentPreferenceMock).not.toHaveBeenCalled();
    buttonText("Make main agent").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveMainAgentPreferenceMock).toHaveBeenCalledWith({ mainAgentId: "beta" });
    expect(document.body.textContent).not.toContain("Make beta your main agent?");
    expect(byLabel("beta is your main agent")).not.toBeNull();
  });

  it("does not save when the confirmation is cancelled", async () => {
    await mountWithMain("gamma");
    byLabel("Make alpha your main agent")!.click();
    buttonText("Cancel").click();
    expect(saveMainAgentPreferenceMock).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Make alpha your main agent?");
  });

  it("keeps the confirmation open and shows the error when saving fails", async () => {
    await mountWithMain("gamma");
    saveMainAgentPreferenceMock.mockRejectedValue(new Error("Could not save your main agent. Try again."));
    byLabel("Make alpha your main agent")!.click();
    buttonText("Make main agent").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).toContain("Make alpha your main agent?");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not save your main agent");
  });
});
