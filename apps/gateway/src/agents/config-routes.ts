import fs from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { getAgent, isAgentActive, resolveWorkspaceDir } from "../config/index.js";
import { updateAgentProfile } from "../extensions/agent-config-writer.js";
import { reloadAfterExtensionWrite } from "../extensions/reload.js";
import type { AgentConfigAccess } from "./config-access.js";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(280).optional(),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict().optional(),
  instructions: z.string().max(20000).optional(),
  globalSkills: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: "empty_patch" });

const reservedPrefix = /^\$(?:env|secret):/;

export type AgentConfigRouteDeps = {
  /** Access of the requester. `staff` shows the model and instructions in multi-user mode. */
  requester(c: Context): Promise<{ access: AgentConfigAccess; staff: boolean }>;
  listModels(): Promise<{ provider: string; model: string }[]>;
};

const failures = {
  invalid_request: [400, "Check the agent fields."],
  reserved_prefix: [400, "Remove the $env: or $secret: prefix."],
  unavailable_model: [400, "Select a model from the list."],
  agent_config_disabled: [403, "Agent editing is off on this gateway."],
  model_list_failed: [500, "Yoplai could not read the model list. Try again."],
  write_failed: [500, "Yoplai could not save the agent. Try again."],
} as const;

function findAgent(id: string) {
  return isAgentActive(id) ? getAgent(id) : undefined;
}

async function readInstructions(dir: string): Promise<string> {
  return fs.readFile(path.join(dir, "AGENTS.md"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

async function detail(agent: NonNullable<ReturnType<typeof getAgent>>, access: AgentConfigAccess, showDetails: boolean) {
  const dir = resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace);
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    globalSkills: agent.globalSkills === true,
    ...(showDetails ? {
      model: { provider: agent.model.provider ?? null, model: agent.model.model },
      instructions: await readInstructions(dir),
    } : {}),
    access,
  };
}

/** Routes under `/api/agents`: `GET|PATCH /:id/config`. The caller mounts them after the agent access check. */
export function createAgentConfigRoutes(deps: AgentConfigRouteDeps) {
  const routes = new Hono();
  const fail = (c: Context, error: keyof typeof failures) => {
    const [status, message] = failures[error];
    return c.json({ error, message }, status);
  };

  routes.get("/:id/config", async (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const { access, staff } = await deps.requester(c);
    return c.json(await detail(agent, access, access.edit || staff));
  });

  routes.patch("/:id/config", async (c) => {
    const id = c.req.param("id");
    const { access, staff } = await deps.requester(c);
    if (!access.edit) return fail(c, "agent_config_disabled");
    if (!findAgent(id)) return c.json({ error: "Agent not found" }, 404);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return fail(c, "invalid_request");
    const body = parsed.data;
    if ([body.name, body.description].some((value) => value && reservedPrefix.test(value))) return fail(c, "reserved_prefix");
    if (body.model) {
      const models = await deps.listModels().catch(() => undefined);
      if (!models) return fail(c, "model_list_failed");
      if (!models.some(({ provider, model }) => provider === body.model?.provider && model === body.model?.model)) return fail(c, "unavailable_model");
    }
    const agent = findAgent(id)!;
    const dir = resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace);
    try {
      const profile = { name: body.name, description: body.description, model: body.model, globalSkills: body.globalSkills };
      if (Object.values(profile).some((value) => value !== undefined)) {
        await updateAgentProfile(dir, profile);
        await reloadAfterExtensionWrite();
      }
      if (body.instructions !== undefined) await fs.writeFile(path.join(dir, "AGENTS.md"), body.instructions);
    } catch {
      return fail(c, "write_failed");
    }
    return c.json(await detail(findAgent(id) ?? agent, access, access.edit || staff));
  });

  return routes;
}
