/**
 * ProjectListGrouped — Board home project list grouped by lifecycle status.
 * §15.2 of kanban-slice-refactor spec + Issue #11.
 */
// @vitest-environment jsdom
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import type {
  BoardProject,
  ProjectLifecycleCounts,
  ProjectLifecycleStatus,
} from "../../api/types";
import {
  fetchRuntimeSubagents,
  moveBoardProject,
  subscribeToSubagentChanges,
} from "../../api";
import { ToastNotification, type ToastVariant } from "../ui/Toast";
import type { SubagentRun } from "@yoplai/shared/types";
import {
  getProjectRunPillState,
  isProjectShapingRun,
  projectRunPillLabel,
} from "../../lib/project-shaping-runs";

// ── Types ──────────────────────────────────────────────────────────

type GroupDef = {
  status: ProjectLifecycleStatus;
  label: string;
  defaultExpanded: boolean;
};

const GROUPS: GroupDef[] = [
  { status: "active", label: "Active", defaultExpanded: true },
  { status: "shaping", label: "Shaping", defaultExpanded: true },
  { status: "done", label: "Done", defaultExpanded: false },
  { status: "cancelled", label: "Cancelled", defaultExpanded: false },
  { status: "archived", label: "Archived", defaultExpanded: false },
];

const UNASSIGNED_PROJECT_ID = "__unassigned";

const LIFECYCLE_STATUSES = GROUPS.map((group) => group.status);

export type ProjectListGroupedProps = {
  /** All projects from GET /board/projects (archived already omitted server-side) */
  projects: BoardProject[];
  lifecycleCounts?: ProjectLifecycleCounts;
  doneLoading?: boolean;
  onDoneExpandedChange?: (expanded: boolean) => void;
  /** Area names keyed by id (for filter chips) */
  areas: { id: string; name: string }[];
  /** Loading state — show skeletons */
  loading?: boolean;
  /** Error state */
  error?: string;
  /** Called when retry clicked in error state */
  onRetry?: () => void;
  /** Navigate to project detail */
  onProjectClick?: (project: BoardProject) => void;
  /** Toast message emitter */
  onToast?: (message: string, variant?: ToastVariant) => void;
};

// ── Helpers ────────────────────────────────────────────────────────

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "No activity";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "No activity";
  const diff = Date.now() - ms;
  if (diff < 30_000) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const DEFAULT_SHAPING_STAGE_ORDER = [
  "repo",
  "drill",
  "slice",
  "verticality",
  "validation",
  "approve",
  "blocked",
];

function shapingStage(status: string): string | null {
  return status.startsWith("shaping:") ? status.slice("shaping:".length) : null;
}

function shapingStageRank(status: string): number {
  const stage = shapingStage(status);
  if (!stage) return -1;
  const index = DEFAULT_SHAPING_STAGE_ORDER.indexOf(stage);
  return index === -1 ? DEFAULT_SHAPING_STAGE_ORDER.length : index;
}

function lifecycleStatusLabel(status: ProjectLifecycleStatus): string {
  switch (status) {
    case "triage":
      return "triage";
    case "active":
      return "active";
    case "shaping":
      return "shaping";
    case "ready_to_merge":
      return "ready";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    case "archived":
      return "archived";
  }
}

// ── Sub-components ─────────────────────────────────────────────────

function StatusPill(props: { status: ProjectLifecycleStatus }) {
  const colorMap: Record<ProjectLifecycleStatus, string> = {
    triage: "var(--color-muted, #6b6b6b)",
    active: "var(--color-success, #53b97c)",
    shaping: "var(--color-warning, #d2b356)",
    ready_to_merge: "var(--color-link, #4a9eff)",
    done: "var(--color-muted, #6b6b6b)",
    cancelled: "var(--color-danger, #e05252)",
    archived: "var(--color-muted, #6b6b6b)",
  };
  return (
    <span
      data-testid={`status-pill-${props.status}`}
      style={{
        display: "inline-block",
        padding: "1px 6px",
        "border-radius": "4px",
        "font-size": "11px",
        "font-weight": 600,
        color: "#fff",
        background: colorMap[props.status] ?? "#6b6b6b",
        "text-transform": "capitalize",
        "letter-spacing": "0.02em",
      }}
    >
      {lifecycleStatusLabel(props.status)}
    </span>
  );
}

