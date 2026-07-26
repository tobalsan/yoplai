import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GatewayConfig } from "@yoplai/shared";
import { resolveCliProfileOptions } from "../profiles/resolver.js";
import {
  clearProjectSpaceRebaseConflict,
  getGitHead,
  getProjectSpace,
  getProjectSpaceConflictContext,
} from "../projects/index.js";
import { readSubagentConfig } from "../subagents/index.js";
import {
  isSupportedSubagentCli,
  spawnSubagent,
} from "../subagents/runner.js";
import { getProjectsContext } from "../context.js";
import { resolveRunName } from "./start-project-run.js";

const execFileAsync = promisify(execFile);

export type SpaceConflictFixResult =
  | { ok: true; data: unknown; status: 201 }
  | { ok: false; error: string; status: 400 | 404 | 409 | 500 };

export async function fixSpaceRebaseConflict(
  config: GatewayConfig,
  projectId: string
): Promise<SpaceConflictFixResult> {
  try {
    const spaceResult = await getProjectSpace(config, projectId);
    if (!spaceResult.ok) {
      return {
        ok: false,
        error: spaceResult.error,
        status:
          spaceResult.error.startsWith("Project not found") ||
          spaceResult.error === "Project space not found"
            ? 404
            : spaceResult.error === "Project repo not set"
              ? 400
              : 500,
      };
    }
    const space = spaceResult.data;
    if (!space.rebaseConflict) {
      return { ok: false, error: "Space rebase conflict not found", status: 409 };
    }

    const reviewerConfig = getProjectsContext()
      .getSubagentTemplates()
      .find((t) => t.type === "reviewer");
    if (!reviewerConfig) {
      return { ok: false, error: "No reviewer subagent configured", status: 400 };
    }
    if (!isSupportedSubagentCli(reviewerConfig.cli)) {
      return {
        ok: false,
        error: "Reviewer subagent cli is missing or unsupported",
        status: 400,
      };
    }

    const resolvedCliOptions = resolveCliProfileOptions(
      reviewerConfig.cli,
      reviewerConfig.model,
      reviewerConfig.reasoning,
      undefined
    );
    if (!resolvedCliOptions.ok) {
      return { ok: false, error: resolvedCliOptions.error, status: 400 };
    }

    const slug = "space-rebase-fixer";
    const prompt = [
      "Space branch rebase onto base branch has conflicts.",
      "Resolve all rebase conflicts in this workspace and continue the rebase.",
      "",
      `Base branch: ${space.baseBranch}`,
      `Target base SHA: ${space.rebaseConflict.baseSha || "(unknown)"}`,
      `Rebase error: ${space.rebaseConflict.error}`,
      "",
      "Required commands:",
      "  git status",
      "  # resolve conflicts",
      "  git add <resolved-files>",
      "  git rebase --continue",
      "",
      "Repeat until rebase finishes cleanly. Then summarize what changed.",
    ].join("\n");
    const spawned = await spawnSubagent(config, {
      projectId,
      slug,
      cli: reviewerConfig.cli,
      name: resolveRunName(reviewerConfig.name, slug, undefined),
      prompt,
      model: resolvedCliOptions.data.model,
      reasoningEffort: resolvedCliOptions.data.reasoningEffort,
      thinking: resolvedCliOptions.data.thinking,
      mode: "main-run",
      baseBranch: space.baseBranch,
      resume: true,
    });
    if (!spawned.ok) {
      return {
        ok: false,
        error: spawned.error,
        status: spawned.error.startsWith("Project not found") ? 404 : 400,
      };
    }

    await clearProjectSpaceRebaseConflict(config, projectId);
    return { ok: true, data: { slug }, status: 201 };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      ok: false,
      error: message,
      status:
        message.startsWith("Project not found") ||
        message === "Project space not found"
          ? 404
          : message === "Space rebase conflict not found"
            ? 409
            : message === "Project repo not set"
              ? 400
              : 500,
    };
  }
}

export async function fixSpaceQueueConflict(
  config: GatewayConfig,
  projectId: string,
  entryId: string
): Promise<SpaceConflictFixResult> {
  try {
    const context = await getProjectSpaceConflictContext(config, projectId, entryId);
    await execFileAsync("git", ["cherry-pick", "--abort"], {
      cwd: context.space.worktreePath,
    }).catch(() => undefined);
    const spaceHead = await getGitHead(context.space.worktreePath);
    if (!spaceHead) {
      return { ok: false, error: "Failed to resolve Space HEAD SHA", status: 400 };
    }
    const persisted = await readSubagentConfig(
      config,
      projectId,
      context.entry.workerSlug
    );
    if (!persisted.ok) {
      return {
        ok: false,
        error: persisted.error,
        status:
          persisted.error.startsWith("Project not found") ||
          persisted.error.startsWith("Subagent not found")
            ? 404
            : 400,
      };
    }
    const cliRaw =
      typeof persisted.data.cli === "string" ? persisted.data.cli.trim() : "";
    if (!isSupportedSubagentCli(cliRaw)) {
      return {
        ok: false,
        error: "Original worker CLI is missing or unsupported",
        status: 400,
      };
    }
    const model =
      typeof persisted.data.model === "string"
        ? persisted.data.model.trim() || undefined
        : undefined;
    const reasoningEffort =
      typeof persisted.data.reasoningEffort === "string"
        ? persisted.data.reasoningEffort.trim() || undefined
        : undefined;
    const thinking =
      typeof persisted.data.thinking === "string"
        ? persisted.data.thinking.trim() || undefined
        : undefined;
    const name =
      typeof persisted.data.name === "string"
        ? persisted.data.name.trim() || undefined
        : undefined;
    const prompt = [
      "Your previous delivery caused a conflict when Space tried to cherry-pick it.",
      "",
      "Rebase your branch onto the current Space HEAD to resolve conflicts:",
      "",
      "  git fetch origin",
      `  git rebase --onto ${spaceHead} ${context.entry.startSha ?? "<start-sha-missing>"} HEAD`,
      "",
      "If rebase conflicts occur, resolve them manually, then git rebase --continue.",
      "After rebase is complete, verify your changes still work, then deliver.",
      "",
      `Space HEAD: ${spaceHead}`,
      `Your original start SHA: ${context.entry.startSha ?? "(missing)"}`,
      `Your original end SHA: ${context.entry.endSha ?? "(missing)"}`,
      "Conflicted files:",
      ...(context.conflictFiles.length > 0
        ? context.conflictFiles.map((file) => `- ${file}`)
        : ["- (no unmerged files reported)"]),
    ].join("\n");
    const spawned = await spawnSubagent(config, {
      projectId,
      slug: context.entry.workerSlug,
      cli: cliRaw,
      name,
      prompt,
      model,
      reasoningEffort,
      thinking,
      resume: true,
      replaces: [entryId],
    });
    if (!spawned.ok) {
      return {
        ok: false,
        error: spawned.error,
        status: spawned.error.startsWith("Project not found") ? 404 : 400,
      };
    }
    return {
      ok: true,
      data: { entryId, slug: context.entry.workerSlug },
      status: 201,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      ok: false,
      error: message,
      status:
        message.startsWith("Project not found") ||
        message === "Project space not found" ||
        message === "Space conflict entry not found"
          ? 404
          : message === "Project repo not set"
            ? 400
            : 500,
    };
  }
}
