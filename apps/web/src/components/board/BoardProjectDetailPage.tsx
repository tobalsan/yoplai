/**
 * Board-hosted project detail page — §15.3
 * Route: /board/projects/:projectId
 * Tabs: Pitch | Slices | Thread | Activity | Agent
 */
import { useParams, useNavigate, useSearchParams } from "@solidjs/router";
import {
  For,
  Match,
  Show,
  Suspense,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  addProjectComment,
  archiveProject,
  createSlice,
  fetchAreas,
  fetchProject,
  fetchRuntimeSubagents,
  subscribeToFileChanges,
  subscribeToSubagentChanges,
  unarchiveProject,
  updateProject,
} from "../../api";
import type { ProjectDetail, ProjectLifecycleStatus } from "../../api/types";
import { DocEditor } from "./DocEditor";
import { SliceKanbanWidget } from "../SliceKanbanWidget";
import { SliceDetailPage } from "../SliceDetailPage";
import { ActivityFeed } from "../ActivityFeed";
import { AgentRunChatPanel } from "../AgentRunChatPanel";
import { renderMarkdown } from "../../lib/markdown";
import { EditRepoModal } from "../project/EditRepoModal";
import { ToastNotification, type ToastVariant } from "../ui/Toast";
import {
  getProjectRunPillState,
  isProjectShapingRun,
  projectRunPillClass,
  projectRunPillLabel,
  sortProjectShapingRuns,
} from "../../lib/project-shaping-runs";

// ── Types ────────────────────────────────────────────────────────────

type BpdTab = "pitch" | "slices" | "thread" | "activity" | "agent";
type PitchDocKey = "PITCH" | "README";

type LifecycleAction = {
  label: string;
  nextStatus: string;
  dangerous?: boolean;
};

// ── Helpers ──────────────────────────────────────────────────────────

function getShapingSubStatus(
  frontmatter: Record<string, unknown>
): string | null {
  const s = frontmatter.status;
  if (typeof s !== "string" || !s.startsWith("shaping:")) return null;
  const stage = s.slice("shaping:".length);
  return stage || null;
}

function getLifecycleStatus(
  frontmatter: Record<string, unknown>
): ProjectLifecycleStatus {
  const s = frontmatter.status;
  if (typeof s === "string" && s.startsWith("shaping:")) return "shaping";
  if (
    s === "triage" ||
    s === "shaping" ||
    s === "active" ||
    s === "ready_to_merge" ||
    s === "done" ||
    s === "cancelled" ||
    s === "archived"
  ) {
    return s;
  }
  return "triage";
}

function getValidActions(status: ProjectLifecycleStatus): LifecycleAction[] {
  switch (status) {
    case "triage":
      return [{ label: "Move to shaping", nextStatus: "shaping" }];
    case "shaping":
      return [{ label: "Move to active", nextStatus: "active" }];
    case "active":
      return [
        { label: "Move to ready", nextStatus: "ready_to_merge" },
        { label: "Cancel", nextStatus: "cancelled", dangerous: true },
      ];
    case "ready_to_merge":
      return [
        { label: "Move to done", nextStatus: "done" },
        { label: "Cancel", nextStatus: "cancelled", dangerous: true },
      ];
    case "done":
      return [{ label: "Archive", nextStatus: "archived" }];
    case "archived":
      return [{ label: "Unarchive", nextStatus: "triage" }];
    case "cancelled":
      return [];
  }
}

function statusPillStyle(status: ProjectLifecycleStatus): string {
  switch (status) {
    case "triage":
      return "background:#f59e0b22;color:#d97706;border-color:#f59e0b44";
    case "active":
      return "background:#22c55e22;color:#16a34a;border-color:#22c55e44";
    case "ready_to_merge":
      return "background:#14b8a622;color:#0f766e;border-color:#14b8a644";
    case "done":
      return "background:#6366f122;color:#6366f1;border-color:#6366f144";
    case "cancelled":
      return "background:#f8717122;color:#dc2626;border-color:#f8717144";
    case "archived":
      return "background:#71717a22;color:#71717a;border-color:#71717a44";
    case "shaping":
    default:
      return "background:#f59e0b22;color:#d97706;border-color:#f59e0b44";
  }
}

function fmtDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function isBpdTab(value: unknown): value is BpdTab {
  return (
    value === "pitch" ||
    value === "slices" ||
    value === "thread" ||
    value === "activity" ||
    value === "agent"
  );
}

// ── Props ────────────────────────────────────────────────────────────

export type BoardProjectDetailPageProps = {
  /**
   * Project ID to display. When omitted (standalone route), read from URL params.
   * When provided (embedded in BoardView), use this value directly.
   */
  projectId?: string;
  sliceId?: string | null;
  tab?: string;
  /** Called when back button clicked. Defaults to navigate('/board'). */
  onBack?: () => void;
  /**
   * Called when navigating to another project (e.g. via ActivityFeed).
   * Defaults to navigate('/board/projects/:id').
   */
  onOpenProject?: (id: string) => void;
  onNavigate?: (to: string, options?: { replace?: boolean }) => void;
};

// ── Component ────────────────────────────────────────────────────────

