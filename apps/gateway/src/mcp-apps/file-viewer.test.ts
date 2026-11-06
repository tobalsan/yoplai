import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { getByRole, getAllByRole, getByTitle, queryByRole } from "@testing-library/dom";
import { fileViewerHtml } from "./file-viewer-page.js";

type Rpc = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const windows: JSDOM[] = [];
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); });

function viewer() {
  const host = new JSDOM("", { url: "https://apps.example.test" });
  windows.push(host);
  const messages: Rpc[] = [];
  host.window.postMessage = (message: Rpc) => { messages.push(message); };
  const dom = new JSDOM(fileViewerHtml, {
    url: "https://apps.example.test/content/fixture",
    runScripts: "dangerously",
    beforeParse(window) { Object.defineProperty(window, "parent", { value: host.window }); },
  });
  windows.push(dom);
  const send = (data: Rpc, source = host.window) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: source as unknown as Window }));
  async function ready() {
    await vi.waitFor(() => expect(messages.find((message) => message.method === "ui/initialize")).toBeDefined());
    const request = messages.find((message) => message.method === "ui/initialize")!;
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2026-01-26", hostContext: { displayMode: "inline", containerDimensions: { maxHeight: 800 } } } });
    await vi.waitFor(() => expect(messages.some((message) => message.method === "ui/notifications/initialized")).toBe(true));
  }
  async function read(filename: string, mimeType: string, size: number) {
    const previous = messages.length;
    send({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "File sent to user" }], structuredContent: { uri: "yoplai-file://file-one", fileId: "file-one", filename, mimeType, size } } });
    await vi.waitFor(() => expect(messages.slice(previous).some((message) => message.method === "resources/read")).toBe(true));
    return messages.slice(previous).find((message) => message.method === "resources/read")!;
  }
  async function result(filename: string, mimeType: string, text: string, blob = false) {
    const request = await read(filename, mimeType, text.length);
    send({ jsonrpc: "2.0", id: request.id, result: { contents: [{ uri: "yoplai-file://file-one", mimeType, ...(blob ? { blob: text } : { text }) }] } });
  }
  return { dom, host, messages, send, ready, read, result };
}

