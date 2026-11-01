import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { renderToolSignature } from "@earendil-works/pi-codemode";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { createToolDeferralCatalog } from "@yoplai/shared/tool-deferral";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession as PiAgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, McpAppView } from "@yoplai/shared";
import {
  DEFAULT_RETRY_BASE_DELAY_SECONDS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  PI_SYSTEM_PROMPT,
  claimAgentToolName,
  classifyRunFailure,
  codemodeGuidance,
  findFailedTurn,
  formatImageDescriptionBlocks,
  getProviderErrorCategory,
  isReplayableFailedTurn,
  isFallbackEligibleError,
  isInvalidRequestError,
  modelSupportsImages,
  renderAgentContext,
  resumeAfterFailedTurn,
  runTurnWithProviderRetry,
} from "@yoplai/shared";
import type {
  SdkAdapter,
  SdkRunParams,
  SdkRunResult,
  HistoryEvent,
} from "../types.js";
import { CONFIG_DIR, loadConfig, resolveAgentEnv } from "../../config/index.js";
import { logError, logInfo, logWarn } from "../../logging.js";
import { buildOnecliEnv } from "../../config/onecli.js";
import { resolveSystemFiles } from "@yoplai/shared/node/system-files";
import { createRuntimeSessionFile } from "@yoplai/shared/node/sanitize-session";
import {
  FIRST_RUN_BOOTSTRAP_PROMPT,
  ensureWorkspaceFiles,
} from "../../agents/workspace.js";
import { selfImprovementPrompt } from "../../agents/self-improvement.js";
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
import { describeImage } from "../../media/describe.js";
import { getFullHistory } from "../../history/store.js";
import { getMediaFileMetadata } from "../../media/metadata.js";
import { createManagedSkillsStaging, getBuiltInSkillsDir } from "./skills.js";
import { getSkillContext } from "../../skills/context.js";
import { resolveRunSkills } from "../../skills/resolver.js";
import { executeSkillSave, skillSaveTool } from "../../skills/tools.js";
import { executeProjectTool, projectTools } from "../../chat-projects/tools.js";
import { getConversationFiles } from "../../media/conversation-files.js";
import { ContainerFileOutputAdapter } from "../container/file-output.js";
import { clearMcpAppViews, getMcpAppView } from "../../mcp-apps/capture.js";

type SignatureSchema = Parameters<typeof renderToolSignature>[0]["inputSchema"];

function runFailureError(message: string): Error {
  return Object.assign(new Error(message), {
    kind: classifyRunFailure(undefined, message),
  });
}