function ShapingStageBadge(props: { status: string }) {
  const stage = () => shapingStage(props.status);
  return (
    <Show when={stage()}>
      {(value) => (
        <span
          data-testid="shaping-stage-badge"
          style={{
            "font-size": "11px",
            color: "var(--text-primary)",
            background: "var(--bg-elevated, var(--bg-base))",
            border: "1px solid var(--border-default)",
            padding: "1px 5px",
            "border-radius": "999px",
          }}
        >
          {value()}
        </span>
      )}
    </Show>
  );
}

function ProgressBar(props: { done: number; total: number }) {
  const pct = () =>
    props.total > 0 ? Math.round((props.done / props.total) * 100) : 0;
  return (
    <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
      <div
        data-testid="progress-bar-track"
        style={{
          flex: 1,
          height: "4px",
          "border-radius": "2px",
          background: "var(--border-default)",
          overflow: "hidden",
          "max-width": "80px",
        }}
      >
        <div
          data-testid="progress-bar-fill"
          style={{
            height: "100%",
            width: `${pct()}%`,
            background: "var(--color-success, #53b97c)",
            "border-radius": "2px",
            transition: "width 0.3s",
          }}
        />
      </div>
      <span
        data-testid="progress-bar-label"
        style={{ "font-size": "11px", color: "var(--text-secondary)" }}
      >
        {props.done}/{props.total} slices done
      </span>
    </div>
  );
}

function ProjectRunPill(props: { runs: SubagentRun[] }) {
  const state = () => getProjectRunPillState(props.runs);
  const color = () => {
    switch (state()) {
      case "running":
        return "var(--color-success, #53b97c)";
      case "stalled":
        return "var(--color-warning, #d2b356)";
      case "error":
        return "var(--color-danger, #e05252)";
      case "hidden":
        return "transparent";
    }
  };
  return (
    <Show when={state() !== "hidden"}>
      <span
        data-testid="project-run-pill"
        style={{
          "font-size": "11px",
          "font-weight": 700,
          color: "#fff",
          background: color(),
          padding: "1px 6px",
          "border-radius": "999px",
          "margin-left": "auto",
        }}
      >
        {projectRunPillLabel(state())}
      </span>
    </Show>
  );
}

function ActiveRunDot() {
  return (
    <span
      data-testid="active-run-dot"
      title="Active run in progress"
      style={{
        display: "inline-block",
        width: "8px",
        height: "8px",
        "border-radius": "50%",
        background: "var(--color-success, #53b97c)",
        animation: "pulse 2s infinite",
        "margin-left": "4px",
      }}
    />
  );
}

// ── Drag state ─────────────────────────────────────────────────────

type DragState = {
  projectId: string;
  sourceStatus: ProjectLifecycleStatus;
};

// ── Project Card ───────────────────────────────────────────────────

