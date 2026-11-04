import { createComputed, createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createAppViews, viewKey, type AppViewCall } from "./appViews";

const drawing = { server: "fixture", tool: "draw", resourceUri: "ui://drawing" };
const call = (id: string, ref = true): AppViewCall => ({
  id, timestamp: 1, view: drawing, result: ref ? { view: { ...drawing, recordId: id } } : undefined,
});
const fileView = { server: "yoplai", tool: "send_file", resourceUri: "ui://yoplai/file-viewer" };
const fileCall = (id: string, filename: string): AppViewCall => ({
  id, timestamp: 1, view: fileView,
  result: { view: { ...fileView, recordId: id, file: { fileId: id, filename, mimeType: "text/markdown", size: 957 } } },
});

describe("app views", () => {
  it("separates filenames and reuses an exact filename without changing non-file keys", () => {
    createRoot((dispose) => {
      const a = fileCall("a-v1", "a.md");
      const b = fileCall("b-v1", "b.md");
      const aAgain = fileCall("a-v2", "a.md");
      const views = createAppViews(() => "session", () => [a, b, aAgain]);
      expect(viewKey(a.result!.view!)).toBe("yoplai\nui://yoplai/file-viewer\na.md");
      expect(viewKey(b.result!.view!)).toBe("yoplai\nui://yoplai/file-viewer\nb.md");
      expect(viewKey(drawing)).toBe("fixture\nui://drawing");
      expect([views.roleOf("a-v1"), views.roleOf("b-v1"), views.roleOf("a-v2")]).toEqual(["host", "host", "link"]);
      expect(views.viewOf("a-v1")?.latest.id).toBe("a-v2");
      views.open("yoplai\nui://yoplai/file-viewer\nb.md");
      expect(views.panel()?.latest.id).toBe("b-v1");
      expect(views.roleOf("a-v1")).toBe("host");
      dispose();
    });
  });
  it("hides only the delivered file and restores superseded or failed view cards", () => {
    createRoot((dispose) => {
      const first = fileCall("a-v1", "a.md");
      const [calls, setCalls] = createSignal([first]);
      const views = createAppViews(() => "session", calls);
      const key = "yoplai\nui://yoplai/file-viewer\na.md";
      expect(views.hidesFileCard("a-v1")).toBe(false);
      expect(views.shownFileOf(key)).toBeUndefined();
      expect(views.fileOf("a-v1")).toEqual({ fileId: "a-v1", filename: "a.md", mimeType: "text/markdown", size: 957 });
      views.reportShown(key, "a-v1");
      expect(views.hidesFileCard("a-v1")).toBe(true);
      expect(views.shownFileOf(key)?.fileId).toBe("a-v1");
      setCalls([first, fileCall("a-v2", "a.md")]);
      expect(views.hidesFileCard("a-v1")).toBe(true);
      expect(views.hidesFileCard("a-v2")).toBe(false);
      views.reportShown(key, "a-v2");
      expect(views.hidesFileCard("a-v1")).toBe(false);
      expect(views.hidesFileCard("a-v2")).toBe(true);
      expect(views.shownFileOf(key)?.fileId).toBe("a-v2");
      expect(views.hidesFileCard("unknown")).toBe(false);
      views.reportShown(key, undefined);
      expect(views.hidesFileCard("a-v2")).toBe(false);
      expect(views.shownFileOf(key)).toBeUndefined();
      dispose();
    });
  });
  it("resets shown files on a session change even when call ids are reused", () => {
    createRoot((dispose) => {
      const [session, setSession] = createSignal("one");
      const views = createAppViews(session, () => [fileCall("report", "report.md")]);
      const key = "yoplai\nui://yoplai/file-viewer\nreport.md";
      views.reportShown(key, "report");
      expect(views.hidesFileCard("report")).toBe(true);
      setSession("two");
      expect(views.hidesFileCard("report")).toBe(false);
      expect(views.shownFileOf(key)).toBeUndefined();
      setSession("one");
      expect(views.hidesFileCard("report")).toBe(false);
      dispose();
    });
  });
  it("retains shown metadata and the panel's current file through empty or stale history", () => {
    createRoot((dispose) => {
      const first = fileCall("a-v1", "a.md");
      const second = fileCall("a-v2", "a.md");
      const [calls, setCalls] = createSignal([first, second]);
      const views = createAppViews(() => "session", calls);
      const key = "yoplai\nui://yoplai/file-viewer\na.md";
      views.open(key);
      views.reportShown(key, "a-v1");
      setCalls([]);
      expect(views.fileOf("a-v1")?.fileId).toBe("a-v1");
      expect(views.fileOf("a-v2")?.fileId).toBe("a-v2");
      expect(views.hidesFileCard("a-v1")).toBe(true);
      views.reportShown(key, "a-v2");
      expect(views.hidesFileCard("a-v1")).toBe(false);
      expect(views.hidesFileCard("a-v2")).toBe(true);
      setCalls([first]);
      expect(views.shownFileOf(key)?.fileId).toBe("a-v2");
      expect(views.fileOf("a-v2")?.fileId).toBe("a-v2");
      views.reportShown(key, "a-v2");
      expect(views.hidesFileCard("a-v2")).toBe(true);
      views.close();
      expect(views.fileOf("a-v2")?.fileId).toBe("a-v2");
      dispose();
    });
  });
  it("deduplicates captured history/live sends while pending and failed sends stay outside file views", () => {
    createRoot((dispose) => {
      const pending = { id: "pending", timestamp: 1, view: fileView };
      const failed = { id: "failed", timestamp: 1, view: fileView, result: {} };
      const views = createAppViews(() => "session", () => [
        { ...fileCall("a-v1", "a.md"), history: true },
        { ...pending, id: "a-v1" },
        fileCall("b-v1", "b.md"),
        pending, failed,
        fileCall("a-v2", "a.md"),
        { ...pending, id: "a-v2" },
      ]);
      expect(views.isLiveDuplicate("a-v1")).toBe(true);
      expect(views.viewOf("a-v1")?.calls.map((item) => item.id)).toEqual(["a-v1", "a-v2"]);
      expect([views.roleOf("pending"), views.roleOf("failed")]).toEqual(["none", "none"]);
      expect(views.fileOf("a-v1")?.fileId).toBe("a-v1");
      views.open("yoplai\nui://yoplai/file-viewer");
      expect(views.panel()).toBeUndefined();
      const aKey = "yoplai\nui://yoplai/file-viewer\na.md";
      const bKey = "yoplai\nui://yoplai/file-viewer\nb.md";
      views.reportShown(aKey, "a-v1");
      views.reportShown(bKey, "b-v1");
      expect(views.hidesFileCard("a-v1")).toBe(true);
      expect(views.hidesFileCard("b-v1")).toBe(true);
      views.reportShown(aKey, "a-v2");
      expect(views.hidesFileCard("a-v1")).toBe(false);
      expect(views.hidesFileCard("a-v2")).toBe(true);
      expect(views.hidesFileCard("b-v1")).toBe(true);
      views.reportShown(aKey, undefined);
      expect(views.hidesFileCard("a-v2")).toBe(false);
      expect(views.hidesFileCard("b-v1")).toBe(true);
      dispose();
    });
  });
  it("does not restore a panel when returning to a previous session", () => {
    createRoot((dispose) => {
      const [session, setSession] = createSignal("one");
      const views = createAppViews(session, () => [call("a")]);
      views.open("fixture\nui://drawing");
      expect(views.panel()?.latest.id).toBe("a");
      setSession("two");
      expect(views.panel()).toBeUndefined();
      setSession("one");
      expect(views.panel()).toBeUndefined();
      expect(views.roleOf("a")).toBe("host");
      dispose();
    });
  });
  it("keeps an open panel on its newest call through empty and stale projections, then resets with the session", () => {
    createRoot((dispose) => {
      const [session, setSession] = createSignal("one");
      const [calls, setCalls] = createSignal([call("a"), call("b")]);
      const views = createAppViews(session, calls);
      views.open("fixture\nui://drawing");
      expect(views.roleOf("a")).toBe("panel-card");
      expect(views.panel()?.latest.id).toBe("b");
      setCalls([]);
      expect(views.panel()?.latest.id).toBe("b");
      setCalls([call("a")]);
      expect(views.panel()?.latest.id).toBe("b");
      setCalls([call("a"), call("b"), call("c")]);
      expect(views.panel()?.latest.id).toBe("c");
      setSession("two");
      expect(views.panel()).toBeUndefined();
      dispose();
    });
  });
  it("hosts the first successful call and links later calls to its latest data", () => {
    createRoot((dispose) => {
      const views = createAppViews(() => "session", () => [call("a"), call("b"), call("c")]);
      expect(viewKey(drawing)).toBe("fixture\nui://drawing");
      expect([views.roleOf("a"), views.roleOf("b"), views.roleOf("c")]).toEqual(["host", "link", "link"]);
      expect(views.viewOf("a")?.latest.id).toBe("c");
      dispose();
    });
  });
  it("moves the inline host on pagination while panel subscribers keep the latest data", () => {
    createRoot((dispose) => {
      const [calls, setCalls] = createSignal([call("b")]);
      const views = createAppViews(() => "session", calls);
      const delivered: string[] = [];
      createComputed(() => {
        const latest = views.panel()?.latest.id;
        if (latest) delivered.push(latest);
      });
      views.open("fixture\nui://drawing");
      expect(delivered.at(-1)).toBe("b");
      setCalls([call("a"), call("b")]);
      expect(views.roleOf("a")).toBe("panel-card");
      expect(views.roleOf("b")).toBe("link");
      expect(delivered.at(-1)).toBe("b");
      setCalls([call("a"), call("b"), call("c")]);
      expect(delivered.at(-1)).toBe("c");
      setCalls([call("a"), call("b")]);
      expect(views.panel()?.latest.id).toBe("c");
      views.close();
      expect(views.roleOf("a")).toBe("host");
      expect(views.panel()).toBeUndefined();
      dispose();
    });
  });
  it("does not replace the panel's latest call with an unseen stale call at the same timestamp", () => {
    createRoot((dispose) => {
      const [calls, setCalls] = createSignal([call("a"), call("c")]);
      const views = createAppViews(() => "session", calls);
      views.open("fixture\nui://drawing");
      expect(views.panel()?.latest.id).toBe("c");
      setCalls([call("a"), call("b")]);
      expect(views.panel()?.latest.id).toBe("c");
      setCalls([call("a"), call("b"), call("c"), call("d")]);
      expect(views.panel()?.latest.id).toBe("d");
      dispose();
    });
  });
  it("deduplicates history/live calls and keeps failed or pending calls from becoming a host", () => {
    createRoot((dispose) => {
      const failed = { ...call("failed", false), result: {} };
      const other = { ...call("other"), result: { view: { ...drawing, resourceUri: "ui://other", recordId: "other" } } };
      const views = createAppViews(() => "session", () => [failed, call("a"), other, call("a"), call("pending", false)]);
      expect(views.viewOf("a")?.calls.map((item) => item.id)).toEqual(["failed", "a", "pending"]);
      expect([views.roleOf("failed"), views.roleOf("a"), views.roleOf("pending"), views.roleOf("other")]).toEqual(["link", "host", "link", "host"]);
      expect(views.viewOf("pending")?.latest.id).toBe("a");
      expect(views.roleOf("unknown")).toBe("none");
      dispose();
    });
  });
  it("keeps interleaved apps separate and replaces or closes the selected panel", () => {
    createRoot((dispose) => {
      const other = (id: string): AppViewCall => ({
        ...call(id),
        view: { ...drawing, server: "other" },
        result: { view: { ...drawing, server: "other", recordId: id } },
      });
      const views = createAppViews(() => "session", () => [call("a"), other("x"), call("b"), other("y")]);
      expect([views.roleOf("a"), views.roleOf("x"), views.roleOf("b"), views.roleOf("y")]).toEqual(["host", "host", "link", "link"]);
      expect(views.viewOf("a")?.latest.id).toBe("b");
      expect(views.viewOf("x")?.latest.id).toBe("y");
      views.open("fixture\nui://drawing");
      expect(views.roleOf("a")).toBe("panel-card");
      expect(views.roleOf("x")).toBe("host");
      views.open("other\nui://drawing");
      expect(views.panel()?.key).toBe("other\nui://drawing");
      expect(views.roleOf("a")).toBe("host");
      expect(views.roleOf("x")).toBe("panel-card");
      views.close();
      expect(views.panel()).toBeUndefined();
      expect(views.roleOf("x")).toBe("host");
      dispose();
    });
  });
  it("waits for the first captured result and prefers captured duplicate data over a pending copy", () => {
    createRoot((dispose) => {
      const failed = { ...call("failed", false), result: {} };
      const [calls, setCalls] = createSignal([failed, call("pending", false)]);
      const views = createAppViews(() => "session", calls);
      expect(views.roleOf("failed")).toBe("none");
      expect(views.roleOf("pending")).toBe("none");
      views.open("fixture\nui://drawing");
      expect(views.panel()).toBeUndefined();
      setCalls([failed, call("second"), call("second", false), call("pending", false), { ...call("late-failure", false), result: {} }]);
      expect(views.roleOf("second")).toBe("host");
      expect(views.viewOf("second")?.calls.map((item) => item.id)).toEqual(["failed", "second", "pending", "late-failure"]);
      expect(views.viewOf("pending")?.latest.id).toBe("second");
      setCalls([failed, call("second", false), call("second"), call("third")]);
      expect(views.roleOf("second")).toBe("host");
      expect(views.viewOf("second")?.latest.id).toBe("third");
      dispose();
    });
  });
});