const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");
// Provider names whose Pi API-key environment variable differs from the id.
const PROVIDER_API_KEY_ENV_VARS = new Map([
  ["opencode", "OPENCODE_API_KEY"],
  ["opencode-go", "OPENCODE_API_KEY"],
  ["github-copilot", "COPILOT_GITHUB_TOKEN"],
  ["google", "GEMINI_API_KEY"],
  ["huggingface", "HF_TOKEN"],
  ["moonshotai", "MOONSHOT_API_KEY"],
  ["moonshotai-cn", "MOONSHOT_API_KEY"],
  ["kimi-coding", "KIMI_API_KEY"],
  ["vercel-ai-gateway", "AI_GATEWAY_API_KEY"],
  ["azure", "AZURE_OPENAI_API_KEY"],
  ["cloudflare-workers-ai", "CLOUDFLARE_API_KEY"],
  ["cloudflare-ai-gateway", "CLOUDFLARE_API_KEY"],
]);
let piEnvLock: Promise<void> = Promise.resolve();

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
  sessionId: string,
  userId?: string
): Promise<string> {
  await ensureSessionsDir();
  const createdAt = await getSessionCreatedAt(sessionId, userId);
  return (await resolveSessionDataFile({
    dir: userId ? path.join(CONFIG_DIR, "sessions", "users", userId, "sessions") : SESSIONS_DIR,
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

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function stringifyToolResult(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result ?? null);
}

async function createPiExtensionTools(
  agent: AgentConfig,
  usedToolNames: Set<string>,
  params: SdkRunParams,
  includeDescribeImage = false
) {
  const config = loadConfig();
  const env = resolveAgentEnv(agent, config);
  const conversationFiles = getConversationFiles(agent.id, params.sessionId, params.userId);
  const tools = await getExtensionAgentTools(
    agent,
    config,
    params.extensionRuntime,
    params.userId,
    params
  );
  const invisibleToolNames = new Set<string>();
  const mcpViews = new Map<string, McpAppView>();
  const descriptors: Parameters<typeof createToolDeferralCatalog>[0][number][] = [];
  const piTools: ToolDefinition[] = tools.map((tool): ToolDefinition => {
    const name = claimAgentToolName(tool.name, usedToolNames);
    if (tool.mcp?.ui?.resourceUri) mcpViews.set(name, {
      server: tool.mcp.server, tool: tool.mcp.tool, resourceUri: tool.mcp.ui.resourceUri,
    });
    if (tool.extensionId === "taskLifecycle") invisibleToolNames.add(name);
    descriptors.push({ ...tool, name, canonicalName: tool.name });
    return {
      name,
      label: tool.description,
      description: tool.description,
      parameters: tool.parameters as unknown as ToolDefinition["parameters"],
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema as ToolDefinition["outputSchema"] } : {}),
      execute: async (toolCallId, toolParams, signal) => {
        const result = await tool.execute(toolParams, {
          agent,
          config,
          env,
          sessionId: params.sessionId,
          toolCallId,
          userId: params.userId,
          actorUserId: params.actorUserId,
          actorKind: params.actorKind,
          sessionOwnerId: params.sessionOwnerId === undefined ? params.userId ?? null : params.sessionOwnerId,
          requesterId: params.requesterId,
          signal: signal ? AbortSignal.any([signal, params.abortSignal]) : params.abortSignal,
          conversationFiles,
          emitProgress: (event) =>
            params.onEvent({ type: "progress", ...event }),
        });
        return {
          content: [{ type: "text", text: stringifyToolResult(result) }],
          details: result,
          ...(tool.outputSchema ? {
            structuredContent: JSON.parse(JSON.stringify(result ?? null)),
            isError: typeof result === "object" && result !== null && !Array.isArray(result) && "isError" in result && result.isError === true ? true : undefined,
          } : {}),
        };
      },
    };
  });
  const sendFileName = claimAgentToolName("send_file", usedToolNames);
  descriptors.push({ name: sendFileName, extensionId: "core", core: true });
  piTools.push({
    name: sendFileName,
    label: "Send file to user",
    description: "Send a regular file in this conversation's files directory (sub-folders allowed) as a downloadable card in chat. Symlinks are not supported. Finish writing the file first.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path to the conversation file" } },
      required: ["path"],
    } as ToolDefinition["parameters"],
    execute: async (_toolCallId, args, signal) => {
      const input = args as { path?: unknown };
      if (typeof input.path !== "string") throw new Error("send_file requires a path");
      await new ContainerFileOutputAdapter().handle(params, { type: "file_output", path: input.path }, undefined,
        signal ? AbortSignal.any([signal, params.abortSignal]) : params.abortSignal, conversationFiles);
      return { content: [{ type: "text", text: "File sent to user" }], details: {} };
    },
  });
  const skillSaveName = claimAgentToolName(skillSaveTool.name, usedToolNames);
  descriptors.push({ ...skillSaveTool, name: skillSaveName, canonicalName: skillSaveTool.name });
  piTools.push({
    name: skillSaveName, label: "Save skill", description: skillSaveTool.description,
    parameters: skillSaveTool.parameters as unknown as ToolDefinition["parameters"],
    execute: async (_toolCallId, args) => {
      const result = await executeSkillSave(args, { userId: params.userId });
      return { content: [{ type: "text", text: stringifyToolResult(result) }], details: result };
    },
  });
  if (params.context?.project?.id) {
    for (const tool of projectTools) {
      const name = claimAgentToolName(tool.name, usedToolNames);
      descriptors.push({
        name,
        canonicalName: tool.name,
        extensionId: tool.extensionId,
        extensionDescription: "Read and manage project documents",
      });
      piTools.push({
        name,
        label: tool.description,
        description: tool.description,
        parameters: tool.parameters as unknown as ToolDefinition["parameters"],
        execute: async (_toolCallId, args) => {
          const result = await executeProjectTool(tool.name, args, {
            agentId: params.agentId, sessionId: params.sessionId, userId: params.userId,
            projectId: params.context?.project?.id,
          });
          return { content: [{ type: "text", text: stringifyToolResult(result) }], details: result };
        },
      });
    }
  }
  if (includeDescribeImage && config.imageDescription?.enabled === true) {
    const name = claimAgentToolName("describe_image", usedToolNames);
    descriptors.push({ name, extensionId: "imageDescription", core: true });
    piTools.push({
      name,
      label: "Describe an attached image",
      description:
        "Re-query an image already attached to this conversation. Use the exact attachment path shown in its generated description.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, question: { type: "string" } },
        required: ["path"],
      } as ToolDefinition["parameters"],
      execute: async (_toolCallId, toolParams) => {
        const args = toolParams as { path?: unknown; question?: unknown };
        if (typeof args.path !== "string")
          throw new Error("describe_image requires an image path");
        const attachment = await findSessionImageAttachment(
          agent.id,
          params.sessionId,
          params.sessionOwnerId === undefined ? params.userId : params.sessionOwnerId ?? undefined,
          args.path
        );
        if (!attachment)
          throw new Error(
            "describe_image path is not an image attached to this session"
          );
        const description = await describeImage(
          await readInboundAttachment(attachment),
          attachment.mimeType,
          config,
          typeof args.question === "string" ? args.question : undefined
        );
        return {
          content: [{ type: "text", text: description }],
          details: { description },
        };
      },
    });
  }
  return { tools: piTools, invisibleToolNames, descriptors, mcpViews };
}

