// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getByRole, waitFor } from "@testing-library/dom";
import { render } from "solid-js/web";
import { ChatPanelTabs } from "./ChatPanelTabs";
import { createAppViews, type AppViews } from "./appViews";

const ID = "g".repeat(32);
const handleOf = (n: number) => String(n).padStart(43, "h");
let container: HTMLDivElement;
let dispose: (() => void) | undefined;
let prepareBodies: Array<Record<string, unknown>>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  sessionStorage.clear();
  prepareBodies = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "/api/relay/dashboard-views") return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    prepareBodies.push(body);
    const n = prepareBodies.length;
    return new Response(JSON.stringify({
      handle: handleOf(n), instance: `instance-${n}`, shellUrl: `/api/relay/dashboard-views/${handleOf(n)}/shell`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), gateway: body.gateway, dashboardId: body.dashboardId,
    }), { status: 201, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

describe("reopened remote dashboard in the side panel", () => {
  const other = "o".repeat(32);
  const mountPanel = () => {
    let views!: AppViews;
    dispose = render(() => {
      views = createAppViews(() => "session", () => []);
      return <ChatPanelTabs appViews={views} agentId="pom@ams" sessionId="session" onUserMessage={async () => {}} />;
    }, container);
    return views;
  };
  const frame = (query?: string, id = ID, gateway: string | undefined = "ams") => ({ kind: "dashboard" as const, id, title: "Garden", ...(gateway ? { gateway } : {}), ...(query !== undefined ? { query } : {}) });
  const href = () => getByRole(container, "link", { name: "Open in browser" }).getAttribute("href");

  it("prepares a fresh view for an explicit new query and keeps the query when none is given", async () => {
    const views = mountPanel();
    views.openFrame(frame("week=3"));
    await waitFor(() => expect(prepareBodies).toHaveLength(1));
    expect(prepareBodies[0]).toMatchObject({ query: "week=3" });
    expect(href()).toBe(`/remote-dashboards/ams/${ID}?week=3`);
    views.openFrame(frame("week=4"));
    await waitFor(() => expect(prepareBodies).toHaveLength(2));
    expect(prepareBodies[1]).toMatchObject({ gateway: "ams", dashboardId: ID, query: "week=4" });
    expect(href()).toBe(`/remote-dashboards/ams/${ID}?week=4`);
    expect(views.tabs()).toHaveLength(1);
    views.openFrame(frame());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prepareBodies).toHaveLength(2);
    expect(href()).toBe(`/remote-dashboards/ams/${ID}?week=4`);
    views.openFrame(frame("week=4"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prepareBodies).toHaveLength(2);
  });

  it("keeps another gateway or dashboard in its own tab, and stores only public values", async () => {
    const views = mountPanel();
    views.openFrame(frame("week=3"));
    views.openFrame(frame("week=9", ID, "west"));
    views.openFrame(frame("week=9", other));
    expect(views.tabs()).toHaveLength(3);
    await waitFor(() => expect(prepareBodies.length).toBeGreaterThanOrEqual(1));
    const stored = JSON.stringify(Object.entries(sessionStorage));
    expect(stored).not.toMatch(/handle|instance/);
  });

  it("leaves a local dashboard unchanged by a query", () => {
    const views = mountPanel();
    views.openFrame({ kind: "dashboard", id: ID, title: "Garden" });
    views.openFrame({ kind: "dashboard", id: ID, title: "Garden", query: "week=4" });
    expect(views.tabs()).toHaveLength(1);
    expect(getByRole(container, "link", { name: "Open in browser" }).getAttribute("href")).toBe(`/d/${ID}`);
    expect(prepareBodies).toHaveLength(0);
  });
});
