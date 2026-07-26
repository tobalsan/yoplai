import {
  buildRolePrompt,
  normalizeProjectStatus,
  type GatewayConfig,
  type UpdateProjectRequest,
} from "@yoplai/shared";
import { resolveCliProfileOptions } from "../profiles/resolver.js";
import { getProject, updateProject } from "../projects/index.js";
import { readSubagentConfig } from "../subagents/index.js";
import {
  getUnsupportedSubagentCliError,
  isSupportedSubagentCli,
  spawnSubagent,
  type SubagentMode,
} from "../subagents/runner.js";
import { getProjectsContext } from "../context.js";
import { resolveRunName } from "./start-project-run.js";

export type SpawnProjectSubagentResult =
  | { ok: true; data: unknown; status: 201 }
  | { ok: false; error: string; status: 400 | 404 };

type AttachmentInput = { path: string; mimeType: string; filename?: string };

function readText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

function readOptionalText(
  body: Record<string, unknown>,
  key: string
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readAttachments(body: Record<string, unknown>): AttachmentInput[] | undefined {
  if (!Array.isArray(body.attachments)) return undefined;
  return body.attachments.filter(
    (attachment): attachment is AttachmentInput =>
      typeof attachment === "object" &&
      attachment !== null &&
      typeof (attachment as { path?: unknown }).path === "string" &&
      typeof (attachment as { mimeType?: unknown }).mimeType === "string"
  );
}

export async function spawnProjectSubagent(
  config: GatewayConfig,
  projectId: string,
  body: unknown
): Promise<SpawnProjectSubagentResult> {
  const input =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const slug = readText(input, "slug");
  const cli = readText(input, "cli");
  const prompt = readText(input, "prompt");
  const mode = readOptionalText(input, "mode");
  const name = readOptionalText(input, "name");
  let model = readOptionalText(input, "model");
  let reasoningEffort = readOptionalText(input, "reasoningEffort");
  let thinking = readOptionalText(input, "thinking");
  const baseBranch = readOptionalText(input, "baseBranch");
  const sliceId = readOptionalText(input, "sliceId");
  const resume = typeof input.resume === "boolean" ? input.resume : undefined;
  const attachments = readAttachments(input);
  const agentId = readOptionalText(input, "agentId");

  if (agentId) {
    const agent = getProjectsContext().getAgent(agentId);
    if (!agent || !getProjectsContext().isAgentActive(agentId)) {
      return { ok: false, error: "Agent not found", status: 404 };
    }
    const projectResult = await getProject(config, projectId);
    if (!projectResult.ok) {
      return { ok: false, error: projectResult.error, status: 404 };
    }
    const project = projectResult.data;
    const frontmatter = project.frontmatter ?? {};
    const sessionKeys =
      typeof frontmatter.sessionKeys === "object" && frontmatter.sessionKeys !== null
        ? (frontmatter.sessionKeys as Record<string, string>)
        : {};
    const sessionKey = sessionKeys[agent.id] ?? `project:${project.id}:${agent.id}`;
    const normalizedStatus = normalizeProjectStatus(
      typeof frontmatter.status === "string" ? frontmatter.status : ""
    );
    const updates: Partial<UpdateProjectRequest> = {};
    if (!sessionKeys[agent.id]) {
      updates.sessionKeys = { ...sessionKeys, [agent.id]: sessionKey };
    }
    if (normalizedStatus === "triage" || normalizedStatus === "shaping") {
      updates.status = "active";
    }

    const basePath = (project.absolutePath || project.path).replace(/\/$/, "");
    const docKeys = Object.keys(project.docs ?? {}).sort((a, b) => {
      if (a === "README") return -1;
      if (b === "README") return 1;
      return a.localeCompare(b);
    });
    let fullContent = project.docs?.README ?? "";
    for (const key of docKeys) {
      if (key === "README") continue;
      const docContent = project.docs?.[key];
      if (docContent) {
        fullContent += `\n\n## ${key}\n\n${docContent}`;
      }
    }

    const includeDefaultPrompt =
      typeof input.includeDefaultPrompt === "boolean"
        ? input.includeDefaultPrompt
        : true;
    const includeRoleInstructions =
      typeof input.includeRoleInstructions === "boolean"
        ? input.includeRoleInstructions
        : true;
    const includePostRun =
      typeof input.includePostRun === "boolean" ? input.includePostRun : false;
    const repo =
      typeof frontmatter.repo === "string" ? frontmatter.repo : undefined;
    const status =
      typeof frontmatter.status === "string" ? frontmatter.status : "";
    const coordinatorPrompt = buildRolePrompt({
      role: "coordinator",
      title: project.title,
      status,
      path: basePath,
      content: fullContent,
      specsPath: `${basePath}/SPECS.md`,
      projectId: project.id,
      projectFiles: ["README.md", "THREAD.md", ...docKeys.map((key) => `${key}.md`)],
      repo,
      runAgentLabel: agent.name,
      customPrompt: prompt || undefined,
      subagentTypes: getProjectsContext().getSubagentTemplates(),
      includeDefaultPrompt,
      includeRoleInstructions,
      includePostRun,
    });
    const leadSlug = `lead-${agent.id.replace(/[^a-z0-9]/gi, "-")}`;

    getProjectsContext()
      .runAgent({ agentId: agent.id, message: coordinatorPrompt, sessionKey })
      .catch((err) => {
        console.error(`[projects:${project.id}] lead agent session failed:`, err);
      });

    if (Object.keys(updates).length > 0) {
      await updateProject(config, project.id, updates);
    }

    return {
      ok: true,
      data: { slug: leadSlug, agentId: agent.id, sessionKey },
      status: 201,
    };
  }

  if (!slug || !cli || !prompt) {
    return { ok: false, error: "Missing required fields", status: 400 };
  }
  if (!isSupportedSubagentCli(cli)) {
    return { ok: false, error: getUnsupportedSubagentCliError(cli), status: 400 };
  }

  let resolvedName = name;
  if (resume) {
    const persisted = await readSubagentConfig(config, projectId, slug);
    if (persisted.ok) {
      if (!resolvedName && typeof persisted.data.name === "string") {
        const saved = persisted.data.name.trim();
        if (saved) resolvedName = saved;
      }
      if (!model && typeof persisted.data.model === "string") {
        const saved = persisted.data.model.trim();
        if (saved) model = saved;
      }
      if (!reasoningEffort && typeof persisted.data.reasoningEffort === "string") {
        const saved = persisted.data.reasoningEffort.trim();
        if (saved) reasoningEffort = saved;
      }
      if (!thinking && typeof persisted.data.thinking === "string") {
        const saved = persisted.data.thinking.trim();
        if (saved) thinking = saved;
      }
    }
  }

  const resolvedCliOptions = resolveCliProfileOptions(
    cli,
    model,
    reasoningEffort,
    thinking
  );
  if (!resolvedCliOptions.ok) {
    return { ok: false, error: resolvedCliOptions.error, status: 400 };
  }
  if (!resolvedName) {
    resolvedName = resolveRunName(name, slug, name);
  }
  const result = await spawnSubagent(config, {
    projectId,
    slug,
    cli,
    name: resolvedName,
    prompt,
    model: resolvedCliOptions.data.model,
    reasoningEffort: resolvedCliOptions.data.reasoningEffort,
    thinking: resolvedCliOptions.data.thinking,
    mode: mode as SubagentMode | undefined,
    baseBranch,
    sliceId,
    resume,
    attachments,
  });
  if (!result.ok) {
    const status = result.error.startsWith("Project not found") ? 404 : 400;
    return { ok: false, error: result.error, status };
  }
  return { ok: true, data: result.data, status: 201 };
}
