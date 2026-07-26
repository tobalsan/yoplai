import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  createProject,
  fetchBoardProjects,
  fetchProject,
  subscribeToFileChanges,
  subscribeToSubagentChanges,
  updateProject,
} from "../api";
import type {
  BoardProject,
  BoardWorktree,
  ProjectLifecycleStatus,
} from "../api/types";
import { renderMarkdown } from "../lib/markdown";
import { ProjectDetailPanel } from "./board/ProjectDetailPanel";
import { SubagentRunsPanel } from "./SubagentRunsPanel";

type FilterMode = "active" | "done" | "archived";
type WorktreeTone = "green" | "red" | "yellow" | "muted" | "idle";

type WorktreeStatus = {
  label: string;
  tone: WorktreeTone;
  working: boolean;
};

const UNASSIGNED_PROJECT_ID = "__unassigned";
const TERMINAL_STATUSES = new Set(["archived", "trashed", "cancelled"]);

function emptyBoardProjectsResponse() {
  return {
    projects: [],
    lifecycleCounts: {
      triage: 0,
      shaping: 0,
      active: 0,
      ready_to_merge: 0,
      done: 0,
      cancelled: 0,
      archived: 0,
    },
  };
}

function lifecycleStatusFromProjectStatus(
  status: string
): ProjectLifecycleStatus {
  if (status === "active") return "active";
  if (status === "done") return "done";
  if (status === "cancelled") return "cancelled";
  if (status === "archived") return "archived";
  return "shaping";
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join("/");
}

