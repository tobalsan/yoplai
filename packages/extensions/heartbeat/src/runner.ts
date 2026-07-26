import fs from "node:fs/promises";
import path from "node:path";
import {
  latestAssistantText,
  writeCronRunOutput,
} from "@yoplai/extension-scheduler";
import {
  DEFAULT_MAIN_KEY,
  type AgentConfig,
  type ExtensionContext,
  type HeartbeatEventPayload,
  type HeartbeatStatus,
} from "@yoplai/shared";

// Default heartbeat interval (30 minutes)
// Default ackMaxChars threshold
const DEFAULT_ACK_MAX_CHARS = 300;
// Default heartbeat prompt
export const DEFAULT_HEARTBEAT_PROMPT =
  "Consider outstanding tasks and HEARTBEAT.md guidance from workspace context (if present). Checkup sometimes on human during (user local) day time.";

let extensionCtx: ExtensionContext | null = null;

export function setHeartbeatContext(ctx: ExtensionContext): void {
  extensionCtx = ctx;
}

export function clearHeartbeatContext(): void {
  extensionCtx = null;
}

function getContext(): ExtensionContext {
  if (!extensionCtx) {
    throw new Error("Heartbeat extension context not initialized");
  }
  return extensionCtx;
}

// Global toggle for all heartbeats
let heartbeatsEnabled = true;

// Active timers per agent
const timers = new Map<string, ReturnType<typeof setTimeout>>();

// Event listeners
type HeartbeatEventListener = (payload: HeartbeatEventPayload) => void;
const eventListeners = new Set<HeartbeatEventListener>();

/**
 * Token stripping pattern: handles HTML/Markdown wrapped HEARTBEAT_OK
 * Strips: <b>HEARTBEAT_OK</b>, <strong>HEARTBEAT_OK</strong>, **HEARTBEAT_OK**, *HEARTBEAT_OK*, etc.
 * Uses word boundary \b to avoid matching partial words like "HEARTBEAT_OKAY".
 * Note: underscore markdown (_HEARTBEAT_OK_) is not supported because `_` is a word character.
 */
const TOKEN_PATTERN_STR =
  "(?:<\\/?(?:b|strong|em|i|code|span)[^>]*>|\\*{1,2})*\\bHEARTBEAT_OK\\b(?:<\\/?(?:b|strong|em|i|code|span)[^>]*>|\\*{1,2})*";

/**
 * Create fresh regex for matching (avoids stateful lastIndex issues with g flag)
 */
function createTokenRegex(): RegExp {
  return new RegExp(TOKEN_PATTERN_STR, "gi");
}

/**
 * Parse duration string to milliseconds.
 * Supports: "5" (5 minutes), "5m" (5 minutes), "2h" (2 hours), "0" (disabled)
 * Returns null for disabled or invalid durations.
 */
export function parseDurationMs(
  duration: string | undefined,
  options?: { defaultUnit?: "m" | "h" | "s" }
): number | null {
  if (!duration) return null;

  const trimmed = duration.trim().toLowerCase();
  if (trimmed === "0" || trimmed === "0m" || trimmed === "0h" || trimmed === "0s") {
    return null; // Disabled
  }

  // Parse number and optional unit
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(m|min|h|hr|s|sec)?$/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  if (value <= 0 || !Number.isFinite(value)) return null;

  const unit = match[2] || options?.defaultUnit || "m";

  switch (unit) {
    case "s":
    case "sec":
      return value * 1000;
    case "m":
    case "min":
      return value * 60 * 1000;
    case "h":
    case "hr":
      return value * 60 * 60 * 1000;
    default:
      return null;
  }
}

/**
 * Strip HEARTBEAT_OK token (including HTML/Markdown wrapped variants) from text.
 * Returns remaining text after stripping.
 */
export function stripHeartbeatToken(text: string): string {
  return text.replace(createTokenRegex(), "").trim();
}

/**
 * Check if text contains HEARTBEAT_OK token.
 */
export function containsHeartbeatToken(text: string): boolean {
  return createTokenRegex().test(text);
}

/**
 * Determine heartbeat result status based on reply content.
 */