function ProjectCard(props: {
  project: BoardProject;
  areaName: string;
  dragging?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
  onClick?: () => void;
  onStatusChange?: (status: ProjectLifecycleStatus) => void;
  shapingRuns?: SubagentRun[];
}) {
  const [menuOpen, setMenuOpen] = createSignal(false);

  function moveToStatus(status: ProjectLifecycleStatus) {
    setMenuOpen(false);
    props.onStatusChange?.(status);
  }

  return (
    <div
      data-testid={`project-card-${props.project.id}`}
      data-project-id={props.project.id}
      data-lifecycle-status={props.project.lifecycleStatus}
      aria-grabbed={props.dragging ? "true" : "false"}
      draggable={true}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onClick={props.onClick}
      style={{
        padding: "10px 12px",
        "border-radius": "6px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-default)",
        cursor: props.dragging ? "grabbing" : "grab",
        "margin-bottom": "6px",
        opacity: props.dragging ? 0.55 : 1,
        "user-select": "none",
        transition: "border-color 0.15s, opacity 0.15s",
      }}
    >
      {/* Line 1: ID, status pill, area */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "6px",
          "margin-bottom": "3px",
        }}
      >
        <span
          data-testid="project-id"
          style={{
            "font-size": "11px",
            color: "var(--text-secondary)",
            "font-family": "monospace",
          }}
        >
          {props.project.id}
        </span>
        <StatusPill status={props.project.lifecycleStatus} />
        <ShapingStageBadge status={props.project.status} />
        <ProjectRunPill runs={props.shapingRuns ?? []} />
        <Show when={props.areaName}>
          <span
            data-testid="project-area-chip"
            style={{
              "font-size": "11px",
              color: "var(--text-secondary)",
              background: "var(--bg-surface)",
              padding: "1px 5px",
              "border-radius": "3px",
            }}
          >
            {props.areaName}
          </span>
        </Show>
        <div
          style={{ position: "relative", "margin-left": "auto" }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            data-testid={`project-status-menu-trigger-${props.project.id}`}
            aria-label={`Move ${props.project.id}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
            onClick={() => setMenuOpen((open) => !open)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setMenuOpen(false);
            }}
            style={{
              width: "24px",
              height: "22px",
              display: "inline-flex",
              "align-items": "center",
              "justify-content": "center",
              color: "var(--text-secondary)",
              background: "transparent",
              border: "1px solid transparent",
              "border-radius": "4px",
              cursor: "pointer",
              "font-size": "16px",
              "line-height": 1,
            }}
          >
            …
          </button>
          <Show when={menuOpen()}>
            <div
              data-testid={`project-status-menu-${props.project.id}`}
              role="menu"
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                right: 0,
                "z-index": 20,
                "min-width": "132px",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
                "border-radius": "6px",
                "box-shadow": "0 4px 14px rgba(0,0,0,0.18)",
                overflow: "hidden",
              }}
            >
              <For each={LIFECYCLE_STATUSES}>
                {(status) => (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid={`project-status-menu-item-${props.project.id}-${status}`}
                    disabled={status === props.project.lifecycleStatus}
                    onClick={() => moveToStatus(status)}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "7px 10px",
                      "text-align": "left",
                      "font-size": "12px",
                      color: "var(--text-primary)",
                      background:
                        status === props.project.lifecycleStatus
                          ? "var(--bg-base)"
                          : "transparent",
                      border: "none",
                      cursor:
                        status === props.project.lifecycleStatus
                          ? "default"
                          : "pointer",
                    }}
                  >
                    {lifecycleStatusLabel(status)}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
      {/* Line 2: Title */}
      <div
        data-testid="project-title"
        style={{
          "font-size": "13px",
          "font-weight": 500,
          "margin-bottom": "5px",
          color: "var(--text-primary)",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
      >
        {props.project.title}
      </div>
      {/* Line 3: Slice progress + active run dot */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "margin-bottom": "4px",
        }}
      >
        <ProgressBar
          done={props.project.sliceProgress.done}
          total={props.project.sliceProgress.total}
        />
        <Show when={props.project.activeRunCount > 0}>
          <ActiveRunDot />
        </Show>
      </div>
      {/* Line 4: Last activity */}
      <div
        data-testid="project-last-activity"
        style={{ "font-size": "11px", color: "var(--text-secondary)" }}
      >
        updated {relativeTime(props.project.lastActivity)}
      </div>
    </div>
  );
}

// ── Group Section ──────────────────────────────────────────────────

function GroupSection(props: {
  group: GroupDef;
  projects: BoardProject[];
  totalCount: number;
  loading?: boolean;
  areas: Map<string, string>;
  draggingProjectId?: string | null;
  onDrop?: (targetStatus: ProjectLifecycleStatus) => void;
  onCardDragStart?: (project: BoardProject, e: DragEvent) => void;
  onCardDragEnd?: () => void;
  onCardClick?: (project: BoardProject) => void;
  onStatusChange?: (
    project: BoardProject,
    targetStatus: ProjectLifecycleStatus
  ) => void;
  onExpandedChange?: (expanded: boolean) => void;
  shapingRunsByProjectId?: Map<string, SubagentRun[]>;
}) {
  const [expanded, setExpanded] = createSignal(props.group.defaultExpanded);
  const [dragOver, setDragOver] = createSignal(false);
  const toggleExpanded = () => {
    const next = !expanded();
    setExpanded(next);
    if (props.group.status === "done") props.onExpandedChange?.(next);
  };
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  };
  const handleDragLeave = (e: DragEvent) => {
    const nextTarget = e.relatedTarget as Node | null;
    const currentTarget = e.currentTarget;
    if (
      nextTarget &&
      currentTarget instanceof Node &&
      currentTarget.contains(nextTarget)
    ) {
      return;
    }
    setDragOver(false);
  };
  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    props.onDrop?.(props.group.status);
  };

  return (
    <div
      data-testid={`group-section-${props.group.status}`}
      style={{
        "margin-bottom": "16px",
        "border-radius": "8px",
        outline: dragOver()
          ? "2px dashed var(--color-link, #4a9eff)"
          : "2px dashed transparent",
        "outline-offset": "2px",
      }}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Group header */}
      <div
        data-testid={`group-header-${props.group.status}`}
        style={{
          display: "flex",
          "align-items": "center",
          gap: "8px",
          "margin-bottom": "6px",
          "padding-bottom": "4px",
          "border-bottom": "1px solid var(--border-default)",
          cursor: "pointer",
        }}
        onClick={toggleExpanded}
      >
        <span
          style={{
            "font-size": "12px",
            "font-weight": 600,
            "text-transform": "uppercase",
            "letter-spacing": "0.06em",
            color: "var(--text-secondary)",
          }}
        >
          {props.group.label}
        </span>
        <span
          data-testid={`group-count-${props.group.status}`}
          style={{
            "font-size": "12px",
            color: "var(--text-secondary)",
          }}
        >
          ({props.totalCount})
        </span>
        <Show when={!props.group.defaultExpanded}>
          <span
            style={{
              "font-size": "11px",
              color: "var(--color-link, #4a9eff)",
              "margin-left": "4px",
            }}
          >
            {props.loading ? "loading" : expanded() ? "hide" : "show"}
          </span>
        </Show>
        <span style={{ "margin-left": "auto", "font-size": "12px" }}>
          {expanded() ? "▾" : "▸"}
        </span>
      </div>

      {/* Drop zone — always rendered so collapsed groups accept drops */}
      <div
        data-testid={`group-drop-zone-${props.group.status}`}
        style={{
          "min-height": expanded() ? "40px" : "8px",
          "border-radius": "6px",
          background: dragOver()
            ? "var(--bg-drop-target, rgba(74,158,255,0.07))"
            : "transparent",
          border: dragOver()
            ? "2px dashed var(--color-link, #4a9eff)"
            : "2px dashed transparent",
          transition: "all 0.15s",
          padding: expanded() ? "2px" : "0",
        }}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Cards — only visible when expanded */}
        <Show when={expanded()}>
          <Show
            when={!props.loading}
            fallback={
              <div
                data-testid={`group-loading-${props.group.status}`}
                style={{
                  "text-align": "center",
                  color: "var(--text-secondary)",
                  "font-size": "12px",
                  padding: "12px 0",
                }}
              >
                Loading projects
              </div>
            }
          >
            <Show
              when={props.projects.length > 0}
              fallback={
                <div
                  data-testid={`group-empty-${props.group.status}`}
                  style={{
                    "text-align": "center",
                    color: "var(--text-secondary)",
                    "font-size": "12px",
                    padding: "12px 0",
                  }}
                >
                  No projects
                </div>
              }
            >
              <For each={props.projects}>
                {(project) => (
                  <ProjectCard
                    project={project}
                    areaName={props.areas.get(project.area) ?? project.area}
                    dragging={props.draggingProjectId === project.id}
                    onDragStart={(e) => {
                      props.onCardDragStart?.(project, e);
                    }}
                    onDragEnd={props.onCardDragEnd}
                    onClick={() => props.onCardClick?.(project)}
                    onStatusChange={(targetStatus) =>
                      props.onStatusChange?.(project, targetStatus)
                    }
                    shapingRuns={props.shapingRunsByProjectId?.get(project.id)}
                  />
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────

export function ProjectListGrouped(props: ProjectListGroupedProps) {
  const [search, setSearch] = createSignal("");
  const [selectedArea, setSelectedArea] = createSignal<string>("all");
  const [dragging, setDragging] = createSignal<DragState | null>(null);
  const [suppressNextClick, setSuppressNextClick] = createSignal(false);
  const [toast, setToast] = createSignal<{
    message: string;
    variant: ToastVariant;
  } | null>(null);
  // Optimistic project list — mirrors props.projects with pending status updates
  const [optimisticOverrides, setOptimisticOverrides] = createSignal<
    Map<string, ProjectLifecycleStatus>
  >(new Map());

  const [allRuns, { refetch: refetchAllRuns }] = createResource(async () => {
    const data = await fetchRuntimeSubagents({ includeArchived: true });
    return data.items;
  });

  createEffect(() => {
    let refreshTimer: number | undefined;
    const scheduleRefresh = () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void refetchAllRuns();
      }, 250);
    };
    const unsubscribe = subscribeToSubagentChanges({
      onSubagentChanged: scheduleRefresh,
    });
    onCleanup(() => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      unsubscribe();
    });
  });

  const shapingRunsByProjectId = createMemo(() => {
    const map = new Map<string, SubagentRun[]>();
    for (const project of props.projects) map.set(project.id, []);
    for (const run of allRuns.latest ?? []) {
      const id = run.projectId;
      if (!id || !isProjectShapingRun(run, id) || !map.has(id)) continue;
      map.get(id)!.push(run);
    }
    return map;
  });

  const areaMap = createMemo(() => {
    const m = new Map<string, string>();
    for (const area of props.areas) {
      m.set(area.id, area.name);
    }
    return m;
  });

  const filteredProjects = createMemo(() => {
    const q = search().toLowerCase().trim();
    const area = selectedArea();
    const overrides = optimisticOverrides();
    return props.projects
      .filter((p) => p.id !== UNASSIGNED_PROJECT_ID)
      .filter((p) => p.lifecycleStatus !== "archived")
      .map((p) => {
        const ov = overrides.get(p.id);
        return ov ? { ...p, lifecycleStatus: ov } : p;
      })
      .filter((p) => {
        if (area !== "all" && p.area !== area) return false;
        if (!q) return true;
        const title = p.title.toLowerCase();
        const id = p.id.toLowerCase();
        return title.includes(q) || id.includes(q);
      });
  });

  const groupedProjects = createMemo(() => {
    const filtered = filteredProjects();
    const result = new Map<ProjectLifecycleStatus, BoardProject[]>();
    for (const g of GROUPS) result.set(g.status, []);
    for (const p of filtered) {
      const list = result.get(p.lifecycleStatus);
      if (list) list.push(p);
      else result.get("shaping")!.push(p);
    }
    const shaping = result.get("shaping");
    shaping?.sort((a, b) => {
      const rankDiff = shapingStageRank(a.status) - shapingStageRank(b.status);
      if (rankDiff !== 0) return rankDiff;
      return a.id.localeCompare(b.id);
    });
    return result;
  });
  const fallbackCounts = createMemo(() => {
    const counts: ProjectLifecycleCounts = {
      triage: 0,
      shaping: 0,
      active: 0,
      ready_to_merge: 0,
      done: 0,
      cancelled: 0,
      archived: 0,
    };
    for (const project of filteredProjects()) {
      counts[project.lifecycleStatus] += 1;
    }
    return counts;
  });
  const groupCount = (status: ProjectLifecycleStatus) =>
    props.lifecycleCounts?.[status] ?? fallbackCounts()[status];

  function showToast(message: string, variant: ToastVariant = "info") {
    setToast({ message, variant });
    props.onToast?.(message, variant);
  }

  createEffect(() => {
    const overrides = optimisticOverrides();
    if (overrides.size === 0) return;
    let changed = false;
    const next = new Map(overrides);
    for (const project of props.projects) {
      const override = next.get(project.id);
      if (override && project.lifecycleStatus === override) {
        next.delete(project.id);
        changed = true;
      }
    }
    if (changed) setOptimisticOverrides(next);
  });

  async function moveProject(
    projectId: string,
    sourceStatus: ProjectLifecycleStatus,
    targetStatus: ProjectLifecycleStatus
  ) {
    if (sourceStatus === targetStatus) return;
    setOptimisticOverrides((prev) => {
      const next = new Map(prev);
      next.set(projectId, targetStatus);
      return next;
    });

    const result = await moveBoardProject(projectId, targetStatus);
    if (!result.ok) {
      setOptimisticOverrides((prev) => {
        const next = new Map(prev);
        next.delete(projectId);
        return next;
      });
      showToast(result.error, "error");
    }
  }

  async function handleDrop(targetStatus: ProjectLifecycleStatus) {
    const drag = dragging();
    if (!drag) return;
    setDragging(null);
    setTimeout(() => setSuppressNextClick(false), 0);
    await moveProject(drag.projectId, drag.sourceStatus, targetStatus);
  }

  function handleCardDragStart(project: BoardProject, e: DragEvent) {
    const state: DragState = {
      projectId: project.id,
      sourceStatus: project.lifecycleStatus,
    };
    e.dataTransfer?.setData("text/plain", project.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    setDragging(state);
    setSuppressNextClick(true);
  }

  function handleCardDragEnd() {
    setDragging(null);
    setTimeout(() => setSuppressNextClick(false), 0);
  }

  function handleCardClick(project: BoardProject) {
    if (suppressNextClick()) return;
    props.onProjectClick?.(project);
  }

  const loadingSkeleton = (
    <div data-testid="project-list-loading" aria-label="Loading projects">
      {GROUPS.slice(0, 2).map(() => (
        <div style={{ "margin-bottom": "16px" }}>
          <div
            style={{
              height: "16px",
              width: "80px",
              background: "var(--bg-surface)",
              "border-radius": "4px",
              "margin-bottom": "8px",
            }}
          />
          {[1, 2, 3].map(() => (
            <div
              data-testid="skeleton-row"
              style={{
                height: "72px",
                background: "var(--bg-surface)",
                "border-radius": "6px",
                "margin-bottom": "6px",
                animation: "pulse 1.5s ease-in-out infinite",
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );

  const errorState = (
    <div
      data-testid="project-list-error"
      style={{
        "text-align": "center",
        padding: "32px",
        color: "var(--text-secondary)",
      }}
    >
      <div style={{ "margin-bottom": "12px" }}>Failed to load projects.</div>
      <button
        data-testid="retry-button"
        onClick={props.onRetry}
        style={{
          padding: "6px 14px",
          "border-radius": "4px",
          border: "1px solid var(--border-default)",
          background: "var(--bg-surface)",
          color: "var(--text-primary)",
          cursor: "pointer",
        }}
      >
        Retry
      </button>
    </div>
  );

  // Empty state — only when there are no non-archived projects
  const hasProjects = createMemo(() =>
    props.lifecycleCounts
      ? props.lifecycleCounts.shaping +
          props.lifecycleCounts.active +
          props.lifecycleCounts.done +
          props.lifecycleCounts.cancelled >
        0
      : props.projects.some(
          (p) =>
            p.id !== UNASSIGNED_PROJECT_ID && p.lifecycleStatus !== "archived"
        )
  );

  return (
    <Show when={!props.loading} fallback={loadingSkeleton}>
      <Show when={!props.error} fallback={errorState}>
        <div data-testid="project-list-grouped">
          {/* Top controls */}
          <div
            style={{
              display: "flex",
              gap: "8px",
              "margin-bottom": "12px",
              "flex-wrap": "wrap",
              "align-items": "center",
            }}
          >
            {/* Search */}
            <input
              data-testid="project-search"
              type="text"
              placeholder="Search by title or ID…"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              style={{
                flex: 1,
                "min-width": "160px",
                padding: "5px 10px",
                "border-radius": "5px",
                border: "1px solid var(--border-default)",
                background: "var(--bg-base)",
                color: "var(--text-primary)",
                "font-size": "13px",
              }}
            />
            {/* Area filter chips */}
            <Show when={props.areas.length > 0}>
              <div
                data-testid="area-filter-chips"
                style={{ display: "flex", gap: "4px", "flex-wrap": "wrap" }}
              >
                <button
                  data-testid="area-chip-all"
                  onClick={() => setSelectedArea("all")}
                  style={{
                    padding: "3px 10px",
                    "border-radius": "12px",
                    border: `1px solid ${selectedArea() === "all" ? "var(--color-link, #4a9eff)" : "var(--border-default)"}`,
                    background:
                      selectedArea() === "all"
                        ? "var(--bg-selected, rgba(74,158,255,0.1))"
                        : "var(--bg-surface)",
                    color:
                      selectedArea() === "all"
                        ? "var(--color-link, #4a9eff)"
                        : "var(--text-secondary)",
                    cursor: "pointer",
                    "font-size": "12px",
                  }}
                >
                  All
                </button>
                <For each={props.areas}>
                  {(area) => (
                    <button
                      data-testid={`area-chip-${area.id}`}
                      onClick={() =>
                        setSelectedArea((prev) =>
                          prev === area.id ? "all" : area.id
                        )
                      }
                      style={{
                        padding: "3px 10px",
                        "border-radius": "12px",
                        border: `1px solid ${selectedArea() === area.id ? "var(--color-link, #4a9eff)" : "var(--border-default)"}`,
                        background:
                          selectedArea() === area.id
                            ? "var(--bg-selected, rgba(74,158,255,0.1))"
                            : "var(--bg-surface)",
                        color:
                          selectedArea() === area.id
                            ? "var(--color-link, #4a9eff)"
                            : "var(--text-secondary)",
                        cursor: "pointer",
                        "font-size": "12px",
                      }}
                    >
                      {area.name}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>

          {/* Empty state banner (shown above groups when no projects) */}
          <Show when={!hasProjects()}>
            <div
              data-testid="project-list-empty"
              style={{
                "text-align": "center",
                padding: "24px 20px 12px",
                color: "var(--text-secondary)",
              }}
            >
              <div style={{ "margin-bottom": "12px", "font-size": "15px" }}>
                No projects yet
              </div>
              <span
                data-testid="create-cta"
                style={{
                  padding: "6px 14px",
                  "border-radius": "4px",
                  border: "1px solid var(--border-default)",
                  background: "var(--bg-surface)",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  "font-size": "13px",
                }}
              >
                + Create
              </span>
            </div>
          </Show>

          {/* Grouped project lists — always rendered so drop zones are available */}
          <For each={GROUPS}>
            {(group) => {
              const projects = () => groupedProjects().get(group.status) ?? [];
              return (
                <GroupSection
                  group={group}
                  projects={projects()}
                  totalCount={groupCount(group.status)}
                  loading={group.status === "done" && props.doneLoading}
                  areas={areaMap()}
                  draggingProjectId={dragging()?.projectId ?? null}
                  onExpandedChange={(expanded) =>
                    props.onDoneExpandedChange?.(expanded)
                  }
                  onDrop={(targetStatus) => void handleDrop(targetStatus)}
                  onCardDragStart={handleCardDragStart}
                  onCardDragEnd={handleCardDragEnd}
                  onCardClick={handleCardClick}
                  onStatusChange={(project, targetStatus) =>
                    void moveProject(
                      project.id,
                      project.lifecycleStatus,
                      targetStatus
                    )
                  }
                  shapingRunsByProjectId={shapingRunsByProjectId()}
                />
              );
            }}
          </For>

          {/* Toast */}
          <Show when={toast() !== null}>
            <ToastNotification
              message={toast()!.message}
              variant={toast()!.variant}
              onClose={() => setToast(null)}
            />
          </Show>
        </div>
      </Show>
    </Show>
  );
}
