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
  sessionKey?: unknown;
  thinkLevel?: unknown;
  attachments?: unknown;
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
};

function parseAttachments(value: unknown): FileAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value as FileAttachment[];
  return undefined;
}

const CONTROL_CHAR_REGEX = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`
);

function isSafeSessionId(sessionId: string): boolean {
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
}: NormalizeRunRequestParams): Promise<NormalizedRunRequest> {
  const parsed = SendMessageRequestSchema.safeParse({
    message: input.message,
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    thinkLevel: input.thinkLevel,
  });
  if (!parsed.success) {
    return { type: "validation_error", message: parsed.error.message };
  }

  const data = parsed.data;
  if (data.sessionId && !isSafeSessionId(data.sessionId)) {
    return { type: "validation_error", message: "Invalid session id" };
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
      thinkLevel: data.thinkLevel as ThinkLevel | undefined,
      context: userContext(authContext),
      extensionRuntime,
      source,
      onEvent,
    },
  };
}
