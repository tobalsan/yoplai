// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getByRole, getByTitle, queryByRole, queryByTitle, waitFor } from "@testing-library/dom";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { McpAppToolRow } from "./ChatBlocks";
import { ChatPanelTabs } from "./ChatPanelTabs";
import { createAppViews, dashboardKey, type AppViewCall, type AppViews } from "./appViews";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../../lib/capabilities";
import type { FullToolResultMessage } from "../../api/types";

const ID = "g".repeat(32);
const handleOf = (n: number) => String(n).padStart(43, "h");
const marker = { server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard" };
const result: FullToolResultMessage = {
  role: "toolResult", isError: false, toolCallId: "first", toolName: "dashboard_create", timestamp: 1,
  content: [{ type: "text", text: "Dashboard created" }],
  view: { ...marker, recordId: "record", key: ID },
};
const call: AppViewCall = { id: "first", timestamp: 1, view: marker, result, text: "Dashboard created" };
const captured = (extra: Record<string, unknown> = {}) => ({
  args: {}, result: { content: [], structuredContent: { id: ID, agentId: "pom", slug: "garden.html", link: `/d/${ID}`, title: "Garden", ...extra } },
});

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
let requests: string[];
let prepareBodies: Array<Record<string, unknown>>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  setCapabilitiesForTests({ apps: { available: false } });
  requests = [];
  prepareBodies = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push(path);
    if (path === "/api/relay/dashboard-views") {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      prepareBodies.push(body);
      const n = prepareBodies.length;
      return new Response(JSON.stringify({
        handle: handleOf(n), instance: `instance-${n}`, shellUrl: `/api/relay/dashboard-views/${handleOf(n)}/shell`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), gateway: body.gateway, dashboardId: body.dashboardId,
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(captured(dataExtra)));
  }));
});
let dataExtra: Record<string, unknown> = {};
afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  dataExtra = {};
  resetCapabilitiesForTests();
  vi.unstubAllGlobals();
});

function renderRow(props: { agentId: string; gateway?: () => string | undefined; pending?: () => boolean }) {
  dispose = render(() => {
    const appViews = createAppViews(() => "session", () => [call]);
    return (
      <McpAppToolRow
        agentId={props.agentId}
        gateway={props.gateway?.()}
        gatewayPending={props.pending?.()}
        sessionId="session"
        toolCallId="first"
        name="dashboard_create"
        result={result}
        appViews={appViews}
      />
    );
  }, container);
}

