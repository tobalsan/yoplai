import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { shellHtml } from "./dashboard-view-shell.js";

/**
 * These tests run the shell script against a small fake window. They check what
 * the shell sends to its host, not how the script is written. The renderer is
 * untrusted: a message from it is a request or a claim, never authority. A real
 * browser must still prove that the parent policy confines the renderer.
 */

const ORIGIN = "http://127.0.0.1:3000";
const FRAME_PATH = "/api/relay/dashboard-views/handle/frame";
const INSTANCE = "instance-one";

type Posted = { message: Record<string, unknown>; targetOrigin: string };

function startShell(options: { topLevel?: boolean } = {}) {
  const html = shellHtml(FRAME_PATH, INSTANCE);
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const toHost: Posted[] = [];
  const toRenderer: Array<{ message: Record<string, unknown>; targetOrigin: string }> = [];
  const host = { postMessage: (message: Record<string, unknown>, targetOrigin: string) => toHost.push({ message, targetOrigin }) };
  const renderer = { postMessage: (message: Record<string, unknown>, targetOrigin: string) => toRenderer.push({ message, targetOrigin }) };
  const stranger = { postMessage: () => undefined };
  const listeners: Record<string, (event: object) => void> = {};
  const frameListeners: Record<string, () => void> = {};
  const attributes: Record<string, string> = {};
  let removed = false;
  let created = 0;
  const frameElement = {
    style: {} as Record<string, string>,
    contentWindow: renderer,
    src: "",
    setAttribute: (name: string, value: string) => { attributes[name] = value; },
    addEventListener: (type: string, handler: () => void) => { frameListeners[type] = handler; },
    remove: () => { removed = true; },
  };
  const appended: object[] = [];
  const body = { dataset: { frame: FRAME_PATH, instance: INSTANCE }, style: {} as Record<string, string>, append: (element: object) => appended.push(element) };
  const win: Record<string, unknown> = {
    addEventListener: (type: string, handler: (event: object) => void) => { listeners[type] = handler; },
  };
  win.parent = options.topLevel ? win : host;
  const context = {
    window: win,
    document: { body, createElement: () => { created += 1; return frameElement; } },
    location: { origin: ORIGIN },
    Object, JSON, Infinity,
  };
  vm.runInNewContext(script, context);
  const message = (data: unknown, source: object, origin = ORIGIN) => listeners.message?.({ data, source, origin });
  return {
    html, toHost, toRenderer, attributes, frameElement, appended, stranger, host, renderer,
    created: () => created,
    removed: () => removed,
    load: () => frameListeners.load(),
    fromRenderer: (data: unknown) => message(data, renderer, "null"),
    fromStranger: (data: unknown) => message(data, stranger, "null"),
    fromHost: (data: unknown, origin = ORIGIN) => message(data, host, origin),
    events: () => toHost.map((item) => item.message.event),
  };
}

const embedReady = { channel: "yoplai-embed", type: "ready" };
const annotateReady = { channel: "yoplai-annotate", type: "ready", id: "page", slug: "overview", agentId: "pretend-agent", title: "T", params: {} };

