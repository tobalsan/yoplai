import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentYamlConfigSchema } from "@yoplai/shared";
import yaml from "js-yaml";
import { z } from "zod";
import { allowsDesktopAgentDiscovery, DEFAULT_AGENT_DISCOVERY, desktopDiscoveryCaseAliases, getActiveAgents, getAgents, getConfigPath, isAgentActive, loadConfig } from "../config/index.js";
import { reloadAfterExtensionWrite } from "../extensions/reload.js";
import type { createInstructionWriter } from "../desktop/agent-instructions.js";
import type { createModelAccess } from "../desktop/model-access.js";
import { writeJsonAtomic } from "../util/atomic-write.js";

import { AgentManagementError, creatorFile, defaultFaceSchema, isReservedText, matchesModelChoice, modelChoiceSchema, readAgentOwner, stageAvatar, writeAvatarState, type UploadedAvatar } from "./files.js";

const bodySchema = z.object({
  requestId: z.string().uuid().transform((id) => id.toLowerCase()),
  name: z.string().trim().min(1).max(60),
  purpose: z.string().max(280).optional(),
  avatar: defaultFaceSchema,
  model: modelChoiceSchema,
  folder: z.string().trim().min(1).max(4096).optional(),
}).strict();

type AgentBody = z.infer<typeof bodySchema>;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const markerFile = ".desktop-create.json";
const markerSchema = z.object({ requestId: z.string().uuid(), instructions: z.enum(["model", "template"]) });
type Instructions = { text: string; source: z.infer<typeof markerSchema>["instructions"] };
type FoundAgent = { id: string; instructions: Instructions["source"] };

async function readRequest(finalDir: string, requestId: string, options: CreateOptions): Promise<FoundAgent | undefined> {
  const raw = await fs.readFile(path.join(finalDir, markerFile), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return;
  let marker: z.infer<typeof markerSchema>;
  try { marker = markerSchema.parse(JSON.parse(raw)); } catch { return; }
  if (marker.requestId !== requestId) return;
  const owner = readAgentOwner(finalDir);
  if (owner === options.creatorId || (!owner && options.onboarding)) {
    return { id: path.basename(finalDir), instructions: marker.instructions };
  }
}

async function findRequest(parent: string, requestId: string, options: CreateOptions): Promise<FoundAgent | undefined> {
  const dirs = await fs.readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const dir of dirs) {
    if (!dir.isDirectory() || !slugPattern.test(dir.name)) continue;
    const found = await readRequest(path.join(parent, dir.name), requestId, options);
    if (found) return found;
  }
}

async function resolveCustomFolder(folder: string) {
  const rule = folder.replace(/\/+$/, "");
  const expanded = rule.startsWith("~") ? path.join(os.homedir(), rule.slice(1)) : rule;
  const id = path.basename(expanded);
  if (!path.isAbsolute(expanded) || /[*?[\]{}]/.test(rule) || rule.includes("\0") || !slugPattern.test(id) || id === "status" || id === "sessions") {
    throw new AgentCreateError("invalid_folder");
  }
  const parent = await fs.realpath(path.dirname(expanded)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new AgentCreateError("folder_parent_missing");
    throw error;
  });
  if (!(await fs.stat(parent)).isDirectory()) throw new AgentCreateError("folder_parent_missing");
  const finalDir = path.join(parent, id);
  const target = await fs.lstat(finalDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (target && !target.isDirectory()) throw new AgentCreateError("folder_not_empty");
  const realTarget = target ? await fs.realpath(finalDir) : finalDir;
  const entries = target ? await fs.readdir(finalDir, { withFileTypes: true }) : [];
  return { id, finalDir, realTarget, rule, entries };
}

type CustomFolder = Awaited<ReturnType<typeof resolveCustomFolder>>;

async function checkCustomFolder({ id, finalDir, realTarget, entries }: CustomFolder, access?: CreateAccess) {
  const agents = getAgents();
  for (const agent of agents) {
    const workspace = await fs.realpath(agent.workspace).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!workspace) continue;
    const relative = path.relative(workspace, realTarget);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      throw new AgentCreateError("folder_inside_agent");
    }
  }
  if (entries.length) throw new AgentCreateError("folder_not_empty");
  if (agents.some((agent) => agent.id.toLowerCase() === id) ||
    desktopDiscoveryCaseAliases(path.dirname(finalDir)).includes(id) || access?.hasRow(id)) {
    throw new AgentCreateError("agent_id_used");
  }
}

