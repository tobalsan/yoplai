import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { GatewayConfigSchema, type Extension } from "@yoplai/shared";
import { ExtensionRuntime } from "./runtime.js";

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true }))
  );
});

it("lets an extension edit a persistent conversation file without exposing it to another user or conversation", async () => {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "yoplai-conversation-files-")
  );
  homes.push(home);
  vi.stubEnv("YOPLAI_HOME", home);
  const agent = {
    id: "files",
    name: "Files",
    workspace: home,
    queueMode: "queue" as const,
    model: { provider: "openai", model: "test" },
  };
  const config = GatewayConfigSchema.parse({
    version: 2,
    agents: [agent],
    extensions: { documents: {} },
  });
  const documents: Extension = {
    id: "documents",
    displayName: "Documents",
    description: "Document editing",
    dependencies: [],
    configSchema: z.object({}),
    routePrefixes: [],
    validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes: () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    capabilities: () => [],
    getAgentTools: () => [
      {
        name: "document",
        description: "Edit document",
        parameters: {},
        execute: async (args, context) => {
          if (!context.conversationFiles)
            throw new Error("Conversation files unavailable");
          const file = path.join(
            context.conversationFiles.hostPath,
            "report.txt"
          );
          if (args === "write") await fs.writeFile(file, "Original report");
          if (args === "edit") await fs.writeFile(file, "Edited report");
          return fs
            .readFile(file, "utf8")
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return "No report";
              throw error;
            });
        },
      },
    ],
  };
  const runtime = new ExtensionRuntime();
  runtime.load([documents]);
  const run = (action: string, session = "thread", user = "alice") =>
    runtime.executeTool(agent, "document", action, config, session, user);
  expect((await run("write")).result).toBe("Original report");
  expect((await run("edit")).result).toBe("Edited report");
  expect((await run("read")).result).toBe("Edited report");
  expect((await run("read", "thread", "bob")).result).toBe("No report");
  expect((await run("read", "other-thread")).result).toBe("No report");
});

it("binds container tool execution to the token's conversation folder and requester", async () => {
  const { createInternalTools } = await import("../server/internal-tools.js");
  const { registerContainerToken, removeContainerToken } =
    await import("../sdk/container/tokens.js");
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "yoplai-container-files-")
  );
  homes.push(home);
  vi.stubEnv("YOPLAI_HOME", home);
  const hostPath = path.join(home, "bound-files");
  await fs.mkdir(hostPath);
  const agent = {
    id: "files",
    name: "Files",
    workspace: home,
    queueMode: "queue" as const,
    model: { provider: "openai", model: "test" },
  };
  const config = GatewayConfigSchema.parse({
    version: 2,
    agents: [agent],
    extensions: { documents: {} },
  });
  const runtime = new ExtensionRuntime();
  runtime.load([
    {
      id: "documents",
      displayName: "Documents",
      description: "Document editing",
      dependencies: [],
      configSchema: z.object({}),
      routePrefixes: [],
      validateConfig: () => ({ valid: true, errors: [] }),
      registerRoutes: () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      capabilities: () => [],
      getAgentTools: () => [
        {
          name: "document",
          description: "Download document",
          parameters: {},
          execute: async (_args, context) => {
            if (!context.conversationFiles)
              throw new Error("Conversation files unavailable");
            context.signal?.throwIfAborted();
            await fs.writeFile(
              path.join(context.conversationFiles.hostPath, "report.txt"),
              "Container document"
            );
            return {
              path: `${context.conversationFiles.runtimePath}/report.txt`,
              user: context.userId,
              session: context.sessionId,
            };
          },
        },
      ],
    },
  ]);
  registerContainerToken("files-test", {
    agentId: agent.id,
    sessionId: "thread",
    userId: "alice",
    runId: "run",
    containerName: "container",
    roots: {
      workspace: home,
      data: path.join(home, "data"),
      uploads: path.join(home, "uploads"),
    },
    conversationFiles: { hostPath, runtimePath: "/workspace/files" },
  });
  try {
    const app = createInternalTools({
      getConfig: () => config,
      getRuntime: () => runtime,
    });
    const response = await app.request("/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentToken: "files-test",
        tool: "document",
        sessionId: "thread",
        args: { userId: "bob", path: "/somewhere-else" },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "/workspace/files/report.txt",
      user: "alice",
      session: "thread",
    });
    expect(await fs.readFile(path.join(hostPath, "report.txt"), "utf8")).toBe(
      "Container document"
    );
  } finally {
    removeContainerToken("files-test");
  }
});

