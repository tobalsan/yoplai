// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getByRole, getByText, getByTitle } from "@testing-library/dom";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { FrameView, frameBlock } from "./FrameView";

let container: HTMLDivElement;
let dispose: () => void;
const target = {
  kind: "preview" as const,
  url: "https://example.test/start",
  finalUrl: "https://example.test/page",
  title: "Example page",
  frameable: true,
  reason: null,
};
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  dispose?.();
  container.remove();
  vi.unstubAllGlobals();
});

describe("web preview", () => {
  it("does not navigate the previous iframe when an updated target is blocked", () => {
    const [current, setCurrent] = createSignal(target);
    dispose = render(() => <FrameView target={current()} mode="inline" />, container);
    const frame = getByTitle(container, "Example page web preview") as HTMLIFrameElement;
    setCurrent({ ...target, finalUrl: location.origin + "/private" });
    expect(container.querySelector("iframe")).toBeNull();
    expect(frame.src).toBe("https://example.test/page");
  });
  it.each([
    ["http://localhost:5173", "http://localhost:3000", null],
    ["http://127.0.0.1:5173", "http://localhost:3000", null],
    ["http://[::1]:5173", "http://127.0.0.1:3000", null],
    ["https://example.test/page", "https://chat.test", null],
    ["http://localhost:5173", "https://chat.test", "loopback"],
    ["http://127.0.0.1:5173", "https://chat.test", "loopback"],
    ["http://[::1]:5173", "https://chat.test", "loopback"],
    ["https://chat.test/page", "https://chat.test", "own-origin"],
    ["javascript:alert(1)", "https://chat.test", "scheme"],
    ["bad-url", "https://chat.test", "scheme"],
  ])("guards %s on %s", (url, chat, blocked) => {
    expect(frameBlock(url!, new URL(chat!))).toBe(blocked);
  });
  it("shows a live page at its final URL, with an isolated frame and Open", () => {
    dispose = render(
      () => <FrameView target={target} mode="inline" />,
      container
    );
    const frame = getByTitle(container, "Example page web preview");
    expect(frame.getAttribute("src")).toBe("https://example.test/page");
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
    );
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const open = getByRole(container, "link", { name: "Open" });
    expect(open.getAttribute("href")).toBe("https://example.test/page");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.textContent).toContain("https://example.test/page");
  });
  it.each([
    ["x-frame-options", "This page does not allow being shown in a frame."],
    ["frame-ancestors", "This page does not allow being shown in a frame."],
    ["unreachable", "The page did not answer."],
  ] as const)("shows an actionable link card for %s", (reason, message) => {
    dispose = render(
      () => (
        <FrameView
          target={{ ...target, frameable: false, reason }}
          mode="inline"
        />
      ),
      container
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(getByText(container, message)).toBeTruthy();
    expect(
      getByRole(container, "link", { name: "Open" }).getAttribute("href")
    ).toBe("https://example.test/page");
  });
  it.each([
    ["http://localhost:5173", "http://localhost:3000", null],
    [
      "http://localhost:5173",
      "https://chat.test",
      "This page is on the agent's machine. Ask for a URL your browser can reach (tailnet or HTTPS).",
    ],
    [
      "https://chat.test/page",
      "https://chat.test",
      "This page cannot be shown inside this chat.",
    ],
    [
      "javascript:alert(1)",
      "https://chat.test",
      "This URL cannot be shown in a frame.",
    ],
  ])("uses browser guards when rendering %s on %s", (url, chat, reason) => {
    vi.stubGlobal("location", new URL(chat!));
    dispose = render(
      () => <FrameView target={{ ...target, finalUrl: url! }} mode="inline" />,
      container
    );
    if (reason) {
      expect(container.querySelector("iframe")).toBeNull();
      expect(getByText(container, reason)).toBeTruthy();
    } else {
      expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
        "http://localhost:5173"
      );
    }
  });
  it("reloads the final page after navigation and expands or collapses on request", () => {
    const [mode, setMode] = createSignal<"inline" | "panel">("inline");
    dispose = render(
      () => (
        <FrameView
          target={target}
          mode={mode()}
          onExpand={() => setMode("panel")}
          onCollapse={() => setMode("inline")}
        />
      ),
      container
    );
    const frame = getByTitle(
      container,
      "Example page web preview"
    ) as HTMLIFrameElement;
    frame.src = "https://example.test/navigated";
    getByRole(container, "button", { name: "Reload" }).click();
    expect(frame.src).toBe("https://example.test/page");
    getByRole(container, "button", { name: "Expand" }).click();
    getByRole(container, "button", { name: "Collapse" }).click();
    expect(getByRole(container, "button", { name: "Expand" })).toBeTruthy();
  });
});
