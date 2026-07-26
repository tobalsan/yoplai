/**
 * SliceDetailPage — full slice card view.
 * Route: /projects/:projectId/slices/:sliceId
 *
 * Renders: frontmatter + Specs + Tasks + Validation + Thread + recent runs.
 */
import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import {
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  addSliceComment,
  fetchSlices,
  fetchSlice,
  fetchSubagents,
  updateSlice,
  subscribeToFileChanges,
  subscribeToSubagentChanges,
} from "../api";
import type {
  SliceStatus,
  SliceRecord,
  SubagentListItem,
  SubagentStatus,
} from "../api/types";
import { renderMarkdown } from "../lib/markdown";
import { DocEditor } from "./board/DocEditor";
import { AgentRunChatPanel } from "./AgentRunChatPanel";

const RUN_STATUS_LABELS: Record<SubagentStatus, string> = {
  running: "Running",
  replied: "Done",
  error: "Error",
  idle: "Idle",
};

const STATUS_LABELS: Record<SliceStatus, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  review: "Review",
  ready_to_merge: "Ready to Merge",
  done: "Done",
  cancelled: "Cancelled",
};

const STATUS_COLORS: Record<SliceStatus, string> = {
  todo: "#3b6ecc",
  in_progress: "#8a6fd1",
  review: "#f08b57",
  ready_to_merge: "#2fb6a3",
  done: "#53b97c",
  cancelled: "#6b6b6b",
};

const ALL_STATUSES: SliceStatus[] = [
  "todo",
  "in_progress",
  "review",
  "ready_to_merge",
  "done",
  "cancelled",
];

const UNKNOWN_STATUS_COLOR = "#6b6b6b";
const UNKNOWN_STATUS_LABEL = "Unknown";

type SectionTab = "specs" | "tasks" | "validation" | "thread" | "agent";
type EditableSliceDocKey = Exclude<keyof SliceRecord["docs"], "thread">;
type SliceThreadEntry = {
  author: string;
  date: string;
  body: string;
};
type BlockerDetail = {
  id: string;
  projectId: string;
  status: SliceStatus | null;
  title: string;
};

function isSectionTab(value: unknown): value is SectionTab {
  return (
    value === "specs" ||
    value === "tasks" ||
    value === "validation" ||
    value === "thread" ||
    value === "agent"
  );
}

function blockedBy(slice: SliceRecord | undefined): string[] {
  return Array.isArray(slice?.frontmatter.blocked_by)
    ? slice.frontmatter.blocked_by.filter(
        (item): item is string => typeof item === "string"
      )
    : [];
}

function projectIdFromSliceId(sliceId: string): string {
  return sliceId.match(/^(PRO-\d+)-S\d+$/)?.[1] ?? "";
}

function formatRelative(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const diff = Math.max(0, Date.now() - time);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function runStartedAt(run: SubagentListItem): string | undefined {
  return run.startedAt;
}

function sortRuns(a: SubagentListItem, b: SubagentListItem): number {
  if (a.status === "running" && b.status !== "running") return -1;
  if (a.status !== "running" && b.status === "running") return 1;
  return (runStartedAt(b) ?? "").localeCompare(runStartedAt(a) ?? "");
}

function debounce(callback: () => void, delayMs: number): () => void {
  let timer: number | undefined;
  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(callback, delayMs);
  };
}

function stripMarkdownFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function parseThreadMetadata(lines: string[]): {
  author: string;
  date: string;
  bodyStart: number;
} {
  let author = "Yoplai";
  let date = "";
  let bodyStart = 0;
  for (; bodyStart < lines.length; bodyStart += 1) {
    const line = lines[bodyStart]?.trim();
    if (!line) continue;
    const authorMatch = line.match(/^\[author:(.+)\]$/);
    if (authorMatch) {
      author = authorMatch[1].trim();
      continue;
    }
    const dateMatch = line.match(/^\[date:(.+)\]$/);
    if (dateMatch) {
      date = dateMatch[1].trim();
      continue;
    }
    break;
  }
  return { author, date, bodyStart };
}

