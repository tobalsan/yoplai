import {
  HeartbeatExtensionConfigSchema,
  type Extension,
  type ExtensionContext,
} from "@yoplai/shared";
import type { Hono } from "hono";
import {
  areHeartbeatsEnabled,
  clearHeartbeatContext,
  containsHeartbeatToken,
  evaluateHeartbeatReply,
  getActiveHeartbeats,
  getHeartbeatIntervalMs,
  isHeartbeatEnabled,
  onHeartbeatEvent,
  parseDurationMs,
  runHeartbeat,
  setHeartbeatContext,
  setHeartbeatsEnabled,
  startAllHeartbeats,
  startHeartbeat,
  stopAllHeartbeats,
  stopHeartbeat,
  stripHeartbeatToken,
} from "./runner.js";

let extensionContext: ExtensionContext | null = null;

function getContext(): ExtensionContext {
  if (!extensionContext) {
    throw new Error("Heartbeat extension context not initialized");
  }
  return extensionContext;
}

const heartbeatExtension: Extension = {
  id: "heartbeat",
  displayName: "Heartbeat",
  factory: true,
  description: "Periodic heartbeat checks and alert runs",
  dependencies: [],
  configSchema: HeartbeatExtensionConfigSchema,
  routePrefixes: ["/api/agents/:id/heartbeat"],
  validateConfig(raw) {
    const result = HeartbeatExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success ? [] : result.error.issues.map((issue) => issue.message),
    };
  },
  registerRoutes(app: Hono) {
    app.post("/agents/:id/heartbeat", async (c) => {
      const ctx = getContext();
      const agentId = c.req.param("id");
      const agent = ctx.getAgent(agentId);
      if (!agent || !ctx.isAgentActive(agentId)) {
        return c.json({ error: "Agent not found" }, 404);
      }

      const result = await runHeartbeat(agentId);
      return c.json(result);
    });
  },
  async start(ctx: ExtensionContext) {
    extensionContext = ctx;
    setHeartbeatContext(ctx);
    startAllHeartbeats();
  },
  async stop() {
    stopAllHeartbeats();
    clearHeartbeatContext();
    extensionContext = null;
  },
  capabilities() {
    return ["heartbeat"];
  },
};

export { heartbeatExtension };

export {
  runHeartbeat,
  startHeartbeat,
  stopHeartbeat,
  startAllHeartbeats,
  stopAllHeartbeats,
  setHeartbeatsEnabled,
  areHeartbeatsEnabled,
  isHeartbeatEnabled,
  getHeartbeatIntervalMs,
  getActiveHeartbeats,
  onHeartbeatEvent,
  parseDurationMs,
  stripHeartbeatToken,
  containsHeartbeatToken,
  evaluateHeartbeatReply,
};
