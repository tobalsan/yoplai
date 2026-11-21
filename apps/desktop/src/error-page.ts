import { RESTART_URL } from "./links.js";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Local page with the failure reason, the log tail, and a Restart link. */
export function renderErrorPage(reason: string, logLines: string[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Yoplai</title>
<style>body{font-family:system-ui;margin:2rem;padding-top:40px;background:#000;color:#eee}
.drag-strip{position:fixed;inset:0 0 auto;height:40px;-webkit-app-region:drag}
pre{background:#000;padding:1rem;overflow:auto;max-height:60vh;font-size:12px}
a{-webkit-app-region:no-drag;display:inline-block;padding:.5rem 1rem;background:#3b82f6;color:#fff;border-radius:6px;text-decoration:none}</style>
</head><body><div class="drag-strip" aria-hidden="true"></div><h1>Yoplai could not start</h1><p>${escapeHtml(reason)}</p>
<p><a href="${RESTART_URL}">Restart</a></p>
<pre>${escapeHtml(logLines.join("\n"))}</pre></body></html>`;
}

export function errorPageUrl(reason: string, logLines: string[]): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(renderErrorPage(reason, logLines))}`;
}