describe("captured dashboard of a remote chat tool", () => {
  it("opens the host and the public route for the gateway of the resolved agent, though the result has no gateway", async () => {
    renderRow({ agentId: "pom@ams", gateway: () => "ams" });
    await waitFor(() => expect(getByRole(container, "link", { name: "Open in browser" }).getAttribute("href")).toBe(`/remote-dashboards/ams/${ID}`));
    expect(requests[0]).toBe("/api/agents/pom%40ams/sessions/session/mcp-apps/first/data");
    await waitFor(() => expect(prepareBodies).toHaveLength(1));
    expect(prepareBodies[0]).toMatchObject({ gateway: "ams", dashboardId: ID });
    await waitFor(() => expect(getByTitle(container, "Garden dashboard").getAttribute("src")).toBe(`/api/relay/dashboard-views/${handleOf(1)}/shell`));
  });

  it("ignores a gateway or query that the result names", async () => {
    dataExtra = { gateway: "evil", query: "steal=1", link: "https://evil.example/d/x" };
    renderRow({ agentId: "pom@ams", gateway: () => "ams" });
    await waitFor(() => expect(prepareBodies).toHaveLength(1));
    expect(prepareBodies[0]).toEqual(expect.objectContaining({ gateway: "ams", dashboardId: ID }));
    expect(prepareBodies[0].query).toBeUndefined();
    expect(getByRole(container, "link", { name: "Open in browser" }).getAttribute("href")).toBe(`/remote-dashboards/ams/${ID}`);
  });

  it("keeps a local agent whose ID contains @ on the local frame, also when the result names a gateway", async () => {
    dataExtra = { gateway: "evil" };
    renderRow({ agentId: "me@home" });
    await waitFor(() => expect(getByTitle(container, "Garden dashboard").getAttribute("src")).toBe(`/d/${ID}`));
    expect(getByRole(container, "link", { name: "Open in browser" }).getAttribute("href")).toBe(`/d/${ID}`);
    expect(prepareBodies).toHaveLength(0);
  });

  it("waits for the agent to resolve before it chooses a host", async () => {
    const [pending, setPending] = createSignal(true);
    const [gateway, setGateway] = createSignal<string>();
    renderRow({ agentId: "pom@ams", gateway, pending });
    await waitFor(() => expect(requests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getByRole(container, "status").textContent).toBe("Loading dashboard…");
    expect(queryByTitle(container, "Garden dashboard")).toBeNull();
    expect(prepareBodies).toHaveLength(0);
    setGateway("ams");
    setPending(false);
    await waitFor(() => expect(prepareBodies).toHaveLength(1));
    expect(prepareBodies[0]).toMatchObject({ gateway: "ams" });
    expect(queryByRole(container, "link", { name: "Open in browser" })?.getAttribute("href")).toBe(`/remote-dashboards/ams/${ID}`);
  });

  it("prepares a fresh view in a persistent panel when a later result updates the same dashboard", async () => {
    const second: AppViewCall = {
      id: "second", timestamp: 2, view: marker,
      result: { view: { ...marker, recordId: "record-2", key: ID } },
    };
    const [calls, setCalls] = createSignal<AppViewCall[]>([call]);
    let views!: AppViews;
    dispose = render(() => {
      views = createAppViews(() => "session", calls, undefined, undefined, () => "ams");
      return <ChatPanelTabs appViews={views} agentId="pom@ams" gateway="ams" sessionId="session" onUserMessage={async () => {}} />;
    }, container);
    views.open(dashboardKey(ID, "ams"));
    await waitFor(() => expect(getByTitle(container, "Garden dashboard").getAttribute("src")).toBe(`/api/relay/dashboard-views/${handleOf(1)}/shell`));
    setCalls([call, second]);
    await waitFor(() => expect(getByTitle(container, "Garden dashboard").getAttribute("src")).toBe(`/api/relay/dashboard-views/${handleOf(2)}/shell`));
    expect(prepareBodies).toHaveLength(2);
    expect(requests).toContain("/api/agents/pom%40ams/sessions/session/mcp-apps/second/data");
  });

  it("opens the same host in the side panel", async () => {
    let views!: AppViews;
    dispose = render(() => {
      views = createAppViews(() => "session", () => [call], undefined, undefined, () => "ams");
      return <ChatPanelTabs appViews={views} agentId="pom@ams" gateway="ams" sessionId="session" onUserMessage={async () => {}} />;
    }, container);
    views.open(dashboardKey(ID, "ams"));
    await waitFor(() => expect(prepareBodies).toHaveLength(1));
    expect(prepareBodies[0]).toMatchObject({ gateway: "ams", dashboardId: ID });
    expect(getByRole(container, "link", { name: "Open in browser" }).getAttribute("href")).toBe(`/remote-dashboards/ams/${ID}`);
  });
  describe("a dashboard query chosen in the chat panel", () => {
    const explicit = (query: string) => ({ kind: "dashboard" as const, id: ID, title: "Garden", gateway: "ams", query });
    const mountPanel = (calls: () => AppViewCall[]) => {
      let views!: AppViews;
      dispose = render(() => {
        views = createAppViews(() => "session", calls, undefined, undefined, () => "ams");
        return <ChatPanelTabs appViews={views} agentId="pom@ams" gateway="ams" sessionId="session" onUserMessage={async () => {}} />;
      }, container);
      return views;
    };
    const href = () => getByRole(container, "link", { name: "Open in browser" }).getAttribute("href");

    it("survives a captured result for the same dashboard that arrives later", async () => {
      dataExtra = { query: "steal=1" };
      const [calls, setCalls] = createSignal<AppViewCall[]>([]);
      const views = mountPanel(calls);
      views.openFrame(explicit("week=2"));
      await waitFor(() => expect(prepareBodies).toHaveLength(1));
      expect(prepareBodies[0]).toMatchObject({ query: "week=2" });
      setCalls([call]);
      await waitFor(() => expect(requests).toContain("/api/agents/pom%40ams/sessions/session/mcp-apps/first/data"));
      await waitFor(() => expect(prepareBodies.length).toBeGreaterThan(1));
      expect(views.tabs()).toHaveLength(1);
      expect(prepareBodies.at(-1)).toMatchObject({ gateway: "ams", dashboardId: ID, query: "week=2" });
      expect(href()).toBe(`/remote-dashboards/ams/${ID}?week=2`);
      views.openFrame(explicit("week=3"));
      await waitFor(() => expect(prepareBodies.at(-1)).toMatchObject({ query: "week=3" }));
      expect(href()).toBe(`/remote-dashboards/ams/${ID}?week=3`);
    });

    it("applies to a dashboard that a captured result opened first", async () => {
      dataExtra = { query: "steal=1" };
      const views = mountPanel(() => [call]);
      views.open(dashboardKey(ID, "ams"));
      await waitFor(() => expect(prepareBodies).toHaveLength(1));
      expect(prepareBodies[0].query).toBeUndefined();
      expect(href()).toBe(`/remote-dashboards/ams/${ID}`);
      views.openFrame(explicit("week=2"));
      await waitFor(() => expect(prepareBodies).toHaveLength(2));
      expect(views.tabs()).toHaveLength(1);
      expect(prepareBodies[1]).toMatchObject({ gateway: "ams", dashboardId: ID, query: "week=2" });
      expect(href()).toBe(`/remote-dashboards/ams/${ID}?week=2`);
    });
  });
});
