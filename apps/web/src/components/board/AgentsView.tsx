/**
 * AgentsView — /board/agents live runs view.
 * Groups runs by project. §15.4 of kanban-slice-refactor spec + Issue #13.
 */
// @vitest-environment jsdom
import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { SubagentRun } from "@yoplai/shared/types";
import { fetchBoardAgents, killBoardAgent, subscribeToSubagentChanges } from "../../api";

// ── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const diff = Date.now() - ms;
  if (diff < 30_000) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type RunGroup = {
  projectId: string;
  runs: SubagentRun[];
};

function groupByProject(runs: SubagentRun[]): RunGroup[] {
  const map = new Map<string, SubagentRun[]>();
  for (const run of runs) {
    const key = run.projectId ?? "__unassigned";
    const list = map.get(key) ?? [];
    list.push(run);
    map.set(key, list);
  }
  const groups: RunGroup[] = [];
  for (const [projectId, groupRuns] of map.entries()) {
    groups.push({ projectId, runs: groupRuns });
  }
  // Real projects first, __unassigned last
  groups.sort((a, b) => {
    if (a.projectId === "__unassigned") return 1;
    if (b.projectId === "__unassigned") return -1;
    return a.projectId.localeCompare(b.projectId);
  });
  return groups;
}

// ── KillConfirm dialog ───────────────────────────────────────────────────────

type KillConfirmProps = {
  run: SubagentRun;
  onConfirm: () => void;
  onCancel: () => void;
};

function KillConfirm(props: KillConfirmProps) {
  const label = () => props.run.label;
  const slice = () => props.run.sliceId ?? props.run.projectId ?? "run";
  return (
    <div class="agents-kill-backdrop" onClick={props.onCancel}>
      <div
        class="agents-kill-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm kill"
      >
        <p class="agents-kill-message">
          Kill <strong>{label()}</strong> on <strong>{slice()}</strong>?
        </p>
        <div class="agents-kill-actions">
          <button
            class="agents-kill-btn-cancel"
            type="button"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            class="agents-kill-btn-confirm"
            type="button"
            onClick={props.onConfirm}
          >
            Kill
          </button>
        </div>
      </div>
    </div>
  );
}

// ── RunRow ───────────────────────────────────────────────────────────────────

type RunRowProps = {
  run: SubagentRun;
  onKillRequested: (run: SubagentRun) => void;
};

function RunRow(props: RunRowProps) {
  const viewHref = () =>
    `/projects/${encodeURIComponent(props.run.projectId ?? "__unassigned")}`;

  return (
    <div class="agents-run-row" data-testid={`run-row-${props.run.id}`}>
      <span class="agents-run-profile">{props.run.label}</span>
      <span class="agents-run-slice">
        <Show when={props.run.sliceId} fallback={<span class="agents-no-slice-badge">no-slice</span>}>
          {props.run.sliceId}
        </Show>
      </span>
      <span class="agents-run-started">{relativeTime(props.run.startedAt)}</span>
      <span class="agents-run-actions">
        <a class="agents-btn-view" href={viewHref()}>
          view
        </a>
        <button
          class="agents-btn-kill"
          type="button"
          onClick={() => props.onKillRequested(props.run)}
        >
          kill
        </button>
      </span>
    </div>
  );
}

// ── ProjectGroup ─────────────────────────────────────────────────────────────

type ProjectGroupProps = {
  group: RunGroup;
  onKillRequested: (run: SubagentRun) => void;
};

function ProjectGroup(props: ProjectGroupProps) {
  const displayId = () =>
    props.group.projectId === "__unassigned"
      ? "Unassigned"
      : props.group.projectId;

  return (
    <div class="agents-project-group" data-testid={`group-${props.group.projectId}`}>
      <div class="agents-project-header">{displayId()}</div>
      <For each={props.group.runs}>
        {(run) => (
          <RunRow run={run} onKillRequested={props.onKillRequested} />
        )}
      </For>
    </div>
  );
}

// ── AgentsView ───────────────────────────────────────────────────────────────

