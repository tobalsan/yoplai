import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ContainerInputSchema, type GatewayConfig } from "@yoplai/shared";
import { ContainerInputBuilder } from "./input-builder.js";
import type { SdkRunParams } from "../types.js";
import { ExtensionRuntime } from "../../extensions/runtime.js";

describe("container input builder", () => {
  it("preserves the selected managed skills directory through the runner input schema", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-managed-input-"));
    try {
      await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "test soul");
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
      await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Deferral fixture guidance");
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

  it.each([true, false, undefined])("transports codemode %s to the runner", async (codemode) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-codemode-input-"));
    try {
      await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "test soul");
      const builder = new ContainerInputBuilder({ buildSystemPrompts: async () => [], buildTools: async () => [] });
      const params = {
        agentId: "test", sessionId: "session", message: "hello", workspaceDir,
        agent: { id: "test", codemode, model: { provider: "anthropic", model: "test" } },
      } as SdkRunParams;
      const input = await builder.build(params, { agents: [params.agent], extensions: {} } as GatewayConfig, "test-token");
      expect(ContainerInputSchema.parse(JSON.parse(JSON.stringify(input))).codemode).toBe(codemode);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("builds container input without leaking model auth tokens", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-input-")
    );
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "soul");
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
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "soul");
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
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "soul");
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
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "soul");
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
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "soul");
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
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "soul");
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
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "soul");
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

  it("resolves system files on the host before container launch", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-input-")
    );
    const sharedDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-shared-")
    );
    const sharedFile = path.join(sharedDir, "HOUSE.md");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "agents");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "soul");
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
        system_files: ["SOUL.md", sharedFile],
      },
    } as SdkRunParams;
    const config = { agents: [params.agent], extensions: {} } as GatewayConfig;

    const input = await builder.build(params, config, "token-1");

    expect(input.systemFiles).toEqual([
      { path: "AGENTS.md", content: "agents" },
      { path: "SOUL.md", content: "soul" },
      { path: sharedFile, content: "house rules" },
    ]);
  });
  it("points the container at the gateway socket when the transport is socket", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-container-input-")
    );
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "soul");
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
