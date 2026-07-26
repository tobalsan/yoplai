import type {
  Area as SharedArea,
  CapabilitiesResponse as SharedCapabilitiesResponse,
  ContextEstimate,
  ContentBlock,
  FileAttachment,
  FileBlock,
  FullHistoryMessage,
  ImageAttachment,
  ModelMeta,
  ModelUsage,
  ProjectItem,
  SdkId,
  SimpleHistoryMessage,
  StreamEvent,
  SubagentGlobalListItem as SharedSubagentGlobalListItem,
  SubagentLogEvent as SharedSubagentLogEvent,
  SubagentRun,
  Task as SharedTask,
  TaskboardItemResponse,
  TaskboardResponse,
  TextBlock,
  ThinkLevel,
  ThinkingBlock,
  TodoItem,
  ToolCallBlock,
} from "@yoplai/shared/types";
export type {
  ContextEstimate,
  ContentBlock,
  FileAttachment,
  FileBlock,
  FullHistoryMessage,
  ImageAttachment,
  ModelMeta,
  ModelUsage,
  ProjectItem,
  SdkId,
  SimpleHistoryMessage,
  StreamEvent,
  TaskboardItemResponse,
  TaskboardResponse,
  TextBlock,
  ThinkLevel,
  ThinkingBlock,
  TodoItem,
  ToolCallBlock,
};

export type QueueMode = "queue" | "interrupt";

// Upload response from /api/media/upload
export type UploadResponse = {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
};

export type CapabilitiesResponse = SharedCapabilitiesResponse;

export type Agent = {
  id: string;
  name: string;
  description?: string;
  role?: string;
  avatar?: string;
  sdk?: SdkId; // default "pi"
  model?: {
    provider: string;
    model: string;
  };
  workspace?: string;
  authMode?: "oauth" | "api_key" | "proxy";
  queueMode?: QueueMode; // default "queue"
  isDefaultProjectManager?: boolean;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  files?: FileBlock[];
  timestamp: number;
};

export type SendMessageResponse = {
  payloads: Array<{ text?: string; mediaUrls?: string[] }>;
  meta: {
    durationMs: number;
    sessionId: string;
    aborted?: boolean;
    queued?: boolean;
  };
};

export type SessionSummary = {
  agentId: string;
  sessionId: string;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  firstUserMessage: string;
  title?: string;
  avatar?: string;
  isMain: boolean;
};

// History view mode
export type HistoryViewMode = "simple" | "full";

export type FullUserMessage = Extract<FullHistoryMessage, { role: "user" }>;
export type FullAssistantMessage = Extract<
  FullHistoryMessage,
  { role: "assistant" }
>;
export type FullToolResultMessage = Extract<
  FullHistoryMessage,
  { role: "toolResult" }
>;

// Active tool call during streaming
export type ActiveToolCall = {
  id: string;
  toolName: string;
  status: "running" | "done" | "error";
};

// Projects API types
export type ProjectListItem = {
  id: string;
  title: string;
  path: string;
  absolutePath: string;
  repoValid: boolean;
  frontmatter: Record<string, unknown>;
};

export type ProjectDetail = {
  id: string;
  title: string;
  path: string;
  absolutePath: string;
  repoValid: boolean;
  frontmatter: Record<string, unknown>;
  docs: Record<string, string>;
  thread: ProjectThreadEntry[];
};

export type DeleteProjectResponse = {
  id: string;
  path: string;
  trashedPath: string;
};

export type ArchiveProjectResponse = {
  id: string;
  path: string;
  archivedPath: string;
};

export type UnarchiveProjectResponse = {
  id: string;
  path: string;
};

export type ProjectUpdatePayload = {
  title?: string;
  status?: string;
  area?: string;
  readme?: string;
  specs?: string;
  docs?: Record<string, string>;
  repo?: string;
  sessionKeys?: Record<string, string> | null;
};

export type ProjectThreadEntry = {
  author: string;
  date: string;
  body: string;
};

export type Area = SharedArea;
export type Task = SharedTask;

export type TasksResponse = {
  tasks: Task[];
  progress: { done: number; total: number };
};

export type SubagentStatus = "running" | "replied" | "error" | "idle";

export type SubagentGlobalListItem = SharedSubagentGlobalListItem;

export type SubagentGlobalListResponse = {
  items: SubagentGlobalListItem[];
};

export type RuntimeSubagentListResponse = {
  items: SubagentRun[];
};

export type SubagentListItem = {
  slug: string;
  type?: "subagent";
  cli?: string;
  name?: string;
  model?: string;
  reasoningEffort?: string;
  thinking?: string;
  runMode?: string;
  status: SubagentStatus;
  lastActive?: string;
  startedAt?: string;
  finishedAt?: string;
  baseBranch?: string;
  worktreePath?: string;
  lastError?: string;
  archived?: boolean;
  agentId?: string;
  projectId?: string;
  sliceId?: string;
};

export type SubagentLogEvent = SharedSubagentLogEvent;

export type ActivityEvent = {
  id: string;
  type:
    | "project_status"
    | "agent_message"
    | "subagent_action"
    | "project_comment";
  actor: string;
  action: string;
  projectId?: string;
  subagentSlug?: string;
  timestamp: string;
  color: "green" | "purple" | "blue" | "yellow";
};

export type ActivityResponse = {
  events: ActivityEvent[];
};

export type BoardActivityItemType =
  | "project_status"
  | "slice_status"
  | "run_start"
  | "run_complete"
  | "thread_comment";

export type BoardActivityItem = {
  id: string;
  type: BoardActivityItemType;
  projectId: string;
  sliceId?: string;
  runSlug?: string;
  actor: string;
  action: string;
  timestamp: string;
  color: "green" | "purple" | "blue" | "yellow";
};

