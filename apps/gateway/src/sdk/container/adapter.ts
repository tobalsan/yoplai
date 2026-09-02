import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentConfig,
  ContainerDeliveryContext,
  ContainerDeliveryEnvelope,
  ContainerInput,
  ContainerOutput,
} from "@yoplai/shared";
import {
  ContainerRunnerProtocolEventSchema,
  HistoryEventSchema,
  renderAgentContext,
} from "@yoplai/shared";
import { loadConfig } from "../../config/index.js";
import { logInfo } from "../../logging.js";
import { RunSettledError } from "../run-settled.js";
import {
  FIRST_RUN_BOOTSTRAP_PROMPT,
  ensureWorkspaceFiles,
} from "../../agents/workspace.js";
import { getDefaultSdkId, getSdkAdapter } from "../registry.js";
import { registerContainerToken, removeContainerToken } from "./tokens.js";
import {
  appendAttachmentContext,
  buildDocumentAttachmentContext,
  isImageAttachment,
  readInboundAttachment,
} from "../attachments.js";
import type {
  HistoryEvent,
  SdkAdapter,
  SdkId,
  SdkRunParams,
  SdkRunResult,
} from "../types.js";
import {
  buildContainerLaunchSpec,
  cleanupLaunchFilesystem,
  remapAttachmentsToContainer,
  prepareLaunchFilesystem,
} from "./launch-spec.js";
import { ContainerInputBuilder } from "./input-builder.js";
import { configuredModelSupportsImages, describeImage } from "../../media/describe.js";
import { formatImageDescriptionBlocks } from "@yoplai/shared";
import { ContainerFileOutputAdapter } from "./file-output.js";
import { ContainerProtocolDecoder, getMeaningfulStderr } from "./protocol.js";

const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_RUNTIME_SECONDS = 1800;
const STOP_GRACE_MS = 10_000;

type ContainerSessionHandle = {
  containerName: string;
  ipcDir: string;
  agentId: string;
  sessionId: string;
  runId: string;
  /** True once the run's IPC namespace has been removed. */
  isSettled?: () => boolean;
  recordQueuedMessageActivity?: () => void;
};

function hasReadableDocumentAttachment(params: SdkRunParams): boolean {
  return (
    params.attachments?.some(
      (attachment) =>
        !attachment.mimeType.startsWith("image/") &&
        fs.existsSync(attachment.path)
    ) ?? false
  );
}

const HANDLE_IDENTITY_KEYS = [
  "containerName",
  "ipcDir",
  "agentId",
  "sessionId",
  "runId",
] as const;

function isContainerHandle(handle: unknown): handle is ContainerSessionHandle {
  if (typeof handle !== "object" || handle === null) return false;
  const record = handle as Record<string, unknown>;
  return HANDLE_IDENTITY_KEYS.every((key) => typeof record[key] === "string");
}

function assertContainerHandle(handle: unknown): ContainerSessionHandle {
  if (!isContainerHandle(handle)) {
    throw new Error("Invalid container session handle");
  }
  return handle;
}

function writeCloseSentinel(ipcDir: string): void {
  const inputDir = path.join(ipcDir, "input");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, "_close"), "");
}

function execDocker(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    childProcess.execFile("docker", args, { timeout: timeoutMs }, () => {
      resolve();
    });
  });
}

function stopThenKill(containerName: string): void {
  let stopped = false;
  void execDocker(["stop", containerName], STOP_GRACE_MS).finally(() => {
    stopped = true;
  });
  const killTimer = setTimeout(() => {
    if (!stopped) {
      void execDocker(["kill", containerName], 5_000);
    }
  }, STOP_GRACE_MS);
  killTimer.unref?.();
}

const isHistoryEvent = (event: unknown): event is HistoryEvent =>
  HistoryEventSchema.safeParse(event).success;

function forwardStreamEvent(
  params: SdkRunParams,
  event: HistoryEvent,
  invisibleToolNames: Set<string>
): void {
  if (event.type === "assistant_text") {
    params.onEvent({ type: "text", data: event.text });
    return;
  }
  if (event.type === "assistant_thinking") {
    params.onEvent({ type: "thinking", data: event.text });
    return;
  }
  if (event.type === "assistant_file") {
    params.onEvent({
      type: "file_output",
      fileId: event.fileId,
      filename: event.filename,
      mimeType: event.mimeType,
      size: event.size,
    });
    return;
  }
  if (event.type === "tool_call") {
    if (invisibleToolNames.has(event.name)) return;
    params.onEvent({ type: "tool_start", toolName: event.name });
    params.onEvent({
      type: "tool_call",
      id: event.id,
      name: event.name,
      arguments: event.args,
    });
    return;
  }
  if (event.type === "tool_result") {
    if (invisibleToolNames.has(event.name)) return;
    params.onEvent({
      type: "tool_end",
      toolName: event.name,
      isError: event.isError,
    });
    params.onEvent({
      type: "tool_result",
      id: event.id,
      name: event.name,
      content: event.content,
      isError: event.isError,
      details: event.details,
    });
    return;
  }
}

