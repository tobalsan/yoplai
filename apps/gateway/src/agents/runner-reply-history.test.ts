import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GatewayConfigSchema, type AgentConfig, type Extension } from "@yoplai/shared";
import type { SdkAdapter } from "../sdk/types.js";

const tmpHome = vi.hoisted(() => `/tmp/yoplai-reply-history-${process.pid}-${Math.random().toString(36).slice(2)}`);
const getSdkAdapter = vi.hoisted(() => vi.fn());
const agent = {
  id: "alpha", name: "Alpha", workspace: tmpHome, sdk: "pi",
  model: { provider: "anthropic", model: "claude" }, queueMode: "queue",
  extensions: { "short-replies": {} },
} as AgentConfig;
const config = GatewayConfigSchema.parse({ version: 2, agents: [agent] });

vi.mock("../config/index.js", () => ({
  CONFIG_DIR: tmpHome,
  getAgent: (id: string) => id === "alpha" ? agent : undefined,
  loadConfig: () => config,
  resolveWorkspaceDir: (workspace: string) => workspace,
  resolveAgentEnv: () => ({}),
}));
vi.mock("../sdk/registry.js", () => ({ getSdkAdapter, getDefaultSdkId: () => "pi" }));
vi.mock("../sdk/container/adapter.js", () => ({ getContainerAdapter: vi.fn() }));
vi.mock("../sessions/index.js", () => ({
  resolveSessionId: vi.fn(), getSessionEntry: vi.fn(), isAbortTrigger: () => false,
}));
vi.mock("../tasks/store.js", () => ({ getTask: async () => undefined, pauseTaskForControlCommand: vi.fn() }));
vi.mock("../extensions/registry.js", () => ({ getExtensionRuntime: () => undefined }));
vi.mock("../maintenance/session-auto-title.js", () => ({ maybeAutoTitleSession: vi.fn() }));
vi.mock("./quota-notification.js", () => ({ notifyProviderQuota: vi.fn() }));
vi.mock("../chat-projects/context-resolver.js", () => ({
  ProjectContextResolver: class { resolve = async () => undefined; },
}));

import { ExtensionRuntime } from "../extensions/runtime.js";
import { resolveSessionDataFile } from "../sessions/files.js";
import { getFullSessionHistory, getSessionHistory, runAgent } from "./runner.js";

const DRAFT = "This rejected draft must stay inside the model session.";
const ACCEPTED = "Here is the accepted reply.";
const extension: Extension = {
  id: "short-replies", displayName: "Short replies", description: "Test reply reviewer",
  dependencies: [], routePrefixes: [], configSchema: z.object({}),
  validateConfig: () => ({ valid: true, errors: [] }), registerRoutes() {},
  async start() {}, async stop() {}, capabilities: () => [],
  reviewsReplies: () => true,
  getReplyReviewer: () => ({
    begin() {}, end() {},
    review: (draft) => draft === DRAFT
      ? { ok: false, rewriteHint: "Use the accepted reply." }
      : { ok: true },
  }),
};

afterAll(async () => { await fs.rm(tmpHome, { recursive: true, force: true }); });

describe("reply review with real persisted history", () => {
  it("keeps an attachment-only turn's rejected draft out of simple and full history", async () => {
    const sessionId = "attachment-only";
    const attachment = path.join(tmpHome, "note.txt");
    await fs.mkdir(tmpHome, { recursive: true });
    await fs.writeFile(attachment, "note");
    const piFile = await resolveSessionDataFile({
      dir: path.join(tmpHome, "sessions"), agentId: agent.id, sessionId, createIfMissing: true,
    });
    if (!piFile) throw new Error("Missing Pi session fixture path.");

    let release!: () => void;
    let entered!: () => void;
    const rewriting = new Promise<void>((resolve) => { entered = resolve; });
    const finishRewrite = new Promise<void>((resolve) => { release = resolve; });
    let attempts = 0;
    const adapter: SdkAdapter = {
      id: "pi", displayName: "Test",
      capabilities: { queueWhileStreaming: false, interrupt: false, toolEvents: true, fullHistory: true },
      resolveDisplayModel: () => ({}),
      async run(params) {
        attempts += 1;
        const text = attempts === 1 ? DRAFT : ACCEPTED;
        const timestamp = 1700000000000 + attempts;
        if (attempts > 1) { entered(); await finishRewrite; }
        await fs.appendFile(piFile, `${JSON.stringify({
          type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp },
        })}\n`);
        params.onEvent({ type: "text", data: text });
        params.onHistoryEvent({ type: "assistant_text", text, timestamp });
        return { text };
      },
    };
    getSdkAdapter.mockReturnValue(adapter);
    const runtime = new ExtensionRuntime();
    runtime.load([extension]);
    const running = runAgent({
      agentId: agent.id, sessionId, source: "web", message: "", extensionRuntime: runtime,
      resolvedSession: { sessionId, message: "", isNew: false },
      attachments: [{ path: attachment, mimeType: "text/plain", filename: "note.txt", size: 4 }],
    });
    let during: { simple: unknown; full: unknown } | undefined;
    try {
      await Promise.race([rewriting, running]);
      during = {
        simple: await getSessionHistory(agent.id, sessionId),
        full: await getFullSessionHistory(agent.id, sessionId),
      };
    } finally {
      release();
      await running;
    }

    expect(during).toEqual({ simple: [], full: [] });
    expect((await getSessionHistory(agent.id, sessionId)).map(({ role, content }) => ({ role, content })))
      .toEqual([{ role: "assistant", content: ACCEPTED }]);
    expect(await getFullSessionHistory(agent.id, sessionId)).toEqual([
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: ACCEPTED }] }),
    ]);
  });
});
