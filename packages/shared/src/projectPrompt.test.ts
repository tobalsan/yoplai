import { describe, expect, it } from "vitest";
import {
  buildCoordinatorPrompt,
  buildLegacyPrompt,
  buildProjectStartPrompt,
  buildReviewerPrompt,
  buildRolePrompt,
  buildWorkerPrompt,
  renderTemplate,
} from "./projectPrompt.js";

describe("projectPrompt template helpers", () => {
  it("replaces repeated placeholders", () => {
    const out = renderTemplate("{{A}} + {{A}}", { A: "x" });
    expect(out).toBe("x + x");
  });

  it("keeps unknown placeholders", () => {
    const out = renderTemplate("{{KNOWN}} {{UNKNOWN}}", { KNOWN: "ok" });
    expect(out).toBe("ok {{UNKNOWN}}");
  });

  it("handles paths with spaces", () => {
    const out = renderTemplate("{{PATH}}", {
      PATH: "/tmp/my folder/file.md",
    });
    expect(out).toBe("/tmp/my folder/file.md");
  });

});

describe("role-based project prompts", () => {
  const baseInput = {
    title: "PRO-151 - Role prompts",
    status: "in_progress",
    path: "/tmp/PRO-151",
    projectId: "PRO-151",
    repo: "/tmp/repo",
    runAgentLabel: "Worker Alpha",
    projectFiles: ["README.md", "THREAD.md", "SPECS.md"],
    content: "README content",
    specsPath: "/tmp/PRO-151/SPECS.md",
  } as const;

  it("builds coordinator prompt without implementation repo or commit instructions", () => {
    const out = buildCoordinatorPrompt({
      ...baseInput,
      role: "coordinator",
    });
    expect(out).toContain("## Your Role: Coordinator");
    expect(out).not.toContain("## Implementation Repository");
    expect(out).toContain("## Canonical Repo Root");
    expect(out).toContain("Path: /tmp/repo");
    expect(out).not.toContain("Run relevant tests after changes.");
    expect(out).not.toContain("yoplai projects move PRO-151 review");
    expect(out).toContain("primarily in /tmp/PRO-151/SPECS.md");
    expect(out).toContain("other relevant project markdown files");
    expect(out).toContain(
      "Use `yoplai projects start` with configured subagents for delegation:"
    );
    expect(out).toContain(
      "Preflight first: `command -v yoplai && yoplai projects --version`"
    );
    expect(out).toContain("--subagent Worker --slug worker-<task>");
    expect(out).toContain("--subagent Reviewer --slug reviewer-<scope>");
    expect(out).not.toContain("cd /");
    expect(out).not.toContain("/Users/");
    expect(out).toContain(
      "You do NOT run code reviews yourself. Always dispatch a Reviewer agent for review work."
    );
    expect(out).toContain("Agent names use the subagent config name as prefix");
    expect(out).toContain('Use `--name "..."` to override.');
    expect(out).toContain(
      "Before dispatching, pick an exact subagent name from `## Available Subagent Types` below. If none are listed, inspect the Yoplai config first."
    );
    expect(out).toContain(
      "When using `--subagent`, do NOT add locked flags (`--agent`, `--model`, `--reasoning-effort`, `--thinking`, `--mode`, `--branch`, `--prompt-role`) unless also using `--allow-overrides`."
    );
    expect(out).toContain(
      "Do not merge/cherry-pick directly from coordinator/reviewer runs."
    );
    expect(out).toContain(
      "Every worker agent must run in its dedicated worktree or workspace, never directly in the main repo, unless explicitly required."
    );
    expect(out).toContain(
      "When delegating implementation, keep workers on dedicated worktrees/workspaces; do not send them to the main repo unless the task explicitly requires it."
    );
    expect(out).toContain(
      "When writing SPECS.md, keep checklist sections parseable"
    );
    expect(out).toContain(
      "Optional `###` subsections are supported in both sections."
    );
    expect(out).toContain("## Agent Management Rules");
    expect(out).toContain(
      "Monitor agents with `yoplai projects status <project-id> --slug <agent>`."
    );
    expect(out).toContain(
      'Resume agents with `yoplai projects resume <project-id> -m "..." --slug <agent>`.'
    );
    expect(out).toContain(
      "while true; do yoplai projects status <project-id> --slug <agent> --json; sleep 30; done"
    );
    expect(out).toContain(
      "Never use background tasks to monitor worker agents"
    );
    expect(out).toContain(
      "Never merge commits directly into `main`. Route all changes through the Space branch first."
    );
    expect(out).toContain(
      'Never act on a worker\'s changes until `yoplai projects status` shows the worker finished with status `"done"`.'
    );
    expect(out).toContain(
      "Never implement fixes or run reviews yourself unless the user explicitly asks."
    );
    expect(out).toContain(
      "Never spawn direct native subagents outside Yoplai `yoplai projects` for implementation work."
    );
    expect(out).toContain(
      "wait until the first worker's worktree has been integrated into the Space branch before dispatching the dependent worker."
    );
    expect(out).toContain(
      "As soon as you dispatch workers, move the project to `in_progress` status using `yoplai projects update <project-id> --status in_progress`."
    );
    expect(out).toContain(
      "As soon as implementation is complete and you are ready for review, move the project to `review` status using `yoplai projects update <project-id> --status review`."
    );
    expect(out).toContain(
      "update the project's `space.json` to mark those commits integrated."
    );
    expect(out).toContain(
      "update each commit's status in `space.json` to `integrated` or `skipped` as appropriate."
    );
  });

  it("includes subagent types section in coordinator prompt", () => {
    const result = buildCoordinatorPrompt({
      ...baseInput,
      role: "coordinator",
      subagentTypes: [
        {
          name: "Worker",
          description: "Implements code",
          cli: "codex",
          model: "gpt-5.4",
          reasoning: "medium",
          type: "worker",
          runMode: "clone",
        },
      ],
    });
    expect(result).toContain("## Available Subagent Types");
    expect(result).toContain("**Worker** (codex / gpt-5.4");
    expect(result).toContain("--subagent Worker");
  });

  it("omits subagent types section when none configured", () => {
    const result = buildCoordinatorPrompt({
      ...baseInput,
      role: "coordinator",
      subagentTypes: [],
    });
    expect(result).not.toContain(
      "The following subagent types are configured and can be spawned via `yoplai projects start`:"
    );
  });

  it("builds worker prompt with implementation repo and no move-to-review", () => {
    const out = buildWorkerPrompt({
      ...baseInput,
      role: "worker",
    });
    expect(out).toContain("## Your Role: Worker");
    expect(out).toContain(
      "Commit your implementation once done and checks are green."
    );
    expect(out).toContain("## Implementation Repository");
    expect(out).toContain("Run relevant tests after changes.");
    expect(out).toContain(
      "Once checks pass, commit the implementation before reporting completion."
    );
    expect(out).not.toContain("yoplai projects move PRO-151 review");
    expect(out).toContain(
      "Update task statuses and acceptance criteria notes in /tmp/PRO-151/SPECS.md."
    );
    expect(out).toContain(
      'yoplai projects comment PRO-151 --message "<your summary>" --author <your name>'
    );
  });

  it("builds reviewer prompt with workspace list and no commit block", () => {
    const out = buildReviewerPrompt({
      ...baseInput,
      role: "reviewer",
      workerWorkspaces: [
        {
          name: "Worker Alpha",
          cli: "codex",
          path: "~/projects/.workspaces/PRO-151/worker-alpha/",
        },
      ],
    });
    expect(out).toContain("## Your Role: Reviewer");
    expect(out).toContain(
      "Read code changes directly from each worker workspace path listed below"
    );
    expect(out).toContain("## Active Worker Workspaces");
    expect(out).toContain("~/projects/.workspaces/PRO-151/worker-alpha/");
    expect(out).not.toContain("Run relevant tests after changes.");
    expect(out).not.toContain("yoplai projects move PRO-151 review");
    expect(out).toContain(
      "Update task statuses and acceptance criteria notes in /tmp/PRO-151/SPECS.md."
    );
    expect(out).toContain(
      'yoplai projects comment PRO-151 --message "<your summary>" --author <your name>'
    );
  });

  it("keeps legacy prompt output identical to buildProjectStartPrompt", () => {
    const legacyInput = {
      title: "Legacy",
      status: "todo",
      path: "/tmp/legacy",
      content: "doc body",
      specsPath: "/tmp/legacy/README.md",
      repo: "/tmp/repo",
      customPrompt: "custom",
      runAgentLabel: "Codex",
    };
    const oldOut = buildProjectStartPrompt(legacyInput);
    const newOut = buildLegacyPrompt({
      role: "legacy",
      ...legacyInput,
    });
    expect(newOut).toBe(oldOut);
  });

  it("dispatches role prompt builder and defaults to legacy", () => {
    const workerOut = buildRolePrompt({
      ...baseInput,
      role: "worker",
    });
    expect(workerOut).toContain("## Your Role: Worker");

    const legacyOut = buildRolePrompt({
      ...baseInput,
      role: "legacy",
    });
    expect(legacyOut).toContain("## Your Role");
    expect(legacyOut).toContain("## IMPORTANT: MUST DO AFTER IMPLEMENTATION");
    expect(legacyOut).toContain("yoplai projects move <project_id> review");
    expect(legacyOut).toContain(
      'yoplai projects comment <project_id> --message "<your summary>" --author <your name>'
    );
  });

  it("honors include flags for legacy/custom prompt mode", () => {
    const out = buildRolePrompt({
      ...baseInput,
      role: "legacy",
      includeDefaultPrompt: false,
      includeRoleInstructions: false,
      includePostRun: false,
    });
    expect(out).not.toContain("Let's tackle the following project:");
    expect(out).not.toContain("## Your Role");
    expect(out).not.toContain("## IMPORTANT: MUST DO AFTER IMPLEMENTATION");
  });

  it("can omit role instruction section for role prompts", () => {
    const out = buildRolePrompt({
      ...baseInput,
      role: "worker",
      includeRoleInstructions: false,
    });
    expect(out).not.toContain("## Your Role: Worker");
  });
});
