import WebSocket from "ws";
import type { AgentConfig } from "@yoplai/shared";
import { renderAgentContext } from "@yoplai/shared";
import type { SdkAdapter, SdkRunParams, SdkRunResult } from "../types.js";
import { randomUUID } from "node:crypto";
import {
  appendAttachmentContext,
  buildDocumentAttachmentContext,
  normalizeInboundAttachments,
} from "../attachments.js";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const PROTOCOL_VERSION = 3;
const CLIENT_ID = "gateway-client";
const CLIENT_MODE = "backend";

type OpenClawConfig = AgentConfig["openclaw"];

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getPayload(
  msg: Record<string, unknown>
): Record<string, unknown> | undefined {
  const payload = msg.payload;
  if (payload && typeof payload === "object") {
    return payload as Record<string, unknown>;
  }
  return undefined;
}

function extractMessageText(payload: Record<string, unknown>): string {
  // Handle string message (legacy format)
  if (typeof payload.message === "string") {
    return payload.message;
  }
  // Handle object message format: { role, content: [{ type: "text", text: "..." }] }
  const message = payload.message as Record<string, unknown> | undefined;
  if (!message) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      return block.text;
    }
  }
  return "";
}

function getRunId(data?: Record<string, unknown>): string | undefined {
  if (!data) return undefined;
  if (typeof data.runId === "string") return data.runId;
  if (typeof data.run_id === "string") return data.run_id;
  return undefined;
}

function isProjectSessionKey(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("project:");
}

