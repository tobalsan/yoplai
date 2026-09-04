import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  InMemoryCredentialStore,
  type AssistantMessage,
  type ImageContent,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  ContainerDeliveryEnvelopeSchema,
  ContainerFileOutputRequestSchema,
  DEFAULT_RETRY_BASE_DELAY_SECONDS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  claimAgentToolName,
  findFailedTurn,
  getProviderErrorCategory,
  isReplayableFailedTurn,
  isRetryableProviderError,
  renderAgentContext,
  resumeAfterFailedTurn,
  runTurnWithProviderRetry,
  type AgentContext,
  type ContainerInput,
  type ContainerOutput,
  type ContainerRunnerProtocolEvent,
  type HistoryEvent,
} from "@yoplai/shared";
import { createRuntimeSessionFile } from "@yoplai/shared/node/sanitize-session";
import { callGatewayTool } from "./gateway-client.js";

const CONTAINER_SYSTEM_PROMPT = `You are an AI agent running inside an isolated Yoplai container. Use the mounted workspace as your working directory. Coding tools run inside this container. Orchestration tools call back to the gateway.

To share a file with the user, write it to /workspace/data/ then use the send_file tool. The file will appear as a downloadable card in the chat.
`;

const LARGE_TOOL_RESULT_THRESHOLD = 20_000;
const LARGE_TOOL_RESULT_PREVIEW_LENGTH = 2_000;

let activeSession: AgentSession | undefined;
let pendingFollowUps: string[] = [];

export type DeliveryOwner = Pick<
  ContainerInput,
  "agentId" | "sessionId" | "runId"
>;

export type DeliveryDecision =
  | { accepted: true; text: string; identified: boolean }
  | { accepted: false; reason: string };

/**
 * Decides whether a queued IPC file was addressed to this container. Envelopes
 * carrying a different agent/session/run belong to another live container and
 * must never be steered into this session.
 */
export function resolveIpcDelivery(
  message: unknown,
  owner?: DeliveryOwner
): DeliveryDecision {
  const envelope = ContainerDeliveryEnvelopeSchema.safeParse(message);
  if (envelope.success) {
    const { agentId, sessionId, runId, message: text } = envelope.data;
    if (owner) {
      if (agentId !== owner.agentId) {
        return { accepted: false, reason: "agent_mismatch" };
      }
      if (sessionId !== owner.sessionId) {
        return { accepted: false, reason: "session_mismatch" };
      }
      if (owner.runId && runId !== owner.runId) {
        return { accepted: false, reason: "run_mismatch" };
      }
    }
    return { accepted: true, text, identified: true };
  }

  const text = getIpcMessageText(message);
  if (!text) return { accepted: false, reason: "unreadable" };
  return { accepted: true, text, identified: false };
}

export async function sendFollowUpMessage(
  message: unknown,
  owner?: DeliveryOwner
): Promise<void> {
  const decision = resolveIpcDelivery(message, owner);
  if (!decision.accepted) {
    console.error(
      `[agent-runner] Suppressed IPC delivery (${decision.reason}) for agent ${owner?.agentId ?? "unknown"} session ${owner?.sessionId ?? "unknown"} run ${owner?.runId ?? "unknown"}`
    );
    return;
  }
  if (!decision.identified) {
    console.error(
      `[agent-runner] Delivering IPC message without identity (${decision.text.length} chars)`
    );
  }

  if (!activeSession) {
    pendingFollowUps.push(decision.text);
    return;
  }

  await activeSession.sendUserMessage(decision.text, { deliverAs: "steer" });
}

export function abortActiveAgent(): void {
  void activeSession?.abort();
}

