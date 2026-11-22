import fs from "node:fs/promises";
import path from "node:path";
import { ThinkLevelSchema, type AgentConfig } from "@yoplai/shared";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { getAuditActor, recordSettingsChange } from "../audit/store.js";
import { getAgent, isAgentActive, resolveWorkspaceDir } from "../config/index.js";
import type { createModelAccess } from "../desktop/model-access.js";
import { updateAgentConfig } from "../extensions/agent-config-writer.js";
import { reloadAfterExtensionWrite } from "../extensions/reload.js";
import { MAX_UPLOAD_SIZE_BYTES } from "../media/upload.js";
import { getSkillContext } from "../skills/context.js";
import { defaultsForAgent, isPersonalSkill } from "../skills/resolver.js";
import { enabledAgentSkills, SkillError, type SkillActor } from "../skills/types.js";
import { readWorkspaceSkills } from "../skills/workspace.js";
import { writeFileAtomic } from "../util/atomic-write.js";
import { serializeByKey } from "../util/serialize.js";
import { readManagementBody } from "./body.js";
import {
  AgentManagementError, defaultFaceSchema, isReservedText, modelChoiceSchema, readAgentOwner, readAvatarState,
  stageAvatar, writeAvatarState, type UploadedAvatar,
} from "./files.js";
import type { agentManagementRequest } from "./request.js";

const settingsPatch = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim(),
  model: modelChoiceSchema,
  fallbackModel: modelChoiceSchema.nullable(),
  reasoning: ThinkLevelSchema.nullable(),
  instructions: z.string(),
  avatar: defaultFaceSchema,
  public: z.boolean(),
}).partial().strict();
type SettingsPatch = z.infer<typeof settingsPatch>;

const userSkillsBody = z.object({ ids: z.array(z.string().min(1)) }).strict();
const agentSkillsBody = z.object({ disabled: z.array(z.string().min(1)) }).strict();

type Requester = Awaited<ReturnType<typeof agentManagementRequest>>;
type Deps = {
  requester(c: Context): Promise<Requester>;
  canChat(c: Context, id: string): Promise<boolean>;
  canManageVisibility(c: Context, id: string): Promise<boolean>;
  listModels: ReturnType<typeof createModelAccess>["listModels"];
};

const mutations = new Map<string, Promise<void>>();
const notFound = () => new AgentManagementError("not_found", 404, "Agent not found.");
const forbidden = () => new AgentManagementError("forbidden", 403, "You do not have permission to make this change.");
const invalid = () => new AgentManagementError("invalid_request", 400, "Check the agent fields.");