async function appendDiscoveryRule(rule: string) {
  const file = await fs.realpath(getConfigPath());
  const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
  const raw = JSON.parse(text) as { agents?: string | string[] };
  const original = raw.agents;
  const mode = stat.mode & 0o777;
  await writeJsonAtomic(file, { ...raw, agents: [original ?? DEFAULT_AGENT_DISCOVERY].flat().concat(rule) }, mode);
  return async () => {
    const current = JSON.parse(await fs.readFile(file, "utf8")) as object;
    await writeJsonAtomic(file, { ...current, agents: original }, mode);
  };
}

async function pickSlug(parent: string, name: string, access?: CreateAccess): Promise<string> {
  const base = name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().replace(/^-|-$/g, "") || "agent";
  const config = loadConfig(getConfigPath());
  const taken = new Set([
    ...(await fs.readdir(parent)).map((entry) => entry.toLowerCase()),
    ...config.agents.map((agent) => agent.id.toLowerCase()),
    ...desktopDiscoveryCaseAliases(parent),
    "status", "sessions",
  ]);
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!slugPattern.test(slug)) throw new Error("The agent ID is invalid.");
    if (!taken.has(slug) && !access?.hasRow(slug)) return slug;
  }
}

async function stageAgent(finalDir: string, stagingDir: string, id: string, body: AgentBody, instructions: Instructions, options: CreateOptions) {
  await fs.mkdir(path.dirname(stagingDir), { recursive: true });
  const [stage, target] = await Promise.all([fs.stat(path.dirname(stagingDir)), fs.stat(path.dirname(finalDir))]);
  if (stage.dev !== target.dev) throw new Error("The folders must be on the same file system.");
  await fs.mkdir(stagingDir, { mode: 0o700 });
  let releaseRow: (() => void) | undefined;
  let published = false;
  try {
    const avatar = await stageAvatar(stagingDir, body.avatar, options.upload, options.onboarding);
    const agent = AgentYamlConfigSchema.parse({ id, name: body.name, description: body.purpose, avatar: avatar.filename, model: body.model });
    await fs.writeFile(path.join(stagingDir, "agent.yaml"), yaml.dump(agent));
    await fs.writeFile(path.join(stagingDir, "AGENTS.md"), instructions.text);
    await writeAvatarState(stagingDir, avatar);
    await fs.writeFile(path.join(stagingDir, creatorFile), JSON.stringify({ userId: options.creatorId }));
    await fs.writeFile(path.join(stagingDir, markerFile), JSON.stringify({ requestId: body.requestId, instructions: instructions.source }));
    releaseRow = options.access?.reservePrivate(id, options.creatorId);
    await fs.rename(stagingDir, finalDir);
    published = true;
  } finally {
    if (!published) {
      try {
        releaseRow?.();
      } finally {
        await fs.rm(stagingDir, { recursive: true, force: true });
      }
    }
  }
}

async function withAgentsLock<T>(parent: string, task: () => Promise<T>): Promise<T> {
  await fs.mkdir(parent, { recursive: true });
  // Load the lock after the gateway installs its shutdown handler.
  const { default: lockfile } = await import("proper-lockfile");
  const release = await lockfile.lock(parent, { realpath: false, retries: { retries: 50, minTimeout: 20, maxTimeout: 200 } });
  try {
    return await task();
  } finally {
    await release();
  }
}

const failures = {
  invalid_request: [400, "Check the agent fields."],
  reserved_prefix: [400, "Remove the $env: or $secret: prefix."],
  unavailable_model: [400, "Select a model from the list."],
  invalid_folder: [400, "Enter an absolute folder path or start with ~/. Use a new agent ID in lowercase letters, digits, and hyphens as the folder name, without glob characters."],
  folder_parent_missing: [400, "The parent folder must already exist on the gateway."],
  folder_not_empty: [409, "Choose a folder that does not exist yet or is an empty directory."],
  folder_inside_agent: [409, "Choose a folder outside existing agent folders."],
  agent_id_used: [409, "An agent already uses this folder name as its ID. Choose another name."],
  model_list_failed: [500, "Yoplai could not read the model list. Try again."],
  discovery_refused: [409, "The discovery rules do not allow this agent."],
  write_failed: [500, "Yoplai could not save the agent. Try again."],
  reload_failed: [500, "Yoplai could not reload the agent list. Try again."],
} as const;
type CreateFailure = keyof typeof failures;

