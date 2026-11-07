// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getByRole,
  getByTitle,
  queryByText,
  waitFor,
} from "@testing-library/dom";
import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import { McpAppToolRow } from "./ChatBlocks";
import { createAppViews, type AppViewCall, type AppViews } from "./appViews";
import {
  resetCapabilitiesForTests,
  setCapabilitiesForTests,
} from "../../lib/capabilities";
import type { FullToolResultMessage } from "../../api/types";

const marker = {
  server: "yoplai",
  tool: "dashboard",
  resourceUri: "ui://yoplai/dashboard",
};
const reference = {
  ...marker,
  recordId: "record",
  key: "garden",
};
const result: FullToolResultMessage = {
  role: "toolResult",
  isError: false,
  toolCallId: "first",
  toolName: "dashboard_create",
  timestamp: 1,
  content: [
    { type: "text", text: "Dashboard created" },
  ],
  view: reference,
};
const first: AppViewCall = {
  id: "first",
  timestamp: 1,
  view: marker,
  result,
  text: "Dashboard created",
};
const data = {
  args: {},
  result: {
    content: [],
    structuredContent: {
      id: "garden",
      agentId: "agent",
      slug: "garden.html",
      link: "/d/garden",
      title: "First page",
    },
  },
};
let container: HTMLDivElement;
let dispose: () => void;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  resetCapabilitiesForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(data)))
  );
});
afterEach(() => {
  dispose?.();
  container.remove();
  resetCapabilitiesForTests();
  vi.unstubAllGlobals();
});

// One row per call, like the transcript: the newest successful call hosts the view, earlier ones link to it.
function renderRows(calls: () => AppViewCall[], onViews?: (views: AppViews) => void) {
  return render(() => {
    const appViews = createAppViews(() => "session", calls);
    onViews?.(appViews);
    return (
      <For each={calls()}>
        {(call) => (
          <McpAppToolRow
            agentId="agent"
            sessionId="session"
            toolCallId={call.id}
            name="dashboard_create"
            result={{ ...result, ...call.result }}
            appViews={appViews}
          />
        )}
      </For>
    );
  }, container);
}

