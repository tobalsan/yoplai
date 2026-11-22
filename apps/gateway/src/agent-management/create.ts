import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentYamlConfigSchema } from "@yoplai/shared";
import yaml from "js-yaml";
import { z } from "zod";
import { allowsDesktopAgentDiscovery, desktopDiscoveryCaseAliases, getActiveAgents, getConfigPath, isAgentActive, loadConfig } from "../config/index.js";
import { reloadAfterExtensionWrite } from "../extensions/reload.js";
import type { createInstructionWriter } from "../desktop/agent-instructions.js";
import type { createModelAccess } from "../desktop/model-access.js";

import { AgentManagementError, creatorFile, defaultFaceSchema, isReservedText, modelChoiceSchema, readAgentOwner, stageAvatar, writeAvatarState, type UploadedAvatar } from "./files.js";

const bodySchema = z.object({
  requestId: z.string().uuid().transform((id) => id.toLowerCase()),
  name: z.string().trim().min(1).max(60),
  purpose: z.string().max(280).optional(),
  avatar: defaultFaceSchema,
  model: modelChoiceSchema,
}).strict();

type AgentBody = z.infer<typeof bodySchema>;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const markerFile = ".desktop-create.json";
const markerSchema = z.object({ requestId: z.string().uuid(), instructions: z.enum(["model", "template"]) });
type Instructions = { text: string; source: z.infer<typeof markerSchema>["instructions"] };
type FoundAgent = { id: string; instructions: Instructions["source"] };

async function findRequest(parent: string, requestId: string, options: CreateOptions): Promise<FoundAgent | undefined> {
  const dirs = await fs.readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const dir of dirs) {
    if (!dir.isDirectory() || !slugPattern.test(dir.name)) continue;
    const raw = await fs.readFile(path.join(parent, dir.name, markerFile), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (raw === undefined) continue;
    let marker: z.infer<typeof markerSchema>;
    try { marker = markerSchema.parse(JSON.parse(raw)); } catch { continue; }
    if (marker.requestId !== requestId) continue;
    const owner = readAgentOwner(path.join(parent, dir.name));
    if (owner === options.creatorId || (!owner && options.onboarding)) return { id: dir.name, instructions: marker.instructions };
  }
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
    try {
      if (!published) releaseRow?.();
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true });
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

async function listed(parent: string, id: string): Promise<boolean> {
  const agent = getActiveAgents().find((candidate) => candidate.id === id);
  if (!agent) return false;
  try {
    const [workspace, target] = await Promise.all([fs.realpath(agent.workspace), fs.realpath(path.join(parent, id))]);
    return workspace === target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function recoverAgent(parent: string, found: FoundAgent, needsReload: boolean) {
  if (!needsReload && await listed(parent, found.id)) return found;
  try {
    await reloadAfterExtensionWrite(async () => {
      if (!(await listed(parent, found.id))) throw new AgentCreateError("reload_failed");
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
    if ([body.name, body.purpose].some(isReservedText)) throw new AgentCreateError("reserved_prefix");
    try {
      if (await findRequest(parent, body.requestId, options)) {
        const found = await withAgentsLock(parent, async () => {
          const marker = await findRequest(parent, body.requestId, options);
          return marker && recoverAgent(parent, marker, false);
        });
        if (found) return { agent: found, status: 200 } as const;
      }
      const models = await listModels().catch(() => { throw new AgentCreateError("model_list_failed"); });
      if (!models.some(({ provider, model }) => provider === body.model.provider && model === body.model.model)) throw new AgentCreateError("unavailable_model");
      const instructions = await writeInstructions(body);
      return await withAgentsLock(parent, async () => {
        const found = await findRequest(parent, body.requestId, options);
        if (found) return { agent: await recoverAgent(parent, found, false), status: 200 } as const;
        const id = await pickSlug(parent, body.name, options.access);
        const finalDir = path.join(parent, id);
        const stagingDir = path.join(home, "run", `.desktop-agent-${randomUUID()}`);
        if (!isAgentActive(id) || !allowsDesktopAgentDiscovery(finalDir, stagingDir)) throw new AgentCreateError("discovery_refused");
        await stageAgent(finalDir, stagingDir, id, body, instructions, options);
        return { agent: await recoverAgent(parent, { id, instructions: instructions.source }, true), status: 201 } as const;
      });
    } catch (error) {
      throw error instanceof AgentManagementError ? error : new AgentCreateError("write_failed");
    }
  };
}