class AgentCreateError extends AgentManagementError {
  constructor(code: CreateFailure) {
    const [status, message] = failures[code];
    super(code, status, message);
  }
}

async function listed(finalDir: string, id: string): Promise<boolean> {
  const agent = getActiveAgents().find((candidate) => candidate.id === id);
  if (!agent) return false;
  try {
    const [workspace, target] = await Promise.all([fs.realpath(agent.workspace), fs.realpath(finalDir)]);
    return workspace === target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function recoverAgent(finalDir: string, found: FoundAgent, needsReload: boolean) {
  if (!needsReload && await listed(finalDir, found.id)) return found;
  try {
    await reloadAfterExtensionWrite(async () => {
      if (!(await listed(finalDir, found.id))) throw new AgentCreateError("reload_failed");
    });
    return found;
  } catch {
    throw new AgentCreateError("reload_failed");
  }
}

type CreateAccess = {
  hasRow(id: string): boolean;
  reservePrivate(id: string, creator: string): () => void;
};

type CreateOptions = {
  creatorId: string;
  onboarding?: boolean;
  upload?: UploadedAvatar;
  access?: CreateAccess;
};

export function createAgentWriter(
  home: string,
  listModels: ReturnType<typeof createModelAccess>["listModels"],
  writeInstructions: ReturnType<typeof createInstructionWriter>,
) {
  const parent = path.join(home, "agents");
  return async (json: unknown, options: CreateOptions) => {
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) throw new AgentCreateError("invalid_request");
    const body = parsed.data;
    if (body.folder && options.onboarding) throw new AgentCreateError("invalid_request");
    if ([body.name, body.purpose].some(isReservedText)) throw new AgentCreateError("reserved_prefix");
    try {
      const find = (custom?: CustomFolder) => {
        if (!custom) return findRequest(parent, body.requestId, options);
        const hasFile = (name: string) => custom.entries.some((entry) => entry.name === name && entry.isFile());
        if (hasFile(markerFile) && hasFile(creatorFile)) return readRequest(custom.finalDir, body.requestId, options);
      };
      const custom = body.folder ? await resolveCustomFolder(body.folder) : undefined;
      if (await find(custom)) {
        const found = await withAgentsLock(parent, async () => {
          const target = body.folder ? await resolveCustomFolder(body.folder) : undefined;
          const marker = await find(target);
          return marker && recoverAgent(target?.finalDir ?? path.join(parent, marker.id), marker, false);
        });
        if (found) return { agent: found, status: 200 } as const;
      }
      const models = await listModels().catch(() => { throw new AgentCreateError("model_list_failed"); });
      if (!models.some((row) => matchesModelChoice(row, body.model))) throw new AgentCreateError("unavailable_model");
      const instructions = await writeInstructions(body);
      return await withAgentsLock(parent, async () => {
        const target = body.folder ? await resolveCustomFolder(body.folder) : undefined;
        const found = await find(target);
        if (found) return { agent: await recoverAgent(target?.finalDir ?? path.join(parent, found.id), found, false), status: 200 } as const;
        if (target) await checkCustomFolder(target, options.access);
        const id = target?.id ?? await pickSlug(parent, body.name, options.access);
        const finalDir = target?.finalDir ?? path.join(parent, id);
        const stagingDir = path.join(home, "run", `.desktop-agent-${randomUUID()}`);
        if (!isAgentActive(id)) throw new AgentCreateError("discovery_refused");
        let rollback: (() => Promise<void>) | undefined;
        try {
          if (!allowsDesktopAgentDiscovery(finalDir, stagingDir)) {
            if (!target) throw new AgentCreateError("discovery_refused");
            rollback = await appendDiscoveryRule(target.rule);
            if (!allowsDesktopAgentDiscovery(finalDir, stagingDir)) throw new AgentCreateError("discovery_refused");
          }
          await stageAgent(finalDir, stagingDir, id, body, instructions, options);
        } catch (error) {
          await rollback?.().catch(() => undefined);
          throw error;
        }
        return { agent: await recoverAgent(finalDir, { id, instructions: instructions.source }, true), status: 201 } as const;
      });
    } catch (error) {
      throw error instanceof AgentManagementError ? error : new AgentCreateError("write_failed");
    }
  };
}
