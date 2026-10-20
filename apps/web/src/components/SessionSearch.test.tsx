// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import { SessionSearch, openSessionSearch } from "./SessionSearch";

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  history.replaceState({}, "", "/agents");
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json({ items: [] }));
});

afterEach(() => {
  dispose?.();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount() {
  dispose = render(
    () => (
      <Router
        root={(props) => (
          <>
            <SessionSearch />
            {props.children}
          </>
        )}
      >
        <Route
          path="*"
          component={() => <button onClick={openSessionSearch}>Search</button>}
        />
      </Router>
    ),
    container
  );
}

function input() {
  return container.querySelector<HTMLInputElement>(
    '[aria-label="Search chats"]'
  )!;
}

function key(value: string, modifier: "metaKey" | "ctrlKey" = "metaKey") {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: value,
      [modifier]: true,
      bubbles: true,
      cancelable: true,
    })
  );
}

function typeQuery(value: string) {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}

describe("session search", () => {
  it("opens from any page with a focused, explanatory input and no recent sessions", async () => {
    mount();
    key("k");
    await vi.waitFor(() => expect(document.activeElement).toBe(input()));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(input().placeholder).toBe(
      "Search titles and messages in your chats"
    );
    expect(container.querySelector('[role="option"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("debounces words and shows highlighted titles and snippets as safe text", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      Response.json({
        items: [
          {
            agentId: "sage",
            sessionId: "chat-1",
            title: "PgBouncer notes",
            firstUserMessage: "",
            lastActivity: Date.now(),
            match: "content",
            snippet: "Use pgbouncer with <script>alert(1)</script> pools",
          },
        ],
      })
    );
    mount();
    key("k");
    typeQuery("PgBouncer pools");
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/sessions/search?q=PgBouncer+pools",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const option = container.querySelector('[role="option"]')!;
    expect(option.textContent).toContain("sage");
    expect(option.textContent).toContain("now");
    expect(option.textContent).toContain("<script>alert(1)</script>");
    expect(option.querySelector("script")).toBeNull();
    expect(
      Array.from(option.querySelectorAll("mark"), (mark) => mark.textContent)
    ).toEqual(["PgBouncer", "pgbouncer", "pools"]);
  });

  it("aborts immediately on input and only the latest request can change results or loading", async () => {
    vi.useFakeTimers();
    const pending: Array<{
      resolve: (response: Response) => void;
      signal: AbortSignal;
    }> = [];
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((resolve) => {
          pending.push({ resolve, signal: init!.signal as AbortSignal });
        })
    );
    mount();
    key("k");
    typeQuery("old");
    await vi.advanceTimersByTimeAsync(200);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Searching"
    );
    typeQuery("new");
    expect(pending[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    pending[0].resolve(
      Response.json({
        items: [
          { agentId: "old", sessionId: "old", firstUserMessage: "Old result" },
        ],
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[role="option"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Searching"
    );
    pending[1].resolve(Response.json({ items: [] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "No matches. Try different words."
    );
  });

  it("moves selection with arrows and opens the selected chat with Enter", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      Response.json({
        items: [
          { agentId: "first", sessionId: "one", title: "First chat" },
          {
            agentId: "sage/one",
            sessionId: "project chat&two",
            title: "Second chat",
          },
        ],
      })
    );
    mount();
    key("k", "ctrlKey");
    typeQuery("chat");
    await vi.advanceTimersByTimeAsync(200);
    const selected = () =>
      container.querySelector('[role="option"][aria-selected="true"]')
        ?.textContent;
    expect(selected()).toContain("First chat");
    input().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      })
    );
    expect(selected()).toContain("Second chat");
    input().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      })
    );
    expect(selected()).toContain("First chat");
    input().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      })
    );
    input().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(location.pathname + location.search).toBe(
      "/chat/sage%2Fone?session=project%20chat%26two"
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps keyboard focus in search and consumes Escape before the chat below it", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      Response.json({
        items: [{ agentId: "sage", sessionId: "one", title: "Chat" }],
      })
    );
    mount();
    const trigger = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Search"
    )!;
    trigger.focus();
    trigger.click();
    await vi.advanceTimersByTimeAsync(0);
    typeQuery("chat");
    await vi.advanceTimersByTimeAsync(200);
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
    const chatEscape = vi.fn();
    window.addEventListener("keydown", chatEscape);
    input().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );
    window.removeEventListener("keydown", chatEscape);
    expect(chatEscape).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("ignores stale failures, reports current failures and recovers on the next query", async () => {
    vi.useFakeTimers();
    let rejectOld: (error: Error) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        })
    );
    mount();
    key("k");
    typeQuery("old");
    await vi.advanceTimersByTimeAsync(200);
    typeQuery("current");
    fetchMock.mockResolvedValueOnce(
      Response.json({
        items: [
          {
            agentId: "sage",
            sessionId: "assistant-only-42",
            firstUserMessage: "",
            lastActivity: Date.now(),
          },
        ],
      })
    );
    await vi.advanceTimersByTimeAsync(200);
    rejectOld(new Error("Late failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="option"]')?.textContent).toContain(
      "assistant-only-42"
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    typeQuery("unavailable");
    await vi.advanceTimersByTimeAsync(200);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Unable to search chats. Try again."
    );
    typeQuery("retry");
    await vi.advanceTimersByTimeAsync(200);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "No matches"
    );
    typeQuery("   ");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("opens clicked results and leaves Cmd/Ctrl+K inactive on login", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      Response.json({
        items: [
          {
            agentId: "sage",
            sessionId: "one",
            title: "Chat",
            lastActivity: Date.now(),
          },
        ],
      })
    );
    mount();
    key("k");
    typeQuery("chat");
    await vi.advanceTimersByTimeAsync(200);
    container.querySelector<HTMLButtonElement>('[role="option"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(location.pathname + location.search).toBe("/chat/sage?session=one");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    dispose?.();
    history.replaceState({}, "", "/login");
    mount();
    key("k");
    key("k", "ctrlKey");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