function emitHistory(
  params: SdkRunParams,
  output: ContainerOutput,
  invisibleToolNames: Set<string>
): void {
  if (output.history?.length) {
    for (const event of output.history) {
      if (
        isHistoryEvent(event) &&
        event.type !== "user" &&
        event.type !== "system_context" &&
        !(event.type === "tool_call" && invisibleToolNames.has(event.name)) &&
        !(event.type === "tool_result" && invisibleToolNames.has(event.name))
      ) {
        params.onHistoryEvent(event);
      }
    }
    return;
  }

  if (output.text) {
    params.onHistoryEvent({
      type: "assistant_text",
      text: output.text,
      timestamp: Date.now(),
    });
  }
  params.onHistoryEvent({ type: "turn_end", timestamp: Date.now() });
}

async function attachExtraNetwork(
  containerName: string,
  network: string,
  child: childProcess.ChildProcess,
  getStderr: () => string
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await execFile("docker", ["network", "connect", network, containerName]);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists|endpoint with name/.test(msg)) return;
      if (/No such container/.test(msg)) {
        if (child.exitCode !== null) {
          const meaningfulStderr = getMeaningfulStderr(getStderr());
          throw new Error(
            meaningfulStderr ||
              `Container ${containerName} exited before it could be connected to network ${network}`
          );
        }
        // container not yet running; brief retry
        await delay(100);
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `Failed to connect container ${containerName} to network ${network}`
  );
}