export async function runAgent(
  input: ContainerInput,
  onStreamEvent?: (event: ContainerRunnerProtocolEvent) => void
): Promise<ContainerOutput> {
  if (input.sdkConfig.sdk !== "pi") {
    throw new Error(`Unsupported sandbox SDK: ${input.sdkConfig.sdk}`);
  }

  console.error(
    `[agent-runner] Running agent ${input.agentId} with SDK ${input.sdkConfig.sdk}`
  );

  activeSession = undefined;

  const provider = input.sdkConfig.model.provider;
  if (!provider) {
    throw new Error(
      `Pi SDK requires model.provider for agent: ${input.agentId}`
    );
  }

  const history: HistoryEvent[] = [];
  const context = input.context as AgentContext | undefined;
  const renderedContext = context ? renderAgentContext(context) : "";
  const attachmentContext = formatNonImageAttachmentContext(input);
  const messageWithAttachments = attachmentContext
    ? `${input.message}\n\n${attachmentContext}`
    : input.message;
  const promptText = renderedContext
    ? `${renderedContext}\n\n${messageWithAttachments}`
    : messageWithAttachments;
  if (renderedContext && context) {
    const systemContextEvent: HistoryEvent = {
      type: "system_context",
      context,
      rendered: renderedContext,
      timestamp: Date.now(),
    };
    history.push(systemContextEvent);
    onStreamEvent?.(systemContextEvent);
  }
  history.push({ type: "user", text: input.message, timestamp: Date.now() });
  let aborted = false;

  await fs.mkdir(input.sessionDir, { recursive: true });
  const persistentSessionFile = path.join(
    input.sessionDir,
    `${input.sessionId}.jsonl`
  );
  const runtimeSession = await createRuntimeSessionFile(persistentSessionFile);
  const sessionFile = runtimeSession.file;

  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: path.join(input.sessionDir, "models.json"),
    });
    await modelRuntime.setRuntimeApiKey(provider, "onecli-proxy-managed");
    const model = modelRuntime.getModel(provider, input.sdkConfig.model.model);
    if (!model) {
      throw new Error(
        `Model not found: ${provider}/${input.sdkConfig.model.model}`
      );
    }

    const contextFiles = await loadContextFiles(input);
    const settingsManager = SettingsManager.create(
      input.workspaceDir,
      input.sessionDir
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.workspaceDir,
      agentDir: input.sessionDir,
      settingsManager,
      additionalSkillPaths: [path.join(input.workspaceDir, "skills")],
      appendSystemPrompt: [
        CONTAINER_SYSTEM_PROMPT,
        ...(input.extensionSystemPrompts ?? []),
        renderedContext || undefined,
      ].filter((prompt): prompt is string => Boolean(prompt)),
      agentsFilesOverride: () => ({ agentsFiles: contextFiles }),
    });
    await resourceLoader.reload();

    const sessionManager = SessionManager.open(sessionFile, input.sessionDir);
    const builtInTools = ["read", "bash", "edit", "write"];
    const usedToolNames = new Set<string>();
    const customTools = [
      ...createExtensionTools(input, usedToolNames),
      createSendFileTool(onStreamEvent, usedToolNames),
    ];
    // Pi treats `tools` as an allowlist when provided, so custom tool names must be included.
    const tools = [...builtInTools, ...customTools.map((tool) => tool.name)];

    const { session } = await createAgentSession({
      cwd: input.workspaceDir,
      agentDir: input.sessionDir,
      modelRuntime,
      model,
      ...(input.thinkLevel && { thinkingLevel: input.thinkLevel }),
      tools,
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    activeSession = session;

    const systemPrompt = session.agent.state.systemPrompt;
    if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) {
      const systemPromptEvent: HistoryEvent = {
        type: "system_prompt",
        text: systemPrompt,
        timestamp: Date.now(),
      };
      history.push(systemPromptEvent);
      onStreamEvent?.(systemPromptEvent);
    }

    const unsubscribe = session.subscribe((evt) => {
      for (const event of collectHistoryEvent(evt, history)) {
        onStreamEvent?.(event);
      }
    });

    try {
      for (const message of pendingFollowUps.splice(0)) {
        await session.sendUserMessage(message, { deliverAs: "steer" });
      }

    const promptOptions =
        input.imageInputSupported === false
          ? undefined
          : await loadPromptOptions(input);
      const primaryStartedAt = Date.now();
      let primaryThrown: unknown;
      try {
        await runTurnWithProviderRetry({
          maxAttempts: input.retry?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
          baseDelaySeconds:
            input.retry?.baseDelaySeconds ?? DEFAULT_RETRY_BASE_DELAY_SECONDS,
          runTurn: (attempt) =>
            attempt === 1
              ? session.prompt(promptText, promptOptions)
              : resumeAfterFailedTurn(session, () =>
                  session.prompt(promptText, promptOptions)
                ),
          getMessages: () => session.messages,
          isAbort: isAbortLikeError,
          onRetry: (attempt, delaySeconds, message) =>
            onStreamEvent?.({ type: "retry", attempt, delaySeconds, message }),
          onAttempt: (attempt, durationMs, failure) =>
            console.error(
              JSON.stringify({
                event: "model_primary_attempt",
                provider,
                model: input.sdkConfig.model.model,
                attempt,
                durationMs,
                outcome: failure ? "failure" : "success",
                failureCategory: failure
                  ? getProviderErrorCategory(failure.source, failure.message)
                  : undefined,
                failure: failure?.message,
              })
            ),
          sleep: delay,
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
        : findFailedTurn(session.messages);
      const fallbackConfig = input.sdkConfig.fallbackModel;
      if (
        primaryFailure &&
        fallbackConfig &&
        isReplayableFailedTurn(session.messages) &&
        isRetryableProviderError(primaryFailure.source, primaryFailure.message)
      ) {
        const fallbackStartedAt = Date.now();
        const logFallback = (outcome: "success" | "failure", fallbackFailure?: string) =>
          console.error(
            JSON.stringify({
              event: "model_fallback",
              primaryProvider: provider,
              primaryModel: input.sdkConfig.model.model,
              primaryFailureCategory: getProviderErrorCategory(primaryFailure.source, primaryFailure.message),
              primaryFailure: primaryFailure.message,
              primaryDurationMs: fallbackStartedAt - primaryStartedAt,
              fallbackProvider: fallbackConfig.provider,
              fallbackModel: fallbackConfig.model,
              fallbackOutcome: outcome,
              fallbackFailure,
              fallbackDurationMs: Date.now() - fallbackStartedAt,
            })
          );
        const fallback = modelRuntime.getModel(
          fallbackConfig.provider,
          fallbackConfig.model
        );
        if (!fallback) {
          logFallback("failure", "model not found");
          throw new Error(
            `Primary ${provider}/${input.sdkConfig.model.model} failed: ${primaryFailure.message}; fallback ${fallbackConfig.provider}/${fallbackConfig.model} failed: model not found`
          );
        }
        try {
          await modelRuntime.setRuntimeApiKey(
            fallback.provider,
            "onecli-proxy-managed"
          );
          await session.setModel(fallback);
          await resumeAfterFailedTurn(session, () =>
            session.prompt(promptText, promptOptions)
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logFallback("failure", message);
          throw new Error(
            `Primary ${provider}/${input.sdkConfig.model.model} failed: ${primaryFailure.message}; fallback ${fallbackConfig.provider}/${fallbackConfig.model} failed: ${message}`
          );
        }
        const fallbackFailure = findFailedTurn(session.messages);
        if (fallbackFailure) {
          logFallback("failure", fallbackFailure.message);
          throw new Error(
            `Primary ${provider}/${input.sdkConfig.model.model} failed: ${primaryFailure.message}; fallback ${fallbackConfig.provider}/${fallbackConfig.model} failed: ${fallbackFailure.message}`
          );
        }
        logFallback("success");
      } else if (primaryThrown) {
        throw primaryThrown;
      }
    } catch (error) {
      if (isAbortLikeError(error)) {
        aborted = true;
      } else {
        session.dispose();
        await runtimeSession.persist();
        activeSession = undefined;
        pendingFollowUps = [];
        throw error;
      }
    } finally {
      unsubscribe();
    }

    const lastAssistant = findLastAssistant(session.messages);
    const lastAssistantRecord = lastAssistant as
      | (Record<string, unknown> & AssistantMessage)
      | undefined;
    if (lastAssistantRecord?.stopReason === "error") {
      const message =
        typeof lastAssistantRecord.errorMessage === "string" &&
        lastAssistantRecord.errorMessage
          ? lastAssistantRecord.errorMessage
          : "unknown error";
      session.dispose();
      await runtimeSession.persist();
      activeSession = undefined;
      pendingFollowUps = [];
      throw new Error(`Agent error: ${message}`);
    }

    const text = lastAssistant ? extractAssistantText(lastAssistant) : "";
    session.dispose();
    await runtimeSession.persist();
    activeSession = undefined;
    pendingFollowUps = [];

    return { text, aborted, history };
  } finally {
    await runtimeSession.persist();
  }
}

function formatNonImageAttachmentContext(input: ContainerInput): string {
  const attachments = input.attachments?.filter(
    (attachment) => !attachment.mimeType.startsWith("image/")
  );
  if (!attachments?.length) return "";

  const lines = attachments.map((attachment) => {
    const filename = attachment.filename ?? path.basename(attachment.path);
    const size =
      typeof attachment.size === "number" ? `, ${attachment.size} bytes` : "";
    return `- ${filename}: ${attachment.path} (${attachment.mimeType}${size})`;
  });

  return [
    "Attached files are available inside the container at these paths:",
    ...lines,
    "Use read/bash to inspect them if extracted text is not included above.",
  ].join("\n");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loadContextFiles(
  input: ContainerInput
): Promise<Array<{ path: string; content: string }>> {
  return input.systemFiles ?? [];
}

function createExtensionTools(
  input: ContainerInput,
  usedToolNames: Set<string>
): ToolDefinition[] {
  return (input.extensionTools ?? []).map((tool) =>
    gatewayTool(
      input,
      tool.name,
      tool.description,
      tool.description,
      tool.parameters,
      usedToolNames
    )
  );
}

function createSendFileTool(
  onStreamEvent: ((event: ContainerRunnerProtocolEvent) => void) | undefined,
  usedToolNames: Set<string>
): ToolDefinition {
  return {
    name: claimAgentToolName("send_file", usedToolNames),
    label: "Send file to user",
    description:
      "Send a file from /workspace/data/ to the user. The file appears as a downloadable card in chat. Write the file first, then call this tool with its path.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to the file, e.g. /workspace/data/report.csv",
        },
      },
      required: ["path"],
    } as unknown as ToolDefinition["parameters"],
    execute: async (_toolCallId, params) => {
      const filePath = (params as { path: string }).path;
      if (!filePath.startsWith("/workspace/data/")) {
        return {
          content: [
            {
              type: "text",
              text: "Error: path must be inside /workspace/data/",
            },
          ],
          details: undefined,
        };
      }
      onStreamEvent?.(
        ContainerFileOutputRequestSchema.parse({
          type: "file_output",
          path: filePath,
        })
      );
      return {
        content: [{ type: "text", text: `File sent to user: ${filePath}` }],
        details: undefined,
      };
    },
  };
}

function gatewayTool(
  input: ContainerInput,
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  usedToolNames: Set<string>
): ToolDefinition {
  return {
    name: claimAgentToolName(name, usedToolNames),
    label,
    description,
    promptSnippet: description,
    parameters: parameters as ToolDefinition["parameters"],
    execute: async (toolCallId, params) => {
      const result = await callGatewayTool(
        input.gatewayUrl,
        input.agentToken,
        name,
        params,
        input.agentId,
        input.sessionId,
        input.runId
      );
      const text = await formatGatewayToolResult(
        input,
        toolCallId,
        name,
        result
      );
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  };
}

async function loadPromptOptions(
  input: ContainerInput
): Promise<{ images?: ImageContent[] } | undefined> {
  const imageAttachments = input.attachments?.filter((attachment) =>
    attachment.mimeType.startsWith("image/")
  );
  if (!imageAttachments?.length) return undefined;

  const images = await Promise.all(
    imageAttachments.map(async (attachment) => {
      const buffer = await fs.readFile(attachment.path);
      return {
        type: "image" as const,
        data: buffer.toString("base64"),
        mimeType: attachment.mimeType,
      };
    })
  );
  return { images };
}

function collectHistoryEvent(
  evt: unknown,
  history: HistoryEvent[]
): HistoryEvent[] {
  const event = evt as Record<string, unknown>;
  const collected: HistoryEvent[] = [];

  if (event.type === "message_update") {
    const msg = event.message as AgentMessage | undefined;
    if (msg?.role !== "assistant") return collected;

    const assistantEvent = event.assistantMessageEvent as
      | Record<string, unknown>
      | undefined;
    if (assistantEvent?.type === "text_delta") {
      const text = assistantEvent.delta;
      if (typeof text === "string" && text) {
        collected.push({ type: "assistant_text", text, timestamp: Date.now() });
      }
    }
    if (assistantEvent?.type === "thinking_delta") {
      const text = assistantEvent.delta;
      if (typeof text === "string" && text) {
        collected.push({
          type: "assistant_thinking",
          text,
          timestamp: Date.now(),
        });
      }
    }
  }

  if (event.type === "tool_execution_start") {
    collected.push({
      type: "tool_call",
      id: typeof event.toolCallId === "string" ? event.toolCallId : "",
      name: typeof event.toolName === "string" ? event.toolName : "unknown",
      args: event.args,
      timestamp: Date.now(),
    });
  }

  if (event.type === "tool_execution_end") {
    collected.push({
      type: "tool_result",
      id: typeof event.toolCallId === "string" ? event.toolCallId : "",
      name: typeof event.toolName === "string" ? event.toolName : "unknown",
      content: extractToolResultText(event.result),
      isError: event.isError === true,
      timestamp: Date.now(),
    });
  }

  if (event.type === "message_end") {
    const msg = event.message as AgentMessage | undefined;
    if (msg?.role !== "assistant") return collected;
    const assistant = msg as unknown as Record<string, unknown>;
    if (assistant.stopReason === "error") return collected;
    collected.push({
      type: "meta",
      provider:
        typeof assistant.provider === "string" ? assistant.provider : undefined,
      model: typeof assistant.model === "string" ? assistant.model : undefined,
      api: typeof assistant.api === "string" ? assistant.api : undefined,
      usage: normalizeUsage(assistant.usage),
      stopReason:
        typeof assistant.stopReason === "string"
          ? assistant.stopReason
          : undefined,
      timestamp: Date.now(),
    });
    collected.push({ type: "turn_end", timestamp: Date.now() });
  }

  history.push(...collected);
  return collected;
}

function findLastAssistant(
  messages: AgentMessage[]
): AssistantMessage | undefined {
  return messages
    .slice()
    .reverse()
    .find(
      (message): message is AssistantMessage => message.role === "assistant"
    );
}

function extractAssistantText(message: AssistantMessage): string {
  if (!message.content) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(
        (item): item is { type: "text"; text: string } => item.type === "text"
      )
      .map((item) => item.text)
      .join("\n");
  }
  return "";
}

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (item): item is { type: "text"; text: string } =>
            item?.type === "text" && typeof item.text === "string"
        )
        .map((item) => item.text)
        .join("\n");
    }
  }
  return stringifyToolResult(result);
}

