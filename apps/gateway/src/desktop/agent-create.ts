import { Hono } from "hono";
import { createAgentWriter } from "../agent-management/create.js";
import { AgentManagementError } from "../agent-management/files.js";
import type { createInstructionWriter } from "./agent-instructions.js";
import type { createModelAccess } from "./model-access.js";

export function createAgentRoutes(
  home: string,
  listModels: ReturnType<typeof createModelAccess>["listModels"],
  writeInstructions: ReturnType<typeof createInstructionWriter>,
) {
  const routes = new Hono();
  const create = createAgentWriter(home, listModels, writeInstructions);
  routes.post("/", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    try {
      const { agent, status } = await create(body, { creatorId: "local", onboarding: true });
      return c.json(agent, status);
    } catch (error) {
      if (error instanceof AgentManagementError) return c.json({ error: error.code, message: error.message }, error.status);
      throw error;
    }
  });
  return routes;
}
