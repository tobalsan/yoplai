import fs from "node:fs/promises";
import type {
  DeliverySink,
  Extension,
  ExtensionContext,
  AgentStreamEvent,
  AgentHistoryEvent,
  ProjectFileChangedEvent,
  ProjectAgentChangedEvent,
  GatewayConfig,
  ExtensionCredentials,
} from "@yoplai/shared";
import {
  CONFIG_DIR,
  loadConfig,
  reloadConfig,
  getAgent,
  getActiveAgents as getAgents,
  isAgentActive,
  getSubagentTemplates,
  resolveWorkspaceDir,
} from "../config/index.js";
import { reportExtensionWork } from "../agents/active-turns.js";
import { runAgent, agentEventBus } from "../agents/index.js";
import { getAllSessionsForAgent, getSession } from "../agents/sessions.js";
import {
  getSessionEntry,
  clearSessionEntry,
  restoreSessionUpdatedAt,
} from "../sessions/index.js";
import { deleteSession } from "../agents/sessions.js";
import { getFullHistory, invalidateResolvedHistoryFile, snapshotTurnBuffer } from "../history/store.js";
import { abortAgentRun, getSessionHistory } from "../agents/runner.js";
import { ensureSession, hasSession, resetSession } from "../sessions/persistence.js";
import { logError, logInfo, logWarn } from "../logging.js";
import { saveUploadedFile } from "../media/upload.js";
import {
  getMediaFileMetadata,
  resolveMediaFilePath,
} from "../media/metadata.js";

import { CredentialStore } from "../credentials/store.js";
import { resolveCredential } from "../credentials/resolver.js";
import { credentialConnectHost } from "../credentials/connect.js";
import { recordSettingsChange } from "../audit/store.js";
import { updateAgentExtensionConfig } from "./agent-config-writer.js";
import { reloadAfterExtensionWrite } from "./reload.js";
import { getTask } from "../tasks/store.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Bind extension-owned connector registration to the extension being started. */
export function bindExtensionContext(context: ExtensionContext, extensionId: string): ExtensionContext {
  const credentialConnect = context.credentialConnect;
  const writeConfig = context.updateAgentExtensionConfig;
  return {
    ...context,
    updateAgentExtensionConfig: writeConfig && (async (agentId, targetId, patch) => {
      if (targetId !== extensionId) throw new Error("An extension can only write its own config.");
      return writeConfig(agentId, targetId, patch);
    }),
    credentialConnect: credentialConnect && {
      ...credentialConnect,
      registerOAuthConnector(id, start) {
        if (id !== extensionId) throw new Error("An extension can only register its own OAuth connector.");
        return credentialConnect.registerOAuthConnector(id, start);
      },
    },
  };
}

