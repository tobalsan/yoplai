import crypto from "node:crypto";
import type {
  AgentConfig,
  ExtensionContext,
  WebhookConfig,
} from "@yoplai/shared";
import type { Hono } from "hono";
import {
  parseWakeAgent,
  resolveScriptPath,
  runScript,
  ScriptExecutionError,
  ScriptPathError,
} from "@yoplai/shared/node/script";
import {
  interpolateWebhookPrompt,
  resolveWebhookPrompt,
  WebhookPromptError,
} from "./prompt.js";
import {
  getCachedWebhookSecrets,
  setCachedWebhookSecrets,
  webhookSecretKey,
  type WebhookSecrets,
} from "./secrets.js";
import { verifyWebhookSignature } from "./verify.js";

type WebhooksRuntime = {
  ctx: ExtensionContext;
  secrets: WebhookSecrets;
};

let runtime: WebhooksRuntime | null = null;
export const WEBHOOK_SCRIPT_OWNER = "webhooks";

export function setWebhooksRuntime(next: WebhooksRuntime): void {
  setCachedWebhookSecrets(next.ctx.getDataDir(), next.secrets);
  runtime = next;
}

export function clearWebhooksRuntime(): void {
  runtime = null;
}

function getRuntime(): WebhooksRuntime | null {
  return runtime;
}

function getRequestHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function getRequestPayload(request: Request): Promise<string> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    return url.searchParams.toString();
  }
  return request.text();
}

function getContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const length = Number(raw);
  return Number.isInteger(length) && length >= 0 ? length : null;
}

function payloadByteLength(payload: string): number {
  return Buffer.byteLength(payload, "utf8");
}

function hasWebhookVerificationField(params: {
  webhookConfig: WebhookConfig;
  headers: Record<string, string>;
  payload: string;
}): boolean {
  const verification = params.webhookConfig.verification;
  if (!verification) return false;

  if (verification.location === "header") {
    const fieldName = verification.fieldName.toLowerCase();
    return Object.keys(params.headers).some(
      (header) => header.toLowerCase() === fieldName
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(params.payload);
  } catch {
    return false;
  }

  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.prototype.hasOwnProperty.call(parsed, verification.fieldName)
  );
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload Too Large");
  }
}

async function readRequestPayloadWithLimit(
  request: Request,
  maxPayloadSize: number
): Promise<string> {
  if (request.method === "GET") return getRequestPayload(request);
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxPayloadSize) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getTraceContext(params: {
  agent: AgentConfig;
  webhookName: string;
  originUrl: string;
  headers: Record<string, string>;
  payload: string;
  langfuseTracing: boolean;
  timestamp: string;
}) {
  return {
    enabled: params.langfuseTracing,
    name: `yoplai:webhook:${params.agent.id}`,
    surface: "webhook",
    metadata: {
      webhookName: params.webhookName,
      agentId: params.agent.id,
      sourceUrl: params.originUrl,
      timestamp: params.timestamp,
      requestHeaders: params.headers,
      requestPayload: params.payload,
    },
  };
}

