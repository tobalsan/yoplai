import { createHash } from "node:crypto";

/**
 * The trusted shell of one remote dashboard view. It runs only the local code
 * below and holds one opaque renderer frame. Remote HTML never enters the
 * shell or the host page. The shell has one identity, the `instance` that the
 * prepare answer gave to the host, and it reports to the host with it.
 *
 * Everything that comes from the renderer is untrusted. The shell checks the
 * sender window and the size, then forwards a request to the host. It never
 * gives the renderer a way to select metadata, an agent, or a gateway.
 * The renderer loads once. A second load ends the instance.
 */
export const SHELL_CHANNEL = "yoplai-shell";

const SHELL_SCRIPT = `(function () {
  "use strict";
  var body = document.body;
  var host = window.parent;
  var origin = location.origin;
  var instance = body.dataset.instance;
  var CHANNEL = "yoplai-shell";
  var MAX_MESSAGE = 16384;
  var frame = null;
  var ended = false;
  var loads = 0;
  var readySeen = false;
  var ready = false;
  var heldAnnotation = null;
  var size = function (value) { try { return JSON.stringify(value).length; } catch (error) { return Infinity; } };
  var send = function (event, extra) {
    host.postMessage(Object.assign({ channel: CHANNEL, instance: instance, event: event }, extra || {}), origin);
  };
  var end = function (reason) {
    if (ended) return;
    ended = true;
    ready = false;
    heldAnnotation = null;
    if (frame) { frame.remove(); frame = null; }
    send("ended", { reason: reason });
  };
  var settle = function () {
    if (ended || ready || !readySeen || loads !== 1) return;
    ready = true;
    send("renderer-ready");
    if (heldAnnotation) { send("annotation", { message: heldAnnotation }); heldAnnotation = null; }
  };
  if (host === window) return;
  window.addEventListener("message", function (event) {
    if (ended) return;
    var data = event.data;
    if (event.source === host) {
      if (event.origin !== origin || !data || data.channel !== CHANNEL || data.instance !== instance) return;
      if (data.event === "end") end("host");
      else if (data.event === "annotation" && ready && frame && data.message && data.message.channel === "yoplai-annotate" && size(data.message) <= MAX_MESSAGE) {
        frame.contentWindow.postMessage(data.message, "*");
      }
      return;
    }
    if (!frame || event.source !== frame.contentWindow || !data || typeof data !== "object") return;
    if (data.channel === "yoplai-embed") {
      if (data.type === "ready") { readySeen = true; settle(); }
      else if (data.type === "link" && ready && typeof data.href === "string" && data.href.length <= 2048) send("link-request", { href: data.href });
    } else if (data.channel === "yoplai-annotate" && size(data) <= MAX_MESSAGE) {
      if (ready) send("annotation", { message: data });
      else if (data.type === "ready" && loads <= 1) heldAnnotation = data;
    }
  });
  body.style.margin = "0";
  frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-downloads allow-modals");
  frame.setAttribute("title", "Dashboard");
  frame.style.border = "0";
  frame.style.display = "block";
  frame.style.width = "100vw";
  frame.style.height = "100vh";
  frame.addEventListener("load", function () {
    if (ended) return;
    loads += 1;
    if (loads > 1) { end("extra_load"); return; }
    send("renderer-loaded");
    settle();
  });
  frame.src = body.dataset.frame;
  body.append(frame);
  send("shell-started");
})();`;

const SCRIPT_HASH = `sha256-${createHash("sha256").update(SHELL_SCRIPT).digest("base64")}`;

/** `p` is the exact renderer path. No query, no suffix, and no other path can match it. */
export function shellCsp(origin: string, framePath: string): string {
  return [
    "default-src 'none'",
    `script-src '${SCRIPT_HASH}'`,
    `frame-src ${origin}${framePath}`,
    "connect-src 'none'",
    "img-src 'none'",
    "style-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export function shellHtml(framePath: string, instance: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Dashboard</title></head>
<body data-frame="${framePath}" data-instance="${instance}"><script>${SHELL_SCRIPT}</script></body></html>
`;
}
