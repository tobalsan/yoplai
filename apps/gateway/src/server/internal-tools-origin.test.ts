import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { GatewayConfigSchema, type Extension } from "@yoplai/shared";
import { ExtensionRuntime } from "../extensions/runtime.js";
import { registerContainerToken, removeContainerToken } from "../sdk/container/tokens.js";
import { createInternalTools } from "./internal-tools.js";

afterEach(() => removeContainerToken("invented-container-token"));

it("delivers the host-owned origin to a container tool and ignores a forged request origin", async () => {
  const config = GatewayConfigSchema.parse({
    version: 2,
    agents: [{ id: "interviewer", name: "Interviewer", workspace: "/tmp/interviewer", model: { provider: "test", model: "test" } }],
    extensions: { sample: {} },
  });
  const extension: Extension = {
    id: "sample", displayName: "Sample", description: "Sample",
    dependencies: [], routePrefixes: [], configSchema: z.object({}),
    validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes() {}, async start() {}, async stop() {}, capabilities: () => [],
    getAgentTools: () => [{
      name: "sample_origin", description: "Show delivery origin", parameters: {},
      execute: (_args, context) => ({ origin: context.origin }),
    }],
  };
  const runtime = new ExtensionRuntime();
  runtime.load([extension]);
  registerContainerToken("invented-container-token", {
    agentId: "interviewer", sessionId: "conversation", runId: "run", containerName: "container",
    roots: { workspace: "/tmp/interviewer", data: "/tmp/data", uploads: "/tmp/uploads" },
    origin: { sink: "threadit", destination: { channel: "12:34" } },
  });
  const app = createInternalTools({ getConfig: () => config, getRuntime: () => runtime });
  const response = await app.request("/tools", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Id": "interviewer", "X-Agent-Token": "invented-container-token" },
    body: JSON.stringify({
      agentId: "interviewer", agentToken: "invented-container-token", sessionId: "conversation", tool: "sample_origin", args: {},
      origin: { sink: "slack", destination: { channel: "forged" } },
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ origin: { sink: "threadit", destination: { channel: "12:34" } } });
});
