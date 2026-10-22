// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Route, Router, useParams } from "@solidjs/router";
import type { Agent } from "../api/types";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";
import { MainAgentHome } from "./MainAgentHome";

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
let agents: Agent[];
let preference: { mainAgentId: string | null; accessible: boolean; pickerDismissedAt: string | null };
let saveFails: boolean;
let loadFails: boolean;
let hangPreference: boolean;
let sessions: Array<{ agentId: string; lastActivity: number }>;
let hangSave: boolean;
let resolveHeldSave: ((response: Response) => void) | undefined;
let poolActions: Array<{ poolId: string; action: string; chatAgentId: string | null }>;
let poolAgents: Agent[];
const requests: Array<{ path: string; method: string; body?: unknown }> = [];

beforeEach(() => {
  agents = [];
  preference = { mainAgentId: null, accessible: false, pickerDismissedAt: null };
  requests.length = 0;
  saveFails = false;
  loadFails = false;
  hangPreference = false;
  sessions = [];
  hangSave = false;
  resolveHeldSave = undefined;
  poolActions = [];
  poolAgents = [];
  setCapabilitiesForTests({ forkedAgents: false, multiUser: false });
  history.replaceState({}, "", "/");
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    requests.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/api/me/main-agent") {
      if ((method === "GET" && hangPreference) || (method === "PUT" && hangSave)) return new Promise<Response>((resolve, reject) => {
        if (method === "PUT") resolveHeldSave = resolve;
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      if (method === "GET" && loadFails) return Response.json({ error: "Unavailable" }, { status: 503 });
      if (method === "PUT") {
        if (saveFails) return Response.json({ error: "Unavailable" }, { status: 503 });
        const value = JSON.parse(String(init?.body));
        preference = value.mainAgentId
          ? { mainAgentId: value.mainAgentId, accessible: true, pickerDismissedAt: null }
          : { ...preference, pickerDismissedAt: "2026-10-19T12:00:00.000Z" };
      }
      return Response.json(preference);
    }
    if (path === "/api/agents") return Response.json(agents);
    if (path === "/api/pool") return Response.json(poolAgents);
    if (path === "/api/pool-actions") return Response.json({ actions: poolActions });
    if (path === "/api/agents/sessions") return Response.json({ items: sessions });
    return Response.json(null);
  }));
});