async function runWebhookAgent(params: {
  ctx: ExtensionContext;
  agent: AgentConfig;
  webhookName: string;
  prompt: string;
  originUrl: string;
  headers: Record<string, string>;
  payload: string;
  requestId: string;
  langfuseTracing: boolean;
  timestamp: string;
}): Promise<void> {
  let sessionKey = `webhook:${params.agent.id}:${params.webhookName}:${params.requestId}`;
  const trace = getTraceContext(params);
  let message: string | undefined;

  try {
    const workspaceDir = params.ctx.resolveWorkspaceDir(params.agent);
    const { prompt, options } = await resolveWebhookPrompt(
      params.prompt,
      workspaceDir
    );
    let gateContext: string | undefined;
    if (options.script) {
      try {
        await resolveScriptPath(workspaceDir, options.script);
      } catch (err) {
        if (err instanceof ScriptPathError)
          throw new WebhookPromptError(params.prompt, err);
        // A missing file is a gate failure; runScript supplies its spawn reason.
      }
      try {
        const result = await runScript({
          workspaceDir,
          script: options.script,
          timeoutMs: options.scriptTimeoutMs ?? 30_000,
          owner: WEBHOOK_SCRIPT_OWNER,
          stdin: params.payload,
          env: {
            WEBHOOK_AGENT_ID: params.agent.id,
            WEBHOOK_NAME: params.webhookName,
            WEBHOOK_REQUEST_ID: params.requestId,
            WEBHOOK_ORIGIN_URL: params.originUrl,
            WEBHOOK_HEADERS: JSON.stringify(params.headers),
          },
        });
        const gate = parseWakeAgent(result.finalStdoutLine);
        sessionKey = `webhook:${params.agent.id}:${params.webhookName}:${gate.sessionScope ?? params.requestId}`;
        if (gate.abort) {
          if (params.ctx.abortRun) {
            try {
              const stopped = await params.ctx.abortRun(params.agent.id, sessionKey);
              params.ctx.logger.info(
                `[webhooks] ${params.agent.id}/${params.webhookName} gate: abort`,
                {
                  agentId: params.agent.id,
                  webhookName: params.webhookName,
                  sessionScope: gate.sessionScope,
                  stopped,
                }
              );
            } catch (err) {
              params.ctx.logger.error(
                `[webhooks] ${params.agent.id}/${params.webhookName} gate: abort failed`,
                errorMessage(err).split("\n")[0]
              );
            }
          } else {
            params.ctx.logger.warn(
              `[webhooks] ${params.agent.id}/${params.webhookName} gate: abortRun unavailable`
            );
          }
        }
        if (!gate.wake) {
          params.ctx.logger.info(
            `[webhooks] ${params.agent.id}/${params.webhookName} gate: skipped`
          );
          return;
        }
        gateContext = gate.context;
      } catch (err) {
        const reason =
          err instanceof ScriptExecutionError ? err.reason : "spawn";
        params.ctx.logger.error(
          `[webhooks] ${params.agent.id}/${params.webhookName} gate: ${reason}`,
          errorMessage(err).split("\n")[0],
          {
            reason,
            stderrTail:
              err instanceof ScriptExecutionError ? err.stderrTail : "",
          }
        );
      }
    }
    message = interpolateWebhookPrompt(prompt, {
      originUrl: params.originUrl,
      headers: params.headers,
      payload: params.payload,
      gateContext,
    });
    if (
      gateContext !== undefined &&
      !prompt.includes("$WEBHOOK_GATE_CONTEXT")
    ) {
      message += `\n\nGate context:\n${gateContext}`;
    }

    await params.ctx.runAgent({
      agentId: params.agent.id,
      message,
      sessionKey,
      source: "webhook",
      trace,
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoning ? { thinkLevel: options.reasoning } : {}),
    });
  } catch (err) {
    const messageText = errorMessage(err);
    params.ctx.logger.error(
      `[webhooks] ${params.agent.id}/${params.webhookName} failed${err instanceof WebhookPromptError ? `: ${messageText.replace(/\s+/g, " ")}` : ""}`,
      err
    );
    if (!params.langfuseTracing) return;

    let sessionId = sessionKey;
    try {
      sessionId =
        (await params.ctx.getSessionEntry(params.agent.id, sessionKey))
          ?.sessionId ?? sessionKey;
    } catch {
      sessionId = sessionKey;
    }

    if (message) {
      params.ctx.emit("agent.history", {
        type: "user",
        text: message,
        timestamp: Date.now(),
        agentId: params.agent.id,
        sessionId,
        sessionKey,
        source: "webhook",
        trace,
      });
    }

    params.ctx.emit("agent.stream", {
      type: "text",
      data: "",
      agentId: params.agent.id,
      sessionId,
      sessionKey,
      source: "webhook",
      trace,
    });
    params.ctx.emit("agent.stream", {
      type: "error",
      message: messageText,
      agentId: params.agent.id,
      sessionId,
      sessionKey,
      source: "webhook",
      trace,
    });
  }
}

export function registerWebhookRoutes(app: Hono): void {
  app.on(["GET", "POST"], "/hooks/:agentId/:name", (c) => {
    return c.json({ error: "Unauthorized" }, 401);
  });

  app.on(["GET", "POST"], "/hooks/:agentId/:name/:secret", async (c) => {
    const current = getRuntime();
    if (!current) {
      return c.json({ error: "Webhooks extension not started" }, 503);
    }

    const agentId = c.req.param("agentId");
    const webhookName = c.req.param("name");
    const providedSecret = c.req.param("secret");
    const agent = current.ctx.getAgent(agentId);
    const webhookConfig = agent?.webhooks?.[webhookName];

    if (!agent || !webhookConfig || !current.ctx.isAgentActive(agentId)) {
      return c.json({ error: "Webhook not found" }, 404);
    }

    const secrets = getCachedWebhookSecrets(current.ctx.getDataDir());
    const expectedSecret = secrets[webhookSecretKey(agentId, webhookName)];
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const maxPayloadSize = webhookConfig.maxPayloadSize;
    const contentLength = getContentLength(c.req.raw.headers);
    if (contentLength !== null && contentLength > maxPayloadSize) {
      return c.json({ error: "Payload Too Large" }, 413);
    }

    const headers = getRequestHeaders(c.req.raw.headers);

    let payload: string;
    try {
      payload = await readRequestPayloadWithLimit(c.req.raw, maxPayloadSize);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return c.json({ error: "Payload Too Large" }, 413);
      }
      throw err;
    }
    if (payloadByteLength(payload) > maxPayloadSize) {
      return c.json({ error: "Payload Too Large" }, 413);
    }
    if (hasWebhookVerificationField({ webhookConfig, headers, payload })) {
      current.ctx.logger.info(
        `[webhooks] ${agentId}/${webhookName} verification request — headers: ${JSON.stringify(
          headers
        )} payload: ${payload}`
      );
      return c.json({ ok: true, verification: true });
    }

    const requestId = crypto.randomUUID();
    if (
      webhookConfig.signingSecret &&
      !verifyWebhookSignature({
        webhookName,
        headers: c.req.raw.headers,
        payload,
        signingSecret: webhookConfig.signingSecret,
      })
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const originUrl = c.req.url;
    const timestamp = new Date().toISOString();

    void runWebhookAgent({
      ctx: current.ctx,
      agent,
      webhookName,
      prompt: webhookConfig.prompt,
      originUrl,
      headers,
      payload,
      requestId,
      langfuseTracing: webhookConfig.langfuseTracing,
      timestamp,
    });

    return c.json({ ok: true, requestId });
  });
}
