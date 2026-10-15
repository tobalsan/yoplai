import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentConfigSchema,
  type AgentConfig,
  type GatewayConfig,
} from "@yoplai/shared";
import {
  buildContainerLaunchSpec,
  cleanupLaunchFilesystem,
  prepareContainerUploads,
  prepareLaunchFilesystem,
  remapAttachmentsToContainer,
  sanitizeFilename,
} from "./launch-spec.js";
import type { SdkRunParams } from "../types.js";

const tempDirs: string[] = [];

const mockGetMediaInboundDir = vi.hoisted(() => vi.fn());

vi.mock("../../media/metadata.js", () => ({
  getMediaInboundDir: mockGetMediaInboundDir,
}));

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-launch-spec-"));
  tempDirs.push(dir);
  return dir;
}

function createAgent(root: string): AgentConfig {
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return AgentConfigSchema.parse({
    id: "cloud",
    name: "Cloud",
    workspace,
    model: { provider: "anthropic", model: "claude-sonnet" },
    sandbox: { enabled: true },
  });
}

function createParams(agent: AgentConfig, sessionId: string): SdkRunParams {
  return {
    agentId: agent.id,
    agent,
    sessionId,
    message: "hello",
    workspaceDir: agent.workspace,
    onEvent: vi.fn(),
    onHistoryEvent: vi.fn(),
    abortSignal: new AbortController().signal,
  };
}

function mountSource(args: string[], target: string): string | undefined {
  const mount = args.find(
    (arg) => arg.startsWith("type=bind,") && arg.includes(`target=${target}`)
  );
  return mount?.match(/source=([^,]+)/)?.[1];
}

afterEach(() => {
  delete process.env.YOPLAI_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("container launch spec", () => {
  it.each(["opener", null])("mounts only the current session when owner %s differs from requester", (sessionOwnerId) => {
    const root = tempDir();
    process.env.YOPLAI_HOME = root;
    const agent = createAgent(root);
    const params = { ...createParams(agent, "thread"), userId: "requester", sessionOwnerId };
    const spec = buildContainerLaunchSpec(params, { agents: [agent], extensions: {} } as GatewayConfig);
    const expectedFile = sessionOwnerId
      ? path.join(root, "sessions", "users", sessionOwnerId, "sessions", agent.id, "thread.jsonl")
      : path.join(root, "sessions", agent.id, "thread.jsonl");
    const target = sessionOwnerId ? `/users/${sessionOwnerId}/sessions/${agent.id}/thread.jsonl` : "/sessions/thread.jsonl";
    expect(mountSource(spec.args, target)).toBe(expectedFile);
    expect(fs.existsSync(expectedFile)).toBe(true);
    const mountArgs = spec.args.filter((arg) => arg.startsWith("type=bind,"));
    expect(mountArgs).not.toContainEqual(expect.stringContaining(`source=${path.join(root, "sessions", "users", "opener")},`));
    expect(mountArgs).not.toContainEqual(expect.stringContaining(`source=${path.join(root, "sessions", agent.id)},`));
    expect(mountSource(spec.args, "/sessions")).toBe(path.join(spec.ipcDir, "sessions"));
    cleanupLaunchFilesystem(spec);
  });

  it("sanitizes names and remaps attachments to container upload paths", () => {
    expect(sanitizeFilename("../bad\rname.txt", "fallback")).toBe(
      "bad_name.txt"
    );
    expect(
      remapAttachmentsToContainer([
        {
          path: "/host/inbound/a.txt",
          filename: "../a.txt",
          mimeType: "text/plain",
          size: 1,
        },
      ])
    ).toEqual([
      {
        path: "/workspace/uploads/d78f174823f6-a.txt",
        filename: "../a.txt",
        mimeType: "text/plain",
        size: 1,
      },
    ]);
  });

  it("copies only inbound media files into the upload dir", () => {
    const root = tempDir();
    const inbound = path.join(root, "inbound");
    const uploads = path.join(root, "uploads");
    fs.mkdirSync(inbound, { recursive: true });
    const source = path.join(inbound, "note.txt");
    fs.writeFileSync(source, "hello");
    mockGetMediaInboundDir.mockReturnValue(inbound);

    prepareContainerUploads(
      [{ path: source, filename: "note.txt", mimeType: "text/plain", size: 5 }],
      uploads
    );

    const remapped = remapAttachmentsToContainer([
      { path: source, filename: "note.txt", mimeType: "text/plain", size: 5 },
    ]);
    expect(fs.readFileSync(path.join(uploads, path.basename(remapped![0].path)), "utf8")).toBe("hello");
  });
});

describe("per-run ipc namespaces", () => {
  it("gives concurrent runs of the same agent separate ipc namespaces", () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    const config = { agents: [agent], extensions: {} } as GatewayConfig;

    const first = buildContainerLaunchSpec(
      createParams(agent, "session-1"),
      config
    );
    const second = buildContainerLaunchSpec(
      createParams(agent, "session-2"),
      config
    );
    const sameSession = buildContainerLaunchSpec(
      createParams(agent, "session-1"),
      config
    );

    expect(first.runId).not.toBe(second.runId);
    expect(first.ipcDir).not.toBe(second.ipcDir);
    expect(sameSession.ipcDir).not.toBe(first.ipcDir);
    expect(first.ipcInputDir.startsWith(first.ipcDir)).toBe(true);
  });

  it("mounts the same ipc namespace it reports on the spec", () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    const config = { agents: [agent], extensions: {} } as GatewayConfig;

    const spec = buildContainerLaunchSpec(
      createParams(agent, "session-1"),
      config
    );

    expect(mountSource(spec.args, "/workspace/ipc")).toBe(spec.ipcDir);
  });

  it("does not wipe another live run's queued messages on launch", () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    const config = { agents: [agent], extensions: {} } as GatewayConfig;

    const firstParams = createParams(agent, "session-1");
    const first = buildContainerLaunchSpec(firstParams, config);
    prepareLaunchFilesystem(firstParams, first);
    const queued = path.join(first.ipcInputDir, "1-queued.json");
    fs.writeFileSync(queued, "{}");

    const secondParams = createParams(agent, "session-2");
    const second = buildContainerLaunchSpec(secondParams, config);
    prepareLaunchFilesystem(secondParams, second);

    expect(fs.existsSync(queued)).toBe(true);
    expect(fs.readdirSync(second.ipcInputDir)).toEqual([]);
  });

  it("cleans up only its own namespace when a run finishes", () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    const config = { agents: [agent], extensions: {} } as GatewayConfig;

    const firstParams = createParams(agent, "session-1");
    const first = buildContainerLaunchSpec(firstParams, config);
    prepareLaunchFilesystem(firstParams, first);
    const secondParams = createParams(agent, "session-2");
    const second = buildContainerLaunchSpec(secondParams, config);
    prepareLaunchFilesystem(secondParams, second);

    cleanupLaunchFilesystem(first);

    expect(fs.existsSync(first.ipcDir)).toBe(false);
    expect(fs.existsSync(second.ipcInputDir)).toBe(true);
  });
});