export function evaluateHeartbeatReply(
  replyText: string | undefined,
  ackMaxChars: number
): { status: HeartbeatStatus; strippedText: string; shouldDeliver: boolean } {
  // Empty reply
  if (!replyText || replyText.trim() === "") {
    return { status: "ok-empty", strippedText: "", shouldDeliver: false };
  }

  const hasToken = containsHeartbeatToken(replyText);
  const strippedText = stripHeartbeatToken(replyText);

  // Token present and remaining text within threshold
  if (hasToken && strippedText.length <= ackMaxChars) {
    return { status: "ok-token", strippedText, shouldDeliver: false };
  }

  // Alert: either no token or substantial content beyond threshold
  return { status: "sent", strippedText: strippedText || replyText.trim(), shouldDeliver: true };
}

/**
 * Load heartbeat prompt for agent.
 * Resolution order: config > HEARTBEAT.md > default
 */
export async function loadHeartbeatPrompt(agent: AgentConfig): Promise<string> {
  // 1. Config value
  if (agent.heartbeat?.prompt) {
    return agent.heartbeat.prompt;
  }

  // 2. HEARTBEAT.md in workspace
  try {
    const workspaceDir = getContext().resolveWorkspaceDir(agent);
    const heartbeatPath = path.join(workspaceDir, "HEARTBEAT.md");
    const content = await fs.readFile(heartbeatPath, "utf-8");
    if (content.trim()) {
      return content.trim();
    }
  } catch {
    // File doesn't exist or can't be read - fall through to default
  }

  // 3. Default prompt
  return DEFAULT_HEARTBEAT_PROMPT;
}

/**
 * Emit heartbeat event to listeners + extension bus.
 */
function emitHeartbeatEvent(payload: HeartbeatEventPayload): void {
  for (const listener of eventListeners) {
    try {
      listener(payload);
    } catch {
      // Ignore listener errors
    }
  }

  if (extensionCtx) {
    try {
      extensionCtx.emit("heartbeat.event", payload);
    } catch {
      // Ignore emit errors
    }
  }
}

/**
 * Subscribe to heartbeat events.
 * Returns unsubscribe function.
 */
export function onHeartbeatEvent(listener: HeartbeatEventListener): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/**
 * Global toggle to enable/disable all heartbeats.
 */
export function setHeartbeatsEnabled(enabled: boolean): void {
  heartbeatsEnabled = enabled;
}

/**
 * Check if heartbeats globally enabled.
 */
export function areHeartbeatsEnabled(): boolean {
  return heartbeatsEnabled;
}

function maybeRestoreSessionUpdatedAt(
  agentId: string,
  sessionKey: string,
  originalUpdatedAt: number | undefined
): void {
  if (originalUpdatedAt === undefined) return;
  getContext().restoreSessionUpdatedAt(agentId, sessionKey, originalUpdatedAt);
}

function isSchedulerRuntimeAvailable(): boolean {
  const scheduler = getContext().getConfig().extensions?.scheduler;
  return Boolean(scheduler && scheduler.enabled !== false);
}

function warnSchedulerUnavailable(): void {
  getContext().logger.warn(
    "[heartbeat] Scheduler extension is disabled or unavailable; heartbeat timers will not run."
  );
}

function heartbeatResultStatus(
  status: HeartbeatStatus
): "ok" | "warn" | "error" {
  if (status === "failed") return "error";
  if (status === "sent") return "warn";
  return "ok";
}

async function writeHeartbeatOutput(input: {
  agent: AgentConfig;
  sessionId: string;
  prompt: string;
  firedAt: Date;
  finishedAt: Date;
  status: "ok" | "error";
  resultStatus: "ok" | "warn" | "error";
  response?: string;
  error?: unknown;
}): Promise<void> {
  const ctx = getContext();
  try {
    await writeCronRunOutput({
      workspaceDir: ctx.resolveWorkspaceDir(input.agent),
      jobId: "__heartbeat__",
      agentId: input.agent.id,
      sessionId: input.sessionId,
      runType: "heartbeat",
      name: "Heartbeat",
      prompt: input.prompt,
      firedAt: input.firedAt,
      finishedAt: input.finishedAt,
      status: input.status,
      durationMs: input.finishedAt.getTime() - input.firedAt.getTime(),
      response: input.response,
      error: input.error,
      resultStatus: input.resultStatus,
    });
  } catch (error) {
    ctx.logger.warn("[heartbeat] Failed to write heartbeat output", error);
  }
}

