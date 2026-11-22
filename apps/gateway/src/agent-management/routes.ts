import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentYamlConfigSchema, type GatewayConfig } from "@yoplai/shared";
import { Hono, type Context } from "hono";
import yaml from "js-yaml";
import { z } from "zod";
import { allowsDesktopAgentDiscovery, getActiveAgents, resolveWorkspaceDir } from "../config/index.js";
import { avatarPath, pickSlug, withAgentsLock } from "../desktop/agent-create.js";
import { reloadAfterExtensionWrite } from "../extensions/reload.js";
import { getSkillContext, resolveSkillActor } from "../skills/context.js";
import { applyPatch, INSTRUCTIONS_FILE, OWNER_FILE, patchSchema, readInstructions, readOwner, type AgentPatch } from "./files.js";
import { canCreate, canEdit, isStaff, resolveMode, type ManagementMode, type Requester } from "./policy.js";

export type ModelRow = { provider: string; model: string; name: string; source: string; default: boolean; ready: boolean };

export type AgentManagementDeps = {
  home: string;
  getConfig: () => GatewayConfig;
  /** The signed-in requester, or undefined when a multi-user request has no session. */
  getRequester: (c: Context) => Promise<Requester | undefined>;
  listModels: () => Promise<ModelRow[]>;
  /** Chat access to the agent. Always true on a single-user gateway. */
  hasAgentAccess: (c: Context, agentId: string) => Promise<boolean>;
};

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(280).optional(),
  avatar: z.number().int().min(1).max(10).optional(),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict().optional(),
}).strict();

const rank = (source: string) => (source === "owned" ? 0 : source === "environment" ? 2 : 1);
const avatarName = (n: number) => `default-${n}.webp`;
const defaultModel = (models: ModelRow[]) => [...models].sort((a, b) => rank(a.source) - rank(b.source)).find((model) => model.default) ?? models[0];

export type ManagementStatus = { mode: ManagementMode; create: boolean; edit: boolean };

export async function managementStatus(deps: Pick<AgentManagementDeps, "getConfig">, requester: Requester | undefined): Promise<ManagementStatus> {
  const config = deps.getConfig();
  const mode = resolveMode(config, config.extensions?.multiUser?.enabled === true);
  const allowed = requester !== undefined && canCreate(mode, requester);
  return { mode, create: allowed, edit: allowed };
}

