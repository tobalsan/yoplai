import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { resolveHomeDir, type ContainerExtensionTool, type GatewayConfig } from "@yoplai/shared";
import { resolveSystemFilePath } from "@yoplai/shared/node/system-files";
import { resolveWorkspaceDir } from "../config/index.js";
import { requireInstructionRequester } from "./requester.js";

export type InstructionsContext = {
  config: GatewayConfig;
  agentId: string;
  source?: string;
  sender?: { kind: string };
  userId?: string;
  actorKind?: "user" | "service" | "local" | "eval";
  background?: boolean;
};

const replacementSchema = z.object({ expected: z.string(), content: z.string() });
const pendingWrites = new Map<string, Promise<unknown>>();

export const instructionTools: ContainerExtensionTool[] = [
  {
    extensionId: "gateway", name: "agent_update_instructions",
    description: "Replace your own AGENTS.md on the host, only when the user explicitly asks to change instructions. Read the full current text and pass it as expected; content is the full replacement. Requires a human chat requester: local operator in single-user mode, admin or superadmin in multi-user mode. Never edit AGENTS.md directly. After success, tell the user in one short line which file changed.",
    parameters: { type: "object", properties: { expected: { type: "string" }, content: { type: "string" } }, required: ["expected", "content"] },
  },
  {
    extensionId: "gateway", name: "shared_update_system_file",
    description: "Replace an existing .md system file directly in $YOPLAI_HOME/shared on the host, only on explicit user ask. file is a bare filename; expected is its full current text and content the full replacement. Requires a human superadmin (the local operator in single-user mode). Returns a diff and affected agent ids; changes apply next turn. Never edit shared system files directly. After success, tell the user in one short line which file changed and which agents it affects.",
    parameters: { type: "object", properties: { file: { type: "string" }, expected: { type: "string" }, content: { type: "string" } }, required: ["file", "expected", "content"] },
  },
];

export async function executeAgentUpdateInstructions(args: unknown, context: InstructionsContext): Promise<{ file: string; diff: string }> {
  await requireInstructionRequester(context);
  const input = replacementSchema.parse(args);
  const agent = context.config.agents.find((entry) => entry.id === context.agentId);
  if (!agent) throw new Error("Agent not found.");
  const filePath = path.join(resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace), "AGENTS.md");
  return replaceFile(filePath, "AGENTS.md", input);
}

async function replaceFile(filePath: string, file: string, input: { expected: string; content: string }): Promise<{ file: string; diff: string }> {
  const target = path.join(await fs.realpath(path.dirname(filePath)), path.basename(filePath));
  const write = (pendingWrites.get(target) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const current = await fs.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (current !== input.expected) throw new Error(`${file} file changed; re-read and retry.`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, input.content, { flag: "wx" });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
    return { file, diff: createTwoFilesPatch(file, file, current, input.content) };
  });
  pendingWrites.set(target, write);
  try { return await write; }
  finally { if (pendingWrites.get(target) === write) pendingWrites.delete(target); }
}

export async function executeSharedUpdateSystemFile(args: unknown, context: InstructionsContext): Promise<{ file: string; diff: string; affectedAgents: string[] }> {
  await requireInstructionRequester(context, true);
  const input = replacementSchema.extend({ file: z.string() }).parse(args);
  const pathError = "Choose an existing .md file directly in the shared folder; no paths or symlink escapes.";
  if (!input.file.endsWith(".md") || /[/\\]/.test(input.file) || input.file.includes("..")) throw new Error(pathError);
  const filePath = await fs.realpath(path.join(resolveHomeDir(), "shared", input.file)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(pathError);
    throw error;
  });
  const sharedDir = await fs.realpath(path.join(resolveHomeDir(), "shared"));
  if (path.dirname(filePath) !== sharedDir || !(await fs.stat(filePath)).isFile()) throw new Error(pathError);
  const affectedAgents: string[] = [];
  for (const agent of context.config.agents) {
    const workspace = resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace);
    for (const entry of agent.system_files ?? []) {
      const source = typeof entry === "string" ? entry : entry.path;
      if (path.basename(source) === "AGENTS.md") continue;
      const resolved = await fs.realpath(resolveSystemFilePath(source, workspace)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (resolved === filePath) { affectedAgents.push(agent.id); break; }
    }
  }
  return { ...await replaceFile(filePath, input.file, input), affectedAgents };
}
