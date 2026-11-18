import {
  SendMessageRequestSchema,
  buildUserContext,
  type AgentContext,
  type FileAttachment,
  type RunAgentResult,
  type StreamEvent,
  type ThinkLevel,
  type WsSessionResetEvent,
} from "@yoplai/shared";
import type { AgentConfig } from "@yoplai/shared";
import type { InternalRunAgentParams } from "../agents/runner.js";
import { invalidateResolvedHistoryFile } from "../history/store.js";
import { normalizeInboundAttachments } from "../sdk/attachments.js";
import { isAbortTrigger, resolveSessionId } from "../sessions/index.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";

export type RunRequestAuthContext = {
  user: { name?: string | null };
  session: { userId: string };
} | null;

export type RawRunRequestInput = {
  agentId: string;
  message?: unknown;
  sessionId?: unknown;
  turnId?: unknown;
  sessionKey?: unknown;
  thinkLevel?: unknown;
  attachments?: unknown;
  projectId?: unknown;
  deviceTurnToken?: unknown;
};

export type RunRequestImmediateEvent = StreamEvent | WsSessionResetEvent;

export type NormalizedRunRequest =
  | { type: "run"; params: InternalRunAgentParams }
  | {
      type: "immediate";
      result: RunAgentResult;
      events: RunRequestImmediateEvent[];
    }
  | { type: "validation_error"; message: string };

type NormalizeRunRequestParams = {
  agent: AgentConfig;
  input: RawRunRequestInput;
  authContext: RunRequestAuthContext;
  extensionRuntime: ExtensionRuntime;
  source: string;
  onEvent?: (event: StreamEvent) => void;
  defaultSessionId?: string;
  allowTurnId?: boolean;
};

function parseAttachments(value: unknown): FileAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value as FileAttachment[];
  return undefined;
}

const CONTROL_CHAR_REGEX = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`
);

export function isSafeSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length <= 200 &&
    !sessionId.includes("/") &&
    !sessionId.includes("\\") &&
    !/(^|[._:-])\.\.($|[._:-])/.test(sessionId) &&
    !CONTROL_CHAR_REGEX.test(sessionId)
  );
}

function userContext(
  authContext: RunRequestAuthContext
): AgentContext | undefined {
  if (!authContext) return undefined;
  return buildUserContext({ name: authContext.user.name ?? undefined });
}

function immediateReset(
  agent: AgentConfig,
  sessionId: string
): Extract<NormalizedRunRequest, { type: "immediate" }> {
  const introText = agent.introMessage ?? "New conversation started.";
  const events: RunRequestImmediateEvent[] = [
    { type: "session_reset", sessionId },
    { type: "text", data: introText },
    { type: "done", meta: { durationMs: 0 } },
  ];
  return {
    type: "immediate",
    events,
    result: {
      payloads: [{ text: introText }],
      meta: { durationMs: 0, sessionId },
    },
  };
}

export async function normalizeRunRequest({
  agent,
  input,
  authContext,
  extensionRuntime,
  source,
  onEvent,
  defaultSessionId,
  allowTurnId,
}: NormalizeRunRequestParams): Promise<NormalizedRunRequest> {
  if (input.turnId !== undefined) {
    if (!allowTurnId) return { type: "validation_error", message: "Only desktop chat accepts a turn ID." };
    if (typeof input.sessionId !== "string" || !isSafeSessionId(input.sessionId)) {
      return { type: "validation_error", message: "Supply a valid session ID with the turn ID." };
    }
  }
  const parsed = SendMessageRequestSchema.safeParse({
    turnId: input.turnId,
    projectId: input.projectId,
    message: input.message,
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    thinkLevel: input.thinkLevel,
    deviceTurnToken: input.deviceTurnToken,
  });
  if (!parsed.success) {
    return { type: "validation_error", message: input.turnId === undefined ? parsed.error.message : "Check the chat request. The turn ID must be a UUID." };
  }

  const data = parsed.data;
  if (data.sessionId && !isSafeSessionId(data.sessionId)) {
    return { type: "validation_error", message: "Invalid session id" };
  }
  const turnId = data.turnId?.toLowerCase();
  if (turnId && data.message.trimStart().startsWith("/")) {
    return { type: "validation_error", message: "Send a message without a slash command when you use a turn ID." };
  }
  const userId = authContext?.session.userId;
  const attachments = await normalizeInboundAttachments(
    parseAttachments(input.attachments)
  );

  if (isAbortTrigger(data.message)) {
    return {
      type: "run",
      params: {
        agentId: agent.id,
        userId,
        message: data.message,
        attachments,
        sessionId: data.sessionId,
        sessionKey: data.sessionKey,
        thinkLevel: data.thinkLevel,
        deviceTurnToken: data.deviceTurnToken,
        context: userContext(authContext),
        extensionRuntime,
        source,
        onEvent,
      },
    };
  }

  let resolvedSession:
    | {
        sessionId: string;
        sessionKey?: string;
        message: string;
        isNew: boolean;
      }
    | undefined;
  let sessionId = data.sessionId;

  const sessionKeyToResolve =
    !sessionId && (data.sessionKey || !defaultSessionId)
      ? (data.sessionKey ?? "main")
      : undefined;

  if (sessionKeyToResolve) {
    const resolved = await resolveSessionId({
      agentId: agent.id,
      userId,
      sessionKey: sessionKeyToResolve,
      message: data.message,
    });
    sessionId = resolved.sessionId;
    resolvedSession = {
      sessionId: resolved.sessionId,
      sessionKey: sessionKeyToResolve,
      message: resolved.message,
      isNew: resolved.isNew,
    };

    if (resolved.isNew && !resolved.message.trim()) {
      invalidateResolvedHistoryFile(agent.id, resolved.sessionId, userId);
      return immediateReset(agent, resolved.sessionId);
    }
  }

  return {
    type: "run",
    params: {
      agentId: agent.id,
      userId,
      message: data.message,
      attachments,
      sessionId:
        data.sessionId ?? (resolvedSession ? undefined : defaultSessionId),
      sessionKey: resolvedSession ? undefined : (data.sessionKey ?? "main"),
      resolvedSession,
      projectId: data.projectId,
      thinkLevel: data.thinkLevel as ThinkLevel | undefined,
      deviceTurnToken: data.deviceTurnToken,
      turnId,
      context: userContext(authContext),
      extensionRuntime,
      source,
      onEvent,
    },
  };
}