describe("built-in file viewer", () => {
  it.each([false, true])("loads Pele only for Markdown with a Mermaid fence (%s)", async (diagram) => {
    const app = viewer();
    await app.ready();
    await app.result("diagram.md", "text/markdown", diagram ? "```mermaid\ngraph TD\nA --> B\n```" : "# Plain note\n\nAvailable offline.");
    let frame!: HTMLIFrameElement;
    await vi.waitFor(() => { frame = getByTitle(app.dom.window.document.body, "diagram.md") as HTMLIFrameElement; });
    const report = new JSDOM(frame.srcdoc, { runScripts: "dangerously" });
    windows.push(report);
    expect(Array.from(report.window.document.querySelectorAll<HTMLScriptElement>("script[src]"), (script) => script.src)).toEqual(diagram ? ["https://cdn.jsdelivr.net/npm/pele@1.9.0/dist/pele.global.js"] : []);
    expect(app.dom.window.document.querySelector("script[src]")).toBeNull();
  });
  it("accepts PDF fallback only from its current PDF frame and recovers on the next file", async () => {
    const app = viewer();
    await app.ready();
    await app.result("damaged.pdf", "application/pdf", "JVBERg==", true);
    let frame!: HTMLIFrameElement;
    await vi.waitFor(() => { frame = getByTitle(app.dom.window.document.body, "damaged.pdf") as HTMLIFrameElement; });
    const fallback = (source: Window | null) => app.dom.window.dispatchEvent(new app.dom.window.MessageEvent("message", { data: { type: "yoplai-file-fallback" }, source }));
    fallback(app.host.window as unknown as Window);
    expect(frame.isConnected).toBe(true);
    fallback(frame.contentWindow);
    expect(getByRole(app.dom.window.document.body, "main").textContent).toContain("damaged.pdf");
    expect(frame.isConnected).toBe(false);
    for (const [name, mime, text] of [["note.md", "text/markdown", "# Still readable"], ["report.html", "text/html", "<h1>Report</h1>"]]) {
      await app.result(name, mime, text);
      let next!: HTMLIFrameElement;
      await vi.waitFor(() => { next = getByTitle(app.dom.window.document.body, name) as HTMLIFrameElement; });
      fallback(frame.contentWindow);
      fallback(next.contentWindow);
      expect(next.isConnected).toBe(true);
    }
  });
  it("keeps a PDF without binary content available as a file card", async () => {
    const app = viewer();
    await app.ready();
    await app.result("missing.pdf", "application/pdf", "");
    await vi.waitFor(() => expect(getByRole(app.dom.window.document.body, "main").textContent).toContain("missing.pdf"));
    expect(app.dom.window.document.querySelector("iframe")).toBeNull();
  });
  it.each(["application/pdf", "application/octet-stream"])("opens a %s PDF in an opaque frame and transfers its bytes after load", async (mime) => {
    const app = viewer();
    await app.ready();
    await app.result("sample.pdf", mime, "JVBERg==", true);
    let frame!: HTMLIFrameElement;
    await vi.waitFor(() => { frame = getByTitle(app.dom.window.document.body, "sample.pdf") as HTMLIFrameElement; });
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    const delivered = vi.fn<(message: { type: string; data: ArrayBuffer }, target: unknown, transfer?: Transferable[]) => void>();
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(delivered);
    frame.dispatchEvent(new app.dom.window.Event("load"));
    expect(delivered).toHaveBeenCalledTimes(1);
    const [message, target, transfer] = delivered.mock.calls[0];
    expect(message.type).toBe("yoplai-file-pdf");
    expect(Array.from(new Uint8Array(message.data))).toEqual([37, 80, 68, 70]);
    expect(target).toBe("*");
    expect(transfer).toEqual([message.data]);
  });
  it("initializes the stable protocol and reads a tool result as visible text", async () => {
    const app = viewer();
    await app.ready();
    expect(app.messages.find((message) => message.method === "ui/initialize")).toMatchObject({ params: { protocolVersion: "2026-01-26", appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } } });
    await app.result("note.txt", "text/plain", "Deployment ready <safe>");
    await vi.waitFor(() => expect(app.dom.window.document.body.textContent).toContain("Deployment ready <safe>"));
  });
  it("formats Markdown headings and tables while removing executable HTML", async () => {
    const app = viewer();
    await app.ready();
    await app.result("notes.md", "text/markdown", '# Release notes\n\n| Status | Count |\n| --- | --- |\n| Ready | 3 |\n\n<script>window.reportRan = true</script><img alt="Unsafe image" src=x onerror="window.reportRan = true">');
    let frame!: HTMLIFrameElement;
    await vi.waitFor(() => { frame = getByTitle(app.dom.window.document.body, "notes.md") as HTMLIFrameElement; });
    const report = new JSDOM(frame.srcdoc, { runScripts: "dangerously" });
    windows.push(report);
    expect(getByRole(report.window.document.body, "heading", { name: "Release notes" })).toBeDefined();
    expect(getByRole(report.window.document.body, "table").textContent).toContain("Ready");
    getByRole(report.window.document.body, "img", { name: "Unsafe image" }).dispatchEvent(new report.window.Event("error"));
    expect(Reflect.get(report.window, "reportRan")).toBeUndefined();
    expect(Reflect.get(app.dom.window, "reportRan")).toBeUndefined();
  });

  it("shows binary images and SVG with accessible names while SVG remains an image", async () => {
    const app = viewer();
    await app.ready();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
    await app.result("pixel.png", "image/png", png, true);
    await vi.waitFor(() => expect(getByRole(app.dom.window.document.body, "img", { name: "pixel.png" }).getAttribute("src")).toBe("data:image/png;base64," + png));
    await app.result("diagram.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"><script>window.svgRan=true</script><text>SVG content</text></svg>');
    await vi.waitFor(() => expect(getByRole(app.dom.window.document.body, "img", { name: "diagram.svg" }).getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/));
    expect(queryByRole(app.dom.window.document.body, "img", { name: "pixel.png" })).toBeNull();
    expect(Reflect.get(app.dom.window, "svgRan")).toBeUndefined();
    expect(app.dom.window.document.body.textContent).not.toContain("SVG content");
  });

  it("reads quoted CSV fields, embedded newlines and escaped quotes as table cells", async () => {
    const app = viewer();
    await app.ready();
    await app.result("people.csv", "text/csv", 'name,note\r\n"Doe, Jo","Line one\nLine two"\r\n"Say ""hi""",42');
    await vi.waitFor(() => expect(getByRole(app.dom.window.document.body, "table")).toBeDefined());
    expect(getByRole(app.dom.window.document.body, "columnheader", { name: "name" })).toBeDefined();
    expect(getByRole(app.dom.window.document.body, "cell", { name: "Doe, Jo" })).toBeDefined();
    expect(getByRole(app.dom.window.document.body, "cell", { name: "Line one\nLine two" })).toBeDefined();
    expect(getByRole(app.dom.window.document.body, "cell", { name: 'Say "hi"' })).toBeDefined();
  });

  it("limits CSV to its first 500 rows and explains truncation", async () => {
    const app = viewer();
    await app.ready();
    await app.result("large.csv", "text/csv", "name,value\n" + Array.from({ length: 501 }, (_, index) => "record-" + index + ",1").join("\n"));
    await vi.waitFor(() => expect(getAllByRole(app.dom.window.document.body, "row")).toHaveLength(500));
    expect(app.dom.window.document.body.textContent).toContain("Showing the first 500 rows.");
    expect(getByRole(app.dom.window.document.body, "cell", { name: "record-498" })).toBeDefined();
    expect(queryByRole(app.dom.window.document.body, "cell", { name: "record-499" })).toBeNull();
  });

  it("pretty prints JSON, keeps invalid JSON readable and infers missing types from filenames", async () => {
    const app = viewer();
    await app.ready();
    await app.result("summary.json", "application/octet-stream", '{"ready":true,"count":3}');
    await vi.waitFor(() => expect(getByRole(app.dom.window.document.body, "main").textContent).toBe('{\n  "ready": true,\n  "count": 3\n}'));
    await app.result("broken.json", "application/json", '{invalid');
    await vi.waitFor(() => expect(getByRole(app.dom.window.document.body, "main").textContent).toBe('{invalid'));
    await app.result("notes.MD", "", "# Readable notes");
    let frame!: HTMLIFrameElement;
    await vi.waitFor(() => { frame = getByTitle(app.dom.window.document.body, "notes.MD") as HTMLIFrameElement; });
    const report = new JSDOM(frame.srcdoc);
    windows.push(report);
    expect(getByRole(report.window.document.body, "heading", { name: "Readable notes" })).toBeDefined();
  });

  it("shows unsupported files as name, MIME type and size cards", async () => {
    const app = viewer();
    await app.ready();
    await app.result("archive.zip", "application/zip", "UEs=", true);
    await vi.waitFor(() => expect(getByRole(app.dom.window.document.body, "main").textContent).toContain("archive.zip"));
    expect(getByRole(app.dom.window.document.body, "main").textContent).toContain("application/zip");
    expect(getByRole(app.dom.window.document.body, "main").textContent).toContain("4 B");
    expect(getByRole(app.dom.window.document.body, "main").textContent).not.toContain("UEs=");
  });

  it("keeps oversized files readable as a metadata card after a too_large RPC error", async () => {
    const app = viewer();
    await app.ready();
    const request = await app.read("large-report.html", "text/html", 11 * 1024 * 1024);
    app.send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "too_large", data: { reason: "too_large" } } });
    await vi.waitFor(() => expect(getByRole(app.dom.window.document.body, "main").textContent).toContain("large-report.html"));
    expect(getByRole(app.dom.window.document.body, "main").textContent).toContain("text/html");
    expect(getByRole(app.dom.window.document.body, "main").textContent).toContain("11.0 MB");
  });

  it("reads code files with generic MIME as literal text while unknown archives remain cards", async () => {
    const app = viewer();
    await app.ready();
    await app.result("source.ts", "application/octet-stream", 'const html = "<button>Safe code</button>";');
    await vi.waitFor(() => expect(getByRole(app.dom.window.document.body, "main").textContent).toBe('const html = "<button>Safe code</button>";'));
    expect(queryByRole(app.dom.window.document.body, "button")).toBeNull();
    await app.result("bundle.zip", "application/octet-stream", "UEs=", true);
    await vi.waitFor(() => expect(getByRole(app.dom.window.document.body, "main").textContent).toContain("bundle.zip"));
    expect(getByRole(app.dom.window.document.body, "main").textContent).toContain("application/octet-stream");
  });

  it("renders HTML as a separate report document where author scripts still work", async () => {
    const app = viewer();
    await app.ready();
    await app.result("report.html", "text/html", '<!doctype html><html><head><style>h1{color:rgb(0, 128, 0)}</style></head><body><h1>Loading report</h1><script>document.querySelector("h1").textContent="Report script ran"</script></body></html>');
    let frame!: HTMLIFrameElement;
    await vi.waitFor(() => { frame = getByTitle(app.dom.window.document.body, "report.html") as HTMLIFrameElement; });
    const report = new JSDOM(frame.srcdoc, { runScripts: "dangerously" });
    windows.push(report);
    expect(getByRole(report.window.document.body, "heading", { name: "Report script ran" })).toBeDefined();
    expect(report.window.getComputedStyle(getByRole(report.window.document.body, "heading")).color).toBe("rgb(0, 128, 0)");
    expect(queryByRole(app.dom.window.document.body, "heading", { name: "Report script ran" })).toBeNull();
  });

  it("accepts only report heights and HTTP(S) link requests, dropping forged JSON-RPC", async () => {
    const app = viewer();
    await app.ready();
    await app.result("report.html", "text/html", "<h1>Report</h1>");
    let frame!: HTMLIFrameElement;
    await vi.waitFor(() => { frame = getByTitle(app.dom.window.document.body, "report.html") as HTMLIFrameElement; });
    const fromReport = (data: unknown, source = frame.contentWindow) => app.dom.window.dispatchEvent(new app.dom.window.MessageEvent("message", { data, source }));
    const before = app.messages.length;
    fromReport({ jsonrpc: "2.0", id: 991, method: "resources/read", params: { uri: "yoplai-file://another" } });
    fromReport({ jsonrpc: "2.0", id: 992, method: "ui/open-link", params: { url: "https://forged.example.test" } });
    fromReport({ type: "unknown-report-message", height: 200 });
    fromReport({ type: "yoplai-file-height", height: "200" });
    expect(app.messages.slice(before)).toEqual([]);
    fromReport({ type: "yoplai-file-height", height: 240 });
    expect(app.messages.at(-1)).toMatchObject({ method: "ui/notifications/size-changed", params: { height: 240 } });
    fromReport({ type: "yoplai-file-height", height: 5000 });
    expect(app.messages.at(-1)).toMatchObject({ method: "ui/notifications/size-changed", params: { height: 800 } });
    const validHeight = app.messages.length;
    fromReport({ type: "yoplai-file-height", height: Infinity });
    fromReport({ type: "yoplai-file-height", height: 200 }, app.dom.window as unknown as Window);
    expect(app.messages).toHaveLength(validHeight);
    fromReport({ type: "yoplai-file-link", url: "https://example.test/report" });
    expect(app.messages.at(-1)).toMatchObject({ method: "ui/open-link", params: { url: "https://example.test/report" } });
    const validLink = app.messages.length;
    for (const url of ["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "ftp://example.test", "#anchor"]) fromReport({ type: "yoplai-file-link", url });
    expect(app.messages).toHaveLength(validLink);
  });

  it("bridges report links safely and scrolls fragment anchors inside the report", async () => {
    const app = viewer();
    await app.ready();
    await app.result("links.html", "text/html", '<a href="#section">Inside</a><a href="https://example.test/read">Outside</a><a href="javascript:window.bad=true">Unsafe</a><a href="mailto:test@example.test">Email</a><h2 id="section">Section</h2>');
    let frame!: HTMLIFrameElement;
    await vi.waitFor(() => { frame = getByTitle(app.dom.window.document.body, "links.html") as HTMLIFrameElement; });
    const forwarded: Record<string, unknown>[] = [];
    const scroll = vi.fn();
    const report = new JSDOM(frame.srcdoc, {
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "parent", { value: { postMessage: (data: Record<string, unknown>) => forwarded.push(data) } });
        window.HTMLElement.prototype.scrollIntoView = scroll;
      },
    });
    windows.push(report);
    getByRole(report.window.document.body, "link", { name: "Inside" }).click();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0] === getByRole(report.window.document.body, "heading", { name: "Section" })).toBe(true);
    getByRole(report.window.document.body, "link", { name: "Outside" }).click();
    for (const name of ["Unsafe", "Email"]) getByRole(report.window.document.body, "link", { name }).click();
    expect(forwarded.filter((message) => message.type === "yoplai-file-link")).toEqual([{ type: "yoplai-file-link", url: "https://example.test/read" }]);
    await vi.waitFor(() => expect(forwarded.some((message) => message.type === "yoplai-file-height" && typeof message.height === "number")).toBe(true));
    expect(Reflect.get(report.window, "bad")).toBeUndefined();
  });

  it("reports short content height and routes Markdown links through the host", async () => {
    const app = viewer();
    await app.ready();
    await app.result("links.md", "text/markdown", 'A short note.\n\n[Read more](http://example.test/read) [Email](mailto:hello@example.test) [Inside](#section)\n\n<h2 id="section">Section</h2>');
    let frame!: HTMLIFrameElement;
    await vi.waitFor(() => { frame = getByTitle(app.dom.window.document.body, "links.md") as HTMLIFrameElement; });
    const scroll = vi.fn();
    const report = new JSDOM(frame.srcdoc, {
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "parent", { value: { postMessage: (data: unknown) => app.dom.window.dispatchEvent(new app.dom.window.MessageEvent("message", { data, source: frame.contentWindow })) } });
        window.HTMLElement.prototype.scrollIntoView = scroll;
      },
    });
    windows.push(report);
    getByRole(report.window.document.body, "link", { name: "Read more" }).click();
    expect(app.messages.at(-1)).toMatchObject({ method: "ui/open-link", params: { url: "http://example.test/read" } });
    const before = app.messages.length;
    getByRole(report.window.document.body, "link", { name: "Email" }).click();
    expect(app.messages).toHaveLength(before);
    getByRole(report.window.document.body, "link", { name: "Inside" }).click();
    expect(scroll.mock.contexts).toEqual([getByRole(report.window.document.body, "heading", { name: "Section" })]);
    await vi.waitFor(() => expect(app.messages.filter((message) => message.method === "ui/notifications/size-changed").at(-1)).toMatchObject({ params: { height: 40 } }));
  });

  it.each(["result", "error"])("keeps the latest file visible when an older read returns a late %s", async (outcome) => {
    const app = viewer();
    await app.ready();
    const old = await app.read("old.txt", "text/plain", 3);
    await app.result("new.txt", "text/plain", "Fresh result");
    await vi.waitFor(() => expect(getByRole(app.dom.window.document.body, "main").textContent).toBe("Fresh result"));
    app.send({ jsonrpc: "2.0", id: old.id, ...(outcome === "result" ? { result: { contents: [{ uri: "yoplai-file://file-one", mimeType: "text/plain", text: "Old result" }] } } : { error: { code: -32000, message: "Old read failed" } }) });
    await Promise.resolve(); await Promise.resolve();
    expect(getByRole(app.dom.window.document.body, "main").textContent).toBe("Fresh result");
  });

  it("times out a hung read and can render a later result while dropping its late reply", async () => {
    const app = viewer();
    await app.ready();
    vi.useFakeTimers();
    try {
      const old = await app.read("hung.txt", "text/plain", 4);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getByRole(app.dom.window.document.body, "main").textContent).toBe("Could not read this file. Send it again to retry.");
      await app.result("healthy.txt", "text/plain", "Chat and files still progress");
      await Promise.resolve(); await Promise.resolve();
      expect(getByRole(app.dom.window.document.body, "main").textContent).toBe("Chat and files still progress");
      app.send({ jsonrpc: "2.0", id: old.id, result: { contents: [{ uri: "yoplai-file://file-one", text: "Late stale file" }] } });
      await Promise.resolve(); await Promise.resolve();
      expect(getByRole(app.dom.window.document.body, "main").textContent).toBe("Chat and files still progress");
    } finally { vi.useRealTimers(); }
  });

  it("acknowledges resource teardown and ignores an outstanding resource reply", async () => {
    const app = viewer();
    await app.ready();
    const old = await app.read("retired.txt", "text/plain", 7);
    app.send({ jsonrpc: "2.0", id: "teardown", method: "ui/resource-teardown", params: {} });
    expect(app.messages.at(-1)).toEqual({ jsonrpc: "2.0", id: "teardown", result: {} });
    app.send({ jsonrpc: "2.0", id: old.id, result: { contents: [{ uri: "yoplai-file://file-one", text: "Retired file must not appear" }] } });
    await Promise.resolve(); await Promise.resolve();
    expect(getByRole(app.dom.window.document.body, "main").textContent).not.toContain("Retired file must not appear");
  });

});
