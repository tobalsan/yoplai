import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession as PiAgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "@yoplai/shared";
import { claimAgentToolName, renderAgentContext } from "@yoplai/shared";
import type {
  SdkAdapter,
  SdkRunParams,
  SdkRunResult,
  HistoryEvent,
} from "../types.js";
import { CONFIG_DIR, loadConfig, resolveAgentEnv } from "../../config/index.js";
import { logError } from "../../logging.js";
import { buildOnecliEnv } from "../../config/onecli.js";
import { resolveSystemFiles } from "@yoplai/shared/node/system-files";
import {
  FIRST_RUN_BOOTSTRAP_PROMPT,
  ensureWorkspaceFiles,
} from "../../agents/workspace.js";
import { getSessionCreatedAt } from "../../sessions/store.js";
import { resolveSessionDataFile } from "../../sessions/files.js";
import { getExtensionSystemPromptContributions } from "../../extensions/prompts.js";
import { getExtensionAgentTools } from "../../extensions/tools.js";
import { repairOrphanedToolCalls } from "./session-repair.js";
import {
  appendAttachmentContext,
  buildDocumentAttachmentContext,
  isImageAttachment,
  readInboundAttachment,
} from "../attachments.js";

const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");
let piEnvLock: Promise<void> = Promise.resolve();
const PI_SYSTEM_PROMPT = `You are an AI agent running inside Yoplai, a self-hosted multi-agent gateway. Yoplai provides a unified interface to orchestrate AI agents across multiple surfaces including web UI, CLI, Discord, scheduled jobs, and agent-to-agent messaging. Your role is determined by your configuration — you may operate as a coordinator planning and delegating work, a worker implementing tasks, a reviewer verifying quality, or a general-purpose assistant.

Available tools:
\${toolsList}

In addition to the tools above, you may have access to other custom tools provided by extensions or project configuration.

Guidelines:
\${guidelines}`;

async function ensureSessionsDir() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

/**
 * Resolve session file path with timestamp prefix support.
 * - For existing files: checks known timestamped path, then scans for any timestamped file, then legacy
 * - For new files: always creates timestamped filename (uses createdAt or defaults to now)
 */
async function resolveSessionFile(
  agentId: string,
  sessionId: string
): Promise<string> {
  await ensureSessionsDir();
  const createdAt = await getSessionCreatedAt(sessionId);
  return (await resolveSessionDataFile({
    dir: SESSIONS_DIR,
    agentId,
    sessionId,
    createdAt,
    createIfMissing: true,
  })) as string;
}

function extractAssistantText(msg: AssistantMessage): string {
  if (!msg.content) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

function stringifyToolResult(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result ?? null);
}

async function createPiExtensionTools(
  agent: AgentConfig,
  usedToolNames: Set<string>,
  params: SdkRunParams
): Promise<AgentTool[]> {
  const config = loadConfig();
  const env = resolveAgentEnv(agent, config);
  const tools = params.extensionRuntime
    ? await getExtensionAgentTools(agent, config, params.extensionRuntime)
    : await getExtensionAgentTools(agent, config);
  return tools.map((tool) => ({
    name: claimAgentToolName(tool.name, usedToolNames),
    label: tool.description,
    description: tool.description,
    parameters: tool.parameters as unknown as AgentTool["parameters"],
    execute: async (_toolCallId, toolParams) => {
      const result = await tool.execute(toolParams, {
        agent,
        config,
        env,
        sessionId: params.sessionId,
      });
      return {
        content: [{ type: "text", text: stringifyToolResult(result) }],
        details: result,
      };
    },
  }));
}

async function withPiOnecliEnv<T>(
  agentId: string,
  fn: () => Promise<T>
): Promise<T> {
  const env = buildOnecliEnv(loadConfig(), agentId);
  if (!env) return fn();

  const prevLock = piEnvLock;
  let releaseLock: () => void;
  piEnvLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  await prevLock;

  const saved: Record<string, string | undefined> = {};
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;
      saved[key] = process.env[key];
      process.env[key] = value;
    }

    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    releaseLock!();
  }
}

