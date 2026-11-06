// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getByRole,
  getByTitle,
  queryByText,
  waitFor,
} from "@testing-library/dom";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { McpAppToolRow } from "./ChatBlocks";
import { createAppViews, type AppViewCall } from "./appViews";
import {
  resetCapabilitiesForTests,
  setCapabilitiesForTests,
} from "../../lib/capabilities";
import type { FullToolResultMessage } from "../../api/types";

const marker = {
  server: "yoplai",
  tool: "web_preview",
  resourceUri: "ui://yoplai/web-preview",
};
const reference = {
  ...marker,
  recordId: "record",
  key: "https://example.test/page",
  preview: { frameable: true },
};
const result: FullToolResultMessage = {
  role: "toolResult",
  isError: false,
  toolCallId: "first",
  toolName: "web_preview",
  timestamp: 1,
  content: [
    { type: "text", text: "Web preview shown: https://example.test/page" },
  ],
  view: reference,
};
const first: AppViewCall = {
  id: "first",
  timestamp: 1,
  view: marker,
  result,
  text: "Web preview shown",
};
const data = {
  args: {},
  result: {
    content: [],
    structuredContent: {
      url: "https://example.test/page",
      finalUrl: "https://example.test/page",
      title: "First page",
      frameable: true,
      reason: null,
      status: 200,
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

describe("preview tool row", () => {
  it("ignores an older response after a newer preview record arrives", async () => {
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
    dispose = render(() => {
      const appViews = createAppViews(() => "session", calls);
      return (
        <McpAppToolRow
          agentId="agent"
          sessionId="session"
          toolCallId="first"
          name="web_preview"
          result={result}
          appViews={appViews}
        />
      );
    }, container);
    await waitFor(() =>
      expect(getByTitle(container, "First page web preview")).toBeTruthy()
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
      expect(getByTitle(container, "Newest page web preview")).toBeTruthy()
    );
    finishOlder(new Response(JSON.stringify(data)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getByTitle(container, "Newest page web preview")).toBeTruthy();
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
          name="web_preview"
          result={result}
          appViews={appViews}
        />
      );
    }, container);
    try {
      await vi.advanceTimersByTimeAsync(10000);
      expect(queryByText(container, "Preview unavailable")).not.toBeNull();
      finish(new Response(JSON.stringify(data)));
      await vi.advanceTimersByTimeAsync(0);
      expect(container.querySelector("iframe")).toBeNull();
      expect(queryByText(container, "Loading preview…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps the live iframe during an update, then reloads its requested URL and latest title", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(data)))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      );
    vi.stubGlobal("fetch", fetch);
    const [calls, setCalls] = createSignal([first]);
    dispose = render(() => {
      const appViews = createAppViews(() => "session", calls);
      return (
        <McpAppToolRow
          agentId="agent"
          sessionId="session"
          toolCallId="first"
          name="web_preview"
          result={result}
          appViews={appViews}
        />
      );
    }, container);
    await waitFor(() =>
      expect(getByTitle(container, "First page web preview")).toBeTruthy()
    );
    const frame = getByTitle(
      container,
      "First page web preview"
    ) as HTMLIFrameElement;
    frame.src = "https://example.test/submitted";
    setCalls([
      first,
      { ...first, id: "second", result: { ...result, toolCallId: "second" } },
    ]);
    expect(getByTitle(container, "First page web preview")).toBe(frame);
    await waitFor(() =>
      expect(fetch.mock.calls[1]?.[0]).toBe(
        "/api/agents/agent/sessions/session/mcp-apps/second/data"
      )
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
      expect(getByTitle(container, "Revised page web preview")).toBe(frame)
    );
    expect(frame.src).toBe("https://example.test/page");
  });
  it("keeps the last preview visible when a later record fails to load", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(data)))
        .mockRejectedValueOnce(new Error("offline"))
    );
    const [calls, setCalls] = createSignal([first]);
    dispose = render(() => {
      const appViews = createAppViews(() => "session", calls);
      return (
        <McpAppToolRow
          agentId="agent"
          sessionId="session"
          toolCallId="first"
          name="web_preview"
          result={result}
          appViews={appViews}
        />
      );
    }, container);
    await waitFor(() =>
      expect(getByTitle(container, "First page web preview")).toBeTruthy()
    );
    const frame = getByTitle(container, "First page web preview");
    setCalls([first, { ...first, id: "failed-update" }]);
    await waitFor(() =>
      expect(
        queryByText(container, "Preview update unavailable")
      ).not.toBeNull()
    );
    expect(getByTitle(container, "First page web preview")).toBe(frame);
    expect(getByRole(container, "button", { name: "Reload" })).toBeTruthy();
  });
  it("shows only a refused tool's error text even before apps capabilities load", () => {
    const refused: FullToolResultMessage = {
      ...result,
      view: undefined,
      isError: true,
      content: [
        { type: "text", text: "Only HTTPS or loopback HTTP URLs are allowed." },
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
          name="web_preview"
          result={refused}
          appViews={appViews}
        />
      );
    }, container);
    expect(container.textContent).toBe(
      "Only HTTPS or loopback HTTP URLs are allowed."
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
            name="web_preview"
            result={result}
            appViews={appViews}
          />
        );
      }, container);
      await waitFor(() =>
        expect(getByTitle(container, "First page web preview")).toBeTruthy()
      );
      expect(queryByText(container, "Loading view…")).toBeNull();
      expect(getByRole(container, "button", { name: "Expand" })).toBeTruthy();
    }
  );
});