function relativeTime(value?: string): string {
  if (!value) return "No activity";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "No activity";
  const diff = Date.now() - time;
  if (diff < 30_000) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusLabel(status: string): string {
  if (status === "ready_to_merge") return "Ready to merge";
  return status.replace(/_/g, " ");
}

function getWorktreeStatus(worktree: BoardWorktree): WorktreeStatus {
  const runStatus = worktree.agentRun?.status;
  if (runStatus === "running") {
    return { label: "working", tone: "green", working: true };
  }
  if (runStatus === "failed") {
    return { label: "failed", tone: "red", working: false };
  }
  if (worktree.queueStatus === "conflict") {
    return { label: "conflict", tone: "red", working: false };
  }
  if (worktree.queueStatus === "stale_worker") {
    return { label: "stale", tone: "yellow", working: false };
  }
  if (worktree.queueStatus === "pending") {
    return { label: "pending", tone: "yellow", working: false };
  }
  if (worktree.queueStatus === "skipped") {
    return { label: "skipped", tone: "muted", working: false };
  }
  if (worktree.queueStatus === "integrated") {
    return { label: "integrated", tone: "muted", working: false };
  }
  return { label: "idle", tone: "idle", working: false };
}

function projectMatchesFilter(
  project: BoardProject,
  mode: FilterMode
): boolean {
  if (mode === "done")
    return project.status === "done" || project.group === "done";
  if (mode === "archived") return TERMINAL_STATUSES.has(project.status);
  return (
    !TERMINAL_STATUSES.has(project.status) &&
    project.status !== "done" &&
    project.group !== "done"
  );
}

function isUnassignedProject(project: Pick<BoardProject, "id">): boolean {
  return project.id === UNASSIGNED_PROJECT_ID;
}

function firstParagraph(markdown: string): string {
  return (
    markdown
      .replace(/^---[\s\S]*?---\s*/m, "")
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .find((part) => part && !part.startsWith("#")) ?? ""
  );
}

export function ProjectsOverview(
  props: {
    embedded?: boolean;
    onOpenProject?: (id: string) => void;
    /** When embedded, navigate to full detail page instead of opening inline editor */
    onDetailNavigate?: (id: string) => void;
  } = {}
) {
  const params = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = createSignal<FilterMode>("active");
  const [query, setQuery] = createSignal("");
  const [createOpen, setCreateOpen] = createSignal(false);
  const [createTitle, setCreateTitle] = createSignal("");
  const [createError, setCreateError] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [editingTitle, setEditingTitle] = createSignal(false);
  const [draftTitle, setDraftTitle] = createSignal("");
  const [actionError, setActionError] = createSignal("");
  const [expandedWorktrees, setExpandedWorktrees] = createSignal<Set<string>>(
    new Set()
  );
  const [embeddedEditorProjectId, setEmbeddedEditorProjectId] = createSignal<
    string | null
  >(null);
  const [projects, { mutate, refetch }] = createResource(() =>
    fetchBoardProjects(true)
  );
  const projectItems = createMemo(() => {
    const response = projects() as unknown;
    if (Array.isArray(response)) return response as BoardProject[];
    return (
      (response as { projects?: BoardProject[] } | undefined)?.projects ?? []
    );
  });
  const selectedProjectId = createMemo(() => {
    if (props.embedded) {
      const raw = searchParams.project;
      const value = Array.isArray(raw) ? raw[0] : raw;
      return typeof value === "string" && value.trim() ? value : null;
    }
    return typeof params.id === "string" && params.id.trim() ? params.id : null;
  });
  const selectedProject = createMemo(() => {
    const id = selectedProjectId();
    return projectItems().find((project) => project.id === id) ?? null;
  });
  const [detail] = createResource(selectedProjectId, async (id) =>
    id && id !== UNASSIGNED_PROJECT_ID ? fetchProject(id) : null
  );
  const [lastPreview, setLastPreview] = createSignal("");
  createEffect(() => {
    const resolvedDetail = detail.latest;
    if (resolvedDetail) {
      const readme =
        resolvedDetail.docs?.README ?? resolvedDetail.docs?.["README.md"] ?? "";
      setLastPreview(firstParagraph(readme));
    }
  });
  const preview = createMemo(() => lastPreview());
  const filteredProjects = createMemo(() => {
    const needle = query().trim().toLowerCase();
    const matched = projectItems().filter((project) => {
      if (isUnassignedProject(project)) return true;
      if (!projectMatchesFilter(project, filter())) return false;
      return !needle || project.title.toLowerCase().includes(needle);
    });
    const realProjects = matched.filter(
      (project) => !isUnassignedProject(project)
    );
    const unassigned = matched.filter(isUnassignedProject);
    return [...realProjects, ...unassigned];
  });
  const trackedWorktreeCwds = createMemo(() => {
    const paths = new Set<string>();
    for (const project of projectItems()) {
      for (const worktree of project.worktrees) {
        paths.add(worktree.worktreePath || worktree.path);
      }
    }
    return [...paths];
  });

  createEffect(() => {
    const project = selectedProject();
    if (project && !editingTitle()) setDraftTitle(project.title);
  });

  onMount(() => {
    const onPopState = () => {
      if (embeddedEditorProjectId()) setEmbeddedEditorProjectId(null);
    };
    window.addEventListener("popstate", onPopState);
    onCleanup(() => window.removeEventListener("popstate", onPopState));
  });

  createEffect(() => {
    if (selectedProjectId() || projects.loading) return;
    const first = filteredProjects()[0];
    if (!first) return;
    if (props.embedded) {
      setSearchParams({ project: first.id }, { replace: true });
    } else {
      navigate(`/projects/${first.id}`, { replace: true });
    }
  });

  createEffect(() => {
    let refreshTimer: number | undefined;
    // Track last-seen status per subagent run so we only refetch the board
    // on real lifecycle transitions, not on the runtime's heartbeat-style
    // `subagent_changed status:"running"` pulses that fire ~1Hz during
    // stdout streaming. Without this filter, every active subagent triggers
    // a full board refetch every second.
    const lastSubagentStatus = new Map<string, string>();
    const scheduleRefresh = () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void refetch();
        refreshTimer = undefined;
      }, 250);
    };
    const unsubscribeFileChanges = subscribeToFileChanges({
      onFileChanged: scheduleRefresh,
    });
    const unsubscribeSubagentChanges = subscribeToSubagentChanges({
      onSubagentChanged: (event) => {
        const previous = lastSubagentStatus.get(event.runId);
        if (previous === event.status) return;
        lastSubagentStatus.set(event.runId, event.status);
        scheduleRefresh();
      },
    });
    onCleanup(() => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      lastSubagentStatus.clear();
      unsubscribeFileChanges();
      unsubscribeSubagentChanges();
    });
  });

  function selectProject(id: string) {
    setEmbeddedEditorProjectId(null);
    if (props.embedded) {
      setSearchParams({ project: id });
    } else {
      navigate(`/projects/${id}`);
    }
  }

  function replaceProject(project: BoardProject) {
    mutate((current) => {
      const existing = Array.isArray(current)
        ? { ...emptyBoardProjectsResponse(), projects: current }
        : (current ?? emptyBoardProjectsResponse());
      return {
        ...existing,
        projects: existing.projects.map((item) =>
          item.id === project.id ? project : item
        ),
      };
    });
  }

  async function saveTitle() {
    const project = selectedProject();
    const title = draftTitle().trim();
    if (
      !project ||
      isUnassignedProject(project) ||
      title.length === 0 ||
      title === project.title
    ) {
      setEditingTitle(false);
      setDraftTitle(project?.title ?? "");
      return;
    }
    setActionError("");
    try {
      await updateProject(project.id, { title });
      replaceProject({ ...project, title });
      setEditingTitle(false);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to save title"
      );
    }
  }

  async function markDone() {
    const project = selectedProject();
    if (!project || isUnassignedProject(project)) return;
    setActionError("");
    try {
      await updateProject(project.id, { status: "done" });
      replaceProject({ ...project, status: "done", group: "done" });
      setFilter("done");
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to mark done"
      );
    }
  }

  async function submitCreate(event: SubmitEvent) {
    event.preventDefault();
    const title = createTitle().trim();
    if (!title) return;
    setCreating(true);
    setCreateError("");
    try {
      const result = await createProject({ title });
      if (!result.ok) {
        setCreateError(result.error);
        return;
      }
      const created = result.data;
      mutate((current) => {
        const existing = Array.isArray(current)
          ? { ...emptyBoardProjectsResponse(), projects: current }
          : (current ?? emptyBoardProjectsResponse());
        const status =
          typeof created.frontmatter.status === "string"
            ? created.frontmatter.status
            : "maybe";
        return {
          ...existing,
          projects: [
            {
              id: created.id,
              title: created.title,
              area:
                typeof created.frontmatter.area === "string"
                  ? created.frontmatter.area
                  : "",
              status,
              group: "active",
              created:
                typeof created.frontmatter.created === "string"
                  ? created.frontmatter.created
                  : new Date().toISOString(),
              lifecycleStatus: lifecycleStatusFromProjectStatus(status),
              sliceProgress: { done: 0, total: 0 },
              lastActivity: null,
              activeRunCount: 0,
              worktrees: [],
            },
            ...existing.projects,
          ],
        };
      });
      setCreateOpen(false);
      setCreateTitle("");
      setFilter("active");
      if (props.embedded) {
        setSearchParams({ project: created.id });
      } else {
        navigate(`/projects/${created.id}`);
      }
      void refetch();
    } finally {
      setCreating(false);
    }
  }

  function openDetail(tab: "chat" | "activity" | "changes" = "chat") {
    const project = selectedProject();
    if (!project || isUnassignedProject(project)) return;
    if (props.embedded) {
      if (props.onDetailNavigate) {
        props.onDetailNavigate(project.id);
        return;
      }
      setEmbeddedEditorProjectId(project.id);
      window.history.pushState(
        { projectEditor: project.id },
        "",
        window.location.href
      );
      return;
    }
    if (props.onOpenProject) {
      props.onOpenProject(project.id);
      return;
    }
    try {
      localStorage.setItem(
        `yoplai:project:${project.id}:center-view`,
        JSON.stringify({ tab })
      );
    } catch {
      // ignore
    }
    setSearchParams({ ...searchParams, detail: "1" });
  }

  function worktreeExpansionKey(worktree: BoardWorktree): string {
    return worktree.worktreePath || worktree.path;
  }

  function toggleWorktree(worktree: BoardWorktree) {
    const key = worktreeExpansionKey(worktree);
    setExpandedWorktrees((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <div
      class="projects-overview"
      classList={{ "projects-overview-embedded": Boolean(props.embedded) }}
    >
      <aside class="po-list-pane">
        <header class="po-list-header">
          <div>
            <h1>Projects</h1>
            <p>{filteredProjects().length} visible</p>
          </div>
          <button
            class="po-primary"
            type="button"
            onClick={() => setCreateOpen(true)}
          >
            + New
          </button>
        </header>
        <div class="po-filters" role="tablist" aria-label="Project filters">
          <For each={["active", "done", "archived"] as FilterMode[]}>
            {(mode) => (
              <button
                classList={{ "po-filter": true, active: filter() === mode }}
                onClick={() => setFilter(mode)}
                type="button"
              >
                {mode[0].toUpperCase() + mode.slice(1)}
              </button>
            )}
          </For>
        </div>
        <input
          class="po-search"
          placeholder="Search projects"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <Show
          when={filteredProjects().length > 0}
          fallback={<div class="po-empty">No projects match this view.</div>}
        >
          <div class="po-project-list">
            <For each={filteredProjects()}>
              {(project) => (
                <button
                  classList={{
                    "po-project-row": true,
                    unassigned: isUnassignedProject(project),
                    selected: selectedProjectId() === project.id,
                  }}
                  type="button"
                  onClick={() => selectProject(project.id)}
                >
                  <span class="po-project-heading">
                    <span class="po-project-id">
                      {isUnassignedProject(project) ? "box" : project.id}
                    </span>
                    <span class="po-project-title">{project.title}</span>
                  </span>
                  <span class="po-count">{project.worktrees.length} wt</span>
                  <span class="po-area">
                    {isUnassignedProject(project)
                      ? "Not tied to a project"
                      : project.area || "No area"}
                  </span>
                  <span class={`po-status status-${project.status}`}>
                    {statusLabel(project.status)}
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </aside>

      <main class="po-detail-pane">
        <Show when={embeddedEditorProjectId()}>
          {(projectId) => (
            <ProjectDetailPanel
              projectId={projectId()}
              onBack={() => {
                if (window.history.state?.projectEditor === projectId()) {
                  window.history.back();
                } else {
                  setEmbeddedEditorProjectId(null);
                }
              }}
            />
          )}
        </Show>
        <Show when={!embeddedEditorProjectId()}>
          <Show
            when={selectedProject()}
            fallback={
              <section class="po-detail-empty">Select a project.</section>
            }
          >
            {(project) => (
              <section class="po-detail">
                <header class="po-detail-header">
                  <div class="po-title-wrap">
                    <Show
                      when={!isUnassignedProject(project()) && editingTitle()}
                      fallback={
                        <Show
                          when={isUnassignedProject(project())}
                          fallback={
                            <button
                              class="po-title-button"
                              type="button"
                              onClick={() => setEditingTitle(true)}
                            >
                              {project().title}
                            </button>
                          }
                        >
                          <h1>{project().title}</h1>
                        </Show>
                      }
                    >
                      <input
                        class="po-title-input"
                        value={draftTitle()}
                        autofocus
                        onInput={(event) =>
                          setDraftTitle(event.currentTarget.value)
                        }
                        onBlur={() => void saveTitle()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void saveTitle();
                          if (event.key === "Escape") {
                            setDraftTitle(project().title);
                            setEditingTitle(false);
                          }
                        }}
                      />
                    </Show>
                    <Show when={!isUnassignedProject(project())}>
                      <div class="po-detail-meta">
                        <span class={`po-status status-${project().status}`}>
                          {statusLabel(project().status)}
                        </span>
                        <span>{project().area || "No area"}</span>
                      </div>
                    </Show>
                  </div>
                  <Show when={!isUnassignedProject(project())}>
                    <button
                      class="po-secondary"
                      type="button"
                      onClick={markDone}
                    >
                      Mark done
                    </button>
                  </Show>
                </header>
                <Show when={actionError()}>
                  {(message) => <p class="po-error">{message()}</p>}
                </Show>

                <Show when={!isUnassignedProject(project())}>
                  <details class="po-readme">
                    <summary>
                      <span>README / SPECS</span>
                      <button
                        class="po-link-button"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          openDetail("chat");
                        }}
                      >
                        Edit
                      </button>
                    </summary>
                    <Show
                      when={preview()}
                      fallback={
                        <p class="po-muted">No README description yet.</p>
                      }
                    >
                      {(body) => (
                        <div
                          class="po-readme-preview"
                          innerHTML={renderMarkdown(body())}
                        />
                      )}
                    </Show>
                  </details>
                </Show>

                <Show when={isUnassignedProject(project())}>
                  <section class="po-unassigned-runs">
                    <div class="po-section-title">
                      <h2>Active runs not tied to a worktree</h2>
                    </div>
                    <SubagentRunsPanel
                      mode="unassigned"
                      excludeCwds={trackedWorktreeCwds()}
                    />
                  </section>
                </Show>

                <section class="po-worktrees">
                  <div class="po-section-title">
                    <h2>Worktrees</h2>
                    <span>{project().worktrees.length}</span>
                  </div>
                  <Show
                    when={project().worktrees.length > 0}
                    fallback={<div class="po-empty compact">No worktrees.</div>}
                  >
                    <div class="po-worktree-list">
                      <For each={project().worktrees}>
                        {(worktree) => {
                          const wtStatus = createMemo(() =>
                            getWorktreeStatus(worktree)
                          );
                          const expanded = createMemo(() =>
                            expandedWorktrees().has(
                              worktreeExpansionKey(worktree)
                            )
                          );
                          return (
                            <article class="po-worktree-item">
                              <button
                                type="button"
                                class="po-worktree-row"
                                aria-expanded={expanded()}
                                aria-label={`${expanded() ? "Collapse" : "Expand"} ${worktree.workerSlug || worktree.name} runs`}
                                onClick={() => toggleWorktree(worktree)}
                              >
                                <div class="po-worktree-main">
                                  <div class="po-worktree-title">
                                    <strong>
                                      {worktree.workerSlug || worktree.name}
                                    </strong>
                                    <span>
                                      {shortPath(
                                        worktree.worktreePath || worktree.path
                                      )}
                                    </span>
                                  </div>
                                  <div class="po-worktree-meta">
                                    <span>
                                      {worktree.branch ?? "no branch"}
                                    </span>
                                    <span>
                                      {relativeTime(
                                        worktree.agentRun?.updatedAt ??
                                          worktree.integratedAt ??
                                          worktree.startedAt
                                      )}
                                    </span>
                                  </div>
                                </div>
                                <span
                                  class={`po-worktree-status tone-${wtStatus().tone}`}
                                  classList={{ working: wtStatus().working }}
                                >
                                  <span class="po-status-dot" />
                                  {wtStatus().label}
                                </span>
                                <span
                                  class="po-worktree-chevron"
                                  aria-hidden="true"
                                >
                                  <span classList={{ open: expanded() }}>
                                    ›
                                  </span>
                                </span>
                              </button>
                              <Show when={expanded()}>
                                <div class="po-worktree-runs">
                                  <SubagentRunsPanel cwd={worktree.path} />
                                </div>
                              </Show>
                            </article>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </section>
              </section>
            )}
          </Show>
        </Show>
      </main>

      <Show when={createOpen()}>
        <div class="po-modal-backdrop" onClick={() => setCreateOpen(false)}>
          <form
            class="po-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={submitCreate}
          >
            <h2>New project</h2>
            <input
              class="po-create-title"
              placeholder="Project title"
              value={createTitle()}
              autofocus
              onInput={(event) => setCreateTitle(event.currentTarget.value)}
            />
            <Show when={createError()}>
              {(message) => <p class="po-error">{message()}</p>}
            </Show>
            <div class="po-modal-actions">
              <button type="button" onClick={() => setCreateOpen(false)}>
                Cancel
              </button>
              <button class="po-primary" type="submit" disabled={creating()}>
                Create
              </button>
            </div>
          </form>
        </div>
      </Show>
      <style>{`
        .projects-overview {
          height: 100%;
          min-height: 0;
          display: grid;
          grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
          background: var(--surface-primary);
          color: var(--text-primary);
        }
        .projects-overview-embedded {
          min-width: 0;
          background: transparent;
        }
        .po-list-pane,
        .po-detail-pane {
          min-height: 0;
          overflow: auto;
        }
        .po-list-pane {
          border-right: 1px solid var(--border-default);
          padding: 18px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          background: var(--surface-secondary);
        }
        .po-list-header,
        .po-detail-header,
        .po-section-title,
        .po-worktree-row,
        .po-modal-actions {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .po-list-header h1,
        .po-detail h1,
        .po-section-title h2,
        .po-modal h2 {
          margin: 0;
          color: var(--text-primary);
        }
        .po-list-header h1 { font-size: 22px; }
        .po-list-header p,
        .po-muted,
        .po-empty,
        .po-detail-meta,
        .po-worktree-meta {
          margin: 0;
          color: var(--text-secondary);
          font-size: 13px;
        }
        .po-primary,
        .po-secondary,
        .po-filter,
        .po-worktree-toggle,
        .po-modal-actions button,
        .po-link-button {
          border: 1px solid var(--border-default);
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
        }
        .po-primary {
          background: var(--accent);
          border-color: var(--accent);
          color: var(--accent-contrast);
          padding: 8px 11px;
        }
        .po-secondary,
        .po-modal-actions button {
          background: var(--surface-secondary);
          color: var(--text-primary);
          padding: 8px 11px;
        }
        .po-filters {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
        }
        .po-filter {
          background: transparent;
          color: var(--text-secondary);
          padding: 7px 8px;
        }
        .po-filter.active {
          background: var(--surface-primary);
          color: var(--text-primary);
        }
        .po-search,
        .po-title-input,
        .po-create-title {
          width: 100%;
          box-sizing: border-box;
          border: 1px solid var(--border-default);
          border-radius: 6px;
          background: var(--surface-primary);
          color: var(--text-primary);
          padding: 9px 10px;
          font: inherit;
        }
        .po-project-list {
          display: flex;
          flex-direction: column;
          gap: 7px;
        }
        .po-project-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          grid-template-areas:
            "title count"
            "area status";
          gap: 6px 8px;
          width: 100%;
          text-align: left;
          border: 1px solid transparent;
          border-radius: 8px;
          background: transparent;
          color: inherit;
          padding: 10px;
          cursor: pointer;
        }
        .po-project-row:hover,
        .po-project-row.selected {
          border-color: var(--border-default);
          background: var(--surface-primary);
        }
        .po-project-row.unassigned {
          color: var(--text-secondary);
        }
        .po-project-row.unassigned .po-project-title {
          color: var(--text-secondary);
        }
        .po-project-heading {
          grid-area: title;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .po-project-id {
          flex: 0 0 auto;
          border-radius: 999px;
          background: var(--surface-secondary);
          color: var(--text-secondary);
          padding: 1px 5px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          font-size: 10px;
          line-height: 1.5;
        }
        .po-project-title {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-weight: 600;
        }
        .po-count {
          grid-area: count;
          justify-self: end;
          color: var(--text-secondary);
          font-size: 12px;
        }
        .po-area {
          grid-area: area;
          color: var(--text-secondary);
          font-size: 12px;
        }
        .po-status {
          grid-area: status;
          justify-self: end;
          width: fit-content;
          border: 1px solid var(--border-default);
          border-radius: 999px;
          padding: 2px 7px;
          color: var(--text-secondary);
          font-size: 11px;
          text-transform: capitalize;
          white-space: nowrap;
        }
        .status-ready_to_merge { color: #5eead4; border-color: rgba(20, 184, 166, 0.35); }
        .status-done { color: #86efac; border-color: rgba(34, 197, 94, 0.35); }
        .status-archived,
        .status-trashed,
        .status-cancelled,
        .status-unassigned { color: #cbd5e1; }
        .po-detail-pane {
          padding: 24px;
        }
        .po-detail {
          max-width: 1180px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .po-title-wrap {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .po-title-button {
          border: 0;
          padding: 0;
          background: transparent;
          color: var(--text-primary);
          font-size: 28px;
          font-weight: 700;
          text-align: left;
          cursor: text;
        }
        .po-detail-meta,
        .po-worktree-meta,
        .po-worktree-title {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .po-readme {
          border: 1px solid var(--border-default);
          border-radius: 8px;
          padding: 12px 14px;
          background: var(--surface-secondary);
        }
        .po-readme summary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: pointer;
          color: var(--text-primary);
          font-weight: 600;
        }
        .po-link-button {
          background: transparent;
          color: var(--text-secondary);
          padding: 5px 8px;
        }
        .po-readme-preview {
          margin-top: 12px;
          color: var(--text-primary);
          font-size: 14px;
          line-height: 1.55;
        }
        .po-worktrees {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .po-unassigned-runs {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .po-section-title h2 { font-size: 16px; }
        .po-worktree-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .po-worktree-item {
          border: 1px solid var(--border-default);
          border-radius: 8px;
          background: var(--surface-secondary);
          overflow: hidden;
        }
        .po-worktree-row {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px;
          background: transparent;
          border: 0;
          color: inherit;
          text-align: left;
          font: inherit;
          cursor: pointer;
        }
        .po-worktree-row:hover {
          background: var(--surface-primary);
        }
        .po-worktree-row:focus-visible {
          outline: 2px solid var(--focus-ring, #6366f1);
          outline-offset: -2px;
        }
        .po-worktree-main {
          min-width: 0;
          flex: 1;
        }
        .po-worktree-title strong,
        .po-worktree-title span {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .po-worktree-title span {
          color: var(--text-secondary);
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          font-size: 12px;
        }
        .po-worktree-status {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 92px;
          color: var(--text-secondary);
          font-size: 12px;
          text-transform: capitalize;
        }
        .po-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: currentColor;
        }
        .tone-green { color: #22c55e; }
        .tone-red { color: #ef4444; }
        .tone-yellow { color: #f59e0b; }
        .tone-muted { color: #cbd5e1; }
        .tone-idle { color: var(--text-secondary); }
        .po-worktree-status.working .po-status-dot {
          animation: po-pulse 1.2s ease-in-out infinite;
        }
        @keyframes po-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.45; transform: scale(0.82); }
        }
        .po-worktree-chevron {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          color: var(--text-secondary);
          flex-shrink: 0;
        }
        .po-worktree-chevron span {
          display: inline-block;
          font-size: 18px;
          line-height: 1;
          transition: transform 120ms ease;
        }
        .po-worktree-chevron span.open {
          transform: rotate(90deg);
        }
        .po-worktree-runs {
          border-top: 1px solid var(--border-default);
          padding: 12px;
        }
        .po-empty,
        .po-detail-empty {
          border: 1px dashed var(--border-default);
          border-radius: 8px;
          padding: 18px;
          color: var(--text-secondary);
        }
        .po-empty.compact {
          padding: 12px;
        }
        .po-error {
          margin: 0;
          color: #fca5a5;
          font-size: 13px;
        }
        .po-modal-backdrop {
          position: fixed;
          inset: 0;
          z-index: 50;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          background: rgba(0, 0, 0, 0.42);
        }
        .po-modal {
          width: min(460px, 100%);
          border: 1px solid var(--border-default);
          border-radius: 8px;
          padding: 16px;
          background: var(--surface-primary);
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.24);
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        @media (max-width: 900px) {
          .projects-overview {
            grid-template-columns: 1fr;
          }
          .po-list-pane {
            border-right: 0;
            border-bottom: 1px solid var(--border-default);
            max-height: 45vh;
          }
          .po-detail-pane {
            padding: 16px;
          }
          .po-worktree-row,
          .po-detail-header {
            align-items: flex-start;
            flex-direction: column;
          }
          .po-worktree-status {
            min-width: 0;
          }
        }
      `}</style>
    </div>
  );
}