export const piAdapter: SdkAdapter = {
  id: "pi",
  displayName: "Pi Agent",
  capabilities: {
    queueWhileStreaming: true,
    interrupt: true,
    toolEvents: true,
    fullHistory: true,
  },

  resolveDisplayModel(agent: AgentConfig) {
    return { provider: agent.model.provider, model: agent.model.model };
  },

  async run(params: SdkRunParams): Promise<SdkRunResult> {
    return withPiOnecliEnv(params.agentId, async () => {
      const sessionFile = await resolveSessionFile(
        params.agentId,
        params.sessionId
      );

      // Ensure core workspace files exist
      const isFirstRun = await ensureWorkspaceFiles(params.workspaceDir);

      // Dynamically import pi-coding-agent
      const {
        createAgentSession,
        SessionManager,
        SettingsManager,
        AuthStorage,
        ModelRegistry,
        DefaultResourceLoader,
      } = await import("@earendil-works/pi-coding-agent");
      const { getEnvApiKey } = await import("@earendil-works/pi-ai/compat");

      // Resolve model
      await fs.mkdir(CONFIG_DIR, { recursive: true });

      // Get agent config to resolve model
      const { getAgent } = await import("../../config/index.js");
      const agent = getAgent(params.agentId);
      if (!agent) {
        throw new Error(`Agent not found: ${params.agentId}`);
      }
      const authStorage = AuthStorage.create(
        path.join(CONFIG_DIR, "auth.json")
      );
      const modelRegistry = ModelRegistry.create(
        authStorage,
        path.join(CONFIG_DIR, "models.json")
      );
      const effectiveModel = params.model ?? agent.model;
      if (!effectiveModel.provider) {
        throw new Error(
          `Pi SDK requires model.provider to be set for agent: ${agent.id}`
        );
      }
      const model = modelRegistry.find(
        effectiveModel.provider,
        effectiveModel.model
      );

      if (!model) {
        throw new Error(
          `Model not found: ${effectiveModel.provider}/${effectiveModel.model}`
        );
      }

      // Get API key based on auth.mode
      const authMode = agent.auth?.mode;
      let apiKey: string | null = null;

      if (authMode === "oauth") {
        // OAuth mode: require OAuth credentials
        const cred = authStorage.get(model.provider);
        if (!cred || cred.type !== "oauth") {
          throw new Error(
            `No OAuth credentials for provider: ${model.provider}. Run 'yoplai auth login ${model.provider}' first.`
          );
        }
        const auth = await modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          throw new Error(auth.error);
        }
        apiKey = auth.apiKey ?? null;
      } else if (authMode === "api_key") {
        // API key mode: only use API key credentials or env vars, skip OAuth
        const cred = authStorage.get(model.provider);
        if (cred?.type === "api_key") {
          apiKey = cred.key;
        } else {
          apiKey = getEnvApiKey(model.provider) ?? null;
        }
        if (!apiKey) {
          // Format env var name: github-copilot -> GITHUB_COPILOT_API_KEY
          const envVar = `${model.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
          throw new Error(
            `No API key for provider: ${model.provider}. Set ${envVar} env var.`
          );
        }
      } else {
        const auth = await modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          throw new Error(auth.error);
        }
        apiKey = auth.apiKey ?? null;
      }

      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }
      authStorage.setRuntimeApiKey(model.provider, apiKey);

      // Load configured system files
      const systemFiles = await resolveSystemFiles({
        workspaceDir: params.workspaceDir,
        systemFiles: agent.system_files,
        warn: (message) => console.warn(message),
      });
      const contextFiles = systemFiles.map((file) => ({
        path: file.path,
        content: file.content,
      }));

      // Enable Pi's built-in coding tools plus extension custom tools for the run workspace.
      // Pi treats `tools` as an allowlist when provided, so custom tool names must be included.
      const builtInTools = ["read", "bash", "edit", "write"];
      const usedToolNames = new Set<string>();
      const extensionTools = await createPiExtensionTools(
        agent,
        usedToolNames,
        params
      );
      const tools = [
        ...builtInTools,
        ...extensionTools.map((tool) => tool.name),
      ];
      const extensionPrompts = params.extensionRuntime
        ? await getExtensionSystemPromptContributions(
            agent,
            loadConfig(),
            params.extensionRuntime
          )
        : await getExtensionSystemPromptContributions(agent);
      const renderedContext = params.context
        ? renderAgentContext(params.context)
        : "";
      const allAppendedPrompts = [
        isFirstRun ? FIRST_RUN_BOOTSTRAP_PROMPT : undefined,
        ...extensionPrompts,
        renderedContext || undefined,
      ].filter((prompt): prompt is string => Boolean(prompt));

      const sessionManager = SessionManager.open(sessionFile, SESSIONS_DIR);
      const settingsManager = SettingsManager.create(
        params.workspaceDir,
        CONFIG_DIR
      );
      const globalSkillsDir = path.join(os.homedir(), ".agents", "skills");
      const includeGlobalSkills = agent.globalSkills === true;

      const workspaceSkillsDir = path.join(params.workspaceDir, "skills");

      const resourceLoader = new DefaultResourceLoader({
        cwd: params.workspaceDir,
        agentDir: CONFIG_DIR,
        settingsManager,
        systemPromptOverride: () => PI_SYSTEM_PROMPT,
        appendSystemPrompt:
          allAppendedPrompts.length > 0 ? allAppendedPrompts : undefined,
        additionalSkillPaths: [workspaceSkillsDir],
        agentsFilesOverride: () => ({ agentsFiles: contextFiles }),
        ...(!includeGlobalSkills && {
          skillsOverride: (result) => ({
            skills: result.skills.filter(
              (s) => !s.filePath.startsWith(globalSkillsDir)
            ),
            diagnostics: result.diagnostics,
          }),
        }),
      });
      await resourceLoader.reload();

      const { session: agentSession } = await createAgentSession({
        cwd: params.workspaceDir,
        agentDir: CONFIG_DIR,
        authStorage,
        modelRegistry,
        model,
        ...(params.thinkLevel && { thinkingLevel: params.thinkLevel }),
        tools,
        customTools: extensionTools,
        resourceLoader,
        sessionManager,
        settingsManager,
      });

      // Repair orphaned tool calls from interrupted sessions
      repairOrphanedToolCalls(agentSession);

      // Emit session handle for queue injection
      params.onSessionHandle?.(agentSession);

      let aborted = false;

      // Handle abort
      params.abortSignal.addEventListener("abort", () => {
        aborted = true;
        agentSession.abort();
      });

      const systemPrompt = agentSession.agent.state.systemPrompt;
      if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) {
        params.onHistoryEvent({
          type: "system_prompt",
          text: systemPrompt,
          timestamp: Date.now(),
        });
      }

      if (renderedContext && params.context) {
        params.onHistoryEvent({
          type: "system_context",
          context: params.context,
          rendered: renderedContext,
          timestamp: Date.now(),
        });
      }

      // Load images from file paths
      let images: ImageContent[] | undefined;
      if (params.attachments && params.attachments.length > 0) {
        const imageAttachments = params.attachments.filter(isImageAttachment);
        if (imageAttachments.length > 0) {
          images = await Promise.all(
            imageAttachments.map(async (attachment) => {
              const buffer = await readInboundAttachment(attachment);
              return {
                type: "image" as const,
                data: buffer.toString("base64"),
                mimeType: attachment.mimeType,
              };
            })
          );
        }
      }

      const attachmentContext = await buildDocumentAttachmentContext(
        params.attachments
      );
      const messageWithAttachments = appendAttachmentContext(
        params.message,
        attachmentContext
      );

      // Emit user message to history (without context preamble)
      params.onHistoryEvent({
        type: "user",
        text: params.message,
        attachments: params.attachments,
        timestamp: Date.now(),
      });

      // Subscribe to streaming events

      const unsubscribe = agentSession.subscribe((evt) => {
        if (evt.type === "message_update") {
          const msg = (evt as { message?: AgentMessage }).message;
          if (msg?.role === "assistant") {
            const assistantEvent = (evt as { assistantMessageEvent?: unknown })
              .assistantMessageEvent as Record<string, unknown> | undefined;
            const evtType = assistantEvent?.type as string | undefined;

            if (evtType === "text_delta") {
              const chunk = assistantEvent?.delta as string;
              if (chunk) {
                params.onEvent({ type: "text", data: chunk });
                params.onHistoryEvent({
                  type: "assistant_text",
                  text: chunk,
                  timestamp: Date.now(),
                });
              }
            } else if (evtType === "thinking_delta") {
              const chunk = assistantEvent?.delta as string;
              if (chunk) {
                params.onEvent({ type: "thinking", data: chunk });
                params.onHistoryEvent({
                  type: "assistant_thinking",
                  text: chunk,
                  timestamp: Date.now(),
                });
              }
            }
          }
        }

        if (evt.type === "tool_execution_start") {
          const toolName = (evt as { toolName?: string }).toolName ?? "unknown";
          const toolCallId =
            (evt as { toolCallId?: string }).toolCallId ?? `call_${Date.now()}`;
          const args = (evt as { args?: unknown }).args;

          params.onEvent({ type: "tool_start", toolName });
          params.onEvent({
            type: "tool_call",
            id: toolCallId,
            name: toolName,
            arguments: args,
          });
          params.onHistoryEvent({
            type: "tool_call",
            id: toolCallId,
            name: toolName,
            args,
            timestamp: Date.now(),
          });
        }

        if (evt.type === "tool_execution_end") {
          const toolName = (evt as { toolName?: string }).toolName ?? "unknown";
          const toolCallId = (evt as { toolCallId?: string }).toolCallId ?? "";
          const isError = (evt as { isError?: boolean }).isError ?? false;
          const rawResult = (evt as { result?: unknown }).result;

          // Extract text from result - handle both string and structured formats
          let content = "";
          if (typeof rawResult === "string") {
            content = rawResult;
          } else if (rawResult && typeof rawResult === "object") {
            // Handle structured content like {content: [{type: "text", text: "..."}]}
            const obj = rawResult as Record<string, unknown>;
            if (Array.isArray(obj.content)) {
              content = (obj.content as Array<Record<string, unknown>>)
                .filter((c) => c?.type === "text" && typeof c.text === "string")
                .map((c) => c.text as string)
                .join("\n");
            }
          }

          params.onEvent({ type: "tool_end", toolName, isError });
          params.onEvent({
            type: "tool_result",
            id: toolCallId,
            name: toolName,
            content,
            isError,
          });
          params.onHistoryEvent({
            type: "tool_result",
            id: toolCallId,
            name: toolName,
            content,
            isError,
            timestamp: Date.now(),
          });
        }

        // Capture meta from message end
        if (evt.type === "message_end") {
          const msg = (evt as { message?: AgentMessage }).message;
          if (msg?.role === "assistant") {
            const assistantMsg = msg as unknown as Record<string, unknown>;
            params.onHistoryEvent({
              type: "meta",
              provider: assistantMsg.provider as string | undefined,
              model: assistantMsg.model as string | undefined,
              api: assistantMsg.api as string | undefined,
              usage: assistantMsg.usage as HistoryEvent extends {
                type: "meta";
                usage?: infer U;
              }
                ? U
                : undefined,
              stopReason: assistantMsg.stopReason as string | undefined,
              timestamp: Date.now(),
            });
            params.onHistoryEvent({
              type: "turn_end",
              timestamp: Date.now(),
            });
          }
        }
      });

      try {
        await agentSession.prompt(
          messageWithAttachments,
          images && images.length > 0 ? { images } : undefined
        );
      } finally {
        unsubscribe();
      }

      const messages = agentSession.messages;
      const lastAssistant = messages
        .slice()
        .reverse()
        .find((m: AgentMessage) => m.role === "assistant") as
        | AssistantMessage
        | undefined;

      const lastAssistantRecord = lastAssistant as
        | (Record<string, unknown> & AssistantMessage)
        | undefined;
      if (lastAssistantRecord?.stopReason === "error") {
        const errorMessage =
          typeof lastAssistantRecord.errorMessage === "string" &&
          lastAssistantRecord.errorMessage
            ? lastAssistantRecord.errorMessage
            : "unknown error";
        const errorStr = `Agent error: ${errorMessage}`;
        logError("[agent] SDK run failed", new Error(errorStr), {
          agentId: params.agent.id,
        });
        agentSession.dispose();
        throw new Error(errorStr);
      }

      const finalText = lastAssistant
        ? extractAssistantText(lastAssistant)
        : "";

      agentSession.dispose();

      return { text: finalText, aborted };
    });
  },

  async queueMessage(handle: unknown, message: string): Promise<void> {
    const piSession = handle as PiAgentSession;
    await piSession.sendUserMessage(message, { deliverAs: "steer" });
  },

  abort(handle: unknown): void {
    const piSession = handle as PiAgentSession;
    piSession.abort();
  },
};