function RawMarkdownEditor(props: {
  docKey: string;
  content: string;
  onSave: (content: string) => void;
  headerContent?: import("solid-js").JSX.Element;
}) {
  const [draft, setDraft] = createSignal(props.content);
  const [status, setStatus] = createSignal<"idle" | "saving" | "saved">("idle");
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSaved = props.content;

  createEffect(() => {
    const next = props.content;
    if (next === lastSaved) return;
    lastSaved = next;
    setDraft(next);
  });

  const flush = (content: string) => {
    if (content === lastSaved) return;
    setStatus("saving");
    lastSaved = content;
    props.onSave(content);
    setStatus("saved");
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => setStatus("idle"), 1500);
  };

  const scheduleSave = (content: string) => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      flush(content);
    }, 800);
  };

  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer);
    if (savedTimer) clearTimeout(savedTimer);
    flush(draft());
  });

  return (
    <section class="raw-doc-editor">
      <header class="raw-doc-editor-header">
        {props.headerContent ?? (
          <span class="raw-doc-editor-key">{props.docKey}</span>
        )}
        <span class="raw-doc-editor-status" data-status={status()}>
          <Show when={status() === "saving"}>saving…</Show>
          <Show when={status() === "saved"}>saved</Show>
        </span>
      </header>
      <textarea
        class="raw-doc-editor-body"
        aria-label={`Document ${props.docKey}`}
        value={draft()}
        onInput={(e) => {
          const next = e.currentTarget.value;
          setDraft(next);
          scheduleSave(next);
        }}
        onBlur={() => {
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = undefined;
          flush(draft());
        }}
      />
    </section>
  );
}