export function createAgentManagementRoutes(deps: AgentManagementDeps) {
  const routes = new Hono();
  const parent = path.join(deps.home, "agents");

  const gate = async (c: Context) => {
    const requester = await deps.getRequester(c);
    const config = deps.getConfig();
    const mode = resolveMode(config, config.extensions?.multiUser?.enabled === true);
    if (!requester) return { error: c.json({ error: "unauthorized" }, 401) } as const;
    if (!canCreate(mode, requester)) return { error: c.json({ error: "agent_management_disabled" }, 403) } as const;
    return { requester, mode, config } as const;
  };
  /** An agent the requester may edit. */
  const editable = async (c: Context, agentId: string) => {
    const allowed = await gate(c);
    if (allowed.error) return { error: allowed.error } as const;
    const agent = allowed.config.agents.find((candidate) => candidate.id === agentId);
    if (!agent) return { error: c.json({ error: "agent_not_found" }, 404) } as const;
    const workspace = resolveWorkspaceDir(agent.workspace);
    if (!canEdit(allowed.mode, allowed.requester, await readOwner(workspace))) return { error: c.json({ error: "forbidden" }, 403) } as const;
    return { ...allowed, agent, workspace } as const;
  };

  routes.get("/agent-management", async (c) => c.json(await managementStatus(deps, await deps.getRequester(c))));

  routes.get("/agent-management/models", async (c) => {
    const allowed = await gate(c);
    if ("error" in allowed) return allowed.error;
    const models = await deps.listModels().catch(() => undefined);
    return models ? c.json({ models }) : c.json({ error: "model_list_failed" }, 500);
  });

  routes.post("/agent-management/agents", async (c) => {
    const allowed = await gate(c);
    if ("error" in allowed) return allowed.error;
    const body = createSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const { name, description } = body.data;
    if ([name, description].some((value) => value && /^\$(?:env|secret):/.test(value))) return c.json({ error: "reserved_prefix" }, 400);
    const models = await deps.listModels().catch(() => undefined);
    if (!models) return c.json({ error: "model_list_failed" }, 500);
    const model = body.data.model ?? defaultModel(models);
    if (!model) return c.json({ error: "no_model", message: "No model has credentials. Add a provider key first." }, 409);
    if (!models.some((row) => row.provider === model.provider && row.model === model.model)) return c.json({ error: "unavailable_model" }, 400);
    try {
      const id = await withAgentsLock(parent, async () => {
        const slug = await pickSlug(parent, name);
        const finalDir = path.join(parent, slug);
        const stagingDir = path.join(deps.home, "run", `.agent-${randomUUID()}`);
        if (!allowsDesktopAgentDiscovery(finalDir, stagingDir)) throw Object.assign(new Error("discovery"), { code: "discovery_refused" });
        const avatar = avatarName(body.data.avatar ?? 1 + Math.floor(Math.random() * 10));
        const agent = AgentYamlConfigSchema.parse({ id: slug, name, description: description || undefined, avatar, model: { provider: model.provider, model: model.model } });
        await fs.mkdir(path.dirname(stagingDir), { recursive: true });
        await fs.mkdir(stagingDir, { mode: 0o700 });
        try {
          await fs.writeFile(path.join(stagingDir, "agent.yaml"), yaml.dump(agent));
          await fs.writeFile(path.join(stagingDir, INSTRUCTIONS_FILE), `You are ${name}.\n${description ? `Your purpose is: ${description}\n` : ""}Ask for details when you need them.\n`);
          await fs.copyFile(avatarPath(avatar), path.join(stagingDir, avatar));
          if (allowed.requester.userId) await fs.writeFile(path.join(stagingDir, OWNER_FILE), JSON.stringify({ userId: allowed.requester.userId }));
          await fs.rename(stagingDir, finalDir);
        } finally {
          await fs.rm(stagingDir, { recursive: true, force: true });
        }
        try {
          await reloadAfterExtensionWrite(async () => {
            if (!getActiveAgents().some((candidate) => candidate.id === slug)) throw new Error("not listed");
          });
        } catch (error) {
          await fs.rm(finalDir, { recursive: true, force: true });
          throw Object.assign(error as Error, { code: "reload_failed" });
        }
        return slug;
      });
      return c.json({ id }, 201);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "discovery_refused") return c.json({ error: code, message: "The discovery rules in yoplai.json do not include $YOPLAI_HOME/agents/*." }, 409);
      return c.json({ error: code ?? "write_failed", message: (error as Error).message }, 500);
    }
  });

  routes.get("/agent-management/agents/:id", async (c) => {
    const found = await editable(c, c.req.param("id"));
    if ("error" in found) return found.error;
    const { agent } = found;
    return c.json({
      id: agent.id, name: agent.name, description: agent.description ?? "", role: agent.role ?? "",
      avatar: agent.avatar ?? null, model: agent.model, reasoning: agent.reasoning ?? null,
      instructions: await readInstructions(found.workspace), disabledSkills: agent.skills?.disabled ?? [],
    });
  });

  routes.patch("/agent-management/agents/:id", async (c) => {
    const found = await editable(c, c.req.param("id"));
    if ("error" in found) return found.error;
    const body = patchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const patch: AgentPatch = body.data;
    if (patch.skills && !canToggleAgentSkills(found.requester)) return c.json({ error: "skills_require_admin" }, 403);
    if (patch.model && (patch.model.provider !== found.agent.model.provider || patch.model.model !== found.agent.model.model)) {
      const models = await deps.listModels().catch(() => undefined);
      if (!models) return c.json({ error: "model_list_failed" }, 500);
      if (!models.some((row) => row.provider === patch.model!.provider && row.model === patch.model!.model)) return c.json({ error: "unavailable_model" }, 400);
    }
    try {
      const avatar = patch.avatar === undefined ? undefined : { name: avatarName(patch.avatar), source: avatarPath(avatarName(patch.avatar)) };
      await applyPatch(found.workspace, patch, avatar);
      await reloadAfterExtensionWrite();
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: "write_failed", message: (error as Error).message }, 500);
    }
  });

  /** An agent that the requester can chat with. Any signed-in user with access may set their own user skills. */
  const accessible = async (c: Context, agentId: string) => {
    const requester = await deps.getRequester(c);
    if (!requester) return { error: c.json({ error: "unauthorized" }, 401) } as const;
    const config = deps.getConfig();
    const agent = config.agents.find((candidate) => candidate.id === agentId);
    if (!agent || !(await deps.hasAgentAccess(c, agentId))) return { error: c.json({ error: "agent_not_found" }, 404) } as const;
    const mode = resolveMode(config, config.extensions?.multiUser?.enabled === true);
    const workspace = resolveWorkspaceDir(agent.workspace);
    const canEditAgent = canEdit(mode, requester, await readOwner(workspace));
    return { requester, agent, workspace, canEditAgent } as const;
  };
  /** Workspace skills are admin work on a multi-user gateway, even for the owner of the agent. */
  const canToggleAgentSkills = (requester: Requester) => !requester.multiUser || isStaff(requester);

  /** User skills that the requester can read. Own skills and skills that others share. */
  const readableUserSkills = async (userId: string | undefined) => {
    const { store, policy } = await getSkillContext();
    const actor = await resolveSkillActor(userId);
    if (!actor) return { store, actor, rows: [] };
    const rows = [];
    for (const skill of await store.list()) {
      const mine = skill.ownerId === actor.userId;
      if (!skill.disabledByAdmin && (mine || skill.shares.some((share) => share.kind === "all" || share.id === actor.userId)) && await policy.canRead(skill, actor)) rows.push(skill);
    }
    return { store, actor, rows };
  };

  // The skills of one agent, in three levels: gateway (always on), agent workspace (on by default), user (off by default).
  routes.get("/agent-management/agents/:id/skills", async (c) => {
    const found = await accessible(c, c.req.param("id"));
    if (found.error) return found.error;
    const disabled = new Set(found.agent.skills?.disabled ?? []);
    const locked = !(found.canEditAgent && canToggleAgentSkills(found.requester));
    const { store, actor, rows } = await readableUserSkills(found.requester.userId);
    const gateway = [...await store.builtins(), ...(await store.defaults()).filter((skill) => !skill.agents || skill.agents.includes(found.agent.id))]
      .map((skill) => ({ level: "gateway" as const, name: skill.name, description: skill.description, enabled: true, locked: true }));
    const { loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent");
    const workspace = loadSkillsFromDir({ dir: path.join(found.workspace, "skills"), source: "workspace" }).skills
      .map((skill) => ({ level: "agent" as const, name: skill.name, description: skill.description, enabled: !disabled.has(skill.name), locked }));
    const on = new Set(actor ? (await store.getState(actor.userId)).agents?.[found.agent.id] ?? [] : []);
    const user = rows.map((skill) => ({ level: "user" as const, id: skill.id, name: skill.name, description: skill.description, enabled: on.has(skill.id), locked: false }));
    return c.json({ canEditAgent: found.canEditAgent, skills: [...gateway, ...workspace, ...user] });
  });

  // The requester chooses which of their user skills apply to this agent.
  routes.put("/agent-management/agents/:id/user-skills", async (c) => {
    const found = await accessible(c, c.req.param("id"));
    if (found.error) return found.error;
    const body = z.object({ enabled: z.array(z.string()).max(500) }).strict().safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const { store, actor, rows } = await readableUserSkills(found.requester.userId);
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    const known = new Set(rows.map((skill) => skill.id));
    if (!body.data.enabled.every((id) => known.has(id))) return c.json({ error: "unknown_skill" }, 400);
    await store.setAgentSkills(actor.userId, found.agent.id, body.data.enabled);
    return c.json({ ok: true });
  });

  return routes;
}
