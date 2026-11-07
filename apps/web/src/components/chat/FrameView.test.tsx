// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getByRole, getByTitle } from "@testing-library/dom";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { FrameView } from "./FrameView";

let container: HTMLDivElement;
let dispose: () => void;
const target = { kind: "dashboard" as const, id: "garden", title: "Garden overview" };
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  dispose?.();
  container.remove();
});

describe("dashboard frame", () => {
  it("shows a dashboard from its own path with an opaque sandbox and no URL toolbar", () => {
    dispose = render(() => <FrameView target={target} mode="panel" onCollapse={() => {}} />, container);
    const frame = getByTitle(container, "Garden overview dashboard");
    expect(frame.getAttribute("src")).toBe("/d/garden");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const open = getByRole(container, "link", { name: "Open" });
    expect(open.getAttribute("href")).toBe("/d/garden");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.querySelector(".fa-table-columns")).not.toBeNull();
    expect(container.querySelector(".frame-view-toolbar")).toBeNull();
    expect(getByRole(container, "button", { name: "Collapse" })).toBeTruthy();
  });
  it("expands or collapses the dashboard on request", () => {
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
    getByRole(container, "button", { name: "Expand" }).click();
    getByRole(container, "button", { name: "Collapse" }).click();
    expect(getByRole(container, "button", { name: "Expand" })).toBeTruthy();
  });
});
