import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentConfig,
  ExtensionContext,
  RunAgentParams,
  RunAgentResult,
} from "@yoplai/shared";
import { AgentConfigSchema, GatewayConfigSchema } from "@yoplai/shared";
import {
  clearWebhooksRuntime,
  registerWebhookRoutes,
  setWebhooksRuntime,
} from "./routes.js";
import { getWebhookSecretsPath, saveWebhookSecrets } from "./secrets.js";

function createContext(params: {
  agent?: AgentConfig;
  dataDir?: string;
  onEmit?: (event: string, payload: unknown) => void;
  onRunAgent?: (params: RunAgentParams) => Promise<RunAgentResult>;
}): ExtensionContext {
  return {
    getConfig: () =>
      GatewayConfigSchema.parse({
        agents: params.agent ? [params.agent] : [],
        extensions: {},
      }),
    getDataDir: () => params.dataDir ?? "/tmp",
    reloadConfig: () => undefined,
    getAgent: (id) => (params.agent?.id === id ? params.agent : undefined),
    getAgents: () => (params.agent ? [params.agent] : []),
    isAgentActive: (id) => params.agent?.id === id,
    isAgentStreaming: () => false,
    resolveWorkspaceDir: (agent) => agent.workspace,
    runAgent:
      params.onRunAgent ??
      (async () => ({
        payloads: [],
        meta: { durationMs: 0, sessionId: "session" },
      })),
    getSubagentTemplates: () => [],
    resolveSessionId: async () => undefined,
    getSessionEntry: async () => undefined,
    clearSessionEntry: async () => undefined,
    restoreSessionUpdatedAt: () => undefined,
    deleteSession: () => undefined,
    invalidateHistoryCache: async () => undefined,
    getSessionHistory: async () => [],
    registerDeliverySink: () => () => undefined,
    getDeliverySink: () => undefined,
    subscribe: () => () => undefined,
    emit: (event, payload) => params.onEmit?.(event, payload),
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

function createApp(): Hono {
  const app = new Hono();
  registerWebhookRoutes(app);
  return app;
}

async function getStatus(app: Hono, url: string): Promise<number> {
  return (await app.fetch(new Request(url))).status;
}

function sign(
  payload: string,
  secret: string,
  encoding: "hex" | "base64" = "hex"
): string {
  return crypto.createHmac("sha256", secret).update(payload).digest(encoding);
}

describe("webhook routes", () => {
  afterEach(() => {
    clearWebhooksRuntime();
  });

  it("returns 401 for missing or invalid secrets", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: { notion: { prompt: "hello", langfuseTracing: true } },
    });
    setWebhooksRuntime({
      ctx: createContext({ agent }),
      secrets: { "sales:notion": "secret" },
    });
    const app = createApp();

    expect(await getStatus(app, "http://localhost/hooks/sales/notion")).toBe(
      401
    );
    expect(
      await getStatus(app, "http://localhost/hooks/sales/notion/wrong")
    ).toBe(401);
  });

  it("reloads rotated secrets from disk at request time", async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "yoplai-webhook-routes-")
    );
    saveWebhookSecrets(dataDir, { "sales:notion": "old-secret" });
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: { notion: { prompt: "hello", langfuseTracing: true } },
    });
    setWebhooksRuntime({
      ctx: createContext({ agent, dataDir }),
      secrets: { "sales:notion": "old-secret" },
    });
    const app = createApp();

    expect(
      await getStatus(app, "http://localhost/hooks/sales/notion/old-secret")
    ).toBe(200);

    const filePath = getWebhookSecretsPath(dataDir);
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ "sales:notion": "new-secret" }, null, 2)}\n`,
      "utf8"
    );
    fs.chmodSync(filePath, 0o600);
    const nextMtime = new Date(Date.now() + 1000);
    fs.utimesSync(filePath, nextMtime, nextMtime);

    expect(
      await getStatus(app, "http://localhost/hooks/sales/notion/old-secret")
    ).toBe(401);
    expect(
      await getStatus(app, "http://localhost/hooks/sales/notion/new-secret")
    ).toBe(200);
  });

  it("returns 404 for unknown agents or webhook names", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: { notion: { prompt: "hello", langfuseTracing: true } },
    });
    setWebhooksRuntime({
      ctx: createContext({ agent }),
      secrets: { "sales:notion": "secret" },
    });
    const app = createApp();

    expect(
      await getStatus(app, "http://localhost/hooks/support/notion/secret")
    ).toBe(404);
    expect(
      await getStatus(app, "http://localhost/hooks/sales/github/secret")
    ).toBe(404);
  });

  it("accepts a valid webhook and runs the agent asynchronously", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: {
        notion: {
          prompt:
            "URL=$WEBHOOK_ORIGIN_URL HEADERS=$WEBHOOK_HEADERS BODY=$WEBHOOK_PAYLOAD",
          langfuseTracing: true,
        },
      },
    });

    let captured: RunAgentParams | undefined;
    let resolveRun: () => void = () => undefined;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onRunAgent: async (params) => {
          captured = params;
          resolveRun();
          return { payloads: [], meta: { durationMs: 0, sessionId: "s1" } };
        },
      }),
      secrets: { "sales:notion": "secret" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/notion/secret", {
        method: "POST",
        body: '{"ticket":123}',
        headers: { "content-type": "application/json" },
      })
    );

    expect(response.status).toBe(200);
    await runPromise;
    expect(captured?.agentId).toBe("sales");
    expect(captured?.sessionKey).toMatch(
      /^webhook:sales:notion:[0-9a-f-]{36}$/
    );
    expect(captured?.source).toBe("webhook");
    expect(captured?.trace).toMatchObject({
      enabled: true,
      name: "yoplai:webhook:sales",
      surface: "webhook",
      metadata: {
        webhookName: "notion",
        agentId: "sales",
        sourceUrl: "http://localhost/hooks/sales/notion/secret",
        requestPayload: '{"ticket":123}',
      },
    });
    expect(captured?.message).toContain(
      "URL=http://localhost/hooks/sales/notion/secret"
    );
    expect(captured?.message).toContain(
      'HEADERS={"content-type":"application/json"}'
    );
    expect(captured?.message).toContain('BODY={"ticket":123}');
  });

  it("returns verification success for a matching payload field", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: {
        notion: {
          prompt: "hello",
          signingSecret: "secret",
          verification: {
            location: "payload",
            fieldName: "verification_token",
          },
        },
      },
    });
    let called = false;
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onRunAgent: async () => {
          called = true;
          return { payloads: [], meta: { durationMs: 0, sessionId: "s1" } };
        },
      }),
      secrets: { "sales:notion": "secret-token" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/notion/secret-token", {
        method: "POST",
        body: '{"verification_token":"abc123"}',
        headers: { "content-type": "application/json" },
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, verification: true });
    expect(called).toBe(false);
  });

  it("returns verification success for a matching header field", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: {
        notion: {
          prompt: "hello",
          signingSecret: "secret",
          verification: {
            location: "header",
            fieldName: "X-Webhook-Verify",
          },
        },
      },
    });
    let called = false;
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onRunAgent: async () => {
          called = true;
          return { payloads: [], meta: { durationMs: 0, sessionId: "s1" } };
        },
      }),
      secrets: { "sales:notion": "secret-token" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/notion/secret-token", {
        method: "POST",
        body: "{}",
        headers: { "x-webhook-verify": "abc123" },
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, verification: true });
    expect(called).toBe(false);
  });

  it("runs the agent when verification config does not match", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: {
        notion: {
          prompt: "BODY=$WEBHOOK_PAYLOAD",
          verification: {
            location: "payload",
            fieldName: "verification_token",
          },
        },
      },
    });
    let captured: RunAgentParams | undefined;
    let resolveRun: () => void = () => undefined;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onRunAgent: async (params) => {
          captured = params;
          resolveRun();
          return { payloads: [], meta: { durationMs: 0, sessionId: "s1" } };
        },
      }),
      secrets: { "sales:notion": "secret-token" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/notion/secret-token", {
        method: "POST",
        body: '{"event":"page.updated"}',
      })
    );

    expect(response.status).toBe(200);
    await runPromise;
    expect(captured?.message).toBe('BODY={"event":"page.updated"}');
  });

  it("runs the agent normally without verification config", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: {
        notion: {
          prompt: "BODY=$WEBHOOK_PAYLOAD",
        },
      },
    });
    let captured: RunAgentParams | undefined;
    let resolveRun: () => void = () => undefined;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onRunAgent: async (params) => {
          captured = params;
          resolveRun();
          return { payloads: [], meta: { durationMs: 0, sessionId: "s1" } };
        },
      }),
      secrets: { "sales:notion": "secret-token" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/notion/secret-token", {
        method: "POST",
        body: '{"verification_token":"abc123"}',
      })
    );

    expect(response.status).toBe(200);
    await runPromise;
    expect(captured?.message).toBe('BODY={"verification_token":"abc123"}');
  });

  it("passes a disabled trace context when langfuse tracing is off", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: {
        notion: {
          prompt: "hello",
          langfuseTracing: false,
        },
      },
    });

    let captured: RunAgentParams | undefined;
    let resolveRun: () => void = () => undefined;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onRunAgent: async (params) => {
          captured = params;
          resolveRun();
          return { payloads: [], meta: { durationMs: 0, sessionId: "s1" } };
        },
      }),
      secrets: { "sales:notion": "secret" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/notion/secret", {
        method: "POST",
        body: "{}",
      })
    );

    expect(response.status).toBe(200);
    await runPromise;
    expect(captured?.trace?.enabled).toBe(false);
  });

  it("rejects known webhook signatures that fail verification", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: {
        github: {
          prompt: "hello",
          signingSecret: "secret",
        },
      },
    });
    let called = false;
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onRunAgent: async () => {
          called = true;
          return { payloads: [], meta: { durationMs: 0, sessionId: "s1" } };
        },
      }),
      secrets: { "sales:github": "secret-token" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/github/secret-token", {
        method: "POST",
        body: "{}",
        headers: { "x-hub-signature-256": "sha256=bad" },
      })
    );

    expect(response.status).toBe(401);
    expect(called).toBe(false);
  });

  it("accepts a known webhook with a valid signature", async () => {
    const payload = '{"action":"opened"}';
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: {
        github: {
          prompt: "BODY=$WEBHOOK_PAYLOAD",
          signingSecret: "secret",
        },
      },
    });
    let captured: RunAgentParams | undefined;
    let resolveRun: () => void = () => undefined;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onRunAgent: async (params) => {
          captured = params;
          resolveRun();
          return { payloads: [], meta: { durationMs: 0, sessionId: "s1" } };
        },
      }),
      secrets: { "sales:github": "secret-token" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/github/secret-token", {
        method: "POST",
        body: payload,
        headers: {
          "x-hub-signature-256": `sha256=${sign(payload, "secret")}`,
        },
      })
    );

    expect(response.status).toBe(200);
    await runPromise;
    expect(captured?.message).toBe(`BODY=${payload}`);
  });

  it("treats Notion GET challenge params as a normal webhook when verification is absent", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: { notion: { prompt: "BODY=$WEBHOOK_PAYLOAD" } },
    });
    let captured: RunAgentParams | undefined;
    let resolveRun: () => void = () => undefined;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onRunAgent: async (params) => {
          captured = params;
          resolveRun();
          return { payloads: [], meta: { durationMs: 0, sessionId: "s1" } };
        },
      }),
      secrets: { "sales:notion": "secret" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/notion/secret?challenge=abc123")
    );

    expect(response.status).toBe(200);
    await runPromise;
    expect(captured?.message).toBe("BODY=challenge=abc123");
  });

  it("treats Zendesk GET challenge params as a normal webhook when verification is absent", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: { zendesk: { prompt: "BODY=$WEBHOOK_PAYLOAD" } },
    });
    let captured: RunAgentParams | undefined;
    let resolveRun: () => void = () => undefined;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onRunAgent: async (params) => {
          captured = params;
          resolveRun();
          return { payloads: [], meta: { durationMs: 0, sessionId: "s1" } };
        },
      }),
      secrets: { "sales:zendesk": "secret" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request(
        "http://localhost/hooks/sales/zendesk/secret?challenge=abc123"
      )
    );

    expect(response.status).toBe(200);
    await runPromise;
    expect(captured?.message).toBe("BODY=challenge=abc123");
  });

  it("returns 413 when the payload exceeds the configured limit", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: {
        notion: {
          prompt: "BODY=$WEBHOOK_PAYLOAD",
          maxPayloadSize: 4,
        },
      },
    });

    let ran = false;
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onRunAgent: async () => {
          ran = true;
          return { payloads: [], meta: { durationMs: 0, sessionId: "s1" } };
        },
      }),
      secrets: { "sales:notion": "secret" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/notion/secret", {
        method: "POST",
        body: "12345",
        headers: { "content-length": "3" },
      })
    );

    expect(response.status).toBe(413);
    expect(ran).toBe(false);
  });

  it("stops reading streamed bodies once the payload limit is exceeded", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: {
        notion: {
          prompt: "BODY=$WEBHOOK_PAYLOAD",
          maxPayloadSize: 4,
        },
      },
    });

    let ran = false;
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onRunAgent: async () => {
          ran = true;
          return { payloads: [], meta: { durationMs: 0, sessionId: "s1" } };
        },
      }),
      secrets: { "sales:notion": "secret" },
    });
    const app = createApp();
    const encoder = new TextEncoder();
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(encoder.encode("12"));
          return;
        }
        if (pullCount === 2) {
          controller.enqueue(encoder.encode("345"));
          return;
        }
        throw new Error("read past payload cap");
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/notion/secret", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit)
    );

    expect(response.status).toBe(413);
    expect(pullCount).toBe(2);
    expect(ran).toBe(false);
  });

  it("emits a traceable error event when async agent execution fails", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: {
        notion: {
          prompt: "BODY=$WEBHOOK_PAYLOAD",
          langfuseTracing: true,
        },
      },
    });

    const events: Array<{ event: string; payload: unknown }> = [];
    let resolveError: () => void = () => undefined;
    const errorEvent = new Promise<void>((resolve) => {
      resolveError = resolve;
    });
    setWebhooksRuntime({
      ctx: createContext({
        agent,
        onEmit: (event, payload) => {
          events.push({ event, payload });
          if (
            event === "agent.stream" &&
            (payload as { type?: string }).type === "error"
          ) {
            resolveError();
          }
        },
        onRunAgent: async () => {
          throw new Error("agent failed");
        },
      }),
      secrets: { "sales:notion": "secret" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/notion/secret", {
        method: "POST",
        body: "{}",
      })
    );

    expect(response.status).toBe(200);
    await errorEvent;
    const emitted = events.find(
      (entry) =>
        entry.event === "agent.stream" &&
        (entry.payload as { type?: string }).type === "error"
    )?.payload as {
      message?: string;
      agentId?: string;
      sessionKey?: string;
      source?: string;
      trace?: { surface?: string; metadata?: Record<string, unknown> };
    };
    expect(emitted).toMatchObject({
      message: "agent failed",
      agentId: "sales",
      source: "webhook",
      trace: {
        surface: "webhook",
        metadata: {
          webhookName: "notion",
          requestPayload: "{}",
        },
      },
    });
    expect(emitted.sessionKey).toMatch(/^webhook:sales:notion:[0-9a-f-]{36}$/);
  });

  it("returns 413 from content-length before reading the body", async () => {
    const agent = AgentConfigSchema.parse({
      id: "sales",
      name: "Sales",
      workspace: "/tmp",
      model: { model: "claude" },
      webhooks: {
        notion: {
          prompt: "BODY=$WEBHOOK_PAYLOAD",
          maxPayloadSize: 4,
        },
      },
    });

    setWebhooksRuntime({
      ctx: createContext({ agent }),
      secrets: { "sales:notion": "secret" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("http://localhost/hooks/sales/notion/secret", {
        method: "POST",
        body: "1",
        headers: { "content-length": "5" },
      })
    );

    expect(response.status).toBe(413);
  });
});
