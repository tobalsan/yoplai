// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getByRole, getByTitle, queryAllByRole, queryByRole } from "@testing-library/dom";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { FrameView } from "./FrameView";
import { createDashboardAnnotations, DashboardAnnotationsContext } from "./dashboardAnnotations";

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
    const open = getByRole(container, "link", { name: "Open in browser" });
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

describe("dashboard annotation toggle", () => {
  const ready = { channel: "yoplai-annotate", type: "ready", id: "garden", slug: "garden.html", agentId: "agent-1", title: "Garden overview", params: {} };
  const renderAnnotated = () => {
    const annotations = createDashboardAnnotations(() => "agent-1");
    dispose = render(() => (
      <DashboardAnnotationsContext.Provider value={annotations}>
        <FrameView target={target} mode="panel" onCollapse={() => {}} />
      </DashboardAnnotationsContext.Provider>
    ), container);
    const frame = getByTitle(container, "Garden overview dashboard") as HTMLIFrameElement;
    const fromFrame = (data: unknown, source: Window | null = frame.contentWindow) =>
      window.dispatchEvent(new MessageEvent("message", { data, source }));
    return { annotations, frame, fromFrame };
  };

  it("offers Annotate only after the framed page itself announces the chat's agent", () => {
    const { fromFrame } = renderAnnotated();
    expect(queryByRole(container, "button", { name: "Annotate" })).toBeNull();
    fromFrame(ready, window);
    fromFrame({ ...ready, agentId: "agent-2" });
    expect(queryByRole(container, "button", { name: "Annotate" })).toBeNull();
    fromFrame(ready);
    expect(getByRole(container, "button", { name: "Annotate" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps one dashboard annotating at a time, re-sends the mode after the page reloads and leaves it when the page asks", () => {
    const annotations = createDashboardAnnotations(() => "agent-1");
    const other = { kind: "dashboard" as const, id: "orchard", title: "Orchard" };
    dispose = render(() => (
      <DashboardAnnotationsContext.Provider value={annotations}>
        <FrameView target={target} mode="inline" />
        <FrameView target={other} mode="panel" />
      </DashboardAnnotationsContext.Provider>
    ), container);
    const frames = [getByTitle(container, "Garden overview dashboard"), getByTitle(container, "Orchard dashboard")] as HTMLIFrameElement[];
    const sent = frames.map((frame) => {
      const messages: unknown[] = [];
      vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message: unknown) => { messages.push(message); });
      return messages;
    });
    frames.forEach((frame, index) => window.dispatchEvent(new MessageEvent("message", {
      data: { ...ready, id: index ? "orchard" : "garden" }, source: frame.contentWindow,
    })));
    const [gardenToggle, orchardToggle] = queryAllByRole(container, "button", { name: "Annotate" });
    gardenToggle.click();
    orchardToggle.click();
    expect(sent[0]).toEqual([{ channel: "yoplai-annotate", type: "set", on: true }, { channel: "yoplai-annotate", type: "set", on: false }]);
    expect(sent[1]).toEqual([{ channel: "yoplai-annotate", type: "set", on: true }]);
    expect([gardenToggle, orchardToggle].map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    window.dispatchEvent(new MessageEvent("message", { data: { ...ready, id: "orchard" }, source: frames[1].contentWindow }));
    expect(sent[1].at(-1)).toEqual({ channel: "yoplai-annotate", type: "set", on: true });
    window.dispatchEvent(new MessageEvent("message", { data: { channel: "yoplai-annotate", type: "exit" }, source: frames[1].contentWindow }));
    expect(orchardToggle.getAttribute("aria-pressed")).toBe("false");
    expect(sent[1].at(-1)).toEqual({ channel: "yoplai-annotate", type: "set", on: false });
  });

  it("stages at most 20 notes, clipping long untrusted text, and tells the page to drop markers it refused", () => {
    const { annotations, frame, fromFrame } = renderAnnotated();
    const sent: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message: unknown) => { sent.push(message); });
    fromFrame(ready);
    getByRole(container, "button", { name: "Annotate" }).click();
    const note = (id: string, body: Record<string, unknown> = {}) =>
      fromFrame({ channel: "yoplai-annotate", type: "note", id, selector: "p", tag: "p", text: "", heading: "", ancestor: "", note: "Bolder", ...body });
    note("long", { note: "b".repeat(600), text: "c".repeat(300), selector: "d".repeat(300) });
    note("not-text", { note: 42 });
    for (let index = 1; index < 21; index++) note(`n${index}`);
    expect(annotations.notes()).toHaveLength(20);
    expect(annotations.notes()[0]).toMatchObject({ note: `${"b".repeat(499)}…`, text: `${"c".repeat(119)}…`, selector: `${"d".repeat(199)}…` });
    expect(sent.at(-1)).toEqual({ channel: "yoplai-annotate", type: "remove", id: "n20" });
  });
});

