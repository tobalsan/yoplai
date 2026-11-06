import { z } from "zod";
import type { Extension } from "@yoplai/shared";
import { captureYoplaiView, yoplaiPreviewView } from "./capture.js";
import { checkPreviewUrl } from "./web-preview.js";

const argsSchema = z.object({ url: z.string(), title: z.string().max(200).optional() });

export const webPreviewExtension: Extension = {
  id: "webPreview",
  displayName: "Web preview",
  description: "Show browser-reachable web pages in chat.",
  factory: true,
  dependencies: [],
  routePrefixes: [],
  configSchema: z.object({}),
  validateConfig: () => ({ valid: true, errors: [] }),
  registerRoutes: () => {},
  async start() {},
  async stop() {},
  capabilities: () => [],
  getAgentTools: () => [{
    name: "web_preview",
    core: true,
    description: "Show a live web page or local dev server in chat. The URL must be reachable from the user's browser. Use HTTPS, or HTTP for loopback hosts on the user's machine.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, title: { type: "string", maxLength: 200 } },
      required: ["url"],
    },
    mcp: { server: "yoplai", tool: "web_preview", ui: { resourceUri: yoplaiPreviewView.resourceUri, visibility: ["model"] } },
    async execute(args, context) {
      const input = argsSchema.parse(args);
      const checked = await checkPreviewUrl(input.url, context);
      context.signal?.throwIfAborted();
      const text = checked.frameable
        ? `Web preview shown: ${checked.finalUrl}`
        : `Web preview of ${checked.finalUrl}: link card shown (${checked.reason})`;
      const key = new URL(checked.finalUrl);
      key.hash = "";
      if (context.sessionId) await captureYoplaiView({ ...context, agentId: context.agent.id, sessionId: context.sessionId },
        yoplaiPreviewView, input, { content: [{ type: "text", text }], structuredContent: { ...input, ...checked } },
        { key: key.href, preview: { frameable: checked.frameable } });
      return text;
    },
  }],
};
