import fs from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { getAgent, resolveWorkspaceDir } from "../config/index.js";
import { reloadAfterExtensionWrite } from "../extensions/reload.js";
import { updateAgentCoreConfig } from "../extensions/agent-config-writer.js";
import {
  canEditAgentConfig,
  effectiveAgentManagementMode,
  readCreatorUserId,
} from "./agent-management.js";

type AuthContext = {
  user: { id: string; role?: string | string[] | null };
} | null;

export type AgentConfigRouteDeps = {
  isMultiUser: () => boolean;
  getAuthContext: (c: Context) => Promise<AuthContext>;
  canManageAgent: (auth: AuthContext, agentId: string) => Promise<boolean>;
  hasAgentAccess: (auth: AuthContext, agentId: string) => Promise<boolean>;
  listModels: () => Promise<{ provider: string; model: string }[]>;
};

const putSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    description: z.string().max(280).nullable().optional(),
    avatar: z.string().max(200).optional(),
    model: z
      .object({ provider: z.string().min(1), model: z.string().min(1) })
      .strict()
      .optional(),
    reasoning: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
      .optional(),
    queueMode: z.enum(["queue", "interrupt"]).optional(),
    globalSkills: z.boolean().optional(),
    instructions: z.string().max(50_000).optional(),
  })
  .strict();

function workspaceOf(agentId: string): string | null {
  const agent = getAgent(agentId);
  if (!agent) return null;
  return resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace);
}

async function permission(
  c: Context,
  deps: AgentConfigRouteDeps,
  agentId: string
): Promise<{ allowed: boolean; canEdit: boolean; workspace: string }> {
  const workspace = workspaceOf(agentId);
  if (!workspace) return { allowed: false, canEdit: false, workspace: "" };
  const multiUser = deps.isMultiUser();
  if (!multiUser) return { allowed: true, canEdit: true, workspace };
  const auth = await deps.getAuthContext(c);
  const mode = effectiveAgentManagementMode(true);
  const creator = await readCreatorUserId(workspace);
  const isCreator = Boolean(auth && creator && auth.user.id === creator);
  const canManage = auth ? await deps.canManageAgent(auth, agentId) : false;
  const canEdit = canEditAgentConfig(mode, auth?.user.role, {
    canManage,
    isCreator,
  });
  const allowed = canEdit || (await deps.hasAgentAccess(auth, agentId));
  return { allowed, canEdit, workspace };
}

async function readInstructions(workspace: string): Promise<string> {
  return (
    (await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8").catch(() => ""))
  );
}

async function readSkills(workspace: string) {
  const dir = path.join(workspace, "skills");
  const { loadSkillsFromDir } = await import(
    "@earendil-works/pi-coding-agent"
  );
  return loadSkillsFromDir({ dir, source: "workspace" }).skills.map(
    (skill) => ({
      name: skill.name,
      description: skill.description,
    })
  );
}

export function createAgentConfigRoutes(deps: AgentConfigRouteDeps) {
  const routes = new Hono();

  routes.get("/:agentId/config", async (c) => {
    const agentId = c.req.param("agentId");
    const agent = getAgent(agentId);
    if (!agent) return c.json({ error: "not_found" }, 404);
    const { allowed, canEdit, workspace } = await permission(c, deps, agentId);
    if (!allowed) return c.json({ error: "forbidden" }, 403);
    return c.json({
      id: agent.id,
      name: agent.name,
      description: agent.description ?? null,
      avatar: agent.avatar ?? null,
      model: agent.model ?? null,
      reasoning: agent.reasoning ?? null,
      queueMode: agent.queueMode ?? "queue",
      globalSkills: agent.globalSkills ?? false,
      instructions: await readInstructions(workspace),
      skills: await readSkills(workspace),
      canEdit,
    });
  });

  routes.put("/:agentId/config", async (c) => {
    const agentId = c.req.param("agentId");
    const agent = getAgent(agentId);
    if (!agent) return c.json({ error: "not_found" }, 404);
    const { canEdit, workspace } = await permission(c, deps, agentId);
    if (!canEdit) return c.json({ error: "forbidden" }, 403);
    const parsed = putSchema.safeParse(
      (await c.req.json().catch(() => undefined)) ?? {}
    );
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    if (
      body.model &&
      !(await (async () => {
        const models = await deps.listModels().catch(() => []);
        return models.some(
          (m) => m.provider === body.model!.provider && m.model === body.model!.model
        );
      })())
    ) {
      return c.json({ error: "unavailable_model" }, 400);
    }
    try {
      await updateAgentCoreConfig(workspace, {
        name: body.name,
        description: body.description ?? undefined,
        avatar: body.avatar,
        model: body.model,
        reasoning: body.reasoning,
        queueMode: body.queueMode,
        globalSkills: body.globalSkills,
      });
      if (body.instructions !== undefined) {
        await fs.writeFile(
          path.join(workspace, "AGENTS.md"),
          body.instructions.endsWith("\n") || body.instructions === ""
            ? body.instructions
            : `${body.instructions}\n`
        );
      }
      await reloadAfterExtensionWrite();
    } catch {
      return c.json({ error: "write_failed" }, 500);
    }
    return c.json({ ok: true });
  });

  return routes;
}