afterEach(() => {
  dispose?.();
  container.remove();
  resetCapabilitiesForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderHome() {
  dispose = render(() => (
    <Router>
      <Route path="/" component={MainAgentHome} />
      <Route path="/chat/:agentId" component={() => <h1>Chat with {useParams().agentId}</h1>} />
    </Router>
  ), container);
}

async function mountHome() {
  renderHome();
  await vi.waitFor(() => expect(container.querySelector("h1")).not.toBeNull());
}

function button(name: string): HTMLButtonElement {
  const control = Array.from(container.querySelectorAll("button")).find((item) =>
    item.getAttribute("aria-label") === name || item.textContent === name
  );
  expect(control, `Button ${name}`).toBeDefined();
  return control!;
}

describe("main agent home", () => {
  it("shows the catalog without a picker when no agents are eligible", async () => {
    await mountHome();
    expect(container.querySelector("h1")?.textContent).toBe("Agents");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens a fresh chat with the accessible main agent", async () => {
    agents = [{ id: "sage", name: "Sage" }, { id: "scout", name: "Scout" }];
    preference = { mainAgentId: "sage", accessible: true, pickerDismissedAt: null };
    await mountHome();
    await vi.waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Chat with sage"));
  });

  it("saves the only eligible agent before opening its chat without a picker", async () => {
    agents = [{ id: "solo", name: "Solo" }];
    await mountHome();
    await vi.waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Chat with solo"));
    expect(requests).toContainEqual({ path: "/api/me/main-agent", method: "PUT", body: { mainAgentId: "solo" } });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows the picker over the catalog when the saved agent is inaccessible", async () => {
    agents = [{ id: "sage", name: "Sage" }, { id: "scout", name: "Scout" }];
    preference = { mainAgentId: "removed", accessible: false, pickerDismissedAt: null };
    await mountHome();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Pick your main agent");
    expect(container.querySelector("h1")?.textContent).toBe("Agents");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Make Sage my main agent"));
  });

  it("records a deliberate dismissal and offers the picker again on the next home visit", async () => {
    agents = [{ id: "sage", name: "Sage" }, { id: "scout", name: "Scout" }];
    await mountHome();
    button("I will decide later").click();
    await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
    expect(preference.pickerDismissedAt).toBe("2026-10-19T12:00:00.000Z");
    dispose?.();
    await mountHome();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("moves focus with arrows, keyboard, and a neighboring agent", async () => {
    agents = [{ id: "sage", name: "Sage" }, { id: "scout", name: "Scout" }];
    await mountHome();
    button("Next agent").click();
    expect(container.querySelector("h3")?.textContent).toBe("Scout");
    button("Previous agent").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(container.querySelector("h3")?.textContent).toBe("Sage");
    button("Focus Scout").click();
    expect(container.querySelector("h3")?.textContent).toBe("Scout");
  });

  it("keeps a failed pick open, then saves and opens the chosen agent on retry", async () => {
    agents = [{ id: "sage", name: "Sage" }, { id: "scout", name: "Scout" }];
    saveFails = true;
    await mountHome();
    button("Make Sage my main agent").click();
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save"));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(preference.mainAgentId).toBeNull();
    saveFails = false;
    button("Make Sage my main agent").click();
    await vi.waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Chat with sage"));
    expect(preference.mainAgentId).toBe("sage");
  });

  it("keeps the catalog usable without a picker after a preference load failure", async () => {
    agents = [{ id: "sage", name: "Sage" }, { id: "scout", name: "Scout" }];
    loadFails = true;
    await mountHome();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(Array.from(container.querySelectorAll("a")).map((link) => link.getAttribute("href"))).toContain("/chat/sage"));
  });

  it("falls back to a usable catalog when loading hangs, and recovers on retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    agents = [{ id: "sage", name: "Sage" }, { id: "scout", name: "Scout" }];
    hangPreference = true;
    renderHome();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(container.querySelector("h1")?.textContent).toBe("Agents");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("took too long");
    expect(Array.from(container.querySelectorAll("a")).map((link) => link.getAttribute("href"))).toContain("/chat/sage");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    hangPreference = false;
    button("Retry").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("starts with the eligible agent from the most recent session", async () => {
    agents = [{ id: "sage", name: "Sage" }, { id: "scout", name: "Scout" }];
    sessions = [{ agentId: "removed", lastActivity: 500 }, { agentId: "sage", lastActivity: 100 }, { agentId: "scout", lastActivity: 300 }];
    await mountHome();
    await vi.waitFor(() => expect(container.querySelector("h3")?.textContent).toBe("Scout"));
  });

  it("ignores Escape and records dismissal only after the close button", async () => {
    agents = [{ id: "sage", name: "Sage" }, { id: "scout", name: "Scout" }];
    await mountHome();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(preference.pickerDismissedAt).toBeNull();
    button("Close main agent picker").click();
    await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
    expect(preference.pickerDismissedAt).toBe("2026-10-19T12:00:00.000Z");
  });

  it("keeps a timed-out pick open and lets the user retry", async () => {
    agents = [{ id: "sage", name: "Sage" }, { id: "scout", name: "Scout" }];
    await mountHome();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hangSave = true;
    button("Make Sage my main agent").click();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Saving your main agent took too long");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    hangSave = false;
    button("Make Sage my main agent").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector("h1")?.textContent).toBe("Chat with sage");
  });

  it("keeps Tab focus inside the picker while a save disables its controls", async () => {
    agents = [{ id: "sage", name: "Sage" }, { id: "scout", name: "Scout" }];
    await mountHome();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hangSave = true;
    button("Make Sage my main agent").click();
    try {
      const dialog = container.querySelector('[role="dialog"]')!;
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      window.dispatchEvent(tab);
      // jsdom does not traverse focus on Tab; model the uncanceled browser default.
      if (!tab.defaultPrevented) container.querySelector<HTMLAnchorElement>('a[href="/chat/sage"]')!.focus();
      expect(dialog.contains(document.activeElement)).toBe(true);
    } finally {
      await vi.advanceTimersByTimeAsync(10_001);
    }
  });

  it("keeps reverse Tab inside the picker after a failed save restores controls", async () => {
    agents = [{ id: "sage", name: "Sage" }, { id: "scout", name: "Scout" }];
    await mountHome();
    hangSave = true;
    button("Make Sage my main agent").click();
    const dialog = container.querySelector('[role="dialog"]')!;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(dialog.contains(document.activeElement)).toBe(true);
    resolveHeldSave!(Response.json({ error: "Unavailable" }, { status: 503 }));
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save"));
    const shiftTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(shiftTab);
    // jsdom does not traverse focus on Tab; model the uncanceled browser default.
    if (!shiftTab.defaultPrevented) container.querySelector<HTMLAnchorElement>('a[href="/chat/sage"]')!.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(button("I will decide later"));
  });

  it("stays in the catalog after a single-agent save fails, then retries", async () => {
    agents = [{ id: "solo", name: "Solo" }];
    saveFails = true;
    await mountHome();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    saveFails = false;
    button("Retry").click();
    await vi.waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Chat with solo"));
  });

  it("uses catalog order and runnable fork IDs when there is no recent chat", async () => {
    setCapabilitiesForTests({ forkedAgents: true });
    agents = [{ id: "fork-b", name: "Second" }, { id: "fork-a", name: "First" }];
    poolAgents = [{ id: "pool-a", name: "First" }, { id: "pool-b", name: "Second" }];
    poolActions = [{ poolId: "pool-a", action: "chat", chatAgentId: "fork-a" }, { poolId: "pool-b", action: "chat", chatAgentId: "fork-b" }];
    await mountHome();
    expect(container.querySelector("h3")?.textContent).toBe("First");
    button("Make First my main agent").click();
    await vi.waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Chat with fork-a"));
    expect(preference.mainAgentId).toBe("fork-a");
  });
});