/**
 * Run single heartbeat for agent.
 * Returns event payload describing result.
 */
export async function runHeartbeat(agentId: string): Promise<HeartbeatEventPayload> {
  const startTs = Date.now();
  const ctx = getContext();
  const agent = ctx.getAgent(agentId);

  // Agent not found
  if (!agent) {
    const payload: HeartbeatEventPayload = {
      ts: startTs,
      agentId,
      status: "failed",
      reason: "agent not found",
    };
    emitHeartbeatEvent(payload);
    return payload;
  }

  // Global disable check
  if (!heartbeatsEnabled) {
    const payload: HeartbeatEventPayload = {
      ts: startTs,
      agentId,
      status: "skipped",
      reason: "disabled",
    };
    emitHeartbeatEvent(payload);
    return payload;
  }

  if (!isHeartbeatEnabled(agent)) {
    const payload: HeartbeatEventPayload = {
      ts: startTs,
      agentId,
      status: "skipped",
      reason: "disabled",
    };
    emitHeartbeatEvent(payload);
    return payload;
  }

  if (!isSchedulerRuntimeAvailable()) {
    warnSchedulerUnavailable();
    const payload: HeartbeatEventPayload = {
      ts: startTs,
      agentId,
      status: "skipped",
      reason: "scheduler disabled or unavailable",
    };
    emitHeartbeatEvent(payload);
    return payload;
  }

  // Capture original updatedAt for restoration
  const originalEntry = await ctx.getSessionEntry(agentId, DEFAULT_MAIN_KEY);
  const originalUpdatedAt = originalEntry?.updatedAt;

  // Check if main session is streaming
  if (ctx.isAgentStreaming(agentId)) {
    maybeRestoreSessionUpdatedAt(agentId, DEFAULT_MAIN_KEY, originalUpdatedAt);
    const payload: HeartbeatEventPayload = {
      ts: startTs,
      agentId,
      status: "skipped",
      reason: "streaming",
    };
    emitHeartbeatEvent(payload);
    return payload;
  }

  // Check delivery target (Discord broadcastToChannel)
  const broadcastChannel = agent.discord?.broadcastToChannel;
  if (!broadcastChannel) {
    maybeRestoreSessionUpdatedAt(agentId, DEFAULT_MAIN_KEY, originalUpdatedAt);
    const payload: HeartbeatEventPayload = {
      ts: startTs,
      agentId,
      status: "skipped",
      reason: "no broadcastToChannel",
    };
    emitHeartbeatEvent(payload);
    return payload;
  }

  const ackMaxChars = agent.heartbeat?.ackMaxChars ?? DEFAULT_ACK_MAX_CHARS;

  let prompt = DEFAULT_HEARTBEAT_PROMPT;
  let outputSessionId = `${DEFAULT_MAIN_KEY}:heartbeat`;
  const firedAt = new Date(startTs);

  try {
    // Load prompt
    prompt = await loadHeartbeatPrompt(agent);

    // Reuse existing main session if present
    const resolved = await ctx.resolveSessionId(agentId, DEFAULT_MAIN_KEY);
    outputSessionId = resolved?.sessionId ?? outputSessionId;

    const result = await ctx.runAgent({
      agentId,
      message: prompt,
      sessionId: resolved?.sessionId,
      sessionKey: DEFAULT_MAIN_KEY,
      source: "heartbeat",
      // No onEvent - no user-visible history for heartbeat runs
    });

    const durationMs = Date.now() - startTs;
    outputSessionId = result.meta?.sessionId ?? outputSessionId;
    const replyText = latestAssistantText(result.payloads);

    // Evaluate reply
    const evaluation = evaluateHeartbeatReply(replyText, ackMaxChars);

    void writeHeartbeatOutput({
      agent,
      sessionId: outputSessionId,
      prompt,
      firedAt,
      finishedAt: new Date(),
      status: "ok",
      resultStatus: heartbeatResultStatus(evaluation.status),
      response: replyText,
    });

    // Restore updatedAt if not delivering
    if (!evaluation.shouldDeliver) {
      maybeRestoreSessionUpdatedAt(agentId, DEFAULT_MAIN_KEY, originalUpdatedAt);
    }

    const payload: HeartbeatEventPayload = {
      ts: startTs,
      agentId,
      status: evaluation.status,
      durationMs,
      to: evaluation.shouldDeliver ? broadcastChannel : undefined,
      preview: evaluation.strippedText.slice(0, 200) || undefined,
      alertText: evaluation.shouldDeliver ? evaluation.strippedText : undefined,
    };
    emitHeartbeatEvent(payload);
    return payload;
  } catch (err) {
    maybeRestoreSessionUpdatedAt(agentId, DEFAULT_MAIN_KEY, originalUpdatedAt);
    void writeHeartbeatOutput({
      agent,
      sessionId: outputSessionId,
      prompt,
      firedAt,
      finishedAt: new Date(),
      status: "error",
      resultStatus: "error",
      error: err,
    });
    const payload: HeartbeatEventPayload = {
      ts: startTs,
      agentId,
      status: "failed",
      durationMs: Date.now() - startTs,
      reason: err instanceof Error ? err.message : String(err),
    };
    emitHeartbeatEvent(payload);
    return payload;
  }
}