export type BoardActivityResponse = {
  items: BoardActivityItem[];
};

export type AgentStatusResponse = {
  statuses: Record<string, "streaming" | "idle">;
};

export type SubagentListResponse = {
  items: SubagentListItem[];
};

export type SubagentLogsResponse = {
  cursor: number;
  events: SubagentLogEvent[];
  latestUsage?: ModelUsage;
  latestContextEstimate?: ContextEstimate;
};

export type ProjectBranchesResponse = {
  branches: string[];
};

export type FileChange = {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  staged: boolean;
};

export type MainBranchCommit = {
  sha: string;
  subject: string;
};

export type DirtyState = {
  files: FileChange[];
  diff: string;
  stats: { filesChanged: number; insertions: number; deletions: number };
};

export type ProjectChanges = {
  branch: string;
  baseBranch: string;
  source?: { type: "space" | "repo"; path: string };
  files: FileChange[];
  diff: string;
  stats: { filesChanged: number; insertions: number; deletions: number };
  branchDiffStats?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  branchDiffFiles?: { path: string; insertions: number; deletions: number }[];
  mainAheadCommits?: MainBranchCommit[];
  mainRepoDirty?: DirtyState;
};

export type SpaceIntegrationEntry = {
  id: string;
  workerSlug: string;
  runMode: "worktree" | "clone";
  worktreePath: string;
  startSha?: string;
  endSha?: string;
  shas: string[];
  status: "pending" | "integrated" | "conflict" | "skipped" | "stale_worker";
  createdAt: string;
  integratedAt?: string;
  error?: string;
  staleAgainstSha?: string;
};

export type SpaceCommitSummary = {
  sha: string;
  subject: string;
  author: string;
  date: string;
};

export type SpaceContribution = {
  entry: SpaceIntegrationEntry;
  commits: SpaceCommitSummary[];
  diff: string;
  conflictFiles: string[];
};

export type ProjectSpaceState = {
  version: 1;
  projectId: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  integrationBlocked: boolean;
  rebaseConflict?: { baseSha: string; error: string };
  queue: SpaceIntegrationEntry[];
  updatedAt: string;
};

export type SpaceWriteLease = {
  holder: string;
  acquiredAt: string;
  expiresAt: string;
};

export type SpaceLeaseState = {
  enabled: boolean;
  lease: SpaceWriteLease | null;
};

export type ProjectPullRequestTarget = {
  branch: string;
  baseBranch: string;
  compareUrl?: string;
};

export type CommitResult = {
  ok: boolean;
  sha?: string;
  message?: string;
  error?: string;
};

export type AreaSummary = {
  id: string;
  title: string;
  color: string;
  order: number;
  hidden: boolean;
  recentlyDone: string;
  whatsNext: string;
};

export type BoardWorktree = {
  id: string;
  name: string;
  path: string;
  workerSlug: string;
  worktreePath: string;
  branch: string | null;
  dirty: boolean;
  ahead: number;
  queueStatus:
    | "pending"
    | "integrated"
    | "conflict"
    | "skipped"
    | "stale_worker"
    | null;
  agentRun: {
    runId: string;
    label: string;
    cli: string;
    status: "running" | "done" | "failed" | "interrupted" | string;
    startedAt: string;
    updatedAt: string;
  } | null;
  startedAt?: string;
  integratedAt?: string;
  startSha?: string;
  endSha?: string;
};

// ── Slice types ─────────────────────────────────────────────────

export type SliceStatus =
  | "todo"
  | "in_progress"
  | "review"
  | "ready_to_merge"
  | "done"
  | "cancelled";

export type SliceHillPosition = "figuring" | "executing" | "done";

export type SliceFrontmatter = {
  id: string;
  project_id: string;
  title: string;
  status: SliceStatus;
  blocked_by?: string[];
  hill_position: SliceHillPosition;
  created_at: string;
  updated_at: string;
} & Record<string, unknown>;

export type SliceRecord = {
  id: string;
  projectId: string;
  dirPath: string;
  frontmatter: SliceFrontmatter;
  docs: {
    readme: string;
    specs: string;
    tasks: string;
    validation: string;
    thread: string;
  };
};

export type SliceListResponse = {
  slices: SliceRecord[];
};

export type CreateSlicePayload = {
  title: string;
  status?: SliceStatus;
  repo?: string;
  hill_position?: SliceHillPosition;
  readme?: string;
  specs?: string;
  tasks?: string;
  validation?: string;
  thread?: string;
};

export type UpdateSlicePayload = {
  title?: string;
  status?: SliceStatus;
  repo?: string;
  hill_position?: SliceHillPosition;
  readme?: string;
  specs?: string;
  tasks?: string;
  validation?: string;
  thread?: string;
};

export type ProjectLifecycleStatus =
  | "triage"
  | "shaping"
  | "active"
  | "ready_to_merge"
  | "done"
  | "cancelled"
  | "archived";

export type SliceProgress = {
  done: number;
  total: number;
};

export type ProjectLifecycleCounts = Record<ProjectLifecycleStatus, number>;

export type BoardProject = {
  id: string;
  title: string;
  area: string;
  status: string;
  /** Lifecycle status for grouped board home view. */
  lifecycleStatus: ProjectLifecycleStatus;
  group: "active" | "review" | "stale" | "done";
  created: string;
  sliceProgress: SliceProgress;
  lastActivity: string | null;
  activeRunCount: number;
  worktrees: BoardWorktree[];
};

export type BoardProjectsResponse = {
  projects: BoardProject[];
  lifecycleCounts: ProjectLifecycleCounts;
};