describe("trusted shell script", () => {
  it("creates one opaque renderer with the exact sandbox and the exact path, and reports to its host with the instance", () => {
    const shell = startShell();
    expect(shell.created()).toBe(1);
    expect(shell.appended).toHaveLength(1);
    expect(shell.attributes.sandbox).toBe("allow-scripts allow-downloads allow-modals");
    expect(shell.frameElement.src).toBe(FRAME_PATH);
    expect(shell.events()).toEqual(["shell-started"]);
    for (const { message, targetOrigin } of shell.toHost) {
      expect(message).toMatchObject({ channel: "yoplai-shell", instance: INSTANCE });
      expect(targetOrigin).toBe(ORIGIN);
    }
  });

  it("does nothing when it is the top-level document", () => {
    const shell = startShell({ topLevel: true });
    expect(shell.created()).toBe(0);
    expect(shell.toHost).toEqual([]);
  });

  it("reports readiness only after exactly one load and a ready message, in either order", () => {
    const loadFirst = startShell();
    loadFirst.load();
    expect(loadFirst.events()).toEqual(["shell-started", "renderer-loaded"]);
    loadFirst.fromRenderer(embedReady);
    expect(loadFirst.events()).toEqual(["shell-started", "renderer-loaded", "renderer-ready"]);
    const readyFirst = startShell();
    readyFirst.fromRenderer(embedReady);
    expect(readyFirst.events()).toEqual(["shell-started"]);
    readyFirst.load();
    expect(readyFirst.events()).toEqual(["shell-started", "renderer-loaded", "renderer-ready"]);
    // A document that never runs script stays unready.
    const silent = startShell();
    silent.load();
    expect(silent.events()).toEqual(["shell-started", "renderer-loaded"]);
    // Readiness is reported once.
    loadFirst.fromRenderer(embedReady);
    expect(loadFirst.events().filter((event) => event === "renderer-ready")).toHaveLength(1);
  });

  it("ends the instance on an extra load, removes the renderer, and ignores everything afterwards", () => {
    const shell = startShell();
    shell.load();
    shell.fromRenderer(embedReady);
    shell.load();
    expect(shell.events()).toEqual(["shell-started", "renderer-loaded", "renderer-ready", "ended"]);
    expect(shell.toHost.at(-1)!.message).toMatchObject({ event: "ended", reason: "extra_load" });
    expect(shell.removed()).toBe(true);
    const count = shell.toHost.length;
    shell.fromRenderer(embedReady);
    shell.fromRenderer({ channel: "yoplai-embed", type: "link", href: "https://example.test/" });
    shell.fromRenderer({ channel: "yoplai-annotate", type: "note" });
    shell.fromHost({ channel: "yoplai-shell", instance: INSTANCE, event: "annotation", message: { channel: "yoplai-annotate", type: "set", on: true } });
    shell.load();
    expect(shell.toHost).toHaveLength(count);
    expect(shell.toRenderer).toEqual([]);
  });

  it("ends when the first load is followed by a second before any ready message, so readiness cannot return", () => {
    const shell = startShell();
    shell.load();
    shell.load();
    shell.fromRenderer(embedReady);
    expect(shell.events()).toEqual(["shell-started", "renderer-loaded", "ended"]);
  });

  it("ends on a host request", () => {
    const shell = startShell();
    shell.load();
    shell.fromHost({ channel: "yoplai-shell", instance: INSTANCE, event: "end" });
    expect(shell.toHost.at(-1)!.message).toMatchObject({ event: "ended", reason: "host" });
    expect(shell.removed()).toBe(true);
  });

  it("accepts instructions only from its host, with its instance and its own origin", () => {
    const shell = startShell();
    shell.load();
    shell.fromRenderer(embedReady);
    const annotation = { channel: "yoplai-annotate", type: "set", on: true };
    const command = (extra: Record<string, unknown>) => ({ channel: "yoplai-shell", instance: INSTANCE, event: "annotation", message: annotation, ...extra });
    shell.fromHost(command({ instance: "another-instance" }));
    shell.fromHost(command({}), "null");
    shell.fromHost(command({}), "https://evil.example.test");
    shell.fromHost(command({ channel: "other" }));
    shell.fromStranger(command({}));
    shell.fromRenderer(command({}));
    shell.fromHost(command({ message: { channel: "other", type: "set" } }));
    shell.fromHost(command({ message: "set" }));
    shell.fromHost(command({ message: { channel: "yoplai-annotate", type: "set", pad: "x".repeat(17000) } }));
    expect(shell.toRenderer).toEqual([]);
    shell.fromHost(command({}));
    expect(shell.toRenderer).toEqual([{ message: annotation, targetOrigin: "*" }]);
    expect(shell.events()).not.toContain("ended");
  });

  it("does not relay a host instruction to a renderer that is not ready", () => {
    const shell = startShell();
    shell.fromHost({ channel: "yoplai-shell", instance: INSTANCE, event: "annotation", message: { channel: "yoplai-annotate", type: "set", on: true } });
    shell.load();
    shell.fromHost({ channel: "yoplai-shell", instance: INSTANCE, event: "annotation", message: { channel: "yoplai-annotate", type: "set", on: true } });
    expect(shell.toRenderer).toEqual([]);
  });

  it("turns a link click into a request only when ready, and forwards only the target text", () => {
    const shell = startShell();
    shell.load();
    shell.fromRenderer({ channel: "yoplai-embed", type: "link", href: "https://example.test/early" });
    expect(shell.events()).not.toContain("link-request");
    shell.fromRenderer(embedReady);
    shell.fromRenderer({ channel: "yoplai-embed", type: "link", href: `${ORIGIN}/api/relay/dashboard-views/${"S".repeat(32)}/?a=1`, dashboardId: "claimed", agentId: "claimed", meta: { annotation: true }, gateway: "claimed" });
    shell.fromRenderer({ channel: "yoplai-embed", type: "link", href: 5 });
    shell.fromRenderer({ channel: "yoplai-embed", type: "link", href: `https://example.test/${"x".repeat(2100)}` });
    const requests = shell.toHost.filter((item) => item.message.event === "link-request");
    expect(requests).toHaveLength(1);
    expect(requests[0].message).toEqual({ channel: "yoplai-shell", instance: INSTANCE, event: "link-request", href: `${ORIGIN}/api/relay/dashboard-views/${"S".repeat(32)}/?a=1` });
  });

  it("ignores messages from any window other than its renderer", () => {
    const shell = startShell();
    shell.load();
    shell.fromStranger(embedReady);
    shell.fromStranger({ channel: "yoplai-embed", type: "link", href: "https://example.test/" });
    expect(shell.events()).toEqual(["shell-started", "renderer-loaded"]);
    shell.fromRenderer(embedReady);
    shell.fromStranger({ channel: "yoplai-embed", type: "link", href: "https://example.test/" });
    shell.fromStranger({ channel: "yoplai-annotate", type: "note" });
    expect(shell.events()).toEqual(["shell-started", "renderer-loaded", "renderer-ready"]);
  });

  it("holds the annotation ready message that arrives before readiness and sends it once after readiness", () => {
    const shell = startShell();
    shell.fromRenderer(embedReady);
    shell.fromRenderer(annotateReady);
    expect(shell.events()).toEqual(["shell-started"]);
    shell.load();
    expect(shell.events()).toEqual(["shell-started", "renderer-loaded", "renderer-ready", "annotation"]);
    // The host receives the claim as a wrapped, untrusted message. It must not take the agent from it.
    expect(shell.toHost.at(-1)!.message).toEqual({ channel: "yoplai-shell", instance: INSTANCE, event: "annotation", message: annotateReady });
    shell.fromRenderer({ channel: "yoplai-annotate", type: "note", id: "n1" });
    expect(shell.toHost.at(-1)!.message).toMatchObject({ event: "annotation", message: { type: "note", id: "n1" } });
    shell.fromRenderer({ channel: "yoplai-annotate", type: "note", pad: "x".repeat(17000) });
    expect(shell.events().filter((event) => event === "annotation")).toHaveLength(2);
    // A held message from a document that loaded twice is gone.
    const twice = startShell();
    twice.fromRenderer(annotateReady);
    twice.load();
    twice.load();
    expect(twice.events()).toEqual(["shell-started", "renderer-loaded", "ended"]);
  });

  it("never lets a renderer message set the instance, the event, or a top-level claim in what it tells the host", () => {
    const shell = startShell();
    shell.load();
    shell.fromRenderer({ ...embedReady, instance: "forged", event: "renderer-ready", dashboardId: "x" });
    shell.fromRenderer({ channel: "yoplai-annotate", type: "note", instance: "forged", event: "ended", dashboardId: "x", agentId: "x" });
    for (const { message } of shell.toHost) {
      expect(message.instance).toBe(INSTANCE);
      expect(message).not.toHaveProperty("dashboardId");
      expect(message).not.toHaveProperty("agentId");
      expect(message).not.toHaveProperty("meta");
    }
    expect(shell.events()).toEqual(["shell-started", "renderer-loaded", "renderer-ready", "annotation"]);
  });
});
