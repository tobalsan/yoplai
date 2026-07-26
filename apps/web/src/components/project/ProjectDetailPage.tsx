import { useNavigate, useParams } from "@solidjs/router";
import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  addProjectComment,
  createTask,
  fetchAreas,
  fetchProject,
  fetchSpec,
  fetchTasks,
  saveSpec,
  useProjectRealtime,
  updateProject,
  updateTask,
} from "../../api";
import type { ProjectDetail, SubagentListItem, Task } from "../../api/types";
import { AgentPanel } from "./AgentPanel";
import {
  CenterPanel,
  type CenterTab,
  type SelectedProjectAgent,
} from "./CenterPanel";
import { SpecEditor } from "./SpecEditor";
import type { SpawnFormDraft, SpawnPrefill, SpawnTemplate } from "./SpawnForm";
import { zenMode } from "../../lib/layout";
import { readMigratedLocal } from "../../lib/local-storage";
import { SliceKanbanWidget } from "../SliceKanbanWidget";
import { EditRepoModal } from "./EditRepoModal";
import { ToastNotification, type ToastVariant } from "../ui/Toast";

type PersistedCenterView = {
  tab: CenterTab;
  agent?: { type: "lead" | "subagent"; slug?: string; agentId?: string };
};

function centerViewKey(id: string): string {
  return `yoplai:project:${id}:center-view`;
}

function readCenterView(id: string): PersistedCenterView | null {
  try {
    const raw = readMigratedLocal(centerViewKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.tab === "chat" ||
        parsed.tab === "activity" ||
        parsed.tab === "changes")
    ) {
      return parsed as PersistedCenterView;
    }
  } catch {
    return null;
  }
  return null;
}

function saveCenterView(id: string, view: PersistedCenterView): void {
  try {
    localStorage.setItem(centerViewKey(id), JSON.stringify(view));
  } catch {
    return;
  }
}

type MergedTab = "chat" | "activity" | "changes" | "spec" | "slices";
type MobileTab =
  | "overview"
  | "chat"
  | "activity"
  | "changes"
  | "spec"
  | "slices";

function getBaseAppTitle(): string {
  if (import.meta.env.VITE_YOPLAI_DEV === "true" || import.meta.env.VITE_AIHUB_DEV === "true") {
    const port = import.meta.env.VITE_YOPLAI_UI_PORT ?? import.meta.env.VITE_AIHUB_UI_PORT ?? "?";
    return `[DEV :${port}] Yoplai`;
  }
  return "Yoplai";
}

function getFrontmatterString(
  frontmatter: Record<string, unknown> | undefined,
  key: string
): string {
  if (!frontmatter) return "";
  const value = frontmatter[key];
  return typeof value === "string" ? value : "";
}