export function BoardProjectDetailPage(
  props: BoardProjectDetailPageProps = {}
) {
  const params = useParams<{ projectId: string; sliceId?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const projectId = createMemo(() => props.projectId ?? params.projectId ?? "");
  const navigateTo = (to: string, options?: { replace?: boolean }) => {
    if (props.onNavigate) props.onNavigate(to, options);
    else if (options) navigate(to, options);
    else navigate(to);
  };

  const selectedSliceId = createMemo(
    () => props.sliceId ?? params.sliceId ?? null
  );
  const activeTab = createMemo<BpdTab>(() => {
    if (selectedSliceId()) return "slices";
    // Embedded (parent owns navigation via onNavigate): trust props.tab only —
    // searchParams comes from Solid Router and goes stale after manual pushState.
    // Standalone: fall back to URL searchParams.
    const tab = props.onNavigate ? props.tab : (props.tab ?? searchParams.tab);
    return isBpdTab(tab) ? tab : "pitch";
  });
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [pitchDoc, setPitchDoc] = createSignal<PitchDocKey>("PITCH");
  const [editRepoOpen, setEditRepoOpen] = createSignal(false);
  const [toast, setToast] = createSignal<{
    message: string;
    variant: ToastVariant;
  } | null>(null);
  const [actionPending, setActionPending] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [titleEditing, setTitleEditing] = createSignal(false);
  const [titleDraft, setTitleDraft] = createSignal("");
  const [titleSaving, setTitleSaving] = createSignal(false);
  const [titleError, setTitleError] = createSignal<string | null>(null);

  // Slice creation form state
  const [addingSlice, setAddingSlice] = createSignal(false);
  const [newSliceTitle, setNewSliceTitle] = createSignal("");
  const [sliceCreating, setSliceCreating] = createSignal(false);
  const [sliceCreateError, setSliceCreateError] = createSignal<string | null>(
    null
  );

  // Thread comment form state
  const [commentDraft, setCommentDraft] = createSignal("");
  const [commentPosting, setCommentPosting] = createSignal(false);
  let titleInputRef: HTMLInputElement | undefined;

  const [project, { mutate: mutateProject, refetch: refetchProject }] =
    createResource(projectId, fetchProject);
  const [areas] = createResource(fetchAreas);
  const [projectRuns, { refetch: refetchProjectRuns }] = createResource(
    projectId,
    async (id) => {
      const data = await fetchRuntimeSubagents({
        projectId: id,
        includeArchived: true,
      });
      return data.items
        .filter((run) => isProjectShapingRun(run, id))
        .sort(sortProjectShapingRuns);
    }
  );

  createEffect(() => {
    if (!titleEditing()) return;
    queueMicrotask(() => {
      titleInputRef?.focus();
      titleInputRef?.select();
    });
  });

  createEffect(() => {
    let refreshTimer: number | undefined;
    const unsubscribe = subscribeToSubagentChanges({
      onSubagentChanged: () => {
        if (refreshTimer) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          void refetchProjectRuns();
        }, 250);
      },
    });
    onCleanup(() => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      unsubscribe();
    });
  });

  const projectRunPillState = createMemo(() =>
    getProjectRunPillState(projectRuns.latest ?? [])
  );

  // Realtime file-change subscription
  createEffect(() => {
    const id = projectId();
    if (!id) return;
    let refreshTimer: number | undefined;

    const unsubscribe = subscribeToFileChanges({
      onFileChanged: (changedId, file) => {
        if (changedId !== id) return;
        const normalized = file.replace(/\\/g, "/").toUpperCase();
        if (
          normalized === "PITCH.MD" ||
          normalized === "README.MD" ||
          normalized === "THREAD.MD"
        ) {
          if (refreshTimer) window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => {
            void refetchProject();
          }, 300);
        }
      },
    });

    onCleanup(() => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      unsubscribe();
    });
  });

  // Close menu on outside click
  createEffect(() => {
    if (!menuOpen()) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest(".bpd-action-menu-root")) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  const area = createMemo(() => {
    const p = project.latest;
    const areaId = p?.frontmatter?.area;
    if (!areaId || typeof areaId !== "string") return undefined;
    return (areas.latest ?? []).find((a) => a.id === areaId);
  });

  const lifecycleStatus = createMemo((): ProjectLifecycleStatus => {
    const p = project.latest;
    if (!p) return "shaping";
    return getLifecycleStatus(p.frontmatter);
  });

  const shapingSubStatus = createMemo((): string | null => {
    const p = project.latest;
    if (!p) return null;
    return getShapingSubStatus(p.frontmatter);
  });

  const validActions = createMemo(() => getValidActions(lifecycleStatus()));
  const currentRepo = createMemo(() => {
    const repo = project.latest?.frontmatter.repo;
    return typeof repo === "string" ? repo : "";
  });

  const projectUrl = (tab: BpdTab = "pitch") => {
    const id = projectId();
    const base = `/board/projects/${encodeURIComponent(id)}`;
    return tab === "pitch" ? base : `${base}?tab=${tab}`;
  };

  const projectAgentRunUrl = (runId: string | undefined) => {
    const base = `/board/projects/${encodeURIComponent(projectId())}?tab=agent`;
    return runId ? `${base}&run=${encodeURIComponent(runId)}` : base;
  };

  const queryStringValue = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;

  const sliceUrl = (sliceId: string, tab?: string) => {
    const id = projectId();
    const base = `/board/projects/${encodeURIComponent(id)}/slices/${encodeURIComponent(sliceId)}`;
    return tab ? `${base}?tab=${encodeURIComponent(tab)}` : base;
  };

  const openProjectTab = (tab: BpdTab) => {
    navigateTo(projectUrl(tab));
  };

  const handleBack = () => {
    if (props.onBack) {
      props.onBack();
    } else {
      navigate("/board");
    }
  };

  const openSliceDetail = (sliceId: string) => {
    if (!projectId()) return;
    navigateTo(sliceUrl(sliceId));
  };

  const closeSliceDetail = () => {
    navigateTo(projectUrl("slices"), { replace: true });
  };

  const handleLifecycleAction = async (nextStatus: string) => {
    setMenuOpen(false);
    const id = projectId();
    if (!id || actionPending()) return;
    setActionPending(true);
    setActionError(null);
    try {
      if (nextStatus === "archived") {
        const result = await archiveProject(id);
        if (!result.ok) throw new Error(result.error);
        handleBack();
        return;
      }
      if (lifecycleStatus() === "archived") {
        const result = await unarchiveProject(id);
        if (!result.ok) throw new Error(result.error);
        const refreshed = await fetchProject(id);
        mutateProject(refreshed);
        return;
      }
      const updated = await updateProject(id, { status: nextStatus });
      mutateProject(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionPending(false);
    }
  };

  const getRepoStatusMessage = (
    target: Pick<ProjectDetail, "frontmatter" | "repoValid">
  ) => {
    const repo = target.frontmatter.repo;
    if (typeof repo !== "string" || !repo) return "No repo configured";
    if (target.repoValid) return "";
    return "Path not found";
  };

  const handleRepoSave = async (repo: string): Promise<ProjectDetail> => {
    const id = projectId();
    const previousRepo = currentRepo();
    if (!id) throw new Error("Project not loaded");
    const updated = await updateProject(id, { repo });
    if (repo.trim() !== "" && !updated.repoValid) {
      await updateProject(id, { repo: previousRepo });
      await refetchProject();
      return updated;
    }
    mutateProject(updated);
    await refetchProject();
    return updated;
  };

  const startTitleEdit = () => {
    const p = project.latest;
    if (!p || titleSaving()) return;
    setTitleDraft(p.title);
    setTitleError(null);
    setTitleEditing(true);
  };

  const cancelTitleEdit = () => {
    setTitleEditing(false);
    setTitleDraft("");
    setTitleError(null);
  };

  const saveTitleEdit = async () => {
    const id = projectId();
    const nextTitle = titleDraft().trim();
    if (!id || titleSaving()) return;
    if (!nextTitle) {
      setTitleError("Title is required");
      return;
    }
    if (nextTitle === project.latest?.title) {
      cancelTitleEdit();
      return;
    }
    setTitleSaving(true);
    setTitleError(null);
    try {
      const updated = await updateProject(id, { title: nextTitle });
      mutateProject(updated);
      setTitleEditing(false);
      setTitleDraft("");
    } catch (error) {
      setTitleError(
        error instanceof Error ? error.message : "Failed to update title"
      );
    } finally {
      setTitleSaving(false);
    }
  };

  const handleSaveDoc = async (docKey: string, content: string) => {
    const id = projectId();
    if (!id) return;
    const updated = await updateProject(id, { docs: { [docKey]: content } });
    mutateProject(updated);
  };

  const handleAddSlice = async (e: Event) => {
    e.preventDefault();
    const title = newSliceTitle().trim();
    if (!title || sliceCreating()) return;
    const id = projectId();
    if (!id) return;
    setSliceCreating(true);
    setSliceCreateError(null);
    try {
      await createSlice(id, { title, status: "todo" });
      setNewSliceTitle("");
      setAddingSlice(false);
    } catch (error) {
      setSliceCreateError(
        error instanceof Error ? error.message : "Failed to create slice"
      );
    } finally {
      setSliceCreating(false);
    }
  };

  const handlePostComment = async (e: Event) => {
    e.preventDefault();
    const body = commentDraft().trim();
    if (!body || commentPosting()) return;
    const id = projectId();
    if (!id) return;
    setCommentPosting(true);
    try {
      await addProjectComment(id, body);
      setCommentDraft("");
      await refetchProject();
    } catch {
      // ignore
    } finally {
      setCommentPosting(false);
    }
  };

  return (
    <div class="bpd">
      {/* ── Header ── */}
      <header class="bpd-header">
        <button
          type="button"
          class="bpd-back"
          onClick={handleBack}
          aria-label="Back"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
        </button>

        <Show
          when={project.latest}
          fallback={<span class="bpd-loading-inline">Loading…</span>}
        >
          {(p) => (
            <div class="bpd-header-info">
              <span class="bpd-id">{p().id}</span>
              <div class="bpd-title-wrap" data-editing={titleEditing()}>
                <Show
                  when={titleEditing()}
                  fallback={
                    <>
                      <span class="bpd-title" title={p().title}>
                        {p().title}
                      </span>
                      <button
                        type="button"
                        class="bpd-title-icon"
                        aria-label="Edit project title"
                        onClick={startTitleEdit}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                        </svg>
                      </button>
                    </>
                  }
                >
                  <input
                    ref={titleInputRef}
                    class="bpd-title-input"
                    aria-label="Project title"
                    value={titleDraft()}
                    disabled={titleSaving()}
                    onInput={(e) => {
                      setTitleDraft(e.currentTarget.value);
                      if (titleError()) setTitleError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void saveTitleEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelTitleEdit();
                      }
                    }}
                  />
                  <button
                    type="button"
                    class="bpd-title-icon bpd-title-check"
                    aria-label="Save project title"
                    disabled={titleSaving()}
                    onClick={() => void saveTitleEdit()}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </button>
                </Show>
              </div>
              <Show when={titleError()}>
                {(error) => <span class="bpd-title-error">{error()}</span>}
              </Show>
              <Show when={projectRunPillState() !== "hidden"}>
                <span class={projectRunPillClass(projectRunPillState())}>
                  {projectRunPillLabel(projectRunPillState())}
                </span>
              </Show>
              <span
                class="bpd-status-pill"
                style={statusPillStyle(lifecycleStatus())}
              >
                {lifecycleStatus()}
              </span>
              <Show when={shapingSubStatus()}>
                {(stage) => (
                  <span class="bpd-shaping-stage">{stage()}</span>
                )}
              </Show>
              <Show when={area()}>
                {(a) => <span class="bpd-area">{a().title}</span>}
              </Show>
            </div>
          )}
        </Show>

        {/* Action menu */}
        <div class="bpd-action-menu-root">
          <button
            type="button"
            class="bpd-action-menu-trigger"
            disabled={actionPending()}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
          >
            {actionPending() ? "…" : "Actions ▾"}
          </button>
          <Show when={menuOpen()}>
            <div class="bpd-action-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                class="bpd-action-item"
                onClick={() => {
                  setMenuOpen(false);
                  setEditRepoOpen(true);
                }}
              >
                Edit repo…
              </button>
              <For each={validActions()}>
                {(action) => (
                  <button
                    type="button"
                    role="menuitem"
                    class="bpd-action-item"
                    classList={{
                      "bpd-action-item--danger": Boolean(action.dangerous),
                    }}
                    onClick={() =>
                      void handleLifecycleAction(action.nextStatus)
                    }
                  >
                    {action.label}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <Show when={actionError()}>
          <span class="bpd-action-error">{actionError()}</span>
        </Show>
      </header>

      {/* ── Tabs ── */}
      <div class="bpd-tabs" role="tablist">
        {(["pitch", "slices", "thread", "activity", "agent"] as BpdTab[]).map(
          (tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab() === tab}
            classList={{ "bpd-tab": true, active: activeTab() === tab }}
            onClick={() => openProjectTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
          )
        )}
      </div>

      {/* ── Body ── */}
      <div class="bpd-body">
        <Show when={project.loading && !project.latest}>
          <div class="bpd-loading">Loading project…</div>
        </Show>
        <Show when={project.error && !project.latest}>
          <div class="bpd-error">Failed to load project.</div>
        </Show>

        <Show when={project.latest}>
          {(p) => (
            <Switch>
              {/* Pitch tab */}
              <Match when={activeTab() === "pitch"}>
                <div class="bpd-tab-panel">
                  <Show
                    when={pitchDoc() === "README"}
                    fallback={
                      <DocEditor
                        projectId={projectId()}
                        docKey="PITCH"
                        content={p().docs?.["PITCH"] ?? ""}
                        onSave={(content) =>
                          void handleSaveDoc("PITCH", content)
                        }
                        headerContent={
                          <div
                            class="bpd-doc-switcher"
                            role="tablist"
                            aria-label="Project documents"
                          >
                            <button
                              type="button"
                              role="tab"
                              aria-selected="true"
                              class="active"
                              onClick={() => setPitchDoc("PITCH")}
                            >
                              PITCH
                            </button>
                            <button
                              type="button"
                              role="tab"
                              aria-selected="false"
                              onClick={() => setPitchDoc("README")}
                            >
                              README
                            </button>
                          </div>
                        }
                      />
                    }
                  >
                    <RawMarkdownEditor
                      docKey="README"
                      content={p().docs?.["README"] ?? ""}
                      onSave={(content) =>
                        void handleSaveDoc("README", content)
                      }
                      headerContent={
                        <div
                          class="bpd-doc-switcher"
                          role="tablist"
                          aria-label="Project documents"
                        >
                          <button
                            type="button"
                            role="tab"
                            aria-selected="false"
                            onClick={() => setPitchDoc("PITCH")}
                          >
                            PITCH
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected="true"
                            class="active"
                            onClick={() => setPitchDoc("README")}
                          >
                            README
                          </button>
                        </div>
                      }
                    />
                  </Show>
                </div>
              </Match>

              {/* Slices tab */}
              <Match when={activeTab() === "slices"}>
                <div class="bpd-tab-panel bpd-tab-panel--slices">
                  <div class="bpd-slices-toolbar">
                    <Show when={!addingSlice()}>
                      <button
                        type="button"
                        class="bpd-add-slice-btn"
                        onClick={() => setAddingSlice(true)}
                      >
                        Add slice
                      </button>
                    </Show>
                    <Show when={addingSlice()}>
                      <form
                        class="bpd-add-slice-form"
                        onSubmit={handleAddSlice}
                      >
                        <input
                          autofocus
                          class="bpd-add-slice-input"
                          placeholder="Slice title…"
                          value={newSliceTitle()}
                          onInput={(e) => {
                            setNewSliceTitle(e.currentTarget.value);
                            setSliceCreateError(null);
                          }}
                        />
                        <button
                          type="submit"
                          class="bpd-add-slice-submit"
                          disabled={sliceCreating() || !newSliceTitle().trim()}
                        >
                          {sliceCreating() ? "Adding…" : "Add"}
                        </button>
                        <button
                          type="button"
                          class="bpd-add-slice-cancel"
                          onClick={() => {
                            setAddingSlice(false);
                            setNewSliceTitle("");
                            setSliceCreateError(null);
                          }}
                        >
                          Cancel
                        </button>
                        <Show when={sliceCreateError()}>
                          {(message) => (
                            <div class="bpd-add-slice-error">{message()}</div>
                          )}
                        </Show>
                      </form>
                    </Show>
                  </div>
                  <Show
                    when={selectedSliceId()}
                    fallback={
                      <div class="bpd-slices-kanban">
                        <Suspense fallback={<SlicesLoading />}>
                          <SliceKanbanWidget
                            projectId={projectId()}
                            onSliceClick={openSliceDetail}
                          />
                        </Suspense>
                      </div>
                    }
                  >
                    {(sliceId) => (
                      <div class="bpd-slices-detail">
                        <SliceDetailPage
                          projectId={projectId()}
                          sliceId={sliceId()}
                          tab={props.tab}
                          routeBase="board"
                          onBack={closeSliceDetail}
                          onNavigate={navigateTo}
                          onOpenSlice={(nextProjectId, nextSliceId) => {
                            if (nextProjectId === projectId()) {
                              openSliceDetail(nextSliceId);
                            } else if (props.onOpenProject) {
                              props.onOpenProject(nextProjectId);
                              navigateTo(
                                `/board/projects/${encodeURIComponent(nextProjectId)}/slices/${encodeURIComponent(nextSliceId)}`
                              );
                            } else {
                              navigateTo(
                                `/board/projects/${encodeURIComponent(nextProjectId)}/slices/${encodeURIComponent(nextSliceId)}`
                              );
                            }
                          }}
                        />
                      </div>
                    )}
                  </Show>
                </div>
              </Match>

              {/* Thread tab — comment log + comment form */}
              <Match when={activeTab() === "thread"}>
                <div class="bpd-tab-panel bpd-tab-panel--thread">
                  <div class="bpd-thread-comments">
                    <Show
                      when={p().thread.length > 0}
                      fallback={
                        <div class="bpd-comment-empty">No comments yet.</div>
                      }
                    >
                      <div class="bpd-comment-list">
                        <For each={p().thread}>
                          {(entry) => (
                            <div class="bpd-comment">
                              <div class="bpd-comment-meta">
                                <span class="bpd-comment-author">
                                  {entry.author}
                                </span>
                                <span class="bpd-comment-date">
                                  {fmtDate(entry.date)}
                                </span>
                              </div>
                              <div
                                class="bpd-comment-body bpd-comment-markdown"
                                innerHTML={renderMarkdown(entry.body, {
                                  rewriteHref: (href) => href,
                                })}
                              />
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                    <form class="bpd-comment-form" onSubmit={handlePostComment}>
                      <textarea
                        class="bpd-comment-input"
                        placeholder="Add a comment…"
                        value={commentDraft()}
                        onInput={(e) => setCommentDraft(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                            e.preventDefault();
                            e.currentTarget.form?.requestSubmit();
                          }
                        }}
                        rows={3}
                      />
                      <button
                        type="submit"
                        class="bpd-comment-submit"
                        disabled={commentPosting() || !commentDraft().trim()}
                      >
                        {commentPosting() ? "Posting…" : "Post comment"}
                      </button>
                    </form>
                  </div>
                </div>
              </Match>

              <Match when={activeTab() === "activity"}>
                <div class="bpd-tab-panel bpd-activity-feed">
                  <ActivityFeed
                    projectId={projectId()}
                    onOpenProject={(id) =>
                      props.onOpenProject
                        ? props.onOpenProject(id)
                        : navigateTo(`/board/projects/${id}`)
                    }
                  />
                </div>
              </Match>

              <Match when={activeTab() === "agent"}>
                <div class="bpd-tab-panel bpd-agent-panel">
                  <AgentRunChatPanel
                    projectId={projectId()}
                    selectedRunId={queryStringValue(searchParams.run)}
                    onSelectedRunIdChange={(runId) =>
                      navigateTo(projectAgentRunUrl(runId), { replace: true })
                    }
                    filter={(run) => isProjectShapingRun(run, projectId())}
                  />
                </div>
              </Match>
            </Switch>
          )}
        </Show>
      </div>

      <Show when={editRepoOpen()}>
        <EditRepoModal
          initialRepo={currentRepo()}
          onClose={() => setEditRepoOpen(false)}
          onSave={handleRepoSave}
          showToast={(message, variant) => setToast({ message, variant })}
          getErrorMessage={getRepoStatusMessage}
        />
      </Show>
      <Show when={toast()}>
        {(currentToast) => (
          <ToastNotification
            message={currentToast().message}
            variant={currentToast().variant}
            onClose={() => setToast(null)}
          />
        )}
      </Show>

      <style>{`
        .bpd {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          background: var(--bg-base);
          color: var(--text-primary);
        }

        /* Header */
        .bpd-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border-default);
          flex-shrink: 0;
          flex-wrap: wrap;
          min-height: 52px;
        }

        .bpd-back {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 30px;
          height: 30px;
          flex-shrink: 0;
          border-radius: 6px;
          border: 1px solid var(--border-default);
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
          transition: background 0.12s, color 0.12s;
        }

        .bpd-back:hover {
          background: var(--bg-surface);
          color: var(--text-primary);
        }

        .bpd-header-info {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 0;
          flex-wrap: wrap;
        }

        .bpd-id {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 12px;
          color: var(--text-accent, #6366f1);
          padding: 2px 8px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--text-accent, #6366f1) 12%, transparent);
          flex-shrink: 0;
        }

        .bpd-title-wrap {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          min-width: 0;
          max-width: min(460px, 100%);
        }

        .bpd-title {
          font-size: 15px;
          font-weight: 600;
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .bpd-title-icon {
          width: 22px;
          height: 22px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--text-secondary);
          opacity: 0;
          cursor: pointer;
          transition: opacity 0.12s, background 0.12s, color 0.12s;
        }

        .bpd-title-wrap:hover .bpd-title-icon,
        .bpd-title-wrap:focus-within .bpd-title-icon,
        .bpd-title-wrap[data-editing="true"] .bpd-title-icon {
          opacity: 1;
        }

        .bpd-title-icon:hover:not(:disabled) {
          background: var(--bg-surface);
          color: var(--text-primary);
        }

        .bpd-title-icon:disabled {
          cursor: default;
          opacity: 0.5;
        }

        .bpd-title-check {
          color: var(--text-accent, #6366f1);
        }

        .bpd-title-input {
          min-width: 180px;
          max-width: min(420px, 60vw);
          height: 28px;
          padding: 3px 8px;
          border: 1px solid var(--border-default);
          border-radius: 6px;
          background: var(--bg-surface);
          color: var(--text-primary);
          font-size: 15px;
          font-weight: 600;
          outline: none;
        }

        .bpd-title-input:focus {
          border-color: var(--text-accent, #6366f1);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--text-accent, #6366f1) 18%, transparent);
        }

        .bpd-title-error {
          font-size: 12px;
          color: var(--color-danger, #dc2626);
        }

        .bpd-status-pill,
        .project-run-pill {
          font-size: 11px;
          font-weight: 500;
          padding: 2px 8px;
          border-radius: 999px;
          border: 1px solid transparent;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          flex-shrink: 0;
        }

        .project-run-pill--running {
          background: #22c55e22;
          color: #16a34a;
          border-color: #22c55e44;
        }

        .project-run-pill--stalled {
          background: #f59e0b22;
          color: #d97706;
          border-color: #f59e0b44;
        }

        .project-run-pill--error {
          background: #ef444422;
          color: #dc2626;
          border-color: #ef444444;
        }

        .bpd-shaping-stage {
          font-size: 11px;
          font-weight: 500;
          padding: 2px 8px;
          border-radius: 999px;
          background: rgba(74, 163, 160, 0.16);
          color: #4aa3a0;
          text-transform: lowercase;
          letter-spacing: 0.02em;
          flex-shrink: 0;
          white-space: nowrap;
        }

        .bpd-area {
          font-size: 12px;
          color: var(--text-secondary);
          flex-shrink: 0;
        }

        .bpd-loading-inline {
          font-size: 13px;
          color: var(--text-secondary);
        }

        /* Lifecycle action menu */
        .bpd-action-menu-root {
          position: relative;
          flex-shrink: 0;
        }

        .bpd-action-menu-trigger {
          font-size: 12px;
          font-weight: 500;
          padding: 5px 10px;
          border-radius: 6px;
          border: 1px solid var(--border-default);
          background: var(--bg-surface);
          color: var(--text-primary);
          cursor: pointer;
          transition: background 0.12s;
        }

        .bpd-action-menu-trigger:hover:not(:disabled) {
          background: var(--bg-hover, color-mix(in srgb, var(--bg-surface) 80%, #fff));
        }

        .bpd-action-menu-trigger:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .bpd-action-menu {
          position: absolute;
          top: calc(100% + 4px);
          right: 0;
          background: var(--bg-surface);
          border: 1px solid var(--border-default);
          border-radius: 8px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.15);
          min-width: 160px;
          z-index: 100;
          overflow: hidden;
        }

        .bpd-action-item {
          display: block;
          width: 100%;
          padding: 8px 12px;
          font-size: 13px;
          text-align: left;
          background: transparent;
          border: none;
          color: var(--text-primary);
          cursor: pointer;
          transition: background 0.1s;
        }

        .bpd-action-item:hover {
          background: var(--bg-hover, color-mix(in srgb, var(--bg-surface) 80%, #fff));
        }

        .bpd-action-item--danger {
          color: #dc2626;
        }

        .bpd-action-error {
          font-size: 12px;
          color: #dc2626;
        }

        /* Tabs */
        .bpd-tabs {
          display: flex;
          gap: 0;
          border-bottom: 1px solid var(--border-default);
          flex-shrink: 0;
        }

        .bpd-tab {
          background: transparent;
          border: none;
          color: var(--text-secondary);
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
          padding: 10px 16px;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          margin-bottom: -1px;
          transition: color 0.12s, border-color 0.12s;
        }

        .bpd-tab:hover {
          color: var(--text-primary);
        }

        .bpd-tab.active {
          color: var(--text-primary);
          border-bottom-color: var(--text-accent, #6366f1);
        }

        /* Body */
        .bpd-body {
          flex: 1;
          min-height: 0;
          overflow: auto;
          display: flex;
          flex-direction: column;
        }

        .bpd-loading,
        .bpd-error {
          padding: 32px;
          font-size: 13px;
          color: var(--text-secondary);
          text-align: center;
        }

        .bpd-error {
          color: #dc2626;
        }

        .bpd-tab-panel {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          height: 100%;
          padding: 16px;
        }

        .bpd-agent-panel {
          overflow: hidden;
        }

        .bpd-doc-switcher {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }

        .bpd-doc-switcher button {
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 11px;
          letter-spacing: 0.02em;
          padding: 4px 7px;
        }

        .bpd-doc-switcher button:hover,
        .bpd-doc-switcher button.active {
          background: var(--bg-surface-hover, var(--bg-surface));
          color: var(--text-primary);
        }

        .raw-doc-editor {
          min-height: 200px;
          height: 100%;
          display: flex;
          flex-direction: column;
          background: var(--bg-surface);
          color: var(--text-primary);
          border: 1px solid var(--border-default);
          border-radius: 10px;
          overflow: hidden;
        }

        .raw-doc-editor-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          border-bottom: 1px solid var(--border-default);
          background: var(--bg-surface);
          font-size: 11px;
          color: var(--text-secondary);
        }

        .raw-doc-editor-key {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          letter-spacing: 0.02em;
        }

        .raw-doc-editor-status {
          min-width: 56px;
          text-align: right;
          opacity: 0.75;
        }

        .raw-doc-editor-status[data-status="idle"] {
          opacity: 0;
        }

        .raw-doc-editor-body {
          flex: 1;
          min-height: 200px;
          resize: none;
          border: 0;
          outline: none;
          background: transparent;
          color: var(--text-primary);
          font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          padding: 14px;
        }

        /* Slices tab */
        .bpd-tab-panel--slices {
          padding: 12px 16px;
          gap: 10px;
        }

        .bpd-slices-toolbar {
          display: flex;
          align-items: center;
          flex-shrink: 0;
        }

        .bpd-add-slice-btn {
          font-size: 13px;
          font-weight: 500;
          padding: 6px 12px;
          border-radius: 6px;
          border: 1px solid var(--border-default);
          background: var(--bg-surface);
          color: var(--text-primary);
          cursor: pointer;
          transition: background 0.12s;
        }

        .bpd-add-slice-btn:hover {
          background: var(--bg-hover, color-mix(in srgb, var(--bg-surface) 80%, #fff));
        }

        .bpd-add-slice-form {
          display: flex;
          align-items: center;
          gap: 6px;
          flex: 1;
          flex-wrap: wrap;
        }

        .bpd-add-slice-input {
          flex: 1;
          font-family: inherit;
          font-size: 13px;
          padding: 5px 9px;
          border-radius: 6px;
          border: 1px solid var(--border-default);
          background: var(--bg-base);
          color: var(--text-primary);
          outline: none;
        }

        .bpd-add-slice-input:focus {
          border-color: var(--text-accent, #6366f1);
        }

        .bpd-add-slice-submit {
          font-size: 13px;
          padding: 5px 12px;
          border-radius: 6px;
          border: none;
          background: var(--text-accent, #6366f1);
          color: #fff;
          cursor: pointer;
          font-weight: 500;
        }

        .bpd-add-slice-submit:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .bpd-add-slice-cancel {
          font-size: 13px;
          padding: 5px 10px;
          border-radius: 6px;
          border: 1px solid var(--border-default);
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
        }

        .bpd-add-slice-error {
          flex-basis: 100%;
          color: var(--danger, #d25656);
          font-size: 12px;
          line-height: 1.35;
        }

        .bpd-slices-kanban {
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }

        .bpd-slices-detail {
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }

        /* Thread tab */
        .bpd-tab-panel--thread {
          gap: 16px;
          overflow: auto;
        }

        .bpd-thread-comments {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .bpd-comment-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .bpd-comment-empty {
          padding: 12px;
          border: 1px dashed var(--border-default);
          border-radius: 8px;
          color: var(--text-secondary);
          font-size: 13px;
        }

        .bpd-comment {
          padding: 10px 12px;
          border: 1px solid var(--border-default);
          border-radius: 8px;
          background: var(--bg-surface);
        }

        .bpd-comment-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
          font-size: 12px;
        }

        .bpd-comment-author {
          font-weight: 600;
          color: var(--text-primary);
        }

        .bpd-comment-date {
          color: var(--text-secondary);
        }

        .bpd-comment-body {
          font-size: 13px;
          color: var(--text-primary);
          line-height: 1.5;
        }

        .bpd-comment-markdown > :first-child {
          margin-top: 0;
        }

        .bpd-comment-markdown > :last-child {
          margin-bottom: 0;
        }

        .bpd-comment-markdown p,
        .bpd-comment-markdown pre,
        .bpd-comment-markdown blockquote,
        .bpd-comment-markdown ul,
        .bpd-comment-markdown ol {
          margin: 0 0 8px;
        }

        .bpd-comment-markdown ul,
        .bpd-comment-markdown ol {
          padding-left: 18px;
        }

        .bpd-comment-markdown code {
          font-family: var(--font-mono, monospace);
          font-size: 12px;
          background: var(--bg-elevated);
          border-radius: 4px;
          padding: 1px 4px;
        }

        .bpd-comment-markdown pre {
          overflow-x: auto;
          background: var(--bg-elevated);
          border-radius: 6px;
          padding: 10px;
        }

        .bpd-comment-markdown pre code {
          background: transparent;
          padding: 0;
        }

        .bpd-comment-markdown a {
          color: var(--accent);
        }

        .bpd-comment-form {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: auto;
        }

        .bpd-comment-input {
          width: 100%;
          font-family: inherit;
          font-size: 13px;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid var(--border-default);
          background: var(--bg-base);
          color: var(--text-primary);
          resize: vertical;
          outline: none;
          box-sizing: border-box;
        }

        .bpd-comment-input:focus {
          border-color: var(--text-accent, #6366f1);
        }

        .bpd-comment-submit {
          align-self: flex-end;
          font-size: 13px;
          font-weight: 500;
          padding: 6px 14px;
          border-radius: 6px;
          border: none;
          background: var(--text-accent, #6366f1);
          color: #fff;
          cursor: pointer;
        }

        .bpd-comment-submit:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        /* Activity stub */
        .bpd-activity-stub {
          align-items: center;
          justify-content: center;
        }

        .bpd-activity-stub-inner {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          text-align: center;
          color: var(--text-secondary);
          max-width: 320px;
        }

        .bpd-activity-stub-icon {
          font-size: 32px;
          margin-bottom: 4px;
        }

        .bpd-activity-stub-text {
          margin: 0;
          font-size: 14px;
          color: var(--text-primary);
          font-weight: 500;
        }

        .bpd-activity-stub-sub {
          margin: 0;
          font-size: 12px;
          line-height: 1.5;
        }
      `}</style>
    </div>
  );
}

function SlicesLoading() {
  return <div class="bpd-loading">Loading slices…</div>;
}
