import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentConfigSchema, GatewayConfigSchema, McpAppViewReferenceSchema } from "@yoplai/shared";
import { z } from "zod";

// ALG-708 Testing Decisions + Groom GO f321c105 approve tool execution/captured
// views: catches provenance, capture and URL restrictions; misses browser layout.
let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "extension-frame-"));
  vi.stubEnv("YOPLAI_HOME", home);
  vi.resetModules();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

async function fixture(url = "/x/questionnaire/form-one") {
  const agent = AgentConfigSchema.parse({ id: "interviewer", name: "Interviewer", workspace: path.join(home, "workspace"), model: { provider: "test", model: "test" } });
  const config = GatewayConfigSchema.parse({ agents: [agent] });
  const { ExtensionRuntime } = await import("./runtime.js");
  const runtime = new ExtensionRuntime();
  runtime.load([{
    id: "questionnaire", displayName: "Questionnaire", description: "Fixture", dependencies: [], routePrefixes: [],
    configSchema: z.object({}), validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes() {}, registerPageRoutes() {}, async start() {}, async stop() {}, capabilities: () => [],
    getAgentTools: () => [{ name: "ask", description: "Ask", parameters: {}, execute: async () => ({
      status: "open", frameView: { url, title: "Project choices", key: "form-one" },
    }) }],
  }]);
  const result = await runtime.executeTool(agent, "ask", {}, config, "conversation", undefined, undefined, undefined, { toolCallId: "ask-one" });
  const { getMcpAppView, readMcpAppRecord } = await import("../mcp-apps/capture.js");
  const scope = { agentId: agent.id, sessionId: "conversation" };
  return { result, view: getMcpAppView(scope, "ask-one"), record: await readMcpAppRecord(scope, "ask-one") };
}

it("captures an extension's own page as a keyed built-in frame and preserves its tool result", async () => {
  const { result, view, record } = await fixture();
  expect(result).toMatchObject({ found: true, result: { status: "open", frameView: { url: "/x/questionnaire/form-one", title: "Project choices", key: "form-one" } } });
  expect(McpAppViewReferenceSchema.parse(view)).toMatchObject({ server: "yoplai", tool: "extension-frame", resourceUri: "ui://yoplai/extension-frame", key: "questionnaire:form-one", title: "Project choices" });
  expect(record).toMatchObject({ result: { structuredContent: { extensionId: "questionnaire", url: "/x/questionnaire/form-one", title: "Project choices", key: "form-one" } } });
});

it.each([
  "https://foreign.example.test/x/questionnaire/form-one", "//foreign.example.test/form-one", "/api/admin/users",
  "/x/another/form-one", "/x/questionnaire-other/form-one", "/x/questionnaire/../another/form-one",
  "/x/questionnaire/%2e%2e/another/form-one", "/x/questionnaire/..\\another/form-one",
])("keeps a frame outside its extension page prefix text-only: %s", async (url) => {
  const { result, view, record } = await fixture(url);
  expect(result.found).toBe(true);
  expect(view).toBeUndefined();
  expect(record).toBeUndefined();
});