function stringifyToolResult(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result ?? null);
}

function normalizeUsage(
  usage: unknown
): HistoryEvent extends { type: "meta"; usage?: infer U } ? U : undefined {
  if (!usage || typeof usage !== "object") return undefined as never;
  const record = usage as Record<string, unknown>;
  const input = readNumber(record.input) ?? readNumber(record.inputTokens);
  const output = readNumber(record.output) ?? readNumber(record.outputTokens);
  if (input === undefined || output === undefined) return undefined as never;
  return {
    input,
    output,
    cacheRead: readNumber(record.cacheRead),
    cacheWrite: readNumber(record.cacheWrite),
    totalTokens: readNumber(record.totalTokens) ?? input + output,
  } as never;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

async function formatGatewayToolResult(
  input: ContainerInput,
  toolCallId: string,
  toolName: string,
  result: unknown
): Promise<string> {
  const text = stringifyToolResult(result);
  if (text.length <= LARGE_TOOL_RESULT_THRESHOLD) return text;

  const safeId = `${toolName}-${toolCallId}`.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  const outputDir = path.join(input.workspaceDir, "data", "tool-results");
  const outputPath = path.join(outputDir, `${safeId}.json`);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, text, "utf8");

  return [
    `Large tool result saved to ${outputPath}.`,
    `Use that file path directly instead of pasting this JSON into shell commands.`,
    "",
    "Preview:",
    text.slice(0, LARGE_TOOL_RESULT_PREVIEW_LENGTH),
  ].join("\n");
}

function getIpcMessageText(message: unknown): string | undefined {
  if (typeof message === "string") return message;
  if (message && typeof message === "object" && "message" in message) {
    const text = (message as { message?: unknown }).message;
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
