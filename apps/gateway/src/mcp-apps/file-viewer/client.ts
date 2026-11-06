import { marked } from "marked";
import DOMPurify from "dompurify";

type Rpc = { jsonrpc: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; data?: { reason?: string } } };
type FileInfo = { uri: string; fileId: string; filename: string; mimeType: string; size: number; title?: string };
const content = document.querySelector<HTMLElement>("main")!;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
let nextId = 0;
let reportFrame: HTMLIFrameElement | undefined;
let lastHeight = 0;
let renderGeneration = 0;
let disposed = false;
function post(message: Rpc) { window.parent.postMessage(message, "*"); }
function notify(method: string, params: Record<string, unknown> = {}) { post({ jsonrpc: "2.0", method, params }); }
function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("File request timed out")); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    post({ jsonrpc: "2.0", id, method, params });
  });
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function csvTable(text: string): DocumentFragment {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && (char === "," || char === "\n" || char === "\r")) {
      row.push(field); field = "";
      if (char !== ",") {
        rows.push(row); row = [];
        if (char === "\r" && text[index + 1] === "\n") index++;
      }
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const table = document.createElement("table");
  for (const [index, fields] of rows.slice(0, 500).entries()) {
    const tr = table.insertRow();
    for (const value of fields) {
      const cell = document.createElement(index === 0 ? "th" : "td");
      if (index === 0) cell.setAttribute("scope", "col");
      cell.textContent = value; tr.append(cell);
    }
  }
  const fragment = document.createDocumentFragment();
  fragment.append(table);
  if (rows.length > 500) {
    const note = document.createElement("p");
    note.textContent = "Showing the first 500 rows.";
    fragment.append(note);
  }
  return fragment;
}
function mimeType(file: FileInfo): string {
  const explicit = file.mimeType?.split(";")[0].trim().toLowerCase();
  if (explicit && explicit !== "application/octet-stream") return explicit;
  const ext = file.filename?.split(".").at(-1)?.toLowerCase() ?? "";
  const types: Record<string, string> = { html: "text/html", htm: "text/html", md: "text/markdown", markdown: "text/markdown", json: "application/json", csv: "text/csv", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  return types[ext] || (/^(txt|log|[cm]?[jt]sx?|py|rb|sh|bash|css|xml|ya?ml|toml|sql|rs|go|java|c|cpp|h)$/.test(ext) ? "text/plain" : explicit || "application/octet-stream");
}
function card(file: FileInfo, mime: string) {
  const name = document.createElement("strong");
  name.textContent = file.filename;
  const details = document.createElement("p");
  const unit = file.size >= 1024 * 1024 ? "MB" : file.size >= 1024 ? "KB" : "B";
  const size = unit === "MB" ? (file.size / (1024 * 1024)).toFixed(1) : unit === "KB" ? (file.size / 1024).toFixed(1) : file.size;
  details.textContent = `${mime} — ${size} ${unit}`;
  content.replaceChildren(name, details);
}
// Runs in the opaque report document; it has no access to viewer RPC.
function reportBridge() {
  function height() {
    const body = document?.body;
    if (!body) return;
    const style = getComputedStyle(body);
    const margin = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    window.parent.postMessage({ type: "yoplai-file-height", height: Math.max(body.scrollHeight, body.offsetHeight) + margin }, "*");
  }
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute("href") || "";
    if (href.startsWith("#")) {
      try {
        const id = decodeURIComponent(href.slice(1));
        if (!id) window.scrollTo(0, 0);
        else (document.getElementById(id) || document.getElementsByName(id)[0])?.scrollIntoView();
      } catch { /* Invalid fragments do nothing. */ }
      return;
    }
    try {
      const url = new URL(href);
      if (url.protocol === "http:" || url.protocol === "https:") window.parent.postMessage({ type: "yoplai-file-link", url: url.href }, "*");
    } catch { /* Relative and unsupported links do nothing. */ }
  }, true);
  function observe() {
    height();
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(height).observe(document.body);
    new MutationObserver(height).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe, { once: true }); else observe();
  window.addEventListener("load", height);
  window.addEventListener("resize", height);
}
function reportPage(html: string): string {
  const page = new DOMParser().parseFromString(html, "text/html");
  const policy = page.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  const resources = "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com";
  policy.content = `default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: ${resources}; font-src ${resources}; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const bridge = page.createElement("script");
  bridge.textContent = `(${reportBridge.toString()})()`;
  page.head.prepend(policy, bridge);
  return "<!doctype html>" + page.documentElement.outerHTML;
}
async function render(value: unknown) {
  const file = object(object(value).structuredContent) as FileInfo;
  if (typeof file.uri !== "string") return;
  const generation = ++renderGeneration;
  reportFrame = undefined;
  content.textContent = "Loading file…";
  try {
    const resource = object(await request("resources/read", { uri: file.uri }));
    if (generation !== renderGeneration) return;
    const item = object(Array.isArray(resource.contents) ? resource.contents[0] : undefined);
    const mime = mimeType(file);
    const textType = mime.startsWith("text/") || /^(application\/(json|javascript|x-javascript|xml|yaml|x-yaml|sql|toml|x-sh|typescript))$/.test(mime) || /\+(json|xml)$/.test(mime);
    if (!textType && !["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"].includes(mime)) { card(file, mime); return; }
    if (mime === "text/html" || mime === "application/xhtml+xml") {
      const frame = document.createElement("iframe");
      frame.title = file.title || file.filename;
      frame.setAttribute("sandbox", "allow-scripts");
      frame.style.height = "40px";
      frame.srcdoc = reportPage(String(item.text ?? ""));
      content.replaceChildren(frame);
      reportFrame = frame;
      return;
    }
    if (mime === "text/csv") {
      content.replaceChildren(csvTable(String(item.text ?? "")));
      return;
    }
    if (mime.startsWith("image/")) {
      const image = document.createElement("img");
      image.alt = file.title || file.filename;
      const encoded = typeof item.blob === "string" ? item.blob : btoa(Array.from(new TextEncoder().encode(String(item.text ?? "")), (byte) => String.fromCharCode(byte)).join(""));
      image.src = `data:${mime};base64,${encoded}`;
      content.replaceChildren(image);
      return;
    }
    if (mime === "text/markdown") {
      content.innerHTML = DOMPurify.sanitize(marked.parse(String(item.text ?? ""), { async: false }));
      return;
    }
    const pre = document.createElement("pre");
    let text = typeof item.text === "string" ? item.text : "";
    if (mime === "application/json" || mime.endsWith("+json")) {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Invalid JSON remains readable. */ }
    }
    pre.textContent = text;
    content.replaceChildren(pre);
  } catch (error) {
    if (generation !== renderGeneration) return;
    if (object(object(error).data).reason === "too_large") card(file, mimeType(file));
    else content.textContent = "Could not read this file. Send it again to retry.";
  } finally { if (generation === renderGeneration) sizeChanged(); }
}
function sizeChanged(measured = Math.max(content.scrollHeight, content.offsetHeight)) {
  if (disposed) return;
  const height = Math.max(40, Math.min(800, Math.ceil(measured)));
  if (height !== lastHeight) { lastHeight = height; notify("ui/notifications/size-changed", { height }); }
}
const sizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => sizeChanged()) : undefined;
sizeObserver?.observe(content);
content.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute("href") || "";
  if (href.startsWith("#")) {
    try { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView(); } catch { /* Invalid fragments do nothing. */ }
  } else openLink(href);
});
function openLink(raw: string) {
  if (disposed) return;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") void request("ui/open-link", { url: url.href }).catch(() => {});
  } catch { /* Relative links and non-HTTP schemes stay inside the report. */ }
}
window.addEventListener("message", (event: MessageEvent) => {
  if (!reportFrame || event.source !== reportFrame.contentWindow) return;
  const message = object(event.data);
  if (message.type === "yoplai-file-height" && typeof message.height === "number" && Number.isFinite(message.height)) {
    const height = Math.max(40, Math.min(800, Math.ceil(message.height)));
    reportFrame.style.height = `${height}px`;
    sizeChanged(height);
  } else if (message.type === "yoplai-file-link" && typeof message.url === "string") openLink(message.url);
});
window.addEventListener("message", (event: MessageEvent) => {
  if (disposed || event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
  const message = event.data as Rpc;
  if (typeof message.id === "number" && !message.method) {
    const call = pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timer); pending.delete(message.id);
    if (message.error) call.reject(message.error); else call.resolve(message.result);
  } else if (message.method === "ui/notifications/tool-result") { void render(message.params); }
  else if (message.method === "ui/resource-teardown" && message.id !== undefined) {
    post({ jsonrpc: "2.0", id: message.id, result: {} });
    disposed = true; renderGeneration++; reportFrame = undefined; sizeObserver?.disconnect();
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("View closed")); }
    pending.clear();
  }
});
void request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "Yoplai file viewer", version: "1" }, appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } }).then(() => notify("ui/notifications/initialized")).catch(() => { if (!disposed) content.textContent = "File viewer could not connect. Reload to retry."; });