describe("dashboard tool row", () => {
  it("renders and refreshes a dashboard without the apps origin", async () => {
    setCapabilitiesForTests({ apps: { available: false } });
    const marker = { server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard" };
    const created = { ...first, view: marker, result: { ...result, toolName: "dashboard_create", view: { ...marker, recordId: "created-record", key: "garden" } } };
    const dashboardData = { args: {}, result: { content: [], structuredContent: { id: "garden", agentId: "agent", slug: "garden.html", title: "Garden overview", link: "https://elsewhere.test/d/garden" } } };
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(dashboardData)));
    vi.stubGlobal("fetch", fetch);
    const [calls, setCalls] = createSignal([created]);
    dispose = renderRows(calls);
    await waitFor(() => expect(getByTitle(container, "Garden overview dashboard")).toBeTruthy());
    const frame = getByTitle(container, "Garden overview dashboard") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("/d/garden");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    setCalls([created, { ...created, id: "updated", result: { ...created.result, toolCallId: "updated", view: { ...created.result.view, recordId: "updated-record" } } }]);
    await waitFor(() => expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/agents/agent/sessions/session/mcp-apps/updated/data"));
    await waitFor(() => expect(getByTitle(container, "Garden overview dashboard").getAttribute("src")).toBe("/d/garden"));
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(getByRole(container, "button", { name: "Dashboard updated. Click to see it" })).toBeTruthy();
    expect(getByRole(container, "button", { name: "Expand" })).toBeTruthy();
  });
  it("ignores an older response after a newer dashboard record arrives", async () => {
    let finishOlder!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(data)))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finishOlder = resolve;
            })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ...data,
              result: {
                ...data.result,
                structuredContent: {
                  ...data.result.structuredContent,
                  title: "Newest page",
                },
              },
            })
          )
        )
    );
    const [calls, setCalls] = createSignal([first]);
    dispose = renderRows(calls);
    await waitFor(() =>
      expect(getByTitle(container, "First page dashboard")).toBeTruthy()
    );
    setCalls([
      first,
      { ...first, id: "older", result: { ...result, toolCallId: "older" } },
    ]);
    setCalls([
      first,
      { ...first, id: "older", result: { ...result, toolCallId: "older" } },
      { ...first, id: "newest", result: { ...result, toolCallId: "newest" } },
    ]);
    await waitFor(() =>
      expect(getByTitle(container, "Newest page dashboard")).toBeTruthy()
    );
    finishOlder(new Response(JSON.stringify(data)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getByTitle(container, "Newest page dashboard")).toBeTruthy();
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(queryByText(container, "First page", { exact: true })).toBeNull();
  });
  it("ends a hung data load and ignores its late response without blocking the row", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      )
    );
    dispose = render(() => {
      const appViews = createAppViews(
        () => "session",
        () => [first]
      );
      return (
        <McpAppToolRow
          agentId="agent"
          sessionId="session"
          toolCallId="first"
          name="dashboard_create"
          result={result}
          appViews={appViews}
        />
      );
    }, container);
    try {
      await vi.advanceTimersByTimeAsync(10000);
      expect(queryByText(container, "Dashboard unavailable")).not.toBeNull();
      finish(new Response(JSON.stringify(data)));
      await vi.advanceTimersByTimeAsync(0);
      expect(container.querySelector("iframe")).toBeNull();
      expect(queryByText(container, "Loading dashboard…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("moves the dashboard to the updated call, loads its latest title and links the earlier row", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(data)))
      .mockResolvedValueOnce(new Response(JSON.stringify(data)))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      );
    vi.stubGlobal("fetch", fetch);
    const [calls, setCalls] = createSignal([first]);
    dispose = renderRows(calls);
    await waitFor(() =>
      expect(getByTitle(container, "First page dashboard")).toBeTruthy()
    );
    setCalls([
      first,
      { ...first, id: "second", result: { ...result, toolCallId: "second" } },
    ]);
    // The new host starts at the shown call, then loads the latest.
    await waitFor(() =>
      expect(fetch.mock.calls.map((call) => call[0])).toEqual([
        "/api/agents/agent/sessions/session/mcp-apps/first/data",
        "/api/agents/agent/sessions/session/mcp-apps/first/data",
        "/api/agents/agent/sessions/session/mcp-apps/second/data",
      ])
    );
    finish(
      new Response(
        JSON.stringify({
          ...data,
          result: {
            ...data.result,
            structuredContent: {
              ...data.result.structuredContent,
              title: "Revised page",
            },
          },
        })
      )
    );
    await waitFor(() =>
      expect(getByTitle(container, "Revised page dashboard")).toBeTruthy()
    );
    expect(
      getByTitle(container, "Revised page dashboard").getAttribute("src")
    ).toBe("/d/garden");
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(
      getByRole(container, "button", { name: "Dashboard updated. Click to see it" })
    ).toBeTruthy();
  });
  it("disables the link while the side panel shows the view and enables it otherwise", async () => {
    const [calls, setCalls] = createSignal([first]);
    let views!: AppViews;
    dispose = renderRows(calls, (appViews) => { views = appViews; });
    await waitFor(() =>
      expect(getByTitle(container, "First page dashboard")).toBeTruthy()
    );
    setCalls([
      first,
      { ...first, id: "second", result: { ...result, toolCallId: "second" } },
    ]);
    const link = await waitFor(() =>
      getByRole(container, "button", { name: "Dashboard updated. Click to see it" })
    );
    expect((link as HTMLButtonElement).disabled).toBe(false);
    views.open("yoplai\nui://yoplai/dashboard\ngarden");
    await waitFor(() =>
      expect(
        (getByRole(container, "button", { name: "Dashboard updated. Displayed in side panel" }) as HTMLButtonElement).disabled
      ).toBe(true)
    );
    expect(
      getByRole(container, "button", { name: "Dashboard · shown in the side panel" })
    ).toBeTruthy();
    views.close();
    await waitFor(() =>
      expect(
        (getByRole(container, "button", { name: "Dashboard updated. Click to see it" }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
  });
  it("keeps the last dashboard visible when a later record fails to load", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(data)))
        .mockResolvedValueOnce(new Response(JSON.stringify(data)))
        .mockRejectedValueOnce(new Error("offline"))
    );
    const [calls, setCalls] = createSignal([first]);
    dispose = renderRows(calls);
    await waitFor(() =>
      expect(getByTitle(container, "First page dashboard")).toBeTruthy()
    );
    setCalls([first, { ...first, id: "failed-update" }]);
    await waitFor(() =>
      expect(
        queryByText(container, "Dashboard update unavailable")
      ).not.toBeNull()
    );
    // The view moved to the newest row and kept the last good version.
    expect(getByTitle(container, "First page dashboard")).toBeTruthy();
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(getByRole(container, "button", { name: "Expand" })).toBeTruthy();
  });
  it("shows the latest dashboard when the moved host's seed load fails", async () => {
    const titled = (title: string) => new Response(JSON.stringify({ ...data, result: { ...data.result, structuredContent: { ...data.result.structuredContent, title } } }));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(titled("First page"))
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(titled("Latest page"))
    );
    const [calls, setCalls] = createSignal([first]);
    dispose = renderRows(calls);
    await waitFor(() =>
      expect(getByTitle(container, "First page dashboard")).toBeTruthy()
    );
    setCalls([first, { ...first, id: "second", result: { ...result, toolCallId: "second" } }]);
    await waitFor(() =>
      expect(getByTitle(container, "Latest page dashboard")).toBeTruthy()
    );
    expect(queryByText(container, "Dashboard unavailable")).toBeNull();
  });
  it("shows only a failed dashboard tool's error text before apps capabilities load", () => {
    const refused: FullToolResultMessage = {
      ...result,
      view: undefined,
      isError: true,
      content: [
        { type: "text", text: "Dashboard not found" },
      ],
    };
    dispose = render(() => {
      const appViews = createAppViews(
        () => "session",
        () => [{ ...first, result: refused }]
      );
      return (
        <McpAppToolRow
          agentId="agent"
          sessionId="session"
          toolCallId="first"
          name="dashboard_create"
          result={refused}
          appViews={appViews}
        />
      );
    }, container);
    expect(container.textContent).toBe(
      "Dashboard not found"
    );
    expect(container.querySelector("iframe")).toBeNull();
  });
  it.each([false, undefined])(
    "renders a native frame with appsAvailable %s",
    async (available) => {
      if (available !== undefined)
        setCapabilitiesForTests({ apps: { available } });
      dispose = render(() => {
        const appViews = createAppViews(
          () => "session",
          () => [first]
        );
        return (
          <McpAppToolRow
            agentId="agent"
            sessionId="session"
            toolCallId="first"
            name="dashboard_create"
            result={result}
            appViews={appViews}
          />
        );
      }, container);
      await waitFor(() =>
        expect(getByTitle(container, "First page dashboard")).toBeTruthy()
      );
      expect(queryByText(container, "Loading view…")).toBeNull();
      expect(getByRole(container, "button", { name: "Expand" })).toBeTruthy();
    }
  );
});