function parseSliceThreadEntries(content: string): SliceThreadEntry[] {
  const body = stripMarkdownFrontmatter(content).trim();
  if (!body) return [];

  const headingMatches = Array.from(body.matchAll(/^##\s+(.+?)\s*$/gm));
  if (headingMatches.length > 0) {
    return headingMatches
      .map((match, index) => {
        const date = match[1]?.trim() ?? "";
        const start = (match.index ?? 0) + match[0].length;
        const end =
          index + 1 < headingMatches.length
            ? (headingMatches[index + 1]?.index ?? body.length)
            : body.length;
        const sectionBody = body.slice(start, end).trim();
        const metadata = parseThreadMetadata(sectionBody.split(/\r?\n/));
        return {
          author: metadata.author,
          date: metadata.date || date,
          body: sectionBody
            .split(/\r?\n/)
            .slice(metadata.bodyStart)
            .join("\n")
            .trim(),
        };
      })
      .filter((entry) => entry.body);
  }

  const metadata = parseThreadMetadata(body.split(/\r?\n/));
  const entryBody = body
    .split(/\r?\n/)
    .slice(metadata.bodyStart)
    .join("\n")
    .trim();
  return entryBody
    ? [{ author: metadata.author, date: metadata.date, body: entryBody }]
    : [];
}

function SliceThreadSection(props: {
  content: string;
  draft: string;
  posting: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (event: Event) => void;
}) {
  const entries = createMemo(() => parseSliceThreadEntries(props.content));
  return (
    <div class="slice-detail-section">
      <h3 class="slice-detail-section-title">THREAD.md</h3>
      <Show
        when={entries().length > 0}
        fallback={<p class="slice-detail-empty">No thread entries yet.</p>}
      >
        <div class="slice-detail-thread-list">
          <For each={entries()}>
            {(entry) => (
              <article class="slice-detail-thread-card">
                <div class="slice-detail-thread-meta">
                  <span class="slice-detail-thread-author">{entry.author}</span>
                  <Show when={formatRelative(entry.date)}>
                    {(relative) => (
                      <span class="slice-detail-thread-date">{relative()}</span>
                    )}
                  </Show>
                </div>
                <div
                  class="slice-detail-thread-markdown"
                  innerHTML={renderMarkdown(entry.body, {
                    rewriteHref: (href) => href,
                  })}
                />
              </article>
            )}
          </For>
        </div>
      </Show>
      <form class="slice-detail-comment-form" onSubmit={props.onSubmit}>
        <textarea
          class="slice-detail-comment-input"
          placeholder="Add a comment…"
          value={props.draft}
          onInput={(event) => props.onDraftChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={3}
        />
        <button
          type="submit"
          class="slice-detail-comment-submit"
          disabled={props.posting || !props.draft.trim()}
        >
          {props.posting ? "Posting…" : "Post comment"}
        </button>
      </form>
    </div>
  );
}

function SliceAgentRunsSection(props: {
  projectId: string;
  sliceId: string;
  selectedRunId?: string;
  selectedLeadId?: string;
  onSelectedRunIdChange?: (runId: string | undefined) => void;
  onSelectedLeadIdChange?: (leadId: string | undefined) => void;
}) {
  return (
    <div class="slice-detail-section slice-detail-agent-section">
      <AgentRunChatPanel
        projectId={props.projectId}
        sliceId={props.sliceId}
        selectedRunId={props.selectedRunId}
        selectedLeadId={props.selectedLeadId}
        onSelectedRunIdChange={props.onSelectedRunIdChange}
        onSelectedLeadIdChange={props.onSelectedLeadIdChange}
      />
    </div>
  );
}

export type SliceDetailPageProps = {
  projectId?: string;
  sliceId?: string;
  tab?: string;
  routeBase?: "board" | "standalone";
  onBack?: () => void;
  onOpenSlice?: (projectId: string, sliceId: string) => void;
  onNavigate?: (to: string, options?: { replace?: boolean }) => void;
};

export function SliceDetailPage(props: SliceDetailPageProps = {}) {
  const params = useParams<{ projectId: string; sliceId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const projectId = createMemo(() => props.projectId ?? params.projectId ?? "");
  const sliceId = createMemo(() => props.sliceId ?? params.sliceId ?? "");

  const activeTab = createMemo<SectionTab>(() => {
    const tab = props.tab ?? searchParams.tab;
    return isSectionTab(tab) ? tab : "specs";
  });
  const [statusChanging, setStatusChanging] = createSignal(false);
  const [saveError, setSaveError] = createSignal("");
  const [commentDraft, setCommentDraft] = createSignal("");
  const [commentPosting, setCommentPosting] = createSignal(false);
  const locallySavedFiles = new Map<string, number>();

  const [slice, { mutate, refetch }] = createResource(
    () => ({ projectId: projectId(), sliceId: sliceId() }),
    ({ projectId, sliceId }) => fetchSlice(projectId, sliceId)
  );

  // Recent runs: fetch project subagents, filter by sliceId
  const [recentRuns, { refetch: refetchRuns }] = createResource(
    () => ({ projectId: projectId(), sliceId: sliceId() }),
    async ({ projectId, sliceId }) => {
      const result = await fetchSubagents(projectId, true);
      if (!result.ok) return [] as SubagentListItem[];
      return result.data.items
        .filter((s) => s.sliceId === sliceId)
        .sort(sortRuns);
    }
  );

  // Live refresh
  createResource(
    () => projectId(),
    (pid) => {
      const debouncedRefetchRuns = debounce(() => {
        void refetchRuns();
      }, 250);
      const unsub = subscribeToFileChanges({
        onFileChanged: (changedId, file) => {
          if (changedId !== pid) return;
          const normalized = file.replace(/\\/g, "/");
          const slicePrefix = `slices/${sliceId()}/`;
          const isThisSliceFile = normalized.startsWith(slicePrefix);
          const isProjectLifecycleFile =
            normalized === "README.md" || normalized === "SCOPE_MAP.md";
          if (!isThisSliceFile && !isProjectLifecycleFile) return;
          if ((locallySavedFiles.get(normalized) ?? 0) > Date.now()) return;
          void refetch();
        },
        onAgentChanged: (changedId) => {
          if (changedId === pid) debouncedRefetchRuns();
        },
      });
      const unsubSubagents = subscribeToSubagentChanges({
        onSubagentChanged: () => debouncedRefetchRuns(),
      });
      onCleanup(() => {
        unsub();
        unsubSubagents();
      });
    }
  );

  const handleStatusChange = async (status: SliceStatus) => {
    if (statusChanging()) return;
    setStatusChanging(true);
    const prev = slice();
    if (prev) {
      mutate({ ...prev, frontmatter: { ...prev.frontmatter, status } });
    }
    try {
      const updated = await updateSlice(projectId(), sliceId(), { status });
      mutate(updated);
    } catch {
      if (prev) mutate(prev);
    } finally {
      setStatusChanging(false);
    }
  };

  const handleBack = () => {
    if (props.onBack) {
      props.onBack();
      return;
    }
    navigate(`/projects/${encodeURIComponent(projectId())}`);
  };

  const tabUrl = (tab: SectionTab) => {
    const boardHosted =
      props.routeBase === "board" ||
      (props.routeBase !== "standalone" &&
        window.location.pathname.startsWith("/board/projects/"));
    const base = boardHosted
      ? `/board/projects/${encodeURIComponent(projectId())}/slices/${encodeURIComponent(sliceId())}`
      : `/projects/${encodeURIComponent(projectId())}/slices/${encodeURIComponent(sliceId())}`;
    return tab === "specs" ? base : `${base}?tab=${tab}`;
  };

  const agentRunUrl = (runId: string | undefined) => {
    const base = tabUrl("agent");
    return runId ? `${base}&run=${encodeURIComponent(runId)}` : base;
  };

  const agentLeadUrl = (leadId: string | undefined) => {
    const base = tabUrl("agent");
    return leadId ? `${base}&lead=${encodeURIComponent(leadId)}` : base;
  };

  const queryStringValue = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;

  const openTab = (tab: SectionTab) => {
    const to = tabUrl(tab);
    if (props.onNavigate) {
      props.onNavigate(to);
      return;
    }
    navigate(to);
  };

  const handleSaveDoc = async (
    docKey: EditableSliceDocKey,
    content: string
  ) => {
    const current = slice();
    if (!current) return;

    setSaveError("");
    const fileByDocKey: Partial<Record<EditableSliceDocKey, string>> = {
      specs: "SPECS.md",
      tasks: "TASKS.md",
      validation: "VALIDATION.md",
    };
    const suppressUntil = Date.now() + 2000;
    const fileName = fileByDocKey[docKey];
    if (fileName) {
      locallySavedFiles.set(`slices/${sliceId()}/${fileName}`, suppressUntil);
    }
    locallySavedFiles.set(`slices/${sliceId()}/README.md`, suppressUntil);
    locallySavedFiles.set("SCOPE_MAP.md", suppressUntil);
    mutate({ ...current, docs: { ...current.docs, [docKey]: content } });

    try {
      const updated = await updateSlice(projectId(), sliceId(), {
        [docKey]: content,
      });
      mutate(updated);
    } catch (error) {
      mutate(current);
      setSaveError(error instanceof Error ? error.message : "Save failed");
      setTimeout(() => setSaveError(""), 3000);
    }
  };

  const handlePostComment = async (event: Event) => {
    event.preventDefault();
    const body = commentDraft().trim();
    const current = slice();
    if (!body || commentPosting() || !current) return;

    setCommentPosting(true);
    setSaveError("");
    try {
      await addSliceComment(projectId(), sliceId(), body);
      setCommentDraft("");
      await refetch();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to add comment");
      setTimeout(() => setSaveError(""), 3000);
    } finally {
      setCommentPosting(false);
    }
  };

  const frontmatter = createMemo(() => slice()?.frontmatter);
  const docs = createMemo(() => slice()?.docs);
  const blockerIds = createMemo(() => blockedBy(slice()));
  const blockerProjectIds = createMemo(() => [
    ...new Set(blockerIds().map(projectIdFromSliceId).filter(Boolean)),
  ]);
  const [blockerSlices] = createResource(
    () => blockerProjectIds().join(","),
    async (key) => {
      if (!key) return [] as SliceRecord[];
      const nested = await Promise.all(
        key.split(",").map(async (pid) => {
          try {
            return await fetchSlices(pid);
          } catch {
            return [] as SliceRecord[];
          }
        })
      );
      return nested.flat();
    }
  );
  const blockerDetails = createMemo<BlockerDetail[]>(() => {
    const byId = new Map(
      (blockerSlices() ?? []).map((item) => [item.id, item])
    );
    return blockerIds().map((id) => {
      const resolved = byId.get(id);
      return {
        id,
        projectId: projectIdFromSliceId(id) || projectId(),
        status: resolved?.frontmatter.status ?? null,
        title: resolved?.frontmatter.title ?? "Missing slice",
      };
    });
  });

  return (
    <div class="slice-detail-page">
      <Show when={slice.loading && !slice()}>
        <div class="slice-detail-state">Loading slice…</div>
      </Show>
      <Show when={slice.error}>
        <div class="slice-detail-state">Failed to load slice.</div>
      </Show>
      <Show when={slice()}>
        {(detail: () => SliceRecord) => (
          <>
            <header class="slice-detail-breadcrumb">
              <button
                type="button"
                class="slice-detail-back"
                onClick={handleBack}
              >
                ← Slice Kanban
              </button>
              <span class="slice-detail-sep">/</span>
              <span class="slice-detail-id">{detail().id}</span>
              <span class="slice-detail-sep">/</span>
              <span class="slice-detail-title-crumb">
                {detail().frontmatter.title}
              </span>
            </header>

            <div class="slice-detail-body">
              {/* Left: metadata */}
              <aside class="slice-detail-sidebar">
                <div class="slice-detail-meta-group">
                  <div class="slice-detail-meta-label">Status</div>
                  <div class="slice-detail-status-row">
                    <span
                      class="slice-detail-status-pill"
                      style={{
                        background: STATUS_COLORS[frontmatter()!.status],
                      }}
                    >
                      {STATUS_LABELS[frontmatter()!.status]}
                    </span>
                  </div>
                  <div class="slice-detail-status-buttons">
                    <For each={ALL_STATUSES}>
                      {(s) => (
                        <button
                          type="button"
                          class="slice-detail-status-btn"
                          classList={{
                            active: frontmatter()!.status === s,
                          }}
                          disabled={
                            statusChanging() || frontmatter()!.status === s
                          }
                          onClick={() => void handleStatusChange(s)}
                          style={
                            { "--dot-color": STATUS_COLORS[s] } as Record<
                              string,
                              string
                            >
                          }
                        >
                          <span class="slice-status-btn-dot" />
                          {STATUS_LABELS[s]}
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                <div class="slice-detail-meta-group">
                  <div class="slice-detail-meta-label">Hill position</div>
                  <div class="slice-detail-meta-value">
                    {frontmatter()?.hill_position ?? "—"}
                  </div>
                </div>

                <Show when={blockerDetails().length > 0}>
                  <div class="slice-detail-meta-group slice-detail-blockers">
                    <div class="slice-detail-meta-label">
                      Blockers ({blockerDetails().length})
                    </div>
                    <For each={blockerDetails()}>
                      {(blocker) => (
                        <a
                          class="slice-detail-blocker-row"
                          href={`/projects/${encodeURIComponent(blocker.projectId)}/slices/${encodeURIComponent(blocker.id)}`}
                          onClick={(event) => {
                            event.preventDefault();
                            if (props.onOpenSlice) {
                              props.onOpenSlice(blocker.projectId, blocker.id);
                            } else {
                              navigate(
                                `/projects/${encodeURIComponent(blocker.projectId)}/slices/${encodeURIComponent(blocker.id)}`
                              );
                            }
                          }}
                        >
                          <span class="slice-detail-blocker-id">
                            {blocker.id}
                          </span>
                          <span
                            class="slice-detail-status-pill slice-detail-blocker-status"
                            style={{
                              background: blocker.status
                                ? STATUS_COLORS[blocker.status]
                                : UNKNOWN_STATUS_COLOR,
                            }}
                          >
                            {blocker.status
                              ? STATUS_LABELS[blocker.status]
                              : UNKNOWN_STATUS_LABEL}
                          </span>
                          <span class="slice-detail-blocker-title">
                            {blocker.title}
                          </span>
                        </a>
                      )}
                    </For>
                  </div>
                </Show>

                <div class="slice-detail-meta-group">
                  <div class="slice-detail-meta-label">Created</div>
                  <div class="slice-detail-meta-value">
                    {formatRelative(
                      (frontmatter()?.created_at as string) ?? ""
                    )}
                  </div>
                </div>

                <div class="slice-detail-meta-group">
                  <div class="slice-detail-meta-label">Updated</div>
                  <div class="slice-detail-meta-value">
                    {formatRelative(
                      (frontmatter()?.updated_at as string) ?? ""
                    )}
                  </div>
                </div>

                <div class="slice-detail-meta-group">
                  <div class="slice-detail-meta-label">Recent Runs</div>
                  <Show when={recentRuns.loading}>
                    <div class="slice-detail-runs-empty">Loading…</div>
                  </Show>
                  <Show
                    when={
                      !recentRuns.loading && (recentRuns() ?? []).length === 0
                    }
                  >
                    <div class="slice-detail-runs-empty">No runs yet.</div>
                  </Show>
                  <For each={recentRuns() ?? []}>
                    {(run) => (
                      <div class="slice-detail-run-row">
                        <span class="slice-detail-run-name">
                          {run.name ?? run.slug}
                        </span>
                        <span
                          class="slice-detail-run-status"
                          classList={{
                            "run-running": run.status === "running",
                            "run-done": run.status === "replied",
                            "run-error": run.status === "error",
                          }}
                        >
                          {RUN_STATUS_LABELS[run.status] ?? run.status}
                        </span>
                        <Show
                          when={formatRelative(
                            run.lastActive ?? run.startedAt ?? ""
                          )}
                        >
                          {(relative) => (
                            <span class="slice-detail-run-time">
                              {relative()}
                            </span>
                          )}
                        </Show>
                      </div>
                    )}
                  </For>
                </div>

                {/* Frontmatter extras (any keys beyond known ones) */}
                <For
                  each={Object.entries(frontmatter() ?? {}).filter(
                    ([k]) =>
                      ![
                        "id",
                        "project_id",
                        "title",
                        "status",
                        "blocked_by",
                        "hill_position",
                        "created_at",
                        "updated_at",
                      ].includes(k)
                  )}
                >
                  {([key, value]) => (
                    <div class="slice-detail-meta-group">
                      <div class="slice-detail-meta-label">{key}</div>
                      <div class="slice-detail-meta-value slice-detail-meta-mono">
                        {typeof value === "string"
                          ? value
                          : JSON.stringify(value)}
                      </div>
                    </div>
                  )}
                </For>
              </aside>

              {/* Center: docs */}
              <main class="slice-detail-main">
                <Show when={saveError()}>
                  <div class="slice-detail-save-error" role="alert">
                    {saveError()}
                  </div>
                </Show>

                {/* Tabs: Specs | Tasks | Validation | Thread | Agent */}
                <nav class="slice-detail-tabs">
                  <For
                    each={[
                      { id: "specs" as SectionTab, label: "Specs" },
                      { id: "tasks" as SectionTab, label: "Tasks" },
                      { id: "validation" as SectionTab, label: "Validation" },
                      { id: "thread" as SectionTab, label: "Thread" },
                      { id: "agent" as SectionTab, label: "Agent" },
                    ]}
                  >
                    {(tab) => (
                      <button
                        type="button"
                        class="slice-detail-tab-btn"
                        classList={{ active: activeTab() === tab.id }}
                        onClick={() => openTab(tab.id)}
                      >
                        {tab.label}
                      </button>
                    )}
                  </For>
                </nav>

                <div class="slice-detail-tab-content">
                  <Show when={activeTab() === "specs"}>
                    <DocEditor
                      projectId={projectId()}
                      docKey="SPECS"
                      content={docs()?.specs ?? ""}
                      onSave={(content) => void handleSaveDoc("specs", content)}
                    />
                  </Show>
                  <Show when={activeTab() === "tasks"}>
                    <DocEditor
                      projectId={projectId()}
                      docKey="TASKS"
                      content={docs()?.tasks ?? ""}
                      onSave={(content) => void handleSaveDoc("tasks", content)}
                    />
                  </Show>
                  <Show when={activeTab() === "validation"}>
                    <DocEditor
                      projectId={projectId()}
                      docKey="VALIDATION"
                      content={docs()?.validation ?? ""}
                      onSave={(content) =>
                        void handleSaveDoc("validation", content)
                      }
                    />
                  </Show>
                  <Show when={activeTab() === "thread"}>
                    <SliceThreadSection
                      content={docs()?.thread ?? ""}
                      draft={commentDraft()}
                      posting={commentPosting()}
                      onDraftChange={setCommentDraft}
                      onSubmit={handlePostComment}
                    />
                  </Show>
                  <Show when={activeTab() === "agent"}>
                    <SliceAgentRunsSection
                      projectId={projectId()}
                      sliceId={sliceId()}
                      selectedRunId={queryStringValue(searchParams.run)}
                      selectedLeadId={queryStringValue(searchParams.lead)}
                      onSelectedRunIdChange={(runId) =>
                        props.onNavigate
                          ? props.onNavigate(agentRunUrl(runId), {
                              replace: true,
                            })
                          : navigate(agentRunUrl(runId), { replace: true })
                      }
                      onSelectedLeadIdChange={(leadId) =>
                        props.onNavigate
                          ? props.onNavigate(agentLeadUrl(leadId), {
                              replace: true,
                            })
                          : navigate(agentLeadUrl(leadId), { replace: true })
                      }
                    />
                  </Show>
                </div>
              </main>
            </div>
          </>
        )}
      </Show>
      <style>{`
        .slice-detail-page {
          height: 100%;
          display: flex;
          flex-direction: column;
          background: var(--bg-base);
          color: var(--text-primary);
          overflow: hidden;
        }

        .slice-detail-state {
          padding: 24px;
          color: var(--text-secondary);
          font-size: 13px;
        }

        .slice-detail-breadcrumb {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          border-bottom: 1px solid var(--border-subtle);
          font-size: 13px;
          color: var(--text-secondary);
          flex-shrink: 0;
          overflow: hidden;
          white-space: nowrap;
        }

        .slice-detail-back {
          background: none;
          border: none;
          color: var(--text-primary);
          cursor: pointer;
          font-size: 13px;
          padding: 0;
        }

        .slice-detail-sep { color: var(--text-tertiary); }

        .slice-detail-id {
          font-family: var(--font-mono, monospace);
          font-size: 12px;
          color: var(--text-tertiary);
        }

        .slice-detail-title-crumb {
          overflow: hidden;
          text-overflow: ellipsis;
          font-weight: 500;
          color: var(--text-primary);
        }

        .slice-detail-body {
          flex: 1;
          display: flex;
          gap: 0;
          overflow: hidden;
        }

        .slice-detail-sidebar {
          width: 200px;
          flex-shrink: 0;
          border-right: 1px solid var(--border-subtle);
          overflow-y: auto;
          padding: 16px 12px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .slice-detail-meta-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .slice-detail-meta-label {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-tertiary);
        }

        .slice-detail-meta-value {
          font-size: 13px;
          color: var(--text-secondary);
        }

        .slice-detail-meta-mono {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          word-break: break-all;
        }

        .slice-detail-status-row {
          margin-bottom: 6px;
        }

        .slice-detail-status-pill {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 10px;
          font-size: 11px;
          font-weight: 600;
          color: #fff;
        }

        .slice-detail-blockers {
          gap: 6px;
        }

        .slice-detail-blocker-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 4px;
          padding: 7px 8px;
          border: 1px solid var(--border-subtle);
          border-radius: 6px;
          color: inherit;
          text-decoration: none;
          background: var(--bg-surface);
        }

        .slice-detail-blocker-row:hover {
          border-color: var(--border-default);
          background: var(--bg-elevated);
        }

        .slice-detail-blocker-row:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }

        .slice-detail-blocker-id {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          color: var(--text-tertiary);
        }

        .slice-detail-blocker-status {
          width: fit-content;
          font-size: 10px;
          padding: 1px 6px;
        }

        .slice-detail-blocker-title {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          color: var(--text-secondary);
        }

        .slice-detail-status-buttons {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }

        .slice-detail-status-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          background: none;
          border: 1px solid transparent;
          border-radius: 4px;
          padding: 3px 6px;
          font-size: 12px;
          color: var(--text-secondary);
          cursor: pointer;
          text-align: left;
          transition: background 0.1s;
        }

        .slice-detail-status-btn:hover:not(:disabled) {
          background: var(--bg-elevated);
        }

        .slice-detail-status-btn.active {
          background: var(--bg-elevated);
          border-color: var(--border-default);
          color: var(--text-primary);
          font-weight: 600;
        }

        .slice-detail-status-btn:disabled {
          opacity: 0.6;
          cursor: default;
        }

        .slice-status-btn-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--dot-color, var(--text-tertiary));
          flex-shrink: 0;
        }

        .slice-detail-main {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          min-width: 0;
        }

        .slice-detail-save-error {
          margin: 12px 16px 0;
          padding: 8px 10px;
          border: 1px solid color-mix(in srgb, #e05c5c 35%, var(--border-default));
          border-radius: 6px;
          background: color-mix(in srgb, #e05c5c 12%, var(--bg-surface));
          color: #e05c5c;
          font-size: 12px;
          flex-shrink: 0;
        }

        .slice-detail-tabs {
          display: flex;
          gap: 0;
          border-bottom: 1px solid var(--border-subtle);
          padding: 0 12px;
          flex-shrink: 0;
        }

        .slice-detail-tab-btn {
          background: none;
          border: none;
          border-bottom: 2px solid transparent;
          padding: 8px 12px;
          font-size: 13px;
          color: var(--text-secondary);
          cursor: pointer;
          transition: color 0.1s, border-color 0.1s;
        }

        .slice-detail-tab-btn.active {
          color: var(--text-primary);
          border-bottom-color: var(--accent, #7c6aff);
        }

        .slice-detail-tab-content {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
        }

        .slice-detail-section {}

        .slice-detail-agent-section {
          height: 100%;
          min-height: 0;
          overflow: hidden;
        }

        .slice-detail-section-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-secondary);
          margin: 0 0 12px;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .slice-detail-progress-badge {
          font-size: 11px;
          font-weight: 400;
          background: var(--bg-elevated);
          border-radius: 8px;
          padding: 1px 6px;
          color: var(--text-tertiary);
        }

        .slice-detail-preformatted {
          white-space: pre-wrap;
          word-break: break-word;
          font-family: var(--font-mono, monospace);
          font-size: 12px;
          color: var(--text-secondary);
          background: var(--bg-surface);
          border-radius: 6px;
          padding: 12px;
          margin: 0;
          line-height: 1.6;
        }

        .slice-detail-thread-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .slice-detail-thread-card {
          padding: 10px 12px;
          border: 1px solid var(--border-default);
          border-radius: 8px;
          background: var(--bg-surface);
        }

        .slice-detail-thread-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
          font-size: 12px;
        }

        .slice-detail-thread-author {
          font-weight: 600;
          color: var(--text-primary);
        }

        .slice-detail-thread-date {
          color: var(--text-secondary);
        }

        .slice-detail-thread-markdown {
          font-size: 13px;
          color: var(--text-primary);
          line-height: 1.55;
          word-break: break-word;
        }

        .slice-detail-thread-markdown > :first-child {
          margin-top: 0;
        }

        .slice-detail-thread-markdown > :last-child {
          margin-bottom: 0;
        }

        .slice-detail-thread-markdown p,
        .slice-detail-thread-markdown pre,
        .slice-detail-thread-markdown blockquote,
        .slice-detail-thread-markdown ul,
        .slice-detail-thread-markdown ol {
          margin: 0 0 10px;
        }

        .slice-detail-thread-markdown ul,
        .slice-detail-thread-markdown ol {
          padding-left: 18px;
        }

        .slice-detail-thread-markdown code {
          font-family: var(--font-mono, monospace);
          font-size: 12px;
          background: var(--bg-elevated);
          border-radius: 4px;
          padding: 1px 4px;
        }

        .slice-detail-thread-markdown pre {
          overflow-x: auto;
          background: var(--bg-surface);
          border-radius: 6px;
          padding: 10px;
        }

        .slice-detail-thread-markdown pre code {
          background: transparent;
          padding: 0;
        }

        .slice-detail-thread-markdown a {
          color: var(--accent);
        }

        .slice-detail-comment-form {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 12px;
        }

        .slice-detail-comment-input {
          width: 100%;
          resize: vertical;
          min-height: 78px;
          border: 1px solid var(--border-default);
          border-radius: 8px;
          background: var(--bg-surface);
          color: var(--text-primary);
          padding: 10px 12px;
          font: inherit;
          font-size: 13px;
          line-height: 1.45;
          box-sizing: border-box;
        }

        .slice-detail-comment-submit {
          align-self: flex-end;
          border: 1px solid var(--border-default);
          border-radius: 8px;
          background: var(--text-primary);
          color: var(--bg-base);
          padding: 7px 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }

        .slice-detail-comment-submit:disabled {
          cursor: not-allowed;
          opacity: 0.5;
        }

        .slice-detail-empty {
          color: var(--text-tertiary);
          font-size: 13px;
          margin: 0;
        }

        .slice-detail-error {
          color: #e05c5c;
          font-size: 13px;
          margin: 0 0 8px;
        }

        .slice-agent-runs {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .slice-agent-run-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 8px 12px;
          padding: 10px 12px;
          border: 1px solid var(--border-subtle);
          border-radius: 6px;
          background: var(--bg-surface);
        }

        .slice-agent-run-main {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .slice-agent-run-name {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .slice-agent-run-status {
          flex-shrink: 0;
          font-size: 11px;
          border-radius: 4px;
          padding: 1px 6px;
          background: var(--bg-elevated);
          color: var(--text-tertiary);
        }

        .slice-agent-run-status.running {
          color: #166534;
          background: #dcfce7;
        }

        .slice-agent-run-status.done {
          color: #166534;
          background: color-mix(in srgb, #53b97c 15%, var(--bg-elevated));
        }

        .slice-agent-run-status.error {
          color: #e05c5c;
          background: color-mix(in srgb, #e05c5c 15%, var(--bg-elevated));
        }

        .slice-agent-run-meta {
          grid-column: 1 / -1;
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          font-size: 12px;
          color: var(--text-tertiary);
        }

        .slice-agent-run-actions {
          display: flex;
          gap: 6px;
          align-items: center;
        }

        .slice-agent-run-action {
          border: 1px solid var(--border-default);
          border-radius: 4px;
          background: var(--bg-base);
          color: var(--text-secondary);
          font-size: 12px;
          line-height: 1.2;
          padding: 4px 7px;
          text-decoration: none;
          cursor: pointer;
        }

        .slice-agent-run-action:hover:not(:disabled) {
          color: var(--text-primary);
          border-color: var(--text-tertiary);
        }

        .slice-detail-checklist {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .slice-detail-checklist-item {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          font-size: 13px;
        }

        .slice-detail-checkbox {
          color: var(--text-tertiary);
          font-size: 12px;
          flex-shrink: 0;
          margin-top: 1px;
        }

        .slice-detail-checkbox.checked {
          color: var(--success, #53b97c);
        }

        .slice-detail-checklist-label.done {
          color: var(--text-tertiary);
          text-decoration: line-through;
        }

        .slice-detail-raw-toggle {
          margin-top: 12px;
        }

        .slice-detail-raw-toggle summary {
          font-size: 12px;
          color: var(--text-tertiary);
          cursor: pointer;
          user-select: none;
        }

        @media (max-width: 768px) {
          .slice-detail-body {
            flex-direction: column;
          }
          .slice-detail-sidebar {
            width: 100%;
            border-right: none;
            border-bottom: 1px solid var(--border-subtle);
            max-height: 200px;
            flex-direction: row;
            flex-wrap: wrap;
            gap: 12px;
          }
        }

        .slice-detail-runs-empty {
          font-size: 12px;
          color: var(--text-tertiary);
          padding: 2px 0;
        }

        .slice-detail-run-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 3px 0;
          border-bottom: 1px solid var(--border-subtle);
        }

        .slice-detail-run-row:last-child {
          border-bottom: none;
        }

        .slice-detail-run-name {
          font-size: 12px;
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
          min-width: 0;
        }

        .slice-detail-run-status {
          font-size: 11px;
          border-radius: 4px;
          padding: 1px 5px;
          background: var(--bg-elevated);
          color: var(--text-tertiary);
          flex-shrink: 0;
        }

        .slice-detail-run-time {
          font-size: 11px;
          color: var(--text-tertiary);
          flex-shrink: 0;
        }

        .slice-detail-run-status.run-running {
          background: color-mix(in srgb, #8a6fd1 15%, var(--bg-elevated));
          color: #8a6fd1;
        }

        .slice-detail-run-status.run-done {
          background: color-mix(in srgb, #53b97c 15%, var(--bg-elevated));
          color: #53b97c;
        }

        .slice-detail-run-status.run-error {
          background: color-mix(in srgb, #e05c5c 15%, var(--bg-elevated));
          color: #e05c5c;
        }
      `}</style>
    </div>
  );
}