it("sends a container conversation file and refuses a symlink to another conversation", async () => {
  const { createInternalTools } = await import("../server/internal-tools.js");
  const { registerContainerToken, removeContainerToken } =
    await import("../sdk/container/tokens.js");
  const { ContainerFileOutputAdapter } =
    await import("../sdk/container/file-output.js");
  const { getMediaFileMetadata } = await import("../media/metadata.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-send-files-"));
  homes.push(home);
  vi.stubEnv("YOPLAI_HOME", home);
  const hostPath = path.join(home, "alice");
  await fs.mkdir(hostPath);
  await fs.mkdir(path.join(home, "bob"));
  await fs.writeFile(path.join(hostPath, "report.txt"), "Edited document");
  await fs.mkdir(path.join(hostPath, "nested"));
  await fs.writeFile(
    path.join(hostPath, "nested", "report.txt"),
    "Nested report"
  );
  await fs.writeFile(
    path.join(home, "bob", "secret.txt"),
    "Bob's private document"
  );
  await fs.symlink(
    path.join(home, "bob", "secret.txt"),
    path.join(hostPath, "escape.txt")
  );
  const events: Array<{ type: string; fileId?: string }> = [];
  const params: import("../sdk/types.js").SdkRunParams = {
    agentId: "files",
    userId: "alice",
    agent: {
      id: "files",
      name: "Files",
      workspace: home,
      queueMode: "queue",
      model: { provider: "openai", model: "test" },
    },
    sessionId: "thread",
    message: "Send report",
    workspaceDir: home,
    abortSignal: new AbortController().signal,
    onHistoryEvent: () => undefined,
    onEvent: (event) => {
      events.push(event);
    },
  };
  const conversationFiles = { hostPath, runtimePath: "/workspace/files" };
  const adapter = new ContainerFileOutputAdapter();
  registerContainerToken("send-files-test", {
    agentId: "files",
    sessionId: "thread",
    userId: "alice",
    runId: "run",
    containerName: "container",
    roots: {
      workspace: home,
      data: path.join(home, "data"),
      uploads: path.join(home, "uploads"),
    },
    conversationFiles,
    registerFileOutput: (event, signal) =>
      adapter.handle(params, event, undefined, signal, conversationFiles),
  });
  try {
    const app = createInternalTools();
    const send = (file: string) =>
      app.request("/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentToken: "send-files-test",
          tool: "__register_file_output",
          sessionId: "thread",
          args: { path: file, mimeType: "text/plain" },
        }),
      });
    expect((await send("/workspace/files/report.txt")).status).toBe(200);
    const metadata = await getMediaFileMetadata(events[0].fileId!);
    expect(await fs.readFile(metadata!.path, "utf8")).toBe("Edited document");
    expect(
      (await send("/workspace/files/escape.txt")).status
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await send("/workspace/files/../bob/secret.txt")).status
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await send("/workspace/files/nested/report.txt")).status
    ).toBeGreaterThanOrEqual(400);
    expect(events).toHaveLength(1);
  } finally {
    removeContainerToken("send-files-test");
  }
});

it("refuses download of a conversation output without its owning user's identity", async () => {
  const { api } = await import("../server/api.core.js");
  const { ensureMediaDirectories, getMediaOutboundDir, registerMediaFile } =
    await import("../media/metadata.js");
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "yoplai-private-media-")
  );
  homes.push(home);
  vi.stubEnv("YOPLAI_HOME", home);
  await ensureMediaDirectories();
  const file = path.join(
    getMediaOutboundDir(),
    "11111111-1111-4111-8111-111111111111.txt"
  );
  await fs.writeFile(file, "Alice's private report");
  const media = await registerMediaFile({
    fileId: "11111111-1111-4111-8111-111111111111",
    direction: "outbound",
    filename: "report.txt",
    storedFilename: path.basename(file),
    path: file,
    mimeType: "text/plain",
    size: 22,
    agentId: "files",
    sessionId: "thread",
    userId: "alice",
  });
  const response = await api.request(`/media/download/${media.fileId}`);
  expect(response.status).toBe(403);
});
