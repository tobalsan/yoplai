import { For, Show, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { buildRolePrompt } from "@yoplai/shared/projectPrompt";
import type { PromptRole } from "@yoplai/shared/projectPrompt";
import { spawnSubagent } from "../../api";
import type { ProjectDetail, SubagentListItem } from "../../api/types";

export type SpawnTemplate = "lead" | "custom";

export type SpawnPrefill = {
  name?: string;
  cli?: "codex" | "claude" | "pi";
  model?: string;
  reasoning?: string;
  runMode?: "clone" | "main" | "worktree" | "none";
  customInstructions?: string;
  includeDefaultPrompt?: boolean;
  includeRoleInstructions?: boolean;
  includePostRun?: boolean;
  agentId?: string;
  agentName?: string;
};

export type SpawnFormDraft = {
  includeDefaultPrompt: boolean;
  includeRoleInstructions: boolean;
  includePostRun: boolean;
  includeCustomInstructions: boolean;
  customInstructions: string;
};

export type SpawnFormProps = {
  projectId: string;
  project: ProjectDetail;
  prefill: SpawnPrefill;
  template: SpawnTemplate;
  subagents: SubagentListItem[];
  draft?: SpawnFormDraft;
  onDraftChange?: (draft: SpawnFormDraft) => void;
  onSpawned: (result: {
    type: "lead" | "subagent";
    slug: string;
    agentId?: string;
    sessionKey?: string;
  }) => void;
  onCancel: () => void;
};

const HARNESS_MODELS = {
  codex: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"],
  claude: ["opus", "sonnet", "haiku"],
  pi: [
    "qwen3.5-plus",
    "qwen3-max-2026-01-23",
    "MiniMax-M2.5",
    "glm-5",
    "kimi-k2.5",
  ],
} as const;

const HARNESS_REASONING = {
  codex: ["xhigh", "high", "medium", "low"],
  claude: ["high", "medium", "low"],
  pi: ["off", "low", "medium", "high", "xhigh"],
} as const;

function slugifyName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createSlug(name: string, existingSlugs: Set<string>): string {
  const base = slugifyName(name) || "agent";
  if (!existingSlugs.has(base)) return base;
  let suffix = 2;
  while (existingSlugs.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function normalizeDocFilename(key: string): string {
  return key.toLowerCase().endsWith(".md") ? key : `${key}.md`;
}

function getFrontmatterString(
  frontmatter: Record<string, unknown>,
  key: string
): string {
  const value = frontmatter[key];
  return typeof value === "string" ? value : "";
}

function mapTemplateToPromptRole(template: SpawnTemplate): PromptRole {
  if (template === "lead") return "coordinator";
  return "legacy";
}

function parseReviewerWorkspaces(list: string) {
  return list
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const parsed = /^- (.+?) \((.+?)\): (.+)$/.exec(line);
      if (!parsed) return null;
      return { name: parsed[1], cli: parsed[2], path: parsed[3] };
    })
    .filter((item): item is { name: string; cli: string; path: string } =>
      Boolean(item)
    );
}

export function buildReviewerWorkspaceList(
  projectId: string,
  subagents: SubagentListItem[]
): string {
  const workers = subagents.filter(
    (item) => item.runMode === "clone" || item.runMode === "worktree"
  );
  if (workers.length === 0) return "No active worker workspaces found.";
  return workers
    .map(
      (item) =>
        `- ${item.name || item.slug} (${item.cli || "agent"}): ~/projects/.workspaces/${projectId}/${item.slug}/`
    )
    .join("\n");
}

export function SpawnForm(props: SpawnFormProps) {
  const [addAgentCli, setAddAgentCli] = createSignal<"codex" | "claude" | "pi">(
    "codex"
  );
  const [addAgentName, setAddAgentName] = createSignal("");
  const [addAgentModel, setAddAgentModel] = createSignal("gpt-5.3-codex");
  const [addAgentReasoning, setAddAgentReasoning] = createSignal("high");
  const [addAgentRunMode, setAddAgentRunMode] = createSignal<
    "clone" | "main" | "worktree" | "none"
  >("clone");
  const [includeDefaultPrompt, setIncludeDefaultPrompt] = createSignal(true);
  const [includeRoleInstructions, setIncludeRoleInstructions] =
    createSignal(true);
  const [includePostRun, setIncludePostRun] = createSignal(true);
  const [includeCustomInstructions, setIncludeCustomInstructions] =
    createSignal(false);
  const [addAgentCustomInstructions, setAddAgentCustomInstructions] =
    createSignal("");
  const [addingAgent, setAddingAgent] = createSignal(false);
  const [agentError, setAgentError] = createSignal<string | null>(null);

  createEffect(() => {
    const prefill = props.prefill;
    const nextCli = prefill.cli ?? "codex";
    setAddAgentCli(nextCli);
    setAddAgentName(prefill.name ?? "");
    setAddAgentModel(prefill.model ?? HARNESS_MODELS[nextCli][0]);
    setAddAgentReasoning(prefill.reasoning ?? HARNESS_REASONING[nextCli][0]);
    setAddAgentRunMode(prefill.runMode ?? "clone");
    const draft = untrack(() => props.draft);
    setIncludeDefaultPrompt(
      draft?.includeDefaultPrompt ?? prefill.includeDefaultPrompt ?? true
    );
    setIncludeRoleInstructions(
      draft?.includeRoleInstructions ?? prefill.includeRoleInstructions ?? true
    );
    setIncludePostRun(draft?.includePostRun ?? prefill.includePostRun ?? true);
    setIncludeCustomInstructions(draft?.includeCustomInstructions ?? false);
    setAddAgentCustomInstructions(
      draft?.customInstructions ?? prefill.customInstructions ?? ""
    );
    setAgentError(null);
  });

  createEffect(() => {
    props.onDraftChange?.({
      includeDefaultPrompt: includeDefaultPrompt(),
      includeRoleInstructions: includeRoleInstructions(),
      includePostRun: includePostRun(),
      includeCustomInstructions: includeCustomInstructions(),
      customInstructions: addAgentCustomInstructions(),
    });
  });

  createEffect(() => {
    const cli = addAgentCli();
    const models = HARNESS_MODELS[cli];
    if (!models.some((model) => model === addAgentModel())) {
      setAddAgentModel(models[0]);
    }
    const efforts = HARNESS_REASONING[cli];
    if (!efforts.some((effort) => effort === addAgentReasoning())) {
      setAddAgentReasoning(efforts[0]);
    }
  });

  const reviewerWorkspaceList = createMemo(() =>
    buildReviewerWorkspaceList(props.projectId, props.subagents)
  );
  const addAgentSlug = createMemo(() =>
    createSlug(
      addAgentName().trim() || addAgentCli(),
      new Set(props.subagents.map((item) => item.slug))
    )
  );
  const effectiveProjectPath = createMemo(
    () => props.project.absolutePath || props.project.path
  );
  const projectFiles = createMemo(() => {
    const files = new Set<string>(["README.md", "THREAD.md"]);
    for (const key of Object.keys(props.project.docs ?? {})) {
      files.add(normalizeDocFilename(key));
    }
    return Array.from(files);
  });

  const modeForPrompt = () =>
    addAgentRunMode() === "main"
      ? "main-run"
      : addAgentRunMode() === "worktree"
        ? "worktree"
        : addAgentRunMode() === "none"
          ? "none"
          : "clone";

  const effectiveRepoPath = createMemo(() => {
    const repoPath = getFrontmatterString(props.project.frontmatter, "repo").trim();
    if (props.template !== "custom") {
      return repoPath;
    }
    if (!repoPath) {
      return repoPath;
    }
    const mode = modeForPrompt();
    if (mode !== "clone" && mode !== "worktree") {
      return repoPath;
    }
    return `~/projects/.workspaces/${props.projectId}/${addAgentSlug()}`;
  });

  const preparedPrompt = createMemo(() => {
    const status =
      getFrontmatterString(props.project.frontmatter, "status") || "unknown";
    const cli = addAgentCli();
    const author =
      addAgentName().trim() ||
      (cli === "codex" ? "Codex" : cli === "claude" ? "Claude" : "Pi");
    const promptRole = mapTemplateToPromptRole(props.template);
    return buildRolePrompt({
      role: promptRole,
      title: `${props.project.id} — ${props.project.title}`,
      status,
      path: effectiveProjectPath(),
      projectId: props.projectId,
      repo: effectiveRepoPath(),
      runAgentLabel: author,
      customPrompt: includeCustomInstructions()
        ? addAgentCustomInstructions().trim()
        : "",
      includeDefaultPrompt: includeDefaultPrompt(),
      includeRoleInstructions: includeRoleInstructions(),
      includePostRun: includePostRun(),
      projectFiles: projectFiles(),
      workerWorkspaces: parseReviewerWorkspaces(reviewerWorkspaceList()),
      specsPath: `${effectiveProjectPath().replace(/\/$/, "")}/SPECS.md`,
      content: Object.values(props.project.docs ?? {}).join("\n\n"),
    });
  });

  const canSpawnPreparedAgent = createMemo(
    () => preparedPrompt().trim().length > 0 && !addingAgent()
  );

  const resolvedMode = createMemo<"clone" | "main-run" | "worktree" | "none">(
    () =>
      addAgentRunMode() === "main"
        ? "main-run"
        : addAgentRunMode() === "worktree"
          ? "worktree"
          : addAgentRunMode() === "none"
            ? "none"
            : "clone"
  );

  const cliPreview = createMemo(() => {
    const cli = addAgentCli();
    if (cli === "codex") {
      return `codex exec --json --dangerously-bypass-approvals-and-sandbox -m ${addAgentModel()} -c reasoning_effort=${addAgentReasoning()}`;
    }
    if (cli === "claude") {
      return `claude -p "<prompt>" --output-format stream-json --verbose --dangerously-skip-permissions --model ${addAgentModel()} --effort ${addAgentReasoning()}`;
    }
    return `pi --mode json --session <session_file> --model ${addAgentModel()} --thinking ${addAgentReasoning()} "<prompt>"`;
  });

  const submitAddAgent = async () => {
    if (!canSpawnPreparedAgent()) return;
    setAddingAgent(true);
    setAgentError(null);

    const isLead = props.template === "lead" && !!props.prefill.agentId;

    const result = isLead
      ? await spawnSubagent(props.projectId, {
          slug: "",
          cli: "",
          prompt: includeCustomInstructions()
            ? addAgentCustomInstructions().trim()
            : "",
          agentId: props.prefill.agentId!,
          includeDefaultPrompt: includeDefaultPrompt(),
          includeRoleInstructions: includeRoleInstructions(),
          includePostRun: includePostRun(),
        })
      : await spawnSubagent(props.projectId, {
          slug: addAgentSlug(),
          cli: addAgentCli(),
          name: addAgentName().trim() || undefined,
          prompt: preparedPrompt(),
          template: props.template,
          promptRole: mapTemplateToPromptRole(props.template),
          includeDefaultPrompt: includeDefaultPrompt(),
          includeRoleInstructions: includeRoleInstructions(),
          includePostRun: includePostRun(),
          model: addAgentModel(),
          reasoningEffort:
            addAgentCli() === "pi" ? undefined : addAgentReasoning(),
          thinking: addAgentCli() === "pi" ? addAgentReasoning() : undefined,
          mode: resolvedMode(),
        });
    setAddingAgent(false);

    if (!result.ok) {
      setAgentError(result.error);
      return;
    }

    props.onSpawned({
      type: isLead ? "lead" : "subagent",
      slug: result.data.slug,
      agentId: result.data.agentId ?? props.prefill.agentId,
      sessionKey: result.data.sessionKey,
    });
  };

  return (
    <section class="spawn-form-panel">
      <div class="spawn-form-header">
        <h3>Spawn Agent</h3>
        <p>
          Template: <strong>{props.template}</strong>
        </p>
      </div>
      <form
        class="add-agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submitAddAgent();
        }}
      >
        <Show when={props.template === "lead" && props.prefill.agentName}>
          <div class="spawn-form-lead-header">
            Lead Agent: {props.prefill.agentName}
          </div>
        </Show>
        <Show when={props.template === "custom"}>
        <div class="spawn-form-grid">
          <label class="add-agent-label wide">
            Agent name (optional)
            <input
              class="add-agent-input"
              type="text"
              value={addAgentName()}
              onInput={(event) => setAddAgentName(event.currentTarget.value)}
              placeholder="Defaults to current naming"
            />
          </label>
          <label class="add-agent-label">
            Harness
            <select
              class="add-agent-select"
              value={addAgentCli()}
                onChange={(event) => {
                  const cli = event.currentTarget.value as
                    | "codex"
                    | "claude"
                    | "pi";
                  setAddAgentCli(cli);
                }}
              >
              <option value="codex">codex</option>
              <option value="claude">claude</option>
              <option value="pi">pi</option>
            </select>
          </label>
          <label class="add-agent-label">
            Model
            <select
              class="add-agent-select"
              value={addAgentModel()}
              onChange={(event) => setAddAgentModel(event.currentTarget.value)}
            >
              <For each={HARNESS_MODELS[addAgentCli()]}>
                {(model) => <option value={model}>{model}</option>}
              </For>
            </select>
          </label>
          <label class="add-agent-label">
            <Show
              when={addAgentCli() === "pi"}
              fallback={addAgentCli() === "claude" ? "Effort" : "Reasoning"}
            >
              Thinking
            </Show>
            <select
              class="add-agent-select"
              value={addAgentReasoning()}
              onChange={(event) =>
                setAddAgentReasoning(event.currentTarget.value)
              }
            >
              <For each={HARNESS_REASONING[addAgentCli()]}>
                {(value) => <option value={value}>{value}</option>}
              </For>
            </select>
          </label>
          <label class="add-agent-label">
            Run mode
            <select
              class="add-agent-select"
              value={addAgentRunMode()}
              onChange={(event) =>
                setAddAgentRunMode(
                  event.currentTarget.value as
                    | "clone"
                    | "main"
                    | "worktree"
                    | "none"
                )
              }
            >
              <option value="clone">clone</option>
              <option value="main">main</option>
              <option value="worktree">worktree</option>
              <option value="none">none</option>
            </select>
          </label>
        </div>
        </Show>
        <div class="add-agent-checklist">
          <label class="add-agent-check">
            <input
              class="project-context-toggle"
              type="checkbox"
              checked={includeDefaultPrompt()}
              onInput={(event) =>
                setIncludeDefaultPrompt(event.currentTarget.checked)
              }
            />
            Project context prompt
          </label>
          <label class="add-agent-check">
            <input
              class="role-instructions-toggle"
              type="checkbox"
              checked={includeRoleInstructions()}
              onInput={(event) =>
                setIncludeRoleInstructions(event.currentTarget.checked)
              }
            />
            Role instructions
          </label>
          <label class="add-agent-check">
            <input
              class="post-run-toggle"
              type="checkbox"
              checked={includePostRun()}
              onInput={(event) =>
                setIncludePostRun(event.currentTarget.checked)
              }
            />
            Yoplai post-run instructions
          </label>
          <label class="add-agent-check">
            <input
              class="custom-instructions-toggle"
              type="checkbox"
              checked={includeCustomInstructions()}
              onInput={(event) =>
                setIncludeCustomInstructions(event.currentTarget.checked)
              }
            />
            Custom instructions
          </label>
        </div>
        <Show when={includeCustomInstructions()}>
          <label class="add-agent-label wide">
            Custom instructions (appended last)
            <textarea
              class="add-agent-prompt"
              value={addAgentCustomInstructions()}
              onInput={(event) =>
                setAddAgentCustomInstructions(event.currentTarget.value)
              }
              placeholder="Optional custom instructions"
            />
          </label>
        </Show>
        <details class="add-agent-preview">
          <summary>Final prompt preview</summary>
          <pre>{preparedPrompt() || "(empty)"}</pre>
        </details>
        <Show when={props.template === "custom"}>
          <div class="add-agent-cli-preview">{cliPreview()}</div>
        </Show>
        <div class="add-agent-actions">
          <button
            type="button"
            class="add-agent-cancel"
            onClick={props.onCancel}
            disabled={addingAgent()}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="add-agent-submit"
            disabled={!canSpawnPreparedAgent()}
          >
            {addingAgent() ? "Spawning..." : "Spawn"}
          </button>
        </div>
      </form>
      <Show when={agentError()}>
        {(message) => <p class="agent-error">{message()}</p>}
      </Show>
      <style>{`
        .spawn-form-panel {
          width: 100%;
          flex: 1;
          min-width: 0;
          min-height: 0;
          height: 100%;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 14px;
          align-items: stretch;
          background: transparent;
          color: var(--text-primary);
          overflow-y: auto;
        }

        .spawn-form-header {
          padding-bottom: 10px;
          border-bottom: 1px solid var(--border-subtle);
        }

        .spawn-form-header h3 {
          margin: 0;
          font-size: 18px;
          font-weight: 650;
          letter-spacing: -0.01em;
        }

        .spawn-form-header p {
          margin: 4px 0 0;
          font-size: 12px;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        .spawn-form-lead-header {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
          padding: 4px 0;
        }

        .add-agent-form {
          display: grid;
          gap: 12px;
          border: 1px solid var(--border-subtle);
          border-radius: 12px;
          padding: 14px;
          background: var(--bg-overlay);
          width: 100%;
          box-sizing: border-box;
        }

        .spawn-form-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }

        .add-agent-label {
          display: grid;
          gap: 4px;
          color: var(--text-secondary);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .add-agent-label.wide {
          grid-column: 1 / -1;
        }

        .add-agent-select,
        .add-agent-input,
        .add-agent-prompt {
          border: 1px solid var(--border-subtle);
          border-radius: 6px;
          background: var(--bg-inset);
          color: var(--text-primary);
          font: inherit;
          font-size: 12px;
          padding: 6px 8px;
        }

        .add-agent-prompt {
          min-height: 92px;
          resize: vertical;
        }

        .add-agent-checklist {
          display: flex;
          flex-wrap: wrap;
          gap: 10px 16px;
          padding: 8px 10px;
          border: 1px solid var(--border-subtle);
          border-radius: 10px;
          background: var(--bg-input);
        }

        .add-agent-check {
          display: flex;
          gap: 6px;
          align-items: center;
          color: var(--text-primary);
          font-size: 12px;
        }

        .add-agent-preview {
          border: 1px solid var(--border-subtle);
          border-radius: 10px;
          background: var(--bg-inset);
          padding: 8px 10px;
        }

        .add-agent-preview summary {
          cursor: pointer;
          font-size: 11px;
          color: #3b82f6;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }

        .add-agent-preview pre {
          margin: 8px 0 0;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          font-size: 11px;
          line-height: 1.45;
          color: var(--text-secondary);
          max-height: min(34vh, 300px);
          overflow-y: auto;
          padding-right: 4px;
        }

        .add-agent-cli-preview {
          border: 1px solid var(--border-subtle);
          border-radius: 10px;
          background: var(--bg-inset);
          color: var(--text-primary);
          font-size: 11px;
          line-height: 1.4;
          padding: 8px 10px;
          overflow-wrap: anywhere;
        }

        .add-agent-actions {
          display: flex;
          justify-content: flex-end;
          gap: 6px;
        }

        .add-agent-cancel,
        .add-agent-submit {
          border: 1px solid var(--border-subtle);
          border-radius: 8px;
          background: var(--bg-input);
          color: var(--text-primary);
          font-size: 12px;
          padding: 6px 12px;
          cursor: pointer;
        }

        .add-agent-submit {
          border-color: #3b82f6;
          background: #1d4ed8;
          color: #fff;
        }

        .add-agent-cancel:hover:not(:disabled) {
          border-color: #475569;
          background: var(--bg-input);
        }

        .add-agent-submit:hover:not(:disabled) {
          background: #2563eb;
        }

        .agent-error {
          margin: 8px 0 0;
          font-size: 11px;
          color: #fca5a5;
        }

        @media (max-width: 960px) {
          .spawn-form-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </section>
  );
}