function execFile(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { timeout: 10_000 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getContainerAdapter(): SdkAdapter {
  return {
    id: "container" as SdkId,
    displayName: "Container",
    capabilities: {
      queueWhileStreaming: true,
      interrupt: true,
      toolEvents: true,
      fullHistory: true,
    },
    resolveDisplayModel(agent: AgentConfig) {
      const sdkId = (agent.sdk ?? getDefaultSdkId()) as SdkId;
      return getSdkAdapter(sdkId).resolveDisplayModel(agent);
    },
    async run(params: SdkRunParams) {
      const config = loadConfig();
      const launchSpec = buildContainerLaunchSpec(params, config);
      const { args, containerName, ipcDir, runId, hostDataDir } = launchSpec;
      prepareLaunchFilesystem(params, launchSpec);
      logInfo("[container] ipc namespace claimed", {
        agentId: params.agentId,
        sessionId: params.sessionId,
        runId,
        containerName,
      });
      // Everything between claiming the namespace and handing ownership to the
      // run Promise must release it on failure: the Promise's cleanup() never
      // runs for these paths, so without this the namespace would leak.
      let stderr = "";
      let agentToken: string | undefined;
      let child: childProcess.ChildProcess;
      let input: ContainerInput;
      let invisibleToolNames = new Set<string>();
      try {
        const isFirstRun = await ensureWorkspaceFiles(params.workspaceDir);

        agentToken = randomUUID();
        registerContainerToken(agentToken, {
          agentId: params.agentId,
          sessionId: params.sessionId,
          runId,
          containerName,
          roots: {
            workspace: params.workspaceDir,
            data: hostDataDir,
            uploads: launchSpec.hostUploadsDir,
          },
          userId: params.userId,
          emitProgress: (event) => params.onEvent({ type: "progress", ...event }),
        });
        const attachmentContext = hasReadableDocumentAttachment(params)
          ? await buildDocumentAttachmentContext(params.attachments)
          : "";
        const provider = params.model?.provider ?? params.agent.model.provider;
        const model = params.model?.model ?? params.agent.model.model;
        const needsDescriptions = config.imageDescription?.enabled === true && (!provider || !(await configuredModelSupportsImages(config, provider, model)));
        const imageAttachments = needsDescriptions
          ? (params.attachments ?? []).filter(isImageAttachment)
          : [];
        const remappedImages = (remapAttachmentsToContainer(params.attachments) ?? [])
          .filter(isImageAttachment);
        const imageDescriptionContext = imageAttachments.length
          ? formatImageDescriptionBlocks(await Promise.all(imageAttachments.map(async (attachment, index) => {
              try {
                return { path: remappedImages[index].path, description: await describeImage(await readInboundAttachment(attachment), attachment.mimeType, config) };
              } catch {
                return { path: remappedImages[index].path, description: "Description failed; the image could not be read." };
              }
            })))
          : "";
        input = await new ContainerInputBuilder().build(
          {
            ...params,
            message: appendAttachmentContext(params.message, [attachmentContext, imageDescriptionContext].filter(Boolean).join("\n\n")),
          },
          config,
          agentToken,
          isFirstRun ? FIRST_RUN_BOOTSTRAP_PROMPT : undefined,
          runId
        );
        invisibleToolNames = new Set(
          input.extensionTools
            ?.filter((tool) => tool.extensionId === "taskLifecycle")
            .map((tool) => tool.name)
        );
        child = childProcess.spawn("docker", args, {
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          const text = chunk.toString();
          stderr += text;
          logInfo("[container] stderr", {
            agentId: params.agentId,
            message: text.trimEnd(),
          });
        });
        const extraNetwork = config.onecli?.sandbox?.network;
        if (extraNetwork) {
          await attachExtraNetwork(
            containerName,
            extraNetwork,
            child,
            () => stderr
          );
        }
      } catch (error) {
        if (agentToken) removeContainerToken(agentToken);
        cleanupLaunchFilesystem(launchSpec);
        throw error;
      }
      const runAgentToken = agentToken;
      let timeoutKind: "idle" | "max" | undefined;
      let aborted = false;
      let settled = false;
      const protocol = new ContainerProtocolDecoder();
      const fileOutputAdapter = new ContainerFileOutputAdapter();
      let sawStreamingHistory = false;
      const pendingFileOutputs: Promise<void>[] = [];
      const idleTimeoutSeconds =
        params.agent.sandbox?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
      const maxRunTimeSeconds =
        params.agent.sandbox?.maxRunTime ??
        params.agent.sandbox?.timeout ??
        DEFAULT_MAX_RUNTIME_SECONDS;
      let lastActivityAt = Date.now();
      let lastActivityType = "container_start";
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let maxRunTimeTimer: ReturnType<typeof setTimeout> | undefined;
      const renderedContext = params.context
        ? renderAgentContext(params.context)
        : "";
      let handleSettled = false;

      return new Promise<SdkRunResult>((resolve, reject) => {
        const cleanup = () => {
          if (idleTimer) clearTimeout(idleTimer);
          if (maxRunTimeTimer) clearTimeout(maxRunTimeTimer);
          params.abortSignal.removeEventListener("abort", onAbort);
          removeContainerToken(runAgentToken);
          // The namespace is gone from here on, so the handle must stop
          // accepting deliveries: a write after this point would recreate the
          // directory with nothing left alive to poll it.
          handleSettled = true;
          cleanupLaunchFilesystem(launchSpec);
        };

        const describeLastActivity = (): string => {
          const ageSeconds = Math.max(
            0,
            Math.round((Date.now() - lastActivityAt) / 1000)
          );
          return `last activity was ${lastActivityType} ${ageSeconds}s ago`;
        };

        const stopForTimeout = (kind: "idle" | "max"): void => {
          if (timeoutKind || settled) return;
          timeoutKind = kind;
          stopThenKill(containerName);
        };

        const resetIdleTimer = (): void => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            stopForTimeout("idle");
          }, idleTimeoutSeconds * 1000);
          idleTimer.unref?.();
        };

        const recordActivity = (type: string): void => {
          if (settled || timeoutKind) return;
          lastActivityAt = Date.now();
          lastActivityType = type;
          resetIdleTimer();
        };

        const handle: ContainerSessionHandle = {
          containerName,
          ipcDir,
          agentId: params.agentId,
          sessionId: params.sessionId,
          runId,
          isSettled: () => handleSettled,
          recordQueuedMessageActivity: () =>
            recordActivity("queued_user_message"),
        };
        params.onSessionHandle?.(handle);

        if (renderedContext && params.context) {
          params.onHistoryEvent({
            type: "system_context",
            context: params.context,
            rendered: renderedContext,
            timestamp: Date.now(),
          });
        }

        // Emit user event immediately so active-turn state is populated before
        // the container starts streaming assistant events.
        params.onHistoryEvent({
          type: "user",
          text: params.message,
          attachments: params.attachments,
          timestamp: Date.now(),
        });

        const handleProtocolEvent = (rawEvent: string): void => {
          if (!rawEvent) return;

          try {
            const event = ContainerRunnerProtocolEventSchema.parse(
              JSON.parse(rawEvent)
            );
            if (event.type !== "file_output") {
              recordActivity(`history_${event.type}`);
              sawStreamingHistory = true;
              const isInvisibleToolEvent =
                (event.type === "tool_call" || event.type === "tool_result") &&
                invisibleToolNames.has(event.name);
              if (event.type !== "system_context" && !isInvisibleToolEvent) {
                params.onHistoryEvent(event);
              }
              forwardStreamEvent(params, event, invisibleToolNames);
              return;
            }
            recordActivity("file_output");
            const task = fileOutputAdapter
              .handle(params, event, hostDataDir)
              .catch((error) => {
                const message =
                  error instanceof Error ? error.message : String(error);
                params.onEvent({ type: "error", message });
              });
            pendingFileOutputs.push(task);
          } catch {
            // ignore malformed stream event lines
          }
        };

        const finish = async (code: number | null) => {
          if (settled) return;
          settled = true;
          cleanup();

          for (const frame of protocol.flush()) {
            handleProtocolEvent(frame.payload);
          }

          await Promise.all(pendingFileOutputs);

          let output: ContainerOutput | undefined;
          try {
            output = protocol.parseOutput();
          } catch (error) {
            reject(error);
            return;
          }

          if (!output) {
            if (aborted) {
              resolve({ text: "", aborted: true });
              return;
            }
            const meaningfulStderr = getMeaningfulStderr(stderr);
            const message = timeoutKind
              ? timeoutKind === "idle"
                ? `Container idle timed out after ${idleTimeoutSeconds}s without activity; ${describeLastActivity()}`
                : `Container exceeded max runtime after ${maxRunTimeSeconds}s; ${describeLastActivity()}`
              : meaningfulStderr ||
                `Container exited without protocol output (code ${code ?? "unknown"})`;
            params.onEvent({ type: "error", message });
            reject(new Error(message));
            return;
          }

          if (output.error) {
            params.onEvent({ type: "error", message: output.error });
            reject(new Error(output.error));
            return;
          }

          if (!sawStreamingHistory) {
            emitHistory(params, output, invisibleToolNames);
            if (output.text) {
              params.onEvent({ type: "text", data: output.text });
            }
          }
          resolve({ text: output.text, aborted: output.aborted });
        };

        const onAbort = () => {
          aborted = true;
          writeCloseSentinel(ipcDir);
          stopThenKill(containerName);
        };

        resetIdleTimer();
        maxRunTimeTimer = setTimeout(() => {
          stopForTimeout("max");
        }, maxRunTimeSeconds * 1000);
        maxRunTimeTimer.unref?.();

        child.stdout?.on("data", (chunk: Buffer | string) => {
          for (const frame of protocol.write(chunk)) {
            handleProtocolEvent(frame.payload);
          }
        });
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
        child.once("close", finish);
        child.once("exit", finish);

        if (params.abortSignal.aborted) {
          onAbort();
        } else {
          params.abortSignal.addEventListener("abort", onAbort, { once: true });
        }

        child.stdin?.end(`${JSON.stringify(input)}\n`);
      });
    },
    async queueMessage(
      handle: unknown,
      message: string,
      context?: ContainerDeliveryContext
    ) {
      const {
        ipcDir,
        agentId,
        sessionId,
        runId,
        isSettled,
        recordQueuedMessageActivity,
      } = assertContainerHandle(handle);
      if (isSettled?.()) {
        throw new RunSettledError(
          `Run ${runId} for agent ${agentId} session ${sessionId} already settled`
        );
      }
      const inputDir = path.join(ipcDir, "input");
      const timestamp = Date.now();
      const envelope: ContainerDeliveryEnvelope = {
        message,
        timestamp,
        agentId,
        sessionId,
        runId,
        ...(context?.source ? { source: context.source } : {}),
        ...(context?.slack ? { slack: context.slack } : {}),
      };
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(
        path.join(inputDir, `${timestamp}-${randomUUID()}.json`),
        JSON.stringify(envelope)
      );
      logInfo("[container] follow-up queued", {
        agentId,
        sessionId,
        runId,
        source: context?.source,
        messageLength: message.length,
      });
      recordQueuedMessageActivity?.();
    },
    abort(handle: unknown) {
      const { containerName, ipcDir, agentId, sessionId, runId, isSettled } =
        assertContainerHandle(handle);
      // Nothing left to interrupt, and the sentinel would resurrect the
      // already-removed namespace.
      if (isSettled?.()) return;
      writeCloseSentinel(ipcDir);
      logInfo("[container] abort sentinel written", {
        agentId,
        sessionId,
        runId,
        containerName,
      });
      stopThenKill(containerName);
    },
  };
}