export async function findSessionImageAttachment(
  agentId: string,
  sessionId: string,
  userId: string | undefined,
  requestedPath: string
) {
  const history = await getFullHistory(agentId, sessionId, userId);
  for (const message of history) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block.type !== "file" ||
        block.direction !== "inbound" ||
        !block.mimeType.startsWith("image/")
      )
        continue;
      const metadata = await getMediaFileMetadata(block.fileId);
      if (
        metadata?.path === requestedPath &&
        metadata.agentId === agentId &&
        metadata.sessionId === sessionId
      ) {
        return {
          path: metadata.path,
          mimeType: metadata.mimeType,
          filename: metadata.filename,
          size: metadata.size,
        };
      }
    }
  }
  return undefined;
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
    let persistSession: (() => Promise<void>) | undefined;
    let managedSkills: Awaited<ReturnType<typeof createManagedSkillsStaging>> | undefined;
    return withPiOnecliEnv(params.agentId, async () => {
      const persistentSessionFile = await resolveSessionFile(
        params.agentId,
        params.sessionId,
        params.sessionOwnerId === undefined ? params.userId : params.sessionOwnerId ?? undefined
      );
      const runtimeSession = await createRuntimeSessionFile(
        persistentSessionFile
      );
      const sessionFile = runtimeSession.file;
      persistSession = runtimeSession.persist;

      // Ensure core workspace files exist
      const isFirstRun = await ensureWorkspaceFiles(params.workspaceDir);

      // Dynamically import pi-coding-agent
      const {
        createAgentSession,
        createCodemodeExtension,
        createToolSearchExtension,
        SessionManager,
        SettingsManager,
        ModelRuntime,
        readStoredCredential,
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
      const authPath = path.join(CONFIG_DIR, "auth.json");
      const modelRuntime = await ModelRuntime.create({
        authPath,
        modelsPath: path.join(CONFIG_DIR, "models.json"),
      });
      const effectiveModel = params.model ?? agent.model;
      if (!effectiveModel.provider) {
        throw new Error(
          `Pi SDK requires model.provider to be set for agent: ${agent.id}`
        );
      }
      const model = modelRuntime.getModel(
        effectiveModel.provider,
        effectiveModel.model
      );

      if (!model) {
        throw new Error(
          `Model not found: ${effectiveModel.provider}/${effectiveModel.model}`
        );
      }

      // Explicit model overrides infer auth from that provider's stored
      // credential; ordinary runs preserve the agent's configured auth mode.
      const storedCredential = readStoredCredential(model.provider, authPath);
      const authMode = params.model ? storedCredential?.type : agent.auth?.mode;
      let apiKey: string | null = null;

      if (authMode === "oauth") {
        // OAuth mode: require OAuth credentials
        if (!storedCredential || storedCredential.type !== "oauth") {
          throw new Error(
            `No OAuth credentials for provider: ${model.provider}. Run 'yoplai auth login ${model.provider}' first.`
          );
        }
        const auth = await modelRuntime.getAuth(model);
        apiKey = auth?.auth.apiKey ?? null;
      } else if (authMode === "api_key") {
        // API key mode: only use API key credentials or env vars, skip OAuth
        if (storedCredential?.type === "api_key" && storedCredential.key) {
          apiKey = storedCredential.key;
        } else {
          apiKey = getEnvApiKey(model.provider) ?? null;
        }
        if (!apiKey) {
          const envVar = PROVIDER_API_KEY_ENV_VARS.get(model.provider)
            ?? `${model.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
          throw new Error(
            `No API key for provider: ${model.provider}. Set ${envVar} env var.`
          );
        }
      } else {
        const auth = await modelRuntime.getAuth(model);
        apiKey = auth?.auth.apiKey ?? null;
      }

      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }
      // Runtime-resolved auth must retain its credential type (especially OAuth).
      // Only explicit API-key mode needs an override to exclude stored OAuth.
      if (authMode === "api_key") {
        await modelRuntime.setRuntimeApiKey(model.provider, apiKey);
      }

      // Load configured system files
      const systemFiles = await resolveSystemFiles({
        workspaceDir: params.workspaceDir,
        systemFiles: agent.system_files,
        warn: (message) => logWarn(message),
      });
      const contextFiles = systemFiles.map((file) => ({
        path: file.path,
        content: file.content,
      }));

      // Enable Pi's built-in coding tools plus extension custom tools for the run workspace.
      // Pi treats `tools` as an allowlist when provided, so custom tool names must be included.
      const builtInTools = ["read", "bash", "edit", "write"];
      const configuredFallback = params.agent.fallback_model
        ? modelRuntime.getModel(
            params.agent.fallback_model.provider,
            params.agent.fallback_model.model
          )
        : undefined;
      // Build the turn for the least capable configured model. A fallback must
      // receive the same attachment representation and image tools as primary.
      const turnSupportsImages =
        modelSupportsImages(model) &&
        (!configuredFallback || modelSupportsImages(configuredFallback));
      const usedToolNames = new Set([...builtInTools, "tool_search", "codemode"]);
      const { tools: extensionTools, invisibleToolNames, descriptors, mcpViews } =
        await createPiExtensionTools(
          agent,
          usedToolNames,
          params,
          !turnSupportsImages
        );
      const tools = [
        ...builtInTools,
        ...extensionTools.map((tool) => tool.name),
        ...(agent.codemode === true ? ["codemode"] : []),
        ...(agent.toolDeferral?.enabled !== false ? ["tool_search"] : []),
      ];
      const catalog = createToolDeferralCatalog(
        [
          ...descriptors,
          ...tools.filter(name => !extensionTools.some(tool => tool.name === name))
            .map(name => ({ name, extensionId: "host", core: true })),
        ],
        agent.toolDeferral,
        { codemode: agent.codemode === true }
      );
      for (const tool of extensionTools)
        Object.assign(tool, catalog.tools.get(tool.name));
      const signatureOf = (name: string) => {
        const tool = extensionTools.find((candidate) => candidate.name === name);
        return tool
          ? renderToolSignature({
              name: tool.name,
              inputSchema: tool.parameters as SignatureSchema,
              outputSchema: tool.outputSchema as SignatureSchema,
            })
          : undefined;
      };
      const extensionPrompts = await getExtensionSystemPromptContributions(
        agent,
        loadConfig(),
        params.extensionRuntime,
        params.userId,
        params
      );
      const renderedContext = params.context
        ? renderAgentContext(params.context)
        : "";
      const allAppendedPrompts = [
        isFirstRun ? FIRST_RUN_BOOTSTRAP_PROMPT : undefined,
        ...extensionPrompts,
        selfImprovementPrompt(agent),
        renderedContext || undefined,
        `Conversation files: ${getConversationFiles(agent.id, params.sessionId, params.userId).runtimePath}. Download and edit files here; use send_file to share the result with the user.`,
      ].filter((prompt): prompt is string => Boolean(prompt));

      const sessionManager = SessionManager.open(sessionFile, SESSIONS_DIR);
      const settingsManager = SettingsManager.create(
        params.workspaceDir,
        CONFIG_DIR
      );
      const globalSkillsDir = path.join(os.homedir(), ".agents", "skills");
      const includeGlobalSkills = agent.globalSkills === true;

      const workspaceSkillsDir = path.join(params.workspaceDir, "skills");
      const skillContext = await getSkillContext();
      const selectedSkills = await resolveRunSkills(skillContext.store, {
        agentId: params.agentId, userId: params.userId,
        multiUser: skillContext.multiUser, policy: skillContext.policy,
      });
      for (const collision of selectedSkills.diagnostics) logWarn("[skills] managed skill shadowed", collision);
      managedSkills = await createManagedSkillsStaging(selectedSkills.skills);

      const resourceLoader = new DefaultResourceLoader({
        cwd: params.workspaceDir,
        agentDir: CONFIG_DIR,
        settingsManager,
        extensionFactories: [
          ...(agent.toolDeferral?.enabled !== false
            ? [createToolSearchExtension()]
            : []),
          ...(agent.codemode === true
            ? [createCodemodeExtension({ mode: "on", inlineBudget: 1000, models: false })]
            : []),
          (pi) => {
            pi.on("before_agent_start", (event) => {
              if (agent.codemode === true)
                event.systemPromptOptions.sections["codemode-guidance"] = codemodeGuidance();
              if (catalog.summary)
                event.systemPromptOptions.sections["deferred-tools"] = catalog.summary;
              else delete event.systemPromptOptions.sections["deferred-tools"];
            });
            pi.on("message_end", (event) => {
              const unloaded = catalog.hintUnloadedToolResult(event.message);
              const message =
                agent.codemode === true
                  ? (catalog.hintCodemodeSignatures(unloaded ?? event.message, signatureOf) ?? unloaded)
                  : unloaded;
              return message ? { message } : undefined;
            });
          },
        ],
        systemPromptOverride: () => PI_SYSTEM_PROMPT,
        appendSystemPrompt:
          allAppendedPrompts.length > 0 ? allAppendedPrompts : undefined,
        additionalSkillPaths: [getBuiltInSkillsDir(), workspaceSkillsDir, managedSkills.directory],
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
        modelRuntime,
        model,
        ...(params.thinkLevel && { thinkingLevel: params.thinkLevel }),
        tools,
        customTools: extensionTools,
        resourceLoader,
        sessionManager,
        settingsManager,
      });

      agentSession.setActiveToolsByName(
        catalog.activeToolNames(getCurrentTools(sessionManager.buildSessionContext().messages))
      );

      // Repair orphaned tool calls from interrupted sessions
      repairOrphanedToolCalls(agentSession);

      let aborted = params.abortSignal.aborted;

      // Handle abort
      const onAbort = () => {
        aborted = true;
        void agentSession.abort();
      };
      params.abortSignal.addEventListener("abort", onAbort);

      let sentSystemPrompt: string | undefined;
      const sendSystemPrompt = () => {
        const systemPrompt = agentSession.systemPrompt;
        if (
          typeof systemPrompt !== "string" ||
          systemPrompt.trim().length === 0 ||
          systemPrompt === sentSystemPrompt
        )
          return;
        sentSystemPrompt = systemPrompt;
        params.onHistoryEvent({
          type: "system_prompt",
          text: systemPrompt,
          timestamp: Date.now(),
        });
      };
      sendSystemPrompt();

      if (renderedContext && params.context) {
        params.onHistoryEvent({
          type: "system_context",
          context: params.context,
          rendered: renderedContext,
          timestamp: Date.now(),
        });
      }

      // Preserve pixels for vision models; otherwise inject durable labelled text.
      let images: ImageContent[] | undefined;
      let imageDescriptionContext = "";
      if (params.attachments && params.attachments.length > 0) {
        const imageAttachments = params.attachments.filter(isImageAttachment);
        if (imageAttachments.length > 0) {
          if (turnSupportsImages) {
            images = await Promise.all(
              imageAttachments.map(async (attachment) => ({
                type: "image" as const,
                data: (await readInboundAttachment(attachment)).toString(
                  "base64"
                ),
                mimeType: attachment.mimeType,
              }))
            );
          } else if (loadConfig().imageDescription?.enabled === true) {
            const config = loadConfig();
            const descriptions = await Promise.all(
              imageAttachments.map(async (attachment) => {
                try {
                  return {
                    path: attachment.path,
                    description: await describeImage(
                      await readInboundAttachment(attachment),
                      attachment.mimeType,
                      config
                    ),
                  };
                } catch {
                  return {
                    path: attachment.path,
                    description:
                      "Description failed; the image could not be read.",
                  };
                }
              })
            );
            imageDescriptionContext =
              formatImageDescriptionBlocks(descriptions);
          }
        }
      }

      const attachmentContext = await buildDocumentAttachmentContext(
        params.attachments,
        { includeUnextractedPath: true }
      );
      const messageWithAttachments = appendAttachmentContext(
        params.nudge ? `${params.message}\n\n${params.nudge}` : params.message,
        [attachmentContext, imageDescriptionContext]
          .filter(Boolean)
          .join("\n\n")
      );

      // Aborting an idle Pi session does not cancel a future prompt.
      if (aborted) {
        params.abortSignal.removeEventListener("abort", onAbort);
        agentSession.dispose();
        return { text: "", aborted: true };
      }

      // Emit user message to history (without context preamble)
      params.onHistoryEvent({
        type: "user",
        text: params.message,
        attachments: params.attachments,
        timestamp: Date.now(),
      });

      // Subscribe to streaming events
      let handlePublished = false;
      const unsubscribe = agentSession.subscribe((evt) => {
        // An idle Pi session starts a new prompt on delivery. Publish only
        // once the original run is active, so early messages stay buffered.
        if (evt.type === "agent_start" && !handlePublished) {
          handlePublished = true;
          params.onSessionHandle?.(agentSession);
        }
        // Pi changes the prompt after session creation (`before_agent_start`
        // sections) and between turns (loaded tools). Send each new prompt.
        if (evt.type === "message_start" && evt.message.role === "assistant")
          sendSystemPrompt();
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
          const parentToolCallId = evt.parentToolCallId;

          const view = mcpViews.get(toolName);

          if (invisibleToolNames.has(toolName)) return;
          params.onEvent({ type: "tool_start", toolName });
          params.onEvent({
            type: "tool_call",
            id: toolCallId,
            name: toolName,
            arguments: args,
            parentToolCallId,
            ...(view ? { view } : {}),
          });
          params.onHistoryEvent({
            type: "tool_call",
            id: toolCallId,
            name: toolName,
            args,
            parentToolCallId,
            ...(view ? { view } : {}),
            timestamp: Date.now(),
          });
        }

        if (evt.type === "tool_execution_end") {
          const toolName = (evt as { toolName?: string }).toolName ?? "unknown";
          const toolCallId = (evt as { toolCallId?: string }).toolCallId ?? "";
          const isError = (evt as { isError?: boolean }).isError ?? false;
          const rawResult = (evt as { result?: unknown }).result;
          const parentToolCallId = evt.parentToolCallId;
          const view = getMcpAppView(params, toolCallId);

          if (invisibleToolNames.has(toolName)) return;
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
            parentToolCallId,
            ...(view ? { view } : {}),
          });
          params.onHistoryEvent({
            type: "tool_result",
            id: toolCallId,
            name: toolName,
            content,
            isError,
            parentToolCallId,
            ...(view ? { view } : {}),
            timestamp: Date.now(),
          });
        }

        // Capture meta from message end
        if (evt.type === "message_end") {
          const msg = (evt as { message?: AgentMessage }).message;
          if (msg?.role === "assistant" && msg.stopReason !== "error") {
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
          }
        }

        // Pi's turn_end fires after the assistant message AND its tool
        // executions, so tool calls/results stay in the same history turn
        // as the message that issued them.
        if (evt.type === "turn_end") {
          params.onHistoryEvent({
            type: "turn_end",
            timestamp: Date.now(),
          });
        }
      });

      const promptOptions =
        images && images.length > 0 ? { images } : undefined;
      try {
      const primaryStartedAt = Date.now();
      let primaryThrown: unknown;
      try {
        // Keep the subscription alive across attempts so a resumed turn still streams.
        await runTurnWithProviderRetry({
          maxAttempts:
            params.agent.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
          baseDelaySeconds:
            params.agent.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY_SECONDS,
          runTurn: (attempt) =>
            attempt === 1
              ? agentSession.prompt(messageWithAttachments, promptOptions)
              : resumeAfterFailedTurn(agentSession, () =>
                  agentSession.prompt(messageWithAttachments, promptOptions)
                ),
          getMessages: () => agentSession.messages,
          isAbort: (error) => aborted || isAbortLikeError(error),
          onRetry: (attempt, delaySeconds, message) =>
            logWarn(
              `[agent] retrying transient provider error (attempt ${attempt}, delay ${delaySeconds}s): ${message}`,
              { agentId: params.agent.id }
            ),
          onAttempt: (attempt, durationMs, failure) =>
            (failure ? logWarn : logInfo)("[agent] primary model attempt completed", {
              agentId: params.agent.id,
              provider: effectiveModel.provider,
              model: effectiveModel.model,
              attempt,
              durationMs,
              outcome: failure ? "failure" : "success",
              failureCategory: failure
                ? getProviderErrorCategory(failure.source, failure.message)
                : undefined,
              failure: failure?.message,
            }),
          sleep: (milliseconds) =>
            new Promise((resolve) => setTimeout(resolve, milliseconds)),
        });
      } catch (error) {
        primaryThrown = error;
      }
      const primaryFailure = primaryThrown
        ? {
            source: primaryThrown,
            message:
              primaryThrown instanceof Error
                ? primaryThrown.message
                : String(primaryThrown),
          }
        : findFailedTurn(agentSession.messages);
      if (
        primaryFailure &&
        params.agent.fallback_model &&
        isReplayableFailedTurn(agentSession.messages) &&
        isFallbackEligibleError(primaryFailure.source, primaryFailure.message)
      ) {
        const fallbackStartedAt = Date.now();
        if (isInvalidRequestError(primaryFailure.source, primaryFailure.message)) {
          logError("[agent] primary invalid request; trying fallback model", primaryFailure.message, {
            agentId: params.agent.id,
            primaryFailureCategory: "invalid_request",
          });
        }
        const logFallback = (outcome: "success" | "failure", fallbackFailure?: string) =>
          logWarn("[agent] fallback model attempt completed", {
            agentId: params.agent.id,
            primaryProvider: effectiveModel.provider,
            primaryModel: effectiveModel.model,
            primaryFailureCategory: getProviderErrorCategory(primaryFailure.source, primaryFailure.message),
            primaryFailure: primaryFailure.message,
            primaryDurationMs: fallbackStartedAt - primaryStartedAt,
            fallbackProvider: params.agent.fallback_model!.provider,
            fallbackModel: params.agent.fallback_model!.model,
            fallbackOutcome: outcome,
            fallbackFailure,
            fallbackDurationMs: Date.now() - fallbackStartedAt,
          });
        const fallback = modelRuntime.getModel(
          params.agent.fallback_model.provider,
          params.agent.fallback_model.model
        );
        if (!fallback) {
          logFallback("failure", "model not found");
          throw runFailureError(
            `Primary ${effectiveModel.provider}/${effectiveModel.model} failed: ${primaryFailure.message}; fallback ${params.agent.fallback_model.provider}/${params.agent.fallback_model.model} failed: model not found`
          );
        }
        try {
          await modelRuntime.getAuth(fallback);
          await agentSession.setModel(fallback);
          await resumeAfterFailedTurn(agentSession, () =>
            agentSession.prompt(messageWithAttachments, promptOptions)
          );
        } catch (error) {
          const fallbackMessage =
            error instanceof Error ? error.message : String(error);
          logFallback("failure", fallbackMessage);
          throw runFailureError(
            `Primary ${effectiveModel.provider}/${effectiveModel.model} failed: ${primaryFailure.message}; fallback ${params.agent.fallback_model.provider}/${params.agent.fallback_model.model} failed: ${fallbackMessage}`
          );
        }
        const fallbackFailure = findFailedTurn(agentSession.messages);
        if (fallbackFailure) {
          logFallback("failure", fallbackFailure.message);
          throw runFailureError(
            `Primary ${effectiveModel.provider}/${effectiveModel.model} failed: ${primaryFailure.message}; fallback ${params.agent.fallback_model.provider}/${params.agent.fallback_model.model} failed: ${fallbackFailure.message}`
          );
        }
        logFallback("success");
      } else if (primaryThrown) {
        throw primaryThrown;
      }
      } finally {
        unsubscribe();
        params.abortSignal.removeEventListener("abort", onAbort);
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
      // Pi 1.x reports cancellation during request setup as an error message.
      const cancelledDuringSetup =
        aborted &&
        lastAssistantRecord?.stopReason === "error" &&
        lastAssistantRecord.errorMessage === "This operation was aborted";
      if (lastAssistantRecord?.stopReason === "error" && !cancelledDuringSetup) {
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
        throw runFailureError(errorStr);
      }

      const finalText = lastAssistant
        ? extractAssistantText(lastAssistant)
        : "";

      agentSession.dispose();

      return { text: finalText, aborted };
    }).finally(async () => {
      clearMcpAppViews(params);
      try { await persistSession?.(); }
      finally { await managedSkills?.cleanup(); }
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