function getFrontmatterRecord(
  frontmatter: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  if (!frontmatter) return undefined;
  const value = frontmatter[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getRecordString(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getRepoStatusMessage(project?: {
  frontmatter: Record<string, unknown>;
  repoValid: boolean;
}): string {
  const repoPath = getFrontmatterString(project?.frontmatter, "repo");
  if (!repoPath) return "No repo configured";
  if (project?.repoValid) return "";
  return `Repo path not found: ${repoPath}`;
}

function buildTaskProgress(tasks: Task[]): { done: number; total: number } {
  return {
    done: tasks.filter((task) => task.checked).length,
    total: tasks.length,
  };
}

function getFilename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? normalized;
  return name.toUpperCase();
}

function isSessionArtifact(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/sessions/");
}

export function ProjectDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  const projectId = createMemo(() => params.id ?? "");
  const [compactLayout, setCompactLayout] = createSignal(false);
  const [isMobile, setIsMobile] = createSignal(false);
  const [mergedTab, setMergedTab] = createSignal<MergedTab>("spec");
  const [mobileTab, setMobileTab] = createSignal<MobileTab>("overview");
  const savedView = readCenterView(projectId());
  const [centerTab, setCenterTab] = createSignal<CenterTab>(
    savedView?.tab ?? "chat"
  );
  const [selectedAgent, setSelectedAgent] =
    createSignal<SelectedProjectAgent | null>(null);
  const [subagents, setSubagents] = createSignal<SubagentListItem[]>([]);
  const [spawnMode, setSpawnMode] = createSignal<{
    template: SpawnTemplate;
    prefill: SpawnPrefill;
  } | null>(null);
  const [chatInputDraft, setChatInputDraft] = createSignal("");
  const [spawnFormDraft, setSpawnFormDraft] = createSignal<SpawnFormDraft>({
    includeDefaultPrompt: true,
    includeRoleInstructions: true,
    includePostRun: true,
    includeCustomInstructions: false,
    customInstructions: "",
  });
  const openSliceDetail = (sliceId: string) => {
    navigate(
      `/board/projects/${encodeURIComponent(projectId())}/slices/${encodeURIComponent(sliceId)}`
    );
  };
  const [isEditingTitle, setIsEditingTitle] = createSignal(false);
  const [titleDraft, setTitleDraft] = createSignal("");
  const [actionMenuOpen, setActionMenuOpen] = createSignal(false);
  const [editRepoOpen, setEditRepoOpen] = createSignal(false);
  const [toast, setToast] = createSignal<{
    message: string;
    variant: ToastVariant;
  } | null>(null);
  let titleInputRef: HTMLInputElement | undefined;

  const [project, { mutate: mutateProject, refetch: refetchProject }] =
    createResource(projectId, fetchProject);
  const [areas] = createResource(fetchAreas);
  const [tasks, { mutate: mutateTasks, refetch: refetchTasks }] =
    createResource(projectId, fetchTasks);
  const [spec, { refetch: refetchSpec }] = createResource(projectId, fetchSpec);

  createEffect(() => {
    const id = projectId();
    if (!id) return;
    let refreshTimer: number | undefined;
    let shouldRefreshProject = false;
    let shouldRefreshSpec = false;
    let shouldRefreshTasks = false;

    const flush = () => {
      if (shouldRefreshProject) void refetchProject();
      if (shouldRefreshSpec) void refetchSpec();
      if (shouldRefreshTasks) void refetchTasks();
      shouldRefreshProject = false;
      shouldRefreshSpec = false;
      shouldRefreshTasks = false;
      refreshTimer = undefined;
    };

    const unsubscribe = useProjectRealtime(id, ["files"], (event) => {
      if (event.type === "file_changed") {
        const file = event.file;
        if (isSessionArtifact(file)) return;
        const filename = getFilename(file);
        if (filename === "SPECS.MD") {
          shouldRefreshSpec = true;
          shouldRefreshTasks = true;
        } else if (filename === "README.MD" || filename === "THREAD.MD") {
          shouldRefreshProject = true;
        } else {
          shouldRefreshProject = true;
        }
        if (refreshTimer) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(flush, 300);
      }
    });

    onCleanup(() => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      unsubscribe();
    });
  });

  onMount(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 1199px)");
    const update = (matches: boolean) => setCompactLayout(matches);
    update(media.matches);
    const handler = (event: MediaQueryListEvent) => update(event.matches);
    if (media.addEventListener) {
      media.addEventListener("change", handler);
      onCleanup(() => media.removeEventListener("change", handler));
      return;
    }
    media.addListener(handler);
    onCleanup(() => media.removeListener(handler));
  });

  onMount(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 768px)");
    const update = (matches: boolean) => setIsMobile(matches);
    update(media.matches);
    const handler = (event: MediaQueryListEvent) => update(event.matches);
    if (media.addEventListener) {
      media.addEventListener("change", handler);
      onCleanup(() => media.removeEventListener("change", handler));
      return;
    }
    media.addListener(handler);
    onCleanup(() => media.removeListener(handler));
  });

  const area = createMemo(() => {
    const current = project();
    const areaId = getFrontmatterString(current?.frontmatter, "area");
    if (!areaId) return undefined;
    return (areas() ?? []).find((item) => item.id === areaId);
  });
  const repoMessage = createMemo(() => getRepoStatusMessage(project()));
  const currentRepo = createMemo(() =>
    getFrontmatterString(project()?.frontmatter, "repo")
  );

  const handleBack = () => {
    navigate("/projects");
  };

  const handleStatusChange = async (status: string) => {
    const id = projectId();
    if (!id) return;
    await updateProject(id, { status });
    await refetchProject();
  };

  const handleRepoChange = async (repo: string) => {
    const id = projectId();
    if (!id) return;
    await updateProject(id, { repo });
    await refetchProject();
  };

  const handleModalRepoSave = async (repo: string): Promise<ProjectDetail> => {
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

  const handleAreaChange = async (areaId: string) => {
    const id = projectId();
    if (!id) return;
    await updateProject(id, { area: areaId });
    await refetchProject();
  };

  const handleToggleTask = async (task: Task) => {
    const id = projectId();
    if (!id) return;
    const checked = !task.checked;
    const previous = tasks();

    if (previous) {
      const nextTasks: Task[] = previous.tasks.map((item) =>
        item.order === task.order
          ? { ...item, checked, status: checked ? "done" : "todo" }
          : item
      );
      mutateTasks({
        ...previous,
        tasks: nextTasks,
        progress: buildTaskProgress(nextTasks),
      });
    }

    try {
      await updateTask(id, task.order, {
        checked,
        status: checked ? "done" : "todo",
      });
    } catch (error) {
      if (previous) mutateTasks(previous);
      await refetchTasks();
      throw error;
    }
  };

  const handleAddTask = async (title: string, description?: string) => {
    const id = projectId();
    if (!id) return;
    await createTask(id, { title, description });
    await Promise.all([refetchTasks(), refetchSpec()]);
  };

  const handleSaveSpec = async (content: string) => {
    const id = projectId();
    if (!id) return;
    await saveSpec(id, content);
  };

  const handleSaveDoc = async (docKey: string, content: string) => {
    const id = projectId();
    if (!id) return;
    const updated = await updateProject(id, { docs: { [docKey]: content } });
    mutateProject(updated);
  };

  const handleAddComment = async (body: string) => {
    const id = projectId();
    if (!id) return;
    await addProjectComment(id, body);
    await refetchProject();
  };

  const handleRefreshSpec = async () => {
    await Promise.all([refetchSpec(), refetchTasks()]);
  };

  const handleTitleChange = async (title: string) => {
    const id = projectId();
    const current = project();
    if (!id || !current) return;
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === current.title) return;
    mutateProject({ ...current, title: nextTitle });
    await updateProject(id, { title: nextTitle });
    await refetchProject();
  };

  const applyLeadSpawnToProject = (agentId: string, sessionKey?: string) => {
    const current = project();
    if (!current) return;
    const nextSessionKey =
      sessionKey?.trim() || `project:${projectId()}:${agentId}`;
    const currentFrontmatter = current.frontmatter ?? {};
    const currentSessionKeys =
      getFrontmatterRecord(currentFrontmatter, "sessionKeys") ?? {};
    mutateProject({
      ...current,
      frontmatter: {
        ...currentFrontmatter,
        sessionKeys: {
          ...currentSessionKeys,
          [agentId]: nextSessionKey,
        },
        status:
          getFrontmatterString(currentFrontmatter, "status") === "todo"
            ? "in_progress"
            : currentFrontmatter.status,
      },
    });
  };

  const handleStartTitleEdit = () => {
    const currentTitle = project()?.title ?? "";
    setTitleDraft(currentTitle);
    setIsEditingTitle(true);
  };

  const handleCancelTitleEdit = () => {
    setTitleDraft(project()?.title ?? "");
    setIsEditingTitle(false);
  };

  const handleSaveTitle = async () => {
    const current = project();
    const nextTitle = titleDraft().trim();
    if (!current || !nextTitle || nextTitle === current.title) {
      setIsEditingTitle(false);
      if (current) setTitleDraft(current.title);
      return;
    }
    setIsEditingTitle(false);
    await handleTitleChange(nextTitle);
  };

  createEffect(() => {
    if (isEditingTitle()) {
      queueMicrotask(() => titleInputRef?.focus());
    }
  });

  let restoredFromStorage = false;
  createEffect(() => {
    const current = project();
    const selected = selectedAgent();
    if (!current) return;
    if (selected && selected.projectId === current.id) return;
    const sessionKeys = getFrontmatterRecord(
      current.frontmatter,
      "sessionKeys"
    );
    const leadAgentId = sessionKeys
      ? Object.keys(sessionKeys).find(
          (key) => typeof sessionKeys[key] === "string"
        )
      : undefined;

    // Restore saved lead agent from localStorage
    if (
      !restoredFromStorage &&
      savedView?.agent?.type === "lead" &&
      savedView.agent.agentId &&
      sessionKeys &&
      savedView.agent.agentId in sessionKeys
    ) {
      restoredFromStorage = true;
      setSelectedAgent({
        type: "lead",
        projectId: current.id,
        agentId: savedView.agent.agentId,
        agentName: savedView.agent.agentId,
        sessionKey: getRecordString(sessionKeys, savedView.agent.agentId),
        sessionNonce: 0,
      });
      return;
    }
    // Defer to subagent restore effect if saved agent is a subagent
    if (!restoredFromStorage && savedView?.agent?.type === "subagent") {
      restoredFromStorage = true;
      // Set lead as fallback; subagent restore effect will override once subagents load
      if (leadAgentId) {
        setSelectedAgent({
          type: "lead",
          projectId: current.id,
          agentId: leadAgentId,
          agentName: leadAgentId,
          sessionKey: getRecordString(sessionKeys, leadAgentId),
          sessionNonce: 0,
        });
      }
      return;
    }

    if (!leadAgentId) {
      setSelectedAgent(null);
      return;
    }
    setSelectedAgent({
      type: "lead",
      projectId: current.id,
      agentId: leadAgentId,
      agentName: leadAgentId,
      sessionKey: getRecordString(sessionKeys, leadAgentId),
      sessionNonce: 0,
    });
  });

  // Restore saved subagent once subagents list is available
  let subagentRestored = false;
  createEffect(() => {
    const items = subagents();
    const current = project();
    if (subagentRestored || !current || items.length === 0) return;
    const selected = selectedAgent();
    if (selected && selected.projectId === current.id) {
      subagentRestored = true;
      return;
    }
    if (savedView?.agent?.type !== "subagent" || !savedView.agent.slug) return;
    subagentRestored = true;
    const match = items.find((entry) => entry.slug === savedView.agent!.slug);
    if (!match) return;
    const runMode =
      match.runMode === "main-run" ||
      match.runMode === "worktree" ||
      match.runMode === "clone" ||
      match.runMode === "none"
        ? match.runMode
        : undefined;
    setSelectedAgent({
      type: "subagent",
      projectId: current.id,
      slug: match.slug,
      cli: match.cli,
      runMode,
      status: match.status,
      agentName: match.name || match.slug,
    });
  });

  createEffect(() => {
    const selected = selectedAgent();
    if (selected?.type === "lead" && selected.agentId) {
      const current = project();
      const sessionKeys = current
        ? getFrontmatterRecord(current.frontmatter, "sessionKeys")
        : undefined;
      const nextSessionKey =
        sessionKeys && typeof sessionKeys[selected.agentId] === "string"
          ? (sessionKeys[selected.agentId] as string)
          : undefined;
      if (!nextSessionKey) {
        setSelectedAgent(null);
        return;
      }
      if (selected.sessionKey !== nextSessionKey) {
        setSelectedAgent({ ...selected, sessionKey: nextSessionKey });
      }
      return;
    }
    if (!selected || selected.type !== "subagent" || !selected.slug) return;
    const item = subagents().find((entry) => entry.slug === selected.slug);
    if (!item) return;
    const runMode =
      item.runMode === "main-run" ||
      item.runMode === "worktree" ||
      item.runMode === "clone" ||
      item.runMode === "none"
        ? item.runMode
        : undefined;
    if (
      selected.cli === item.cli &&
      selected.status === item.status &&
      selected.runMode === runMode
    ) {
      return;
    }
    setSelectedAgent({
      ...selected,
      cli: item.cli,
      status: item.status,
      runMode,
    });
  });

  // Persist center view to localStorage
  createEffect(() => {
    const id = projectId();
    const selected = selectedAgent();
    const tab = centerTab();
    if (!id) return;
    const agent = selected
      ? { type: selected.type, slug: selected.slug, agentId: selected.agentId }
      : undefined;
    saveCenterView(id, { tab, agent });
  });

  createEffect(() => {
    const current = project();
    if (!current) return;
    document.title = `${current.title} · ${getBaseAppTitle()}`;
  });

  createEffect(() => {
    if (!zenMode()) return;
    setCenterTab("chat");
    setMergedTab("chat");
    setMobileTab("chat");
    setSpawnMode(null);
  });

  createEffect(() => {
    if (!actionMenuOpen()) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!target.closest(".project-detail-action-menu-root")) {
        setActionMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  onCleanup(() => {
    document.title = getBaseAppTitle();
  });

  return (
    <>
      <Show when={project.loading && !project()}>
        <div class="project-detail-state">Loading project...</div>
      </Show>
      <Show when={project.error}>
        <div class="project-detail-state">Failed to load project.</div>
      </Show>
      <Show when={project()}>
        {(detail) => (
          <div class="project-detail-page" classList={{ zen: zenMode() }}>
            <Show when={!zenMode()}>
              <header class="project-detail-breadcrumb">
                <button
                  type="button"
                  class="project-detail-back"
                  onClick={handleBack}
                >
                  <span aria-hidden="true">←</span>
                  <span class="project-detail-back-text">Back to Projects</span>
                </button>
                <span class="project-detail-breadcrumb-separator">/</span>
                <span
                  class="project-detail-breadcrumb-area"
                  title={area()?.title ?? "Unknown area"}
                >
                  {area()?.title ?? "Unknown area"}
                </span>
                <span class="project-detail-breadcrumb-separator">/</span>
                <Show
                  when={isEditingTitle()}
                  fallback={
                    <span
                      class="project-detail-title"
                      onDblClick={handleStartTitleEdit}
                      title="Double-click to edit title"
                    >
                      {detail().title}
                    </span>
                  }
                >
                  <form
                    class="project-detail-title-edit"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleSaveTitle();
                    }}
                  >
                    <input
                      ref={(el) => (titleInputRef = el)}
                      class="project-detail-title-input"
                      value={titleDraft()}
                      onInput={(event) =>
                        setTitleDraft(event.currentTarget.value)
                      }
                    />
                    <button type="submit" class="project-detail-title-save">
                      Save
                    </button>
                    <button
                      type="button"
                      class="project-detail-title-cancel"
                      onClick={handleCancelTitleEdit}
                    >
                      Cancel
                    </button>
                  </form>
                </Show>
                <div class="project-detail-breadcrumb-spacer" />
                <div class="project-detail-action-menu-root">
                  <button
                    type="button"
                    class="project-detail-action-menu-trigger"
                    aria-haspopup="menu"
                    aria-expanded={actionMenuOpen()}
                    onClick={() => setActionMenuOpen((open) => !open)}
                  >
                    Actions ▾
                  </button>
                  <Show when={actionMenuOpen()}>
                    <div class="project-detail-action-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        class="project-detail-action-item"
                        onClick={() => {
                          setActionMenuOpen(false);
                          setEditRepoOpen(true);
                        }}
                      >
                        Edit repo…
                      </button>
                    </div>
                  </Show>
                </div>
              </header>
            </Show>
            <Show
              when={zenMode()}
              fallback={
                <div class="project-detail">
                  <Switch>
                    <Match when={isMobile()}>
                      <div class="project-detail__merged project-detail__merged--mobile">
                        <header class="project-detail-merged-tabs">
                          <button
                            type="button"
                            classList={{ active: mobileTab() === "overview" }}
                            onClick={() => setMobileTab("overview")}
                          >
                            Overview
                          </button>
                          <button
                            type="button"
                            classList={{ active: mobileTab() === "chat" }}
                            onClick={() => {
                              setMobileTab("chat");
                              setCenterTab("chat");
                            }}
                          >
                            Chat
                          </button>
                          <button
                            type="button"
                            classList={{ active: mobileTab() === "activity" }}
                            onClick={() => {
                              setMobileTab("activity");
                              setCenterTab("activity");
                            }}
                          >
                            Activity
                          </button>
                          <button
                            type="button"
                            classList={{ active: mobileTab() === "changes" }}
                            onClick={() => {
                              setMobileTab("changes");
                              setCenterTab("changes");
                            }}
                          >
                            Changes
                          </button>
                          <button
                            type="button"
                            classList={{ active: mobileTab() === "spec" }}
                            onClick={() => setMobileTab("spec")}
                          >
                            Spec
                          </button>
                          <button
                            type="button"
                            classList={{ active: mobileTab() === "slices" }}
                            onClick={() => setMobileTab("slices")}
                          >
                            Slices
                          </button>
                        </header>
                        <div class="project-detail__merged-body">
                          <Switch>
                            <Match when={mobileTab() === "overview"}>
                              <AgentPanel
                                project={detail()}
                                area={area()}
                                areas={areas() ?? []}
                                subagents={subagents()}
                                onSubagentsChange={(items) =>
                                  setSubagents(items)
                                }
                                onOpenSpawn={(input) => {
                                  setSpawnMode(input);
                                  setSpawnFormDraft({
                                    includeDefaultPrompt:
                                      input.prefill.includeDefaultPrompt ??
                                      true,
                                    includeRoleInstructions:
                                      input.prefill.includeRoleInstructions ??
                                      true,
                                    includePostRun:
                                      input.prefill.includePostRun ?? true,
                                    includeCustomInstructions: false,
                                    customInstructions:
                                      input.prefill.customInstructions ?? "",
                                  });
                                  setMobileTab("chat");
                                  setMergedTab("chat");
                                  setCenterTab("chat");
                                }}
                                onTitleChange={handleTitleChange}
                                onStatusChange={handleStatusChange}
                                onAreaChange={handleAreaChange}
                                onRepoChange={handleRepoChange}
                                onLeadSessionRemoved={() => {
                                  setSelectedAgent(null);
                                }}
                                onLeadSessionReset={({
                                  agentId,
                                  sessionKey,
                                }) => {
                                  setSelectedAgent({
                                    type: "lead",
                                    projectId: projectId(),
                                    agentId,
                                    agentName: agentId,
                                    sessionKey,
                                    sessionNonce: Date.now(),
                                  });
                                }}
                                selectedAgentSlug={
                                  selectedAgent()?.type === "lead"
                                    ? `lead:${selectedAgent()?.agentId ?? ""}`
                                    : (selectedAgent()?.slug ?? null)
                                }
                                onSelectAgent={(info) => {
                                  setMobileTab("chat");
                                  setMergedTab("chat");
                                  setCenterTab("chat");
                                  if (info.type === "lead") {
                                    setSelectedAgent({
                                      type: "lead",
                                      projectId: info.projectId,
                                      agentId: info.agentId,
                                      agentName: info.agentName ?? info.agentId,
                                      sessionKey: info.sessionKey,
                                      sessionNonce: 0,
                                    });
                                    return;
                                  }
                                  setSelectedAgent({
                                    type: "subagent",
                                    projectId: info.projectId,
                                    slug: info.slug,
                                    cli: info.cli,
                                    runMode:
                                      info.runMode === "main-run" ||
                                      info.runMode === "worktree" ||
                                      info.runMode === "clone" ||
                                      info.runMode === "none"
                                        ? info.runMode
                                        : undefined,
                                    status: info.status,
                                  });
                                }}
                              />
                            </Match>
                            <Match when={mobileTab() === "spec"}>
                              <SpecEditor
                                specContent={spec()?.content ?? ""}
                                docs={detail().docs}
                                tasks={tasks()?.tasks ?? []}
                                progress={
                                  tasks()?.progress ?? { done: 0, total: 0 }
                                }
                                areaColor={area()?.color}
                                onToggleTask={handleToggleTask}
                                onAddTask={handleAddTask}
                                onSaveSpec={handleSaveSpec}
                                onSaveDoc={handleSaveDoc}
                                onRefresh={handleRefreshSpec}
                              />
                            </Match>
                            <Match when={mobileTab() === "slices"}>
                              <SliceKanbanWidget
                                projectId={projectId()}
                                onSliceClick={openSliceDetail}
                              />
                            </Match>
                            <Match
                              when={
                                mobileTab() !== "overview" &&
                                mobileTab() !== "spec" &&
                                mobileTab() !== "slices"
                              }
                            >
                              <CenterPanel
                                project={detail()}
                                onAddComment={handleAddComment}
                                showTabs={false}
                                tab={
                                  mobileTab() as "chat" | "activity" | "changes"
                                }
                                selectedAgent={selectedAgent()}
                                spawnMode={spawnMode()}
                                chatInputDraft={chatInputDraft()}
                                onChatInputDraftChange={setChatInputDraft}
                                spawnFormDraft={spawnFormDraft()}
                                onSpawnFormDraftChange={setSpawnFormDraft}
                                subagents={subagents()}
                                onCancelSpawn={() => setSpawnMode(null)}
                                hasArea={Boolean(area())}
                                repoValid={detail().repoValid}
                                repoMessage={repoMessage()}
                                onSpawned={(result) => {
                                  const leadAgentName =
                                    spawnMode()?.prefill.agentName;
                                  setSpawnMode(null);
                                  if (
                                    result.type === "lead" &&
                                    result.agentId
                                  ) {
                                    applyLeadSpawnToProject(
                                      result.agentId,
                                      result.sessionKey
                                    );
                                    setSelectedAgent({
                                      type: "lead",
                                      projectId: projectId(),
                                      agentId: result.agentId,
                                      agentName:
                                        leadAgentName ?? result.agentId,
                                      sessionKey: result.sessionKey,
                                      sessionNonce: Date.now(),
                                    });
                                    return;
                                  }
                                  setSelectedAgent({
                                    type: "subagent",
                                    projectId: projectId(),
                                    slug: result.slug,
                                    cli: undefined,
                                    runMode: undefined,
                                    status: "running",
                                  });
                                }}
                              />
                            </Match>
                          </Switch>
                        </div>
                      </div>
                    </Match>
                    <Match when={!compactLayout()}>
                      <div class="project-detail__left">
                        <AgentPanel
                          project={detail()}
                          area={area()}
                          areas={areas() ?? []}
                          subagents={subagents()}
                          onSubagentsChange={(items) => setSubagents(items)}
                          onOpenSpawn={(input) => {
                            setSpawnMode(input);
                            setSpawnFormDraft({
                              includeDefaultPrompt:
                                input.prefill.includeDefaultPrompt ?? true,
                              includeRoleInstructions:
                                input.prefill.includeRoleInstructions ?? true,
                              includePostRun:
                                input.prefill.includePostRun ?? true,
                              includeCustomInstructions: false,
                              customInstructions:
                                input.prefill.customInstructions ?? "",
                            });
                            setMergedTab("chat");
                            setCenterTab("chat");
                          }}
                          onTitleChange={handleTitleChange}
                          onStatusChange={handleStatusChange}
                          onAreaChange={handleAreaChange}
                          onRepoChange={handleRepoChange}
                          onLeadSessionRemoved={() => {
                            setSelectedAgent(null);
                          }}
                          onLeadSessionReset={({ agentId, sessionKey }) => {
                            setSelectedAgent({
                              type: "lead",
                              projectId: projectId(),
                              agentId,
                              agentName: agentId,
                              sessionKey,
                              sessionNonce: Date.now(),
                            });
                          }}
                          selectedAgentSlug={
                            selectedAgent()?.type === "lead"
                              ? `lead:${selectedAgent()?.agentId ?? ""}`
                              : (selectedAgent()?.slug ?? null)
                          }
                          onSelectAgent={(info) => {
                            setMergedTab("chat");
                            setCenterTab("chat");
                            if (info.type === "lead") {
                              setSelectedAgent({
                                type: "lead",
                                projectId: info.projectId,
                                agentId: info.agentId,
                                agentName: info.agentName ?? info.agentId,
                                sessionKey: info.sessionKey,
                                sessionNonce: 0,
                              });
                              return;
                            }
                            setSelectedAgent({
                              type: "subagent",
                              projectId: info.projectId,
                              slug: info.slug,
                              cli: info.cli,
                              runMode:
                                info.runMode === "main-run" ||
                                info.runMode === "worktree" ||
                                info.runMode === "clone" ||
                                info.runMode === "none"
                                  ? info.runMode
                                  : undefined,
                              status: info.status,
                            });
                          }}
                        />
                      </div>
                      <div class="project-detail__center">
                        <CenterPanel
                          project={detail()}
                          tab={centerTab()}
                          onTabChange={setCenterTab}
                          onAddComment={handleAddComment}
                          selectedAgent={selectedAgent()}
                          spawnMode={spawnMode()}
                          chatInputDraft={chatInputDraft()}
                          onChatInputDraftChange={setChatInputDraft}
                          spawnFormDraft={spawnFormDraft()}
                          onSpawnFormDraftChange={setSpawnFormDraft}
                          subagents={subagents()}
                          onCancelSpawn={() => setSpawnMode(null)}
                          hasArea={Boolean(area())}
                          repoValid={detail().repoValid}
                          repoMessage={repoMessage()}
                          onSpawned={(result) => {
                            const leadAgentName =
                              spawnMode()?.prefill.agentName;
                            setSpawnMode(null);
                            if (result.type === "lead" && result.agentId) {
                              applyLeadSpawnToProject(
                                result.agentId,
                                result.sessionKey
                              );
                              setSelectedAgent({
                                type: "lead",
                                projectId: projectId(),
                                agentId: result.agentId,
                                agentName: leadAgentName ?? result.agentId,
                                sessionKey: result.sessionKey,
                                sessionNonce: Date.now(),
                              });
                              return;
                            }
                            setSelectedAgent({
                              type: "subagent",
                              projectId: projectId(),
                              slug: result.slug,
                              cli: undefined,
                              runMode: undefined,
                              status: "running",
                            });
                          }}
                        />
                      </div>
                      <div class="project-detail__right">
                        <div class="project-right-tabs">
                          <button
                            type="button"
                            classList={{ active: mergedTab() !== "slices" }}
                            onClick={() => setMergedTab("spec")}
                          >
                            Spec
                          </button>
                          <button
                            type="button"
                            classList={{ active: mergedTab() === "slices" }}
                            onClick={() => setMergedTab("slices")}
                          >
                            Slices
                          </button>
                        </div>
                        <Show when={mergedTab() !== "slices"}>
                          <SpecEditor
                            specContent={spec()?.content ?? ""}
                            docs={detail().docs}
                            tasks={tasks()?.tasks ?? []}
                            progress={
                              tasks()?.progress ?? { done: 0, total: 0 }
                            }
                            areaColor={area()?.color}
                            onToggleTask={handleToggleTask}
                            onAddTask={handleAddTask}
                            onSaveSpec={handleSaveSpec}
                            onSaveDoc={handleSaveDoc}
                            onRefresh={handleRefreshSpec}
                          />
                        </Show>
                        <Show when={mergedTab() === "slices"}>
                          <SliceKanbanWidget
                            projectId={projectId()}
                            onSliceClick={openSliceDetail}
                          />
                        </Show>
                      </div>
                    </Match>
                    <Match when={compactLayout()}>
                      <div class="project-detail__left">
                        <AgentPanel
                          project={detail()}
                          area={area()}
                          areas={areas() ?? []}
                          subagents={subagents()}
                          onSubagentsChange={(items) => setSubagents(items)}
                          onOpenSpawn={(input) => {
                            setSpawnMode(input);
                            setSpawnFormDraft({
                              includeDefaultPrompt:
                                input.prefill.includeDefaultPrompt ?? true,
                              includeRoleInstructions:
                                input.prefill.includeRoleInstructions ?? true,
                              includePostRun:
                                input.prefill.includePostRun ?? true,
                              includeCustomInstructions: false,
                              customInstructions:
                                input.prefill.customInstructions ?? "",
                            });
                            setMergedTab("chat");
                            setCenterTab("chat");
                          }}
                          onTitleChange={handleTitleChange}
                          onStatusChange={handleStatusChange}
                          onAreaChange={handleAreaChange}
                          onRepoChange={handleRepoChange}
                          onLeadSessionRemoved={() => {
                            setSelectedAgent(null);
                          }}
                          onLeadSessionReset={({ agentId, sessionKey }) => {
                            setSelectedAgent({
                              type: "lead",
                              projectId: projectId(),
                              agentId,
                              agentName: agentId,
                              sessionKey,
                              sessionNonce: Date.now(),
                            });
                          }}
                          selectedAgentSlug={
                            selectedAgent()?.type === "lead"
                              ? `lead:${selectedAgent()?.agentId ?? ""}`
                              : (selectedAgent()?.slug ?? null)
                          }
                          onSelectAgent={(info) => {
                            setMergedTab("chat");
                            setCenterTab("chat");
                            if (info.type === "lead") {
                              setSelectedAgent({
                                type: "lead",
                                projectId: info.projectId,
                                agentId: info.agentId,
                                agentName: info.agentName ?? info.agentId,
                                sessionKey: info.sessionKey,
                                sessionNonce: 0,
                              });
                              return;
                            }
                            setSelectedAgent({
                              type: "subagent",
                              projectId: info.projectId,
                              slug: info.slug,
                              cli: info.cli,
                              runMode:
                                info.runMode === "main-run" ||
                                info.runMode === "worktree" ||
                                info.runMode === "clone" ||
                                info.runMode === "none"
                                  ? info.runMode
                                  : undefined,
                              status: info.status,
                            });
                          }}
                        />
                      </div>
                      <div class="project-detail__merged">
                        <header class="project-detail-merged-tabs">
                          <button
                            type="button"
                            classList={{ active: mergedTab() === "chat" }}
                            onClick={() => {
                              setMergedTab("chat");
                              setCenterTab("chat");
                            }}
                          >
                            Chat
                          </button>
                          <button
                            type="button"
                            classList={{ active: mergedTab() === "activity" }}
                            onClick={() => {
                              setMergedTab("activity");
                              setCenterTab("activity");
                            }}
                          >
                            Activity
                          </button>
                          <button
                            type="button"
                            classList={{ active: mergedTab() === "changes" }}
                            onClick={() => {
                              setMergedTab("changes");
                              setCenterTab("changes");
                            }}
                          >
                            Changes
                          </button>
                          <button
                            type="button"
                            classList={{ active: mergedTab() === "spec" }}
                            onClick={() => setMergedTab("spec")}
                          >
                            Spec
                          </button>
                          <button
                            type="button"
                            classList={{ active: mergedTab() === "slices" }}
                            onClick={() => setMergedTab("slices")}
                          >
                            Slices
                          </button>
                        </header>
                        <div class="project-detail__merged-body">
                          <Show when={mergedTab() === "spec"}>
                            <SpecEditor
                              specContent={spec()?.content ?? ""}
                              docs={detail().docs}
                              tasks={tasks()?.tasks ?? []}
                              progress={
                                tasks()?.progress ?? { done: 0, total: 0 }
                              }
                              areaColor={area()?.color}
                              onToggleTask={handleToggleTask}
                              onAddTask={handleAddTask}
                              onSaveSpec={handleSaveSpec}
                              onSaveDoc={handleSaveDoc}
                              onRefresh={handleRefreshSpec}
                            />
                          </Show>
                          <Show when={mergedTab() === "slices"}>
                            <SliceKanbanWidget
                              projectId={projectId()}
                              onSliceClick={openSliceDetail}
                            />
                          </Show>
                          <Show
                            when={
                              mergedTab() !== "spec" && mergedTab() !== "slices"
                            }
                          >
                            <CenterPanel
                              project={detail()}
                              onAddComment={handleAddComment}
                              showTabs={false}
                              tab={
                                mergedTab() as "chat" | "activity" | "changes"
                              }
                              selectedAgent={selectedAgent()}
                              spawnMode={spawnMode()}
                              chatInputDraft={chatInputDraft()}
                              onChatInputDraftChange={setChatInputDraft}
                              spawnFormDraft={spawnFormDraft()}
                              onSpawnFormDraftChange={setSpawnFormDraft}
                              subagents={subagents()}
                              onCancelSpawn={() => setSpawnMode(null)}
                              hasArea={Boolean(area())}
                              repoValid={detail().repoValid}
                              repoMessage={repoMessage()}
                              onSpawned={(result) => {
                                const leadAgentName =
                                  spawnMode()?.prefill.agentName;
                                setSpawnMode(null);
                                if (result.type === "lead" && result.agentId) {
                                  applyLeadSpawnToProject(
                                    result.agentId,
                                    result.sessionKey
                                  );
                                  setSelectedAgent({
                                    type: "lead",
                                    projectId: projectId(),
                                    agentId: result.agentId,
                                    agentName: leadAgentName ?? result.agentId,
                                    sessionKey: result.sessionKey,
                                    sessionNonce: Date.now(),
                                  });
                                  return;
                                }
                                setSelectedAgent({
                                  type: "subagent",
                                  projectId: projectId(),
                                  slug: result.slug,
                                  cli: undefined,
                                  runMode: undefined,
                                  status: "running",
                                });
                              }}
                            />
                          </Show>
                        </div>
                      </div>
                    </Match>
                  </Switch>
                </div>
              }
            >
              <div class="project-detail project-detail--zen">
                <div class="project-detail__zen-chat">
                  <CenterPanel
                    project={detail()}
                    onAddComment={handleAddComment}
                    showTabs={false}
                    tab="chat"
                    selectedAgent={selectedAgent()}
                    spawnMode={null}
                    chatInputDraft={chatInputDraft()}
                    onChatInputDraftChange={setChatInputDraft}
                    spawnFormDraft={spawnFormDraft()}
                    onSpawnFormDraftChange={setSpawnFormDraft}
                    subagents={subagents()}
                    onCancelSpawn={() => setSpawnMode(null)}
                    hasArea={Boolean(area())}
                    repoValid={detail().repoValid}
                    repoMessage={repoMessage()}
                    onSpawned={(result) => {
                      if (result.type === "lead" && result.agentId) {
                        applyLeadSpawnToProject(
                          result.agentId,
                          result.sessionKey
                        );
                        setSelectedAgent({
                          type: "lead",
                          projectId: projectId(),
                          agentId: result.agentId,
                          agentName:
                            spawnMode()?.prefill.agentName ?? result.agentId,
                          sessionKey: result.sessionKey,
                          sessionNonce: Date.now(),
                        });
                        return;
                      }
                      setSelectedAgent({
                        type: "subagent",
                        projectId: projectId(),
                        slug: result.slug,
                        cli: undefined,
                        runMode: undefined,
                        status: "running",
                      });
                    }}
                  />
                </div>
              </div>
            </Show>
            <Show when={editRepoOpen()}>
              <EditRepoModal
                initialRepo={currentRepo()}
                onClose={() => setEditRepoOpen(false)}
                onSave={handleModalRepoSave}
                showToast={(message, variant) => setToast({ message, variant })}
                getErrorMessage={(updated) => {
                  const message = getRepoStatusMessage({
                    frontmatter: updated.frontmatter,
                    repoValid: updated.repoValid,
                  });
                  return message.startsWith("Repo path not found")
                    ? "Path not found"
                    : message;
                }}
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
          </div>
        )}
      </Show>
      <style>{`
        .project-detail-page {
          height: 100%;
          background: var(--bg-base);
          color: var(--text-primary);
        }

        .project-detail-breadcrumb {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          border-bottom: 1px solid var(--border-subtle);
          color: var(--text-secondary);
          font-size: 13px;
          min-width: 0;
          overflow-x: auto;
          white-space: nowrap;
        }

        .project-detail-back {
          border: 0;
          background: transparent;
          color: var(--text-primary);
          cursor: pointer;
          padding: 0;
          font-size: 13px;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          flex-shrink: 0;
        }

        .project-detail-breadcrumb-separator {
          flex-shrink: 0;
        }

        .project-detail-breadcrumb-area,
        .project-detail-title {
          overflow: hidden;
          text-overflow: ellipsis;
          min-width: 0;
        }

        .project-detail-breadcrumb-area {
          max-width: 220px;
        }

        .project-detail-title {
          cursor: text;
          display: inline-block;
          max-width: min(40vw, 360px);
        }

        .project-detail-breadcrumb-spacer {
          flex: 1;
          min-width: 12px;
        }

        .project-detail-action-menu-root {
          position: relative;
          flex-shrink: 0;
        }

        .project-detail-action-menu-trigger {
          border: 1px solid var(--border-subtle);
          border-radius: 6px;
          background: var(--bg-overlay);
          color: var(--text-primary);
          font-size: 12px;
          padding: 4px 8px;
          cursor: pointer;
        }

        .project-detail-action-menu {
          position: absolute;
          top: calc(100% + 4px);
          right: 0;
          min-width: 150px;
          border: 1px solid var(--border-default);
          border-radius: 8px;
          background: var(--bg-surface);
          box-shadow: 0 4px 16px rgba(0,0,0,0.15);
          overflow: hidden;
          z-index: 100;
        }

        .project-detail-action-item {
          display: block;
          width: 100%;
          border: 0;
          background: transparent;
          color: var(--text-primary);
          padding: 8px 12px;
          text-align: left;
          font-size: 13px;
          cursor: pointer;
        }

        .project-detail-action-item:hover {
          background: var(--bg-hover, color-mix(in srgb, var(--bg-surface) 80%, #fff));
        }

        .project-detail-title-edit {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }

        .project-detail-title-input {
          min-width: 220px;
          border: 1px solid var(--border-subtle);
          border-radius: 6px;
          background: var(--bg-overlay);
          color: var(--text-primary);
          padding: 4px 8px;
          font-size: 13px;
        }

        .project-detail-title-save,
        .project-detail-title-cancel {
          border: 1px solid var(--border-subtle);
          border-radius: 6px;
          background: var(--bg-overlay);
          color: var(--text-primary);
          font-size: 12px;
          padding: 4px 8px;
          cursor: pointer;
        }

        .project-detail {
          display: flex;
          height: calc(100vh - 43px);
          height: calc(100dvh - 43px);
          overflow: hidden;
        }

        .project-detail--zen {
          height: 100%;
          display: block;
        }

        .project-detail__zen-chat {
          height: 100%;
          min-height: 0;
        }

        .project-detail__left {
          width: 480px;
          flex-shrink: 0;
          border-right: 1px solid var(--border-subtle);
          overflow-y: auto;
        }

        .project-detail__center {
          flex: 1;
          overflow-y: auto;
          min-width: 0;
        }

        .project-detail__right {
          width: 33vw;
          min-width: 420px;
          flex-shrink: 0;
          border-left: 1px solid var(--border-subtle);
          overflow-y: auto;
        }

        .project-detail__merged {
          flex: 1;
          min-width: 0;
          display: grid;
          grid-template-rows: auto 1fr;
          background: var(--bg-base);
        }

        .project-detail-merged-tabs {
          display: flex;
          gap: 8px;
          padding: 16px 18px;
          border-bottom: 1px solid var(--border-subtle);
          background: var(--bg-base);
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
        }

        .project-detail-merged-tabs button {
          border: 1px solid var(--border-subtle);
          background: var(--bg-overlay);
          color: var(--text-secondary);
          border-radius: 999px;
          padding: 6px 12px;
          font-size: 12px;
          cursor: pointer;
        }

        .project-detail-merged-tabs button.active {
          color: #fff;
          border-color: #2563eb;
          background: #2563eb;
        }

        .project-detail__merged-body {
          min-height: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .project-detail__merged-body > * {
          flex: 1;
          min-height: 0;
        }

        @media (max-width: 1199px) {
          .project-detail__left {
            width: 40%;
            min-width: 0;
          }

          .project-detail__merged {
            width: 60%;
            flex: 0 0 60%;
          }
        }

        @media (min-width: 769px) and (max-width: 1199px) {
          .project-detail__left {
            width: 280px;
          }
        }

        @media (min-width: 1600px) {
          .project-detail__left {
            width: 20%;
            min-width: 0;
          }

          .project-detail__center {
            width: 40%;
            flex: 0 0 40%;
          }

          .project-detail__right {
            width: 40%;
            min-width: 0;
          }
        }

        @media (max-width: 768px) {
          .project-detail {
            flex-direction: column;
          }

          .project-detail-breadcrumb {
            gap: 6px;
            padding: 10px 12px;
          }

          .project-detail-back {
            min-height: 44px;
            padding: 0 10px 0 0;
          }

          .project-detail-back-text {
            display: none;
          }

          .project-detail-breadcrumb-area {
            max-width: 96px;
          }

          .project-detail-title {
            max-width: min(48vw, 180px);
          }

          .project-detail-title-input {
            min-width: 160px;
            min-height: 44px;
          }

          .project-detail-title-save,
          .project-detail-title-cancel,
          .project-detail-merged-tabs button {
            min-height: 44px;
          }

          .project-detail-merged-tabs {
            padding: 12px;
          }

          .project-detail-merged-tabs button {
            padding: 10px 16px;
            flex-shrink: 0;
          }

          .project-detail__left {
            display: none;
          }

          .project-detail__merged,
          .project-detail__merged--mobile {
            width: 100%;
            flex: 1 1 0;
            min-height: 0;
          }
        }

        .project-detail-state {
          min-height: 100vh;
          display: grid;
          place-items: center;
          background: var(--bg-base);
          color: var(--text-secondary);
        }

        .project-right-tabs {
          display: flex;
          border-bottom: 1px solid var(--border-subtle);
          padding: 0 12px;
          flex-shrink: 0;
        }

        .project-right-tabs button {
          background: none;
          border: none;
          border-bottom: 2px solid transparent;
          padding: 8px 12px;
          font-size: 13px;
          color: var(--text-secondary);
          cursor: pointer;
          transition: color 0.1s, border-color 0.1s;
        }

        .project-right-tabs button.active {
          color: var(--text-primary);
          border-bottom-color: var(--accent, #7c6aff);
        }
      `}</style>
    </>
  );
}