export function createExtensionContext(
  _resolvedConfig: GatewayConfig
): Parameters<Extension["start"]>[0] {
  // Host-owned delivery sink registry. Extensions register in `start` and drop
  // their entry in `stop` via the returned unregister, so a restart re-registers
  // cleanly instead of leaving a stale sink behind.
  const deliverySinks = new Map<string, DeliverySink>();
  let credentialStore: CredentialStore | undefined;
  const getCredentialStore = () => credentialStore ??= new CredentialStore();

  return {
    updateAgentExtensionConfig: async (agentId, extensionId, patch) => {
      const agent = getAgent(agentId);
      if (!agent) throw new Error(`Unknown agent: ${agentId}`);
      await updateAgentExtensionConfig(
        resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace),
        extensionId,
        patch
      );
      await reloadAfterExtensionWrite();
    },
    audit: { record: recordSettingsChange },
    credentialConnect: credentialConnectHost,
    credentials: {
      get: (key) => getCredentialStore().get(key),
      save: (key, payload) => getCredentialStore().save(key, payload),
      delete: (key) => getCredentialStore().delete(key),
      resolve: <T>(input: Parameters<ExtensionCredentials["resolve"]>[0]) =>
        resolveCredential<T>({ ...input, store: getCredentialStore() }),
    },
    setActiveWork: reportExtensionWork,
    getConfig: () => loadConfig(),
    getDataDir: () => CONFIG_DIR,
    reloadConfig: () => reloadConfig(),
    notifyAgentListChanged: () =>
      agentEventBus.emitAgentChanged({
        type: "agent_changed",
        projectId: "membership",
      }),
    getAgent,
    getAgents,
    isAgentActive,
    isAgentStreaming: (agentId: string) =>
      getAllSessionsForAgent(agentId).some((session) => session.isStreaming),
    getActiveRun: async (agentId, sessionId, sessionOwnerId) => {
      const session = getSession(agentId, sessionId);
      if (!session?.isStreaming || session.streamStartedAt === undefined ||
          session.storageOwnerId !== (sessionOwnerId ?? null)) return undefined;
      const startedAt = session.streamStartedAt;
      const task = await getTask(agentId, sessionId, sessionOwnerId ?? undefined);
      // The run may settle or be replaced during the ledger read.
      if (!session.isStreaming || session.streamStartedAt !== startedAt) return undefined;
      return { startedAt, ...(task?.status === "active" ? { taskTitle: task.title } : {}) };
    },
    abortRun: async (agentId, sessionKey, sessionOwnerId) => {
      const entry = await getSessionEntry(agentId, sessionKey, sessionOwnerId ?? undefined);
      return entry ? abortAgentRun(agentId, entry.sessionId) : false;
    },
    resolveWorkspaceDir: (agent) => resolveWorkspaceDir(agent.workspace),
    runAgent,
    getSubagentTemplates,
    resolveSessionId: async (agentId: string, sessionKey: string, userId?: string) =>
      getSessionEntry(agentId, sessionKey, userId),
    getSessionEntry,
    ensureSession,
    hasSession,
    resetSession,
    clearSessionEntry,
    restoreSessionUpdatedAt: (
      agentId: string,
      sessionKey: string,
      timestamp: number
    ) => {
      void restoreSessionUpdatedAt(agentId, sessionKey, timestamp);
    },
    deleteSession: (agentId: string, sessionId: string) => {
      void deleteSession(agentId, sessionId);
    },
    invalidateHistoryCache: async (
      agentId: string,
      sessionId: string,
      userId?: string
    ) => {
      invalidateResolvedHistoryFile(agentId, sessionId, userId);
    },
    getSessionHistory: (agentId: string, sessionId: string) =>
      getSessionHistory(agentId, sessionId),
    getFullSessionHistory: async (agentId, sessionId, storageOwnerId) => {
      const session = getSession(agentId, sessionId);
      const turns = session?.isStreaming && session.storageOwnerId === storageOwnerId
        ? [...(session.bufferedTurns ?? []), ...(session.currentTurn ? [session.currentTurn] : [])]
        : [];
      // Snapshot before I/O: buffers may flush or advance while history is read.
      const liveTurn = turns.length ? {
        prompt: turns.find((turn) => turn.userText !== null)?.userText ?? null,
        messages: turns.flatMap(snapshotTurnBuffer),
      } : undefined;
      return {
        messages: await getFullHistory(agentId, sessionId, storageOwnerId ?? undefined),
        liveTurn,
      };
    },
    saveMediaFile: async (
      data: Uint8Array | ArrayBuffer,
      mimeType: string,
      filename?: string
    ) => {
      const result = await saveUploadedFile(
        data instanceof ArrayBuffer ? data : Buffer.from(data),
        mimeType,
        filename
      );
      return {
        path: result.path,
        mimeType: result.mimeType,
        filename: filename ?? result.filename,
        size: result.size,
      };
    },
    readMediaFile: async (fileId: string) => {
      const metadata = await getMediaFileMetadata(fileId);
      if (!metadata) {
        throw new Error(`Media file not found: ${fileId}`);
      }
      const mediaPath = await resolveMediaFilePath(metadata);
      const data = await fs.readFile(mediaPath);
      return {
        data,
        filename: metadata.filename,
        mimeType: metadata.mimeType,
        size: metadata.size,
      };
    },
    registerDeliverySink: (id: string, sink: DeliverySink) => {
      if (deliverySinks.has(id)) {
        console.warn(`Delivery sink "${id}" already registered; replacing it`);
      }
      deliverySinks.set(id, sink);
      return () => {
        // Only drop our own entry: a replacement registration must survive the
        // replaced extension's `stop`.
        if (deliverySinks.get(id) === sink) deliverySinks.delete(id);
      };
    },
    getDeliverySink: (id: string) => deliverySinks.get(id),
    subscribe: (event: string, handler: (payload: unknown) => void) => {
      switch (event) {
        case "agent.stream":
          return agentEventBus.onStreamEvent(
            handler as Parameters<typeof agentEventBus.onStreamEvent>[0]
          );
        case "agent.history":
          return agentEventBus.onHistoryEvent(
            handler as Parameters<typeof agentEventBus.onHistoryEvent>[0]
          );
        case "agent.changed":
          return agentEventBus.onAgentChanged(
            handler as Parameters<typeof agentEventBus.onAgentChanged>[0]
          );
        case "file.changed":
          return agentEventBus.onFileChanged(
            handler as Parameters<typeof agentEventBus.onFileChanged>[0]
          );
        default: {
          agentEventBus.on(event, handler);
          return () => agentEventBus.off(event, handler);
        }
      }
    },
    emit: (event: string, payload: unknown) => {
      switch (event) {
        case "agent.stream":
          agentEventBus.emitStreamEvent(payload as AgentStreamEvent);
          break;
        case "agent.history":
          agentEventBus.emitHistoryEvent(payload as AgentHistoryEvent);
          break;
        case "agent.changed":
          agentEventBus.emitAgentChanged(payload as ProjectAgentChangedEvent);
          break;
        case "file.changed":
          agentEventBus.emitFileChanged(payload as ProjectFileChangedEvent);
          break;
        default:
          agentEventBus.emit(event, payload);
          break;
      }
    },
    logger: {
      info: (message: unknown, ...details: unknown[]) =>
        logInfo(String(message), details.length === 1 && isPlainObject(details[0]) ? details[0] : { details }),
      warn: (message: unknown, ...details: unknown[]) =>
        logWarn(String(message), details.length === 1 && isPlainObject(details[0]) ? details[0] : { details }),
      error: (...args: unknown[]) => {
        const [msg, error, fields] = args;
        logError(String(msg), error ?? msg, isPlainObject(fields) ? fields : {});
      },
    },
  } satisfies ExtensionContext;
}