/**
 * Check if heartbeat enabled for agent.
 */
export function isHeartbeatEnabled(agent: AgentConfig): boolean {
  const every = agent.heartbeat?.every;
  if (!every) return false;

  const ms = parseDurationMs(every, { defaultUnit: "m" });
  return ms !== null && ms > 0;
}

/**
 * Get heartbeat interval for agent in milliseconds.
 * Returns null if heartbeat disabled.
 */
export function getHeartbeatIntervalMs(agent: AgentConfig): number | null {
  if (!isHeartbeatEnabled(agent)) return null;

  return parseDurationMs(agent.heartbeat!.every!, { defaultUnit: "m" });
}

/**
 * Schedule heartbeat tick for agent.
 */
function scheduleTick(agentId: string, intervalMs: number): void {
  // Clear existing timer
  const existing = timers.get(agentId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(async () => {
    // Run heartbeat
    await runHeartbeat(agentId);

    // Reschedule (if still configured)
    const agent = getContext().getAgent(agentId);
    if (agent && isHeartbeatEnabled(agent)) {
      const newInterval = getHeartbeatIntervalMs(agent);
      if (newInterval) {
        scheduleTick(agentId, newInterval);
      }
    } else {
      timers.delete(agentId);
    }
  }, intervalMs);

  // Don't block process exit
  if (timer.unref && setTimeout.toString().includes("[native code]")) {
    timer.unref();
  }
  timers.set(agentId, timer);
}

/**
 * Start heartbeat for agent.
 * Returns true if started, false if disabled.
 */
export function startHeartbeat(agentId: string): boolean {
  const agent = getContext().getAgent(agentId);
  if (!agent) return false;

  if (!isHeartbeatEnabled(agent)) return false;

  if (!isSchedulerRuntimeAvailable()) {
    warnSchedulerUnavailable();
    return false;
  }

  const intervalMs = getHeartbeatIntervalMs(agent);
  if (!intervalMs) return false;

  scheduleTick(agentId, intervalMs);
  return true;
}

/**
 * Stop heartbeat for agent.
 */
export function stopHeartbeat(agentId: string): void {
  const timer = timers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(agentId);
  }
}

/**
 * Start heartbeats for all configured agents.
 */
export function startAllHeartbeats(): void {
  for (const agent of getContext().getAgents()) {
    startHeartbeat(agent.id);
  }
}

/**
 * Stop all heartbeat timers.
 */
export function stopAllHeartbeats(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}

/**
 * Get list of agents with active heartbeat timers.
 */
export function getActiveHeartbeats(): string[] {
  return Array.from(timers.keys());
}
