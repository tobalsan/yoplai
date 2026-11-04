import type { Extension } from "@yoplai/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { getMediaFileMetadata, resolveMediaFilePath } from "../media/metadata.js";
import type { McpAppRecord } from "./capture.js";
import { fileViewerHtml } from "./file-viewer-page.js";

function unavailable(): never {
  throw Object.assign(new Error("File unavailable"), { name: "McpAppsError", reason: "not_app_visible" });
}

export function createFileAppProvider(record: McpAppRecord): NonNullable<Extension["mcpApps"]> {
  return {
    async readResource(context, _server, uri) {
      if (uri === "ui://yoplai/file-viewer") return { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: fileViewerHtml,
        _meta: { ui: { prefersBorder: true, csp: {
          resourceDomains: ["https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://unpkg.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
          connectDomains: [], frameDomains: [],
        } } },
      }] };
      const file = record.result.structuredContent;
      if (!file || typeof file !== "object" || !("uri" in file) || uri !== file.uri || !uri.startsWith("yoplai-file://")) unavailable();
      const metadata = await getMediaFileMetadata(uri.slice("yoplai-file://".length));
      if (!metadata || metadata.agentId !== record.agentId) unavailable();
      context.signal?.throwIfAborted();
      const filePath = await resolveMediaFilePath(metadata);
      const maxBytes = 10 * 1024 * 1024;
      const tooLarge = () => { throw Object.assign(new Error("File exceeds 10 MiB"), { name: "McpAppsError", reason: "too_large" }); };
      if ((await fs.stat(filePath)).size > maxBytes) tooLarge();
      const bytes = await fs.readFile(filePath, { signal: context.signal });
      if (bytes.length > maxBytes) tooLarge();
      const mime = metadata.mimeType.split(";")[0].trim().toLowerCase();
      const text = mime.startsWith("text/") || /^(application\/(json|javascript|x-javascript|xml|yaml|x-yaml|sql|toml|x-sh|typescript)|image\/svg\+xml)$/.test(mime) || /\+(json|xml)$/.test(mime)
        || /\.(html?|md|markdown|txt|log|json|csv|svg|[cm]?[jt]sx?|py|rb|sh|bash|css|xml|ya?ml|toml|sql|rs|go|java|c|cpp|h)$/i.test(path.extname(metadata.filename));
      return { contents: [{ uri, mimeType: metadata.mimeType, ...(text ? { text: bytes.toString("utf8") } : { blob: bytes.toString("base64") }) }] };
    },
    async callTool() { throw Object.assign(new Error("File app has no tools"), { name: "McpAppsError", reason: "not_app_visible" }); },
  };
}