export function AgentsView() {
  const [runs, setRuns] = createSignal<SubagentRun[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [killTarget, setKillTarget] = createSignal<SubagentRun | null>(null);
  const [killing, setKilling] = createSignal(false);

  const groups = createMemo(() => groupByProject(runs()));

  async function loadRuns() {
    try {
      const data = await fetchBoardAgents();
      setRuns(data.runs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load runs");
    } finally {
      setLoading(false);
    }
  }

  onMount(() => {
    void loadRuns();
    const cleanup = subscribeToSubagentChanges({
      onSubagentChanged: () => void loadRuns(),
    });
    onCleanup(cleanup);
  });

  async function handleKillConfirm() {
    const target = killTarget();
    if (!target || killing()) return;
    setKilling(true);
    try {
      await killBoardAgent(target.id);
      setKillTarget(null);
      await loadRuns();
    } catch {
      // loadRuns will show error state
    } finally {
      setKilling(false);
    }
  }

  return (
    <div class="agents-view">
      <div class="agents-header">
        <h1 class="agents-title">Live Agents</h1>
      </div>

      <Show when={error()}>
        <div class="agents-error">
          {error()}
          <button type="button" onClick={() => void loadRuns()}>
            Retry
          </button>
        </div>
      </Show>

      <Show when={!loading() && !error()}>
        <Show
          when={groups().length > 0}
          fallback={
            <div class="agents-empty" data-testid="agents-empty">
              No live runs.
            </div>
          }
        >
          <div class="agents-groups">
            <For each={groups()}>
              {(group) => (
                <ProjectGroup
                  group={group}
                  onKillRequested={(run) => setKillTarget(run)}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={killTarget()}>
        {(target) => (
          <KillConfirm
            run={target()}
            onConfirm={() => void handleKillConfirm()}
            onCancel={() => setKillTarget(null)}
          />
        )}
      </Show>

      <style>{`
        .agents-view {
          height: 100%;
          display: flex;
          flex-direction: column;
          overflow: auto;
          padding: 24px;
          gap: 16px;
        }

        .agents-header {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .agents-title {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .agents-empty {
          color: var(--text-secondary);
          padding: 48px 0;
          text-align: center;
        }

        .agents-error {
          color: var(--text-danger, #e53e3e);
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .agents-groups {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .agents-project-group {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .agents-project-header {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-secondary);
          padding: 4px 0;
          border-bottom: 1px solid var(--border-default);
          margin-bottom: 4px;
        }

        .agents-run-row {
          display: grid;
          grid-template-columns: 140px 160px 100px 1fr;
          align-items: center;
          gap: 8px;
          padding: 6px 0;
          font-size: 13px;
          color: var(--text-primary);
        }

        .agents-run-profile {
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .agents-run-slice {
          color: var(--text-secondary);
          font-family: var(--font-mono, monospace);
          font-size: 12px;
        }

        .agents-no-slice-badge {
          display: inline-block;
          background: var(--bg-subtle, #f3f4f6);
          color: var(--text-secondary);
          border-radius: 4px;
          padding: 1px 6px;
          font-size: 11px;
          font-style: italic;
        }

        .agents-run-started {
          color: var(--text-secondary);
          font-size: 12px;
        }

        .agents-run-actions {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .agents-btn-view {
          font-size: 12px;
          color: var(--text-link, #3b82f6);
          text-decoration: none;
          padding: 2px 6px;
          border-radius: 4px;
        }

        .agents-btn-view:hover {
          text-decoration: underline;
        }

        .agents-btn-kill {
          font-size: 12px;
          color: var(--text-danger, #e53e3e);
          background: none;
          border: 1px solid var(--border-danger, #e53e3e);
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
        }

        .agents-btn-kill:hover {
          background: var(--bg-danger-subtle, #fff5f5);
        }

        /* Kill confirm dialog */
        .agents-kill-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .agents-kill-dialog {
          background: var(--bg-surface);
          border: 1px solid var(--border-default);
          border-radius: 8px;
          padding: 20px 24px;
          max-width: 360px;
          width: 90%;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
        }

        .agents-kill-message {
          margin: 0 0 16px;
          font-size: 14px;
          color: var(--text-primary);
        }

        .agents-kill-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }

        .agents-kill-btn-cancel {
          padding: 6px 14px;
          border-radius: 6px;
          border: 1px solid var(--border-default);
          background: none;
          cursor: pointer;
          font-size: 13px;
          color: var(--text-secondary);
        }

        .agents-kill-btn-confirm {
          padding: 6px 14px;
          border-radius: 6px;
          border: none;
          background: var(--bg-danger, #e53e3e);
          color: #fff;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
        }

        .agents-kill-btn-confirm:hover {
          opacity: 0.9;
        }
      `}</style>
    </div>
  );
}