export const openclawAdapter: SdkAdapter = {
  id: "openclaw",
  displayName: "OpenClaw",
  capabilities: {
    queueWhileStreaming: false,
    interrupt: false,
    toolEvents: true,
    fullHistory: true,
  },

  resolveDisplayModel(agent: AgentConfig) {
    return {
      provider: agent.model.provider ?? "openclaw",
      model: agent.model.model,
    };
  },

  async run(params: SdkRunParams): Promise<SdkRunResult> {
    const openclaw = params.agent.openclaw as OpenClawConfig | undefined;
    if (!openclaw?.token) {
      throw new Error(`OpenClaw config missing for agent: ${params.agentId}`);
    }

    const debugEnabled =
      process.env.OPENCLAW_DEBUG === "1" ||
      process.env.OPENCLAW_DEBUG === "true";
    const gatewayUrl = openclaw.gatewayUrl ?? DEFAULT_GATEWAY_URL;
    let sessionKey: string;
    if (isProjectSessionKey(params.sessionKey)) {
      sessionKey = params.sessionKey!;
    } else if (openclaw.sessionKey) {
      sessionKey = openclaw.sessionKey;
    } else if (openclaw.sessionMode === "fixed") {
      sessionKey = params.sessionKey ?? "main";
    } else {
      sessionKey = `yoplai:${params.sessionId}`;
    }

    let assistantText = "";
    let aborted = false;
    let sawFinal = false;
    let seenDelta = false;
    let activeRunId: string | undefined;
    let turnEnded = false;
    let settled = false;
    let toolSeq = 0;
    const toolQueues = new Map<string, string[]>();
    let sendRequestId: string | undefined;
    let connectRequestId: string | undefined;
    let connectSent = false;
    let chatSent = false;

    const emitAssistantText = (text: string) => {
      if (!text) return;
      assistantText += text;
      params.onEvent({ type: "text", data: text });
      params.onHistoryEvent({
        type: "assistant_text",
        text,
        timestamp: Date.now(),
      });
    };

    const pushToolId = (name: string) => {
      const id = `tool_${++toolSeq}`;
      const queue = toolQueues.get(name) ?? [];
      queue.push(id);
      toolQueues.set(name, queue);
      return id;
    };

    const shiftToolId = (name: string) => {
      const queue = toolQueues.get(name);
      if (!queue || queue.length === 0) return `tool_${++toolSeq}`;
      const id = queue.shift() ?? `tool_${++toolSeq}`;
      if (queue.length === 0) {
        toolQueues.delete(name);
      } else {
        toolQueues.set(name, queue);
      }
      return id;
    };

    const endTurn = () => {
      if (turnEnded) return;
      params.onHistoryEvent({ type: "turn_end", timestamp: Date.now() });
      turnEnded = true;
    };

    const renderedContext = params.context
      ? renderAgentContext(params.context)
      : "";
    if (renderedContext && params.context) {
      params.onHistoryEvent({
        type: "system_context",
        context: params.context,
        rendered: renderedContext,
        timestamp: Date.now(),
      });
    }

    const attachmentContext = await buildDocumentAttachmentContext(
      params.attachments
    );
    const textContent = appendAttachmentContext(
      params.message,
      attachmentContext
    );

    // Append file paths to message - OpenClaw detects and loads them automatically
    let messageToSend = textContent;
    const attachments = await normalizeInboundAttachments(params.attachments);
    if (attachments && attachments.length > 0) {
      const filePaths = attachments.map((a) => a.path);
      messageToSend = `${textContent}\n\n${filePaths.join("\n")}`;
    }

    params.onHistoryEvent({
      type: "user",
      text: params.message,
      attachments: params.attachments,
      timestamp: Date.now(),
    });

    return new Promise<SdkRunResult>((resolve, reject) => {
      const ws = new WebSocket(gatewayUrl);
      const clientVersion = process.env.npm_package_version ?? "dev";

      const sendConnect = () => {
        if (connectSent) return;
        connectSent = true;
        const requestId = randomUUID();
        connectRequestId = requestId;
        ws.send(
          JSON.stringify({
            type: "req",
            id: requestId,
            method: "connect",
            params: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: {
                id: CLIENT_ID,
                displayName: "yoplai-openclaw",
                version: clientVersion,
                platform: process.platform,
                mode: CLIENT_MODE,
              },
              role: "operator",
              scopes: ["operator.read", "operator.write"],
              auth: { token: openclaw.token },
              userAgent: `yoplai-openclaw/${clientVersion}`,
            },
          })
        );
      };

      const sendChat = () => {
        if (chatSent) return;
        chatSent = true;
        ws.send(
          JSON.stringify({
            type: "req",
            id: randomUUID(),
            method: "chat.history",
            params: { sessionKey, limit: 200 },
          })
        );
        const reqId = randomUUID();
        sendRequestId = reqId;
        if (debugEnabled) {
          console.debug("[openclaw] chat.send", {
            sessionKey,
            messageLength: messageToSend.length,
          });
        }
        ws.send(
          JSON.stringify({
            type: "req",
            id: reqId,
            method: "chat.send",
            params: {
              sessionKey,
              message: messageToSend,
              ...(renderedContext ? { extraSystemPrompt: renderedContext } : {}),
              deliver: true,
              idempotencyKey: randomUUID(),
            },
          })
        );
      };

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
        } else {
          resolve({ text: assistantText, aborted });
        }
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close();
        }
      };

      const fail = (message: string, err?: Error) => {
        if (!aborted) {
          params.onEvent({ type: "error", message });
        }
        finish(err ?? new Error(message));
      };

      params.abortSignal.addEventListener("abort", () => {
        aborted = true;
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close();
        }
      });

      ws.on("open", () => {
        if (debugEnabled) {
          console.debug("[openclaw] ws open", { gatewayUrl });
        }
        sendConnect();
      });

      ws.on("message", (data) => {
        let msg: Record<string, unknown>;
        let raw = "";
        try {
          raw = typeof data === "string" ? data : data.toString();
          if (debugEnabled) {
            console.debug("[openclaw] recv", raw);
          }
          msg = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
          fail(
            "OpenClaw sent invalid JSON",
            err instanceof Error ? err : undefined
          );
          return;
        }

        const frameType = asString(msg.type);
        if (frameType === "event") {
          const eventType = asString(msg.event);
          const payload = getPayload(msg) ?? {};
          const runId = getRunId(payload);
          if (!activeRunId && runId) activeRunId = runId;

          if (eventType === "connect.challenge") {
            if (!connectSent) {
              sendConnect();
            }
            return;
          }

          if (eventType === "chat") {
            const state = asString(payload.state);
            const message = extractMessageText(payload);
            const eventRunId = getRunId(payload);
            if (activeRunId && eventRunId && eventRunId !== activeRunId) {
              if (debugEnabled) {
                console.debug("[openclaw] skip event runId mismatch", {
                  activeRunId,
                  eventRunId,
                  state,
                });
              }
              return;
            }

            if (state === "delta") {
              seenDelta = true;
              // message is cumulative - only emit the new portion
              if (
                message.length > assistantText.length &&
                message.startsWith(assistantText)
              ) {
                emitAssistantText(message.slice(assistantText.length));
              } else if (!assistantText) {
                emitAssistantText(message);
              }
              return;
            }

            if (state === "final") {
              sawFinal = true;
              if (message) {
                if (!seenDelta) {
                  emitAssistantText(message);
                } else if (message.startsWith(assistantText)) {
                  emitAssistantText(message.slice(assistantText.length));
                } else if (message !== assistantText) {
                  emitAssistantText(message);
                }
              }
              endTurn();
              finish();
              return;
            }

            if (state === "aborted") {
              aborted = true;
              endTurn();
              finish();
              return;
            }

            if (state === "error") {
              const errMessage =
                asString(payload.errorMessage) || message || "OpenClaw error";
              endTurn();
              fail(errMessage);
            }
            return;
          }

          if (eventType === "agent") {
            const stream = asString(payload.stream);
            if (stream !== "tool") return;
            const dataObj = payload.data as Record<string, unknown> | undefined;
            const phase = asString(dataObj?.phase);
            const name = asString(dataObj?.name) ?? "unknown";
            const args = dataObj?.args;
            const result = dataObj?.result;

            if (phase === "start") {
              const toolId = pushToolId(name);
              params.onEvent({ type: "tool_start", toolName: name });
              params.onEvent({
                type: "tool_call",
                id: toolId,
                name,
                arguments: args,
              });
              params.onHistoryEvent({
                type: "tool_call",
                id: toolId,
                name,
                args,
                timestamp: Date.now(),
              });
              return;
            }

            if (phase === "result") {
              const toolId = shiftToolId(name);
              const content =
                typeof result === "string"
                  ? result
                  : result === undefined
                    ? ""
                    : JSON.stringify(result);
              params.onEvent({
                type: "tool_end",
                toolName: name,
                isError: false,
              });
              params.onEvent({
                type: "tool_result",
                id: toolId,
                name,
                content,
                isError: false,
              });
              params.onHistoryEvent({
                type: "tool_result",
                id: toolId,
                name,
                content,
                isError: false,
                timestamp: Date.now(),
              });
            }
          }
          return;
        }

        if (frameType === "res") {
          const id = asString(msg.id);
          if (id && connectRequestId && id === connectRequestId) {
            const ok = msg.ok === true;
            if (debugEnabled) {
              console.debug("[openclaw] connect response", { ok });
            }
            if (!ok) {
              const err = msg.error as Record<string, unknown> | undefined;
              const errMessage =
                asString(err?.message) ?? "OpenClaw connect failed";
              fail(errMessage);
              return;
            }
            sendChat();
            return;
          }
          if (id && sendRequestId && id === sendRequestId) {
            const ok = msg.ok === true;
            if (debugEnabled) {
              console.debug("[openclaw] chat.send response", { ok });
            }
            if (!ok) {
              const err = msg.error as Record<string, unknown> | undefined;
              const errMessage =
                asString(err?.message) ?? "OpenClaw chat.send failed";
              fail(errMessage);
              return;
            }
            const payload = getPayload(msg);
            const runId = getRunId(payload);
            if (!activeRunId && runId) activeRunId = runId;
          }
        }
      });

      ws.on("error", (err) => {
        if (!aborted) {
          fail(err.message, err);
        } else {
          finish();
        }
      });

      ws.on("close", (code, reason) => {
        if (debugEnabled) {
          console.debug("[openclaw] ws close", {
            code,
            reason: reason.toString(),
          });
        }
        if (settled) return;
        if (aborted) {
          endTurn();
          finish();
          return;
        }
        if (sawFinal) {
          endTurn();
          finish();
          return;
        }
        endTurn();
        fail("OpenClaw connection closed before final response");
      });
    });
  },
};