async function readInstructions(directory: string) {
  try {
    return await fs.readFile(path.join(directory, "AGENTS.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
}

async function workspaceSkills(agent: AgentConfig, actor: SkillActor, multiUser: boolean) {
  if (agent.sdk && agent.sdk !== "pi") return [];
  const { store } = await getSkillContext();
  const hidden = new Set(multiUser && actor.role !== "superadmin" ? await store.systemAgentSkills() : []);
  return (await readWorkspaceSkills({
    id: agent.id, name: agent.name, directory: path.join(resolveWorkspaceDir(agent.workspace), "skills"),
  })).filter((skill) => !hidden.has(skill.id));
}

async function userSkills(actor: SkillActor) {
  const { store, policy } = await getSkillContext();
  const personal = await policy.filterVisible((await store.list()).filter((row) => isPersonalSkill(row, actor.userId)), actor);
  return { store, personal };
}

function presentSkill(skill: { id: string; name: string; description: string }) {
  return { id: skill.id, name: skill.name, description: skill.description };
}

async function readSkills(agent: AgentConfig, actor: SkillActor, multiUser: boolean) {
  const { store, personal } = await userSkills(actor);
  const enabled = new Set(enabledAgentSkills(await store.getState(actor.userId), agent.id));
  const disabled = new Set(agent.skills?.disabled);
  const global = [...await store.builtins(), ...await defaultsForAgent(store, agent.id)];
  return {
    global: global.map(presentSkill),
    agent: (await workspaceSkills(agent, actor, multiUser)).map((skill) => ({ ...presentSkill(skill), enabled: !disabled.has(skill.name) })),
    user: personal.map((skill) => ({ ...presentSkill(skill), enabled: enabled.has(skill.id) })),
  };
}

async function writeSettings(agentId: string, directory: string, patch: SettingsPatch, upload?: UploadedAvatar) {
  const { instructions, avatar: face } = patch;
  const editsYaml = (["name", "description", "model", "fallbackModel", "reasoning", "avatar"] as const)
    .some((field) => patch[field] !== undefined);
  const nextAvatar = face === undefined ? undefined : await stageAvatar(directory, face, upload);
  let obsolete: string[] = [];
  if (editsYaml) {
    try {
      await updateAgentConfig(directory, (doc, raw) => {
        for (const key of ["name", "description"] as const) {
          if (patch[key] !== undefined) doc.set(key, patch[key]);
        }
        if (patch.model) {
          doc.setIn(["model", "provider"], patch.model.provider);
          doc.setIn(["model", "model"], patch.model.model);
        }
        if (patch.fallbackModel === null) {
          doc.delete("fallback_model");
        } else if (patch.fallbackModel) {
          doc.setIn(["fallback_model", "provider"], patch.fallbackModel.provider);
          doc.setIn(["fallback_model", "model"], patch.fallbackModel.model);
        }
        if (patch.reasoning === null) {
          doc.delete("reasoning");
          doc.delete("thinkLevel");
        } else if (patch.reasoning !== undefined) {
          doc.set("reasoning", patch.reasoning);
        }
        if (nextAvatar) {
          const previous = readAvatarState(directory, typeof raw.avatar === "string" ? raw.avatar : undefined);
          obsolete = previous.obsolete ?? [];
          if (previous.generatedFile) obsolete.push(previous.generatedFile);
          doc.set("avatar", nextAvatar.filename);
        }
      });
    } catch (error) {
      if (nextAvatar) await fs.rm(path.join(directory, nextAvatar.filename), { force: true });
      throw error;
    }
    if (nextAvatar) await writeAvatarState(directory, { ...nextAvatar, obsolete });
  }
  if (instructions !== undefined) await writeFileAtomic(path.join(directory, "AGENTS.md"), instructions);
  if (editsYaml || instructions !== undefined) {
    await reloadAfterExtensionWrite(nextAvatar && (async () => {
      if (getAgent(agentId)?.avatar !== nextAvatar.filename) throw new Error("Could not reload the agent avatar.");
    }));
  }
  if (nextAvatar && obsolete.length) {
    await Promise.all(obsolete.map((file) => fs.rm(path.join(directory, file), { force: true })));
    await writeAvatarState(directory, nextAvatar);
  }
}

export function createAgentSettingsRoutes(deps: Deps) {
  const routes = new Hono();
  const prefix = "/agents/:id/settings";
  const limit = bodyLimit({
    maxSize: MAX_UPLOAD_SIZE_BYTES,
    onError: (c) => c.json({ error: "body_too_large", message: "The request is too large." }, 413),
  });
  routes.onError((error, c) => {
    if (error instanceof AgentManagementError) return c.json({ error: error.code, message: error.message }, error.status);
    if (error instanceof SkillError) return c.json({ error: error.code }, error.status === 404 ? 404 : 400);
    return c.json({ error: "settings_failed", message: "Yoplai could not read or save the agent settings." }, 500);
  });

  async function resolve(c: Context) {
    const id = c.req.param("id");
    const agent = id && isAgentActive(id) ? getAgent(id) : undefined;
    if (!agent) throw notFound();
    if (!await deps.canChat(c, agent.id)) throw forbidden();
    const requester = await deps.requester(c);
    if (!requester.actor) throw forbidden();
    const directory = resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace);
    const owner = readAgentOwner(directory);
    const canEditAgent = requester.canEditAgent(owner);
    const runtime = requester.multiUser ? (await import("@yoplai/extension-multi-user")).getMultiUserRuntime() : undefined;
    const canSetPublic = !!runtime && canEditAgent && (requester.actor.userId === owner || await deps.canManageVisibility(c, agent.id));
    return { agent, actor: requester.actor, multiUser: requester.multiUser, canEditAgent, canSetPublic, directory, runtime };
  }

  routes.get(prefix, async (c) => {
    c.header("Cache-Control", "no-store");
    const { agent, actor, directory, multiUser, canEditAgent, canSetPublic, runtime } = await resolve(c);
    const avatar = readAvatarState(directory, agent.avatar);
    return c.json({
      canEditAgent, name: agent.name, description: agent.description,
      hasCustomAvatar: avatar.custom, defaultFace: avatar.face,
      ...(multiUser ? { public: runtime?.forks.getForkByAgentId(agent.id)?.public ?? true, canSetPublic } : {}),
      ...(canEditAgent ? {
        model: { provider: agent.model.provider, model: agent.model.model },
        fallbackModel: agent.fallback_model
          ? { provider: agent.fallback_model.provider, model: agent.fallback_model.model }
          : null,
        reasoning: agent.reasoning ?? agent.thinkLevel ?? null,
        instructions: await readInstructions(directory),
      } : {}),
      skills: await readSkills(agent, actor, multiUser),
    });
  });

  function saveSettings(avatarOnly = false, resetAvatar = false) {
    return async (c: Context) => {
      const { agent, actor, directory, canEditAgent, canSetPublic, runtime } = await resolve(c);
      if (!canEditAgent) throw forbidden();
      const { json, upload } = await readManagementBody(c);
      const parsed = settingsPatch.safeParse(json);
      if (!parsed.success || (upload && parsed.data.avatar === undefined)) throw invalid();
      const patch = parsed.data;
      if (avatarOnly && (patch.avatar === undefined || Object.keys(patch).length !== 1 || (resetAvatar && upload))) throw invalid();
      if (patch.public !== undefined && !canSetPublic) throw forbidden();
      if ([patch.name, patch.description, patch.instructions].some(isReservedText)) {
        throw new AgentManagementError("reserved_prefix", 400, "Remove the $env: or $secret: prefix.");
      }
      if (patch.model || patch.fallbackModel) {
        const choices = await deps.listModels();
        const available = (model: z.infer<typeof modelChoiceSchema> | null | undefined) =>
          !model || choices.some((choice) => choice.provider === model.provider && choice.model === model.model);
        if (!available(patch.model) || !available(patch.fallbackModel)) {
          throw new AgentManagementError("unavailable_model", 400, "Select a model from the list.");
        }
      }
      const audit = patch.public !== undefined ? await getAuditActor(c) : undefined;
      await serializeByKey(mutations, directory, async () => {
        if (patch.fallbackModel !== null && (patch.model || patch.fallbackModel)) {
          const current = getAgent(agent.id) ?? agent;
          const main = patch.model ?? current.model;
          const fallback = patch.fallbackModel ?? current.fallback_model;
          if (fallback && fallback.provider === main.provider && fallback.model === main.model) {
            throw new AgentManagementError("invalid_request", 400, "Select a fallback model different from the main model.");
          }
        }
        await writeSettings(agent.id, directory, patch, upload);
        if (patch.public !== undefined && runtime) {
          const before = runtime.forks.getForkByAgentId(agent.id)?.public ?? true;
          const after = runtime.forks.setPublic(agent.id, patch.public, actor.userId).public;
          if (before !== after) recordSettingsChange({
            ...audit, actorUserId: actor.userId, action: "admin.fork_visibility", targetType: "fork",
            targetId: agent.id, agentId: agent.id, changes: [{ field: "public", before, after }],
          });
          runtime.notifyAgentListChanged?.();
        }
      });
      return c.json({ ok: true });
    };
  }

  routes.patch(prefix, limit, saveSettings());
  routes.put(`${prefix}/avatar`, limit, saveSettings(true));
  routes.delete(`${prefix}/avatar`, limit, saveSettings(true, true));

  routes.put(`${prefix}/agent-skills`, limit, async (c) => {
    const { agent, actor, directory, canEditAgent, multiUser } = await resolve(c);
    if (!canEditAgent) throw forbidden();
    const body = agentSkillsBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw invalid();
    const visible = new Set((await workspaceSkills(agent, actor, multiUser)).map((skill) => skill.name));
    if (body.data.disabled.some((name) => !visible.has(name))) throw invalid();
    await serializeByKey(mutations, directory, async () => {
      await updateAgentConfig(directory, (doc, raw) => {
        const disabled = z.object({ disabled: z.array(z.string()) }).safeParse(raw.skills);
        const hidden = (disabled.data?.disabled ?? []).filter((name) => !visible.has(name));
        doc.setIn(["skills", "disabled"], [...new Set([...hidden, ...body.data.disabled])]);
      });
      await reloadAfterExtensionWrite();
    });
    return c.json({ ok: true });
  });

  routes.put(`${prefix}/user-skills`, limit, async (c) => {
    const { agent, actor } = await resolve(c);
    const body = userSkillsBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw invalid();
    const { store, personal } = await userSkills(actor);
    const readable = new Set(personal.map((row) => row.id));
    if (body.data.ids.some((id) => /^(?:builtin|default|agent):/.test(id))) throw new SkillError("skill_locked");
    if (body.data.ids.some((id) => !readable.has(id))) throw new SkillError("not_found", 404);
    await store.setAgentSkills(actor.userId, agent.id, body.data.ids);
    return c.json({ ok: true });
  });

  return routes;
}
