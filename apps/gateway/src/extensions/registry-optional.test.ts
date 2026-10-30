import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GatewayConfigSchema } from "@yoplai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@yoplai/extension-human-chat");
  vi.doUnmock("@yoplai/extension-scheduler");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("optional extension loading", () => {
  it("keeps core loading and reports a missing human-chat dependency for each enabled agent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yoplai-optional-extension-"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("@yoplai/extension-human-chat", () => ({
      get humanChatExtension() {
        throw Object.assign(new Error("Cannot find package 'lint' imported from human-chat"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    }));
    try {
      const { loadExtensions } = await import("./registry.js");
      const config = GatewayConfigSchema.parse({
        version: 3,
        extensionsPath: root,
        agents: ["alpha", "beta", "disabled"].map((id) => ({
          id, name: id, workspace: root,
          model: { provider: "anthropic", model: "claude" },
          extensions: { "human-chat": { enabled: id !== "disabled" } },
        })),
      });

      const extensions = await loadExtensions(config);

      expect(extensions.map((extension) => extension.id)).toEqual([
        "taskLifecycle", "capabilityDiscovery", "canvas", "sessionHistory",
      ]);
      expect(error.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        expect.objectContaining({
          level: "error", agentId: "alpha", extensionId: "human-chat",
          packageName: "@yoplai/extension-human-chat",
          message: expect.stringContaining("Cannot find package 'lint' imported from human-chat"),
        }),
        expect.objectContaining({
          level: "error", agentId: "beta", extensionId: "human-chat",
          packageName: "@yoplai/extension-human-chat",
          message: expect.stringContaining("Cannot find package 'lint' imported from human-chat"),
        }),
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the running core when human-chat is enabled after startup but its package is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yoplai-optional-reload-"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("@yoplai/extension-human-chat", () => ({
      get humanChatExtension() {
        throw Object.assign(new Error("Cannot find module '@yoplai/extension-human-chat'"), {
          code: "MODULE_NOT_FOUND",
        });
      },
    }));
    try {
      const { loadExtensions, reloadExtensions } = await import("./registry.js");
      await loadExtensions(GatewayConfigSchema.parse({ version: 3, extensionsPath: root, agents: [] }));
      const config = GatewayConfigSchema.parse({
        version: 3,
        extensionsPath: root,
        agents: [{
          id: "reload-agent", name: "Reload Agent", workspace: root,
          model: { provider: "anthropic", model: "claude" },
          extensions: { "human-chat": {} },
        }],
      });

      const extensions = await reloadExtensions(config);

      expect(extensions.map((extension) => extension.id)).toEqual([
        "taskLifecycle", "capabilityDiscovery", "canvas", "sessionHistory",
      ]);
      expect(error.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        expect.objectContaining({
          level: "error", agentId: "reload-agent", extensionId: "human-chat",
          packageName: "@yoplai/extension-human-chat",
          message: "Cannot find module '@yoplai/extension-human-chat'",
        }),
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects human-chat initialization errors unrelated to missing modules", async () => {
    vi.doMock("@yoplai/extension-human-chat", () => ({
      get humanChatExtension() {
        throw new Error("human-chat initialization failed");
      },
    }));
    const { loadExtensions } = await import("./registry.js");
    const config = GatewayConfigSchema.parse({
      version: 3,
      agents: [{
        id: "main", name: "Main", workspace: "~/agents/main",
        model: { provider: "anthropic", model: "claude" },
        extensions: { "human-chat": {} },
      }],
    });

    await expect(loadExtensions(config)).rejects.toThrow("human-chat initialization failed");
  });

  it("still rejects a missing enabled required extension", async () => {
    vi.doMock("@yoplai/extension-scheduler", () => ({
      get schedulerExtension() {
        throw Object.assign(new Error("Cannot find module '@yoplai/extension-scheduler'"), {
          code: "MODULE_NOT_FOUND",
        });
      },
    }));
    const { loadExtensions } = await import("./registry.js");
    const config = GatewayConfigSchema.parse({
      version: 3, agents: [], extensions: { scheduler: {} },
    });

    await expect(loadExtensions(config)).rejects.toThrow("Cannot find module '@yoplai/extension-scheduler'");
  });
});
