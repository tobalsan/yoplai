import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ContainerInputSchema, type GatewayConfig } from "@yoplai/shared";
import { ContainerInputBuilder } from "./input-builder.js";
import type { SdkRunParams } from "../types.js";
import { ExtensionRuntime } from "../../extensions/runtime.js";
import { appendAttachmentContext, buildDocumentAttachmentContext } from "../attachments.js";
import { prepareContainerUploads } from "./launch-spec.js";

describe("container input builder", () => {
  it("carries complete document text and copies attachments to remapped container paths without host paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-container-documents-"));
    vi.stubEnv("YOPLAI_HOME", root);
    try {
      const inbound = path.join(root, "media", "inbound");
      const workspaceDir = path.join(root, "workspace");
      await fs.mkdir(inbound, { recursive: true });
      await fs.mkdir(workspaceDir);
      const text = `  heading\n\n${"row,full text\n".repeat(2000)}FINAL-ROW  `;
      const presentation = Buffer.from([0x50, 0x4b, 3, 4, 0, 255]);
      const attachments = [
        { path: path.join(inbound, "report.txt"), filename: "report.txt", mimeType: "text/plain", size: Buffer.byteLength(text) },
        { path: path.join(inbound, "slides.pptx"), filename: "slides.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: presentation.length },
      ];
      await fs.writeFile(attachments[0].path, text);
      await fs.writeFile(attachments[1].path, presentation);
      const context = await buildDocumentAttachmentContext(attachments);
      const params = {
        agentId: "test", sessionId: "documents", workspaceDir, attachments,
        message: appendAttachmentContext("Read these", context),
        agent: { id: "test", model: { provider: "anthropic", model: "test" } },
      } as SdkRunParams;
      const builder = new ContainerInputBuilder({ buildSystemPrompts: async () => [], buildTools: async () => [] });
      const input = await builder.build(params, { agents: [params.agent], extensions: {} } as GatewayConfig, "test-token");
      const uploads = path.join(workspaceDir, "uploads");
      prepareContainerUploads(attachments, uploads);

      expect(input.message).toContain(`heading\n\n${"row,full text\n".repeat(2000)}FINAL-ROW`);
      expect(input.message).toContain("File: slides.pptx");
      expect(input.message).not.toContain(root);
      expect(input.message).not.toContain("Path:");
      expect(input.attachments).toHaveLength(2);
      for (const attachment of input.attachments ?? []) {
        expect(attachment.path).toMatch(/^\/workspace\/uploads\/[^/]+$/);
        const copied = await fs.readFile(path.join(uploads, path.basename(attachment.path)));
        expect(copied).toEqual(attachment.filename === "report.txt" ? Buffer.from(text) : presentation);
      }
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("preserves the selected managed skills directory through the runner input schema", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-managed-input-"));
    try {
      const builder = new ContainerInputBuilder({ buildSystemPrompts: async () => [], buildTools: async () => [] });
      const params = {
        agentId: "test", sessionId: "session", message: "hello", workspaceDir,
        agent: { id: "test", model: { provider: "anthropic", model: "test" } },
      } as SdkRunParams;
      const input = await builder.build(params, { agents: [params.agent], extensions: {} } as GatewayConfig, "test-token", undefined, undefined, undefined, "/skills");
      expect(ContainerInputSchema.parse(JSON.parse(JSON.stringify(input))).managedSkillsDir).toBe("/skills");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
  it("transports resolved deferral settings and extension namespace capabilities through JSON", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-deferral-input-"));
    try {
      const runtime = new ExtensionRuntime();
      runtime.load([{
        id: "mcp", displayName: "MCP", description: "Connected services", dependencies: [],
        configSchema: z.object({}), routePrefixes: [],
        validateConfig: () => ({ valid: true, errors: [] }),
        registerRoutes: () => undefined, start: async () => undefined, stop: async () => undefined,
        capabilities: () => [],
        getAgentTools: async () => [{
          name: "mcp__meetings__find_recording", description: "Find a recording", parameters: { type: "object" },
          namespace: { name: "meetings", displayName: "Meeting archive", description: "Search meeting recordings and transcripts" },
          execute: async () => "recording",
        }],
      }]);
      const params = {
        agentId: "test", sessionId: "session", message: "hello", workspaceDir, extensionRuntime: runtime,
        agent: { id: "test", workspace: workspaceDir, model: { provider: "anthropic", model: "test" }, toolDeferral: { enabled: false, alwaysOnTools: ["pipedrive.search"], alwaysOnExtensions: ["calendar"] } },
      } as SdkRunParams;
      const config = { agents: [params.agent], extensions: {} } as GatewayConfig;
      const builder = new ContainerInputBuilder();
      const input = ContainerInputSchema.parse(JSON.parse(JSON.stringify(await builder.build(params, config, "test-token"))));

      expect(input.toolDeferral).toEqual({ enabled: false, alwaysOnTools: ["pipedrive.search"], alwaysOnExtensions: ["calendar"] });
      expect(input.extensionTools).toContainEqual({
        extensionId: "mcp", extensionDescription: "Connected services", canonicalName: "mcp__meetings__find_recording",
        name: "mcp__meetings__find_recording", description: "Find a recording", parameters: { type: "object" },
        namespace: { name: "meetings", displayName: "Meeting archive", description: "Search meeting recordings and transcripts" },
      });
      const defaults = await builder.build({ ...params, agent: { ...params.agent, toolDeferral: undefined } }, config, "test-token");
      expect(ContainerInputSchema.parse(JSON.parse(JSON.stringify(defaults))).toolDeferral).toEqual({ enabled: true, alwaysOnTools: [], alwaysOnExtensions: [] });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  // ALG-566 Testing Decisions approve JSON input-builder propagation; runtime
  // admission and throttling are covered through the runner seam.
  it.each([true, false, undefined])("transports codemode %s and limits to the runner", async (codemode) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-codemode-input-"));
    try {
      const builder = new ContainerInputBuilder({ buildSystemPrompts: async () => [], buildTools: async () => [] });
      const params = {
        agentId: "test", sessionId: "session", message: "hello", workspaceDir,
        agent: { id: "test", codemode, codemodeLimits: { maxToolCalls: 12, maxConcurrentToolCalls: 2 }, model: { provider: "anthropic", model: "test" } },
      } as SdkRunParams;
      const input = await builder.build(params, { agents: [params.agent], extensions: {} } as GatewayConfig, "test-token");
      const parsed = ContainerInputSchema.parse(JSON.parse(JSON.stringify(input)));
      expect(parsed.codemode).toBe(codemode);
      expect(parsed.codemodeLimits).toEqual({ maxToolCalls: 12, maxConcurrentToolCalls: 2 });
      const defaults = await builder.build({ ...params, agent: { ...params.agent, codemodeLimits: undefined } }, { agents: [params.agent], extensions: {} } as GatewayConfig, "test-token");
      expect(ContainerInputSchema.parse(JSON.parse(JSON.stringify(defaults))).codemodeLimits).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("builds container input without leaking model auth tokens", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-input-")
    );
    const builder = new ContainerInputBuilder({
      buildSystemPrompts: async () => ["extra prompt"],
      buildTools: async () => [
        {
          extensionId: "board",
          name: "scratchpad.read",
          description: "Read",
          parameters: { type: "object" },
        },
      ],
    });
    const params = {
      agentId: "cloud",
      sessionId: "session-1",
      userId: "user-1",
      message: "hello",
      thinkLevel: "medium",
      attachments: [
        {
          path: "/host/inbound/a.txt",
          filename: "a.txt",
          mimeType: "text/plain",
          size: 1,
        },
      ],
      workspaceDir,
      agent: {
        id: "cloud",
        model: {
          provider: "anthropic",
          model: "claude-sonnet",
          auth_token: "secret",
        },
      },
    } as SdkRunParams;
    const config = {
      agents: [params.agent],
      extensions: {},
      gateway: { port: 4100 },
    } as GatewayConfig;

    const previousGatewayPort = process.env.YOPLAI_GATEWAY_PORT;
    delete process.env.YOPLAI_GATEWAY_PORT;
    const input = await builder.build(
      params,
      config,
      "token-1",
      undefined,
      "run-1"
    );
    if (previousGatewayPort === undefined) {
      delete process.env.YOPLAI_GATEWAY_PORT;
    } else {
      process.env.YOPLAI_GATEWAY_PORT = previousGatewayPort;
    }

    expect(input).toMatchObject({
      agentId: "cloud",
      sessionId: "session-1",
      runId: "run-1",
      gatewayUrl: "http://host.docker.internal:4100",
      agentToken: "token-1",
      extensionSystemPrompts: ["extra prompt"],
      extensionTools: [{ extensionId: "board", name: "scratchpad.read" }],
      attachments: [{ path: "/workspace/uploads/d78f174823f6-a.txt" }],
      sdkConfig: {
        sdk: "pi",
        model: { provider: "anthropic", model: "claude-sonnet" },
      },
    });
    expect(input.sdkConfig.model.auth_token).toBeUndefined();
  });

  it.each(["opener", null, undefined])("uses owner %s for session storage while preserving requester identity", async (sessionOwnerId) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-container-owner-"));
    const builder = new ContainerInputBuilder({ buildSystemPrompts: async () => [], buildTools: async () => [] });
    const params = {
      agentId: "cloud", sessionId: "thread", userId: "requester", sessionOwnerId,
      message: "reply", workspaceDir,
      agent: { id: "cloud", model: { provider: "anthropic", model: "test" } },
    } as SdkRunParams;
    const input = await builder.build(params, { agents: [params.agent], extensions: {} } as GatewayConfig, "token");
    const owner = sessionOwnerId === undefined ? "requester" : sessionOwnerId;
    expect(input.sessionDir).toBe(owner ? `/users/${owner}/sessions/cloud` : "/sessions");
    expect(input.userId).toBe("requester");
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("uses run model override for container sdk config", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-input-")
    );
    const builder = new ContainerInputBuilder({
      buildSystemPrompts: async () => [],
      buildTools: async () => [],
    });
    const params = {
      agentId: "cloud",
      sessionId: "session-1",
      message: "hello",
      workspaceDir,
      model: { provider: "openai", model: "gpt-5" },
      agent: {
        id: "cloud",
        model: { provider: "anthropic", model: "claude-sonnet" },
      },
    } as SdkRunParams;
    const config = { agents: [params.agent], extensions: {} } as GatewayConfig;

    const input = await builder.build(params, config, "token-1");

    expect(input.sdkConfig.model).toEqual({ provider: "openai", model: "gpt-5" });
  });

  it("forwards the agent fallback model to the container", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-input-")
    );
    const builder = new ContainerInputBuilder({
      buildSystemPrompts: async () => [],
      buildTools: async () => [],
    });
    const params = {
      agentId: "cloud",
      sessionId: "session-1",
      message: "hello",
      workspaceDir,
      agent: {
        id: "cloud",
        model: { provider: "anthropic", model: "claude-sonnet" },
        fallback_model: { provider: "openai", model: "gpt-5" },
      },
    } as SdkRunParams;
    const config = { agents: [params.agent], extensions: {} } as GatewayConfig;

    const input = await builder.build(params, config, "token-1");

    expect(input.sdkConfig.fallbackModel).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
  });

  it("passes oauthTokens through to the container input", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-input-")
    );
    const builder = new ContainerInputBuilder({
      buildSystemPrompts: async () => [],
      buildTools: async () => [],
    });
    const params = {
      agentId: "cloud",
      sessionId: "session-1",
      message: "hello",
      workspaceDir,
      agent: {
        id: "cloud",
        model: { provider: "anthropic", model: "claude-sonnet" },
        auth: { mode: "oauth" },
      },
    } as SdkRunParams;
    const config = { agents: [params.agent], extensions: {} } as GatewayConfig;
    const oauthTokens = {
      anthropic: { accessToken: "fresh-token", expiresAt: 12345 },
    };

    const input = await builder.build(
      params,
      config,
      "token-1",
      undefined,
      "run-1",
      oauthTokens
    );

    expect(input.oauthTokens).toEqual(oauthTokens);
  });

  it("omits oauthTokens when none are resolved", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-input-")
    );
    const builder = new ContainerInputBuilder({
      buildSystemPrompts: async () => [],
      buildTools: async () => [],
    });
    const params = {
      agentId: "cloud",
      sessionId: "session-1",
      message: "hello",
      workspaceDir,
      agent: {
        id: "cloud",
        model: { provider: "anthropic", model: "claude-sonnet" },
      },
    } as SdkRunParams;
    const config = { agents: [params.agent], extensions: {} } as GatewayConfig;

    const input = await builder.build(params, config, "token-1");

    expect(input.oauthTokens).toBeUndefined();
  });

  it("prepends first-run bootstrap prompt", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-input-")
    );
    const builder = new ContainerInputBuilder({
      buildSystemPrompts: async () => ["extension prompt"],
      buildTools: async () => [],
    });
    const params = {
      agentId: "cloud",
      sessionId: "session-1",
      message: "hello",
      workspaceDir,
      agent: {
        id: "cloud",
        model: { provider: "anthropic", model: "claude-sonnet" },
      },
    } as SdkRunParams;
    const config = { agents: [params.agent], extensions: {} } as GatewayConfig;

    const input = await builder.build(
      params,
      config,
      "token-1",
      "first run bootstrap"
    );

    expect(input.extensionSystemPrompts).toEqual([
      "first run bootstrap",
      "extension prompt",
    ]);
  });

  it("adds the self-improvement prompt only when reflect is on", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-input-")
    );
    const builder = new ContainerInputBuilder({
      buildSystemPrompts: async () => [],
      buildTools: async () => [],
    });
    const make = (reflect?: true) =>
      ({
        agentId: "cloud",
        sessionId: "session-1",
        message: "hello",
        workspaceDir,
        agent: {
          id: "cloud",
          model: { provider: "anthropic", model: "claude-sonnet" },
          reflect,
        },
      }) as SdkRunParams;
    const on = make(true);
    const off = make();
    const withReflect = await builder.build(
      on,
      { agents: [on.agent], extensions: {} } as GatewayConfig,
      "token-1"
    );
    const without = await builder.build(
      off,
      { agents: [off.agent], extensions: {} } as GatewayConfig,
      "token-1"
    );
    expect(withReflect.extensionSystemPrompts?.join("\n")).toContain(
      "skill_save"
    );
    expect(without.extensionSystemPrompts).toBeUndefined();
  });

  it("resolves system files on the host before container launch", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-input-")
    );
    const sharedDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-shared-")
    );
    const sharedFile = path.join(sharedDir, "HOUSE.md");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "agents");
    await fs.writeFile(path.join(workspaceDir, "PERSONA.md"), "persona");
    await fs.writeFile(sharedFile, "house rules");

    const builder = new ContainerInputBuilder({
      buildSystemPrompts: async () => [],
      buildTools: async () => [],
    });
    const params = {
      agentId: "cloud",
      sessionId: "session-1",
      message: "hello",
      workspaceDir,
      agent: {
        id: "cloud",
        model: { provider: "anthropic", model: "claude-sonnet" },
        system_files: ["PERSONA.md", sharedFile],
      },
    } as SdkRunParams;
    const config = { agents: [params.agent], extensions: {} } as GatewayConfig;

    const input = await builder.build(params, config, "token-1");

    expect(input.systemFiles).toEqual([
      { path: "AGENTS.md", content: "agents" },
      { path: "PERSONA.md", content: "persona" },
      { path: sharedFile, content: "house rules" },
    ]);
  });
  it("points the container at the gateway socket when the transport is socket", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-input-")
    );
    const builder = new ContainerInputBuilder({
      buildSystemPrompts: async () => [],
      buildTools: async () => [],
    });
    const params = {
      agentId: "cloud",
      sessionId: "session-1",
      message: "hello",
      workspaceDir,
      agent: { id: "cloud", model: { provider: "anthropic", model: "claude" } },
    } as SdkRunParams;
    const base = { agents: [params.agent], extensions: {} } as GatewayConfig;

    const viaSocket = await builder.build(
      params,
      { ...base, sandbox: { gatewayTransport: "socket" } } as GatewayConfig,
      "token-1"
    );
    const viaHttp = await builder.build(params, base, "token-1");

    expect(viaSocket.gatewaySocketPath).toBe("/run/yoplai/gateway.sock");
    expect(viaHttp.gatewaySocketPath).toBeUndefined();
  });
});
