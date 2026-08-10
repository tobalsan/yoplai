import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import { ContainerInputBuilder } from "./input-builder.js";
import type { SdkRunParams } from "../types.js";

describe("container input builder", () => {
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
});
