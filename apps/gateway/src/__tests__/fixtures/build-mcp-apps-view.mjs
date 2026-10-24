// Run from repository root: env -u YOPLAI_HOME node apps/gateway/src/__tests__/fixtures/build-mcp-apps-view.mjs
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

const webRequire = createRequire(new URL("../../../../web/package.json", import.meta.url));
const { build } = await import(pathToFileURL(webRequire.resolve("vite")).href);
const result = await build({
  configFile: false,
  logLevel: "warn",
  build: {
    write: false,
    lib: { entry: fileURLToPath(new URL("./mcp-apps-view.ts", import.meta.url)), formats: ["iife"], name: "McpAppFixture" },
    minify: "esbuild",
  },
});
const output = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk");
if (!output) throw new Error("No fixture bundle produced");
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MCP App SDK fixture</title>
<style>body{font:14px system-ui;margin:12px;color:#18202a;background:#fff}h1{font-size:18px}nav{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;padding:8px}pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}</style></head>
<body><h1>Fixture drawing</h1><nav aria-label="Fixture actions"><button id="app-tool">Call app-only tool</button><button id="model-tool">Call model-only tool</button><button id="forge">Forge bootstrap message</button><button id="resize">Resize to 600 px</button><button id="hang">Read hung resource</button></nav><pre id="state" aria-label="Fixture state"></pre>
<script>${output.code.replace(/^[\t ]+$/gm, "").replaceAll("</script", "<\\/script")}</script></body></html>\n`;
await writeFile(new URL("./mcp-apps-view.html", import.meta.url), html);
console.log(`Built SDK fixture (${Buffer.byteLength(html)} bytes)`);
