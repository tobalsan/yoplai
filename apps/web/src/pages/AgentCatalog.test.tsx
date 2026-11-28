// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { queryAllByText } from "@testing-library/dom";
import type { Agent } from "../api/types";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  fetchAgentsMock,
  subscribeToRealtimeMock,
  fetchMainAgentPreferenceMock,
  saveMainAgentPreferenceMock,
  navigateMock,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  fetchMainAgentPreferenceMock: vi.fn(),
  saveMainAgentPreferenceMock: vi.fn(),
  fetchAgentsMock: vi.fn(),
  subscribeToRealtimeMock: vi.fn(() => () => undefined),
}));

vi.mock("../api", () => ({
  fetchAgents: fetchAgentsMock,
}));

vi.mock("../api/main-agent", () => ({
  fetchMainAgentPreference: fetchMainAgentPreferenceMock,
  saveMainAgentPreference: saveMainAgentPreferenceMock,
}));

vi.mock("../api/realtime-client", () => ({ subscribeToRealtime: subscribeToRealtimeMock }));

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
import { defaultAvatarUrl } from "../lib/default-avatar";
import { defaultAvatarSources } from "../lib/default-avatar.fixture";
import { refreshScheduleAlerts } from "../lib/schedule-alerts";
import {
  resetCapabilitiesForTests,
  setCapabilitiesForTests,
} from "../lib/capabilities";

// ── Helpers ───────────────────────────────────────────────────────────────────

function agent(id: string): Agent {
  return { id, name: id } as Agent;
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
  subscribeToRealtimeMock.mockReset();
  subscribeToRealtimeMock.mockReturnValue(() => undefined);
  setCapabilitiesForTests({ multiUser: true });
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

describe("AgentCatalog cards", () => {
  it("shows the role on an agent card and falls back to description for older agents", async () => {
    fetchAgentsMock.mockResolvedValue([
      { id: "harbor", name: "Harbor", description: "Plans dock arrivals.", role: "Dock Coordinator" },
      { id: "orchard", name: "Orchard", description: "Tracks growing conditions." },
    ]);
    await mountCatalog();

    expect(queryAllByText(container, "Harbor")).toHaveLength(1);
    expect(queryAllByText(container, "Dock Coordinator")).toHaveLength(1);
    expect(queryAllByText(container, "Tracks growing conditions.")).toHaveLength(1);
    expect(queryAllByText(container, "Plans dock arrivals.")).toHaveLength(0);
  });

  it("marks a remote agent card with its gateway and leaves a local card unmarked", async () => {
    fetchAgentsMock.mockResolvedValue([agent("pom"), { id: "pom@ams", name: "Pom (remote)", gateway: "ams" } as Agent]);
    await mountCatalog();
    const cards = Array.from(container.querySelectorAll(".catalog-card"));
    expect(cards).toHaveLength(2);
    expect(queryAllByText(cards[0] as HTMLElement, "@ams")).toHaveLength(0);
    expect(queryAllByText(cards[1] as HTMLElement, "@ams")).toHaveLength(1);
  });

  it("marks the agent card with a credential alert", async () => {
    fetchAgentsMock.mockResolvedValue([agent("scribe"), agent("helper")]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      agentId: "scribe", jobId: "digest", jobName: "Digest", mode: "owner",
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

  it("shows the default avatar on the card of an agent with no avatar", async () => {
    fetchAgentsMock.mockResolvedValue([agent("scribe")]);
    await mountCatalog();
    expect(defaultAvatarSources(container)).toContain(defaultAvatarUrl("scribe"));
  });

  it("rotates to a fresh non-main session key on every Chat click", async () => {
    fetchAgentsMock.mockResolvedValue([agent("scribe")]);
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

  it("shows Chat links for available agents in a multi-user gateway", async () => {
    setCapabilitiesForTests({ multiUser: true });
    fetchAgentsMock.mockResolvedValue([agent("local")]);
    await mountCatalog();

    expect(fetchAgentsMock).toHaveBeenCalledOnce();

    const chat = container.querySelector<HTMLAnchorElement>(
      ".catalog-chat-link"
    );
    expect(chat?.getAttribute("href")).toBe("/chat/local");
  });

  it("shows a team member an edit icon for a chattable agent", async () => {
    fetchAgentsMock.mockResolvedValue([agent("scribe")]);
    await mountCatalog();

    const edit = container.querySelector<HTMLAnchorElement>(".catalog-edit");
    expect(edit).not.toBeNull();
    expect(edit?.getAttribute("href")).toBe("/agents/scribe/edit");
  });

  it("refreshes visible agents when membership changes in realtime", async () => {
    setCapabilitiesForTests({ multiUser: true });
    fetchAgentsMock.mockResolvedValueOnce([agent("scribe")]).mockResolvedValueOnce([]);
    await mountCatalog();
    expect(container.querySelector('a[href="/chat/scribe"]')).not.toBeNull();
    const calls = subscribeToRealtimeMock.mock.calls as unknown as Array<[
      { onEvent: (event: { type: string; projectId?: string }) => void }
    ]>;
    const options = calls[0]?.[0];
    if (!options) throw new Error("expected realtime subscription");
    options.onEvent({ type: "agent_changed", projectId: "membership" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('a[href="/chat/scribe"]')).toBeNull();
  });

  it("closes its realtime subscription when unmounted", async () => {
    const unsubscribe = vi.fn();
    subscribeToRealtimeMock.mockReturnValue(unsubscribe);
    fetchAgentsMock.mockResolvedValue([agent("scribe")]);
    await mountCatalog();
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("AgentCatalog card click", () => {
  it("opens a chat with the agent from anywhere on the card except its icons", async () => {
    navigateMock.mockReset();
    fetchAgentsMock.mockResolvedValue([agent("scribe")]);
    fetchMainAgentPreferenceMock.mockResolvedValue({ mainAgentId: null, accessible: false, pickerDismissedAt: null });
    await mountCatalog();

    container.querySelector<HTMLButtonElement>('button[aria-label="Make scribe your main agent"]')!.click();
    expect(navigateMock).not.toHaveBeenCalled();
    Array.from(container.querySelectorAll("div")).find((node) => node.textContent === "scribe")!.click();
    expect(navigateMock).toHaveBeenCalledWith("/chat/scribe");
  });

});

describe("AgentCatalog main agent", () => {
  const byLabel = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const buttonText = (text: string) => Array.from(container.ownerDocument.querySelectorAll("button")).find((b) => b.textContent === text)!;

  async function mountWithMain(mainAgentId: string | null) {
    fetchAgentsMock.mockResolvedValue([agent("alpha"), agent("beta"), agent("gamma")]);
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
