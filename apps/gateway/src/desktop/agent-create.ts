import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentYamlConfigSchema } from "@yoplai/shared";
import { Hono } from "hono";
import yaml from "js-yaml";
import { z } from "zod";
import { allowsDesktopAgentDiscovery, desktopDiscoveryCaseAliases, getActiveAgents, getConfigPath, isAgentActive, loadConfig } from "../config/index.js";
import { reloadAfterExtensionWrite } from "../extensions/reload.js";
import type { createInstructionWriter } from "./agent-instructions.js";
import type { createModelAccess } from "./model-access.js";

const bodySchema = z.object({
  requestId: z.string().uuid().transform((id) => id.toLowerCase()),
  name: z.string().trim().min(1).max(60),
  purpose: z.string().max(280).optional(),
  avatar: z.number().int().min(1).max(10),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict(),
}).strict();

type AgentBody = z.infer<typeof bodySchema>;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const markerFile = ".desktop-create.json";
const markerSchema = z.object({ requestId: z.string().uuid(), instructions: z.enum(["model", "template"]) });
type Instructions = { text: string; source: z.infer<typeof markerSchema>["instructions"] };
type FoundAgent = { id: string; instructions: Instructions["source"] };

async function findRequest(parent: string, requestId: string): Promise<FoundAgent | undefined> {
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
    const marker = markerSchema.parse(JSON.parse(raw));
    if (marker.requestId === requestId) return { id: dir.name, instructions: marker.instructions };
  }
}

export async function pickSlug(parent: string, name: string): Promise<string> {
  const base = name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().replace(/^-|-$/g, "") || "agent";
  const config = loadConfig(getConfigPath());
  const taken = new Set([
    ...(await fs.readdir(parent)).map((entry) => entry.toLowerCase()),
    ...[...config.agents, ...(config.pool ?? [])].map((agent) => agent.id.toLowerCase()),
    ...desktopDiscoveryCaseAliases(parent),
  ]);
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!slugPattern.test(slug)) throw new Error("The agent ID is invalid.");
    if (!taken.has(slug)) return slug;
  }
}

export function avatarPath(avatar: string): string {
  const web = process.env.YOPLAI_WEB_DIST;
  return web ? path.join(web, "avatars", avatar) : fileURLToPath(new URL(`../../../web/public/avatars/${avatar}`, import.meta.url));
}

async function stageAgent(finalDir: string, stagingDir: string, id: string, body: AgentBody, instructions: Instructions) {
  const avatar = `default-${body.avatar}.webp`;
  const agent = AgentYamlConfigSchema.parse({ id, name: body.name, description: body.purpose, avatar, model: body.model });
  await fs.mkdir(path.dirname(stagingDir), { recursive: true });
  const [stage, target] = await Promise.all([fs.stat(path.dirname(stagingDir)), fs.stat(path.dirname(finalDir))]);
  if (stage.dev !== target.dev) throw new Error("The folders must be on the same file system.");
  await fs.mkdir(stagingDir, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(stagingDir, "agent.yaml"), yaml.dump(agent));
    await fs.writeFile(path.join(stagingDir, "AGENTS.md"), instructions.text);
    await fs.copyFile(avatarPath(avatar), path.join(stagingDir, avatar));
    await fs.writeFile(path.join(stagingDir, markerFile), JSON.stringify({ requestId: body.requestId, instructions: instructions.source }));
    await fs.rename(stagingDir, finalDir);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

export async function withAgentsLock<T>(parent: string, task: () => Promise<T>): Promise<T> {
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

class AgentCreateError extends Error {
  constructor(readonly code: CreateFailure) {
    super(failures[code][1]);
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

export function createAgentRoutes(
  home: string,
  listModels: ReturnType<typeof createModelAccess>["listModels"],
  writeInstructions: ReturnType<typeof createInstructionWriter>,
) {
  const routes = new Hono();
  const parent = path.join(home, "agents");
  routes.post("/", async (c) => {
    function fail(error: CreateFailure) {
      const [status, message] = failures[error];
      return c.json({ error, message }, status);
    }
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return fail("invalid_request");
    const body = parsed.data;
    if ([body.name, body.purpose?.trim()].some((value) => value && /^\$(?:env|secret):/.test(value))) return fail("reserved_prefix");
    try {
      if (await findRequest(parent, body.requestId)) {
        const found = await withAgentsLock(parent, async () => {
          const marker = await findRequest(parent, body.requestId);
          return marker && recoverAgent(parent, marker, false);
        });
        if (found) return c.json(found, 200);
      }
      const models = await listModels().catch(() => { throw new AgentCreateError("model_list_failed"); });
      if (!models.some(({ provider, model }) => provider === body.model.provider && model === body.model.model)) return fail("unavailable_model");
      const instructions = await writeInstructions(body);
      const result = await withAgentsLock(parent, async () => {
        const found = await findRequest(parent, body.requestId);
        if (found) return { agent: await recoverAgent(parent, found, false), status: 200 } as const;
        const id = await pickSlug(parent, body.name);
        const finalDir = path.join(parent, id);
        const stagingDir = path.join(home, "run", `.desktop-agent-${randomUUID()}`);
        if (!isAgentActive(id) || !allowsDesktopAgentDiscovery(finalDir, stagingDir)) throw new AgentCreateError("discovery_refused");
        await stageAgent(finalDir, stagingDir, id, body, instructions);
        return { agent: await recoverAgent(parent, { id, instructions: instructions.source }, true), status: 201 } as const;
      });
      return c.json(result.agent, result.status);
    } catch (error) {
      return fail(error instanceof AgentCreateError ? error.code : "write_failed");
    }
  });
  return routes;
}
