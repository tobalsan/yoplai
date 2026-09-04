import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock("../logging.js", () => ({ logError }));

import { registerModelCommands, runModelRefreshCommand } from "./models.js";

const temporaryDirs: string[] = [];

async function makeTemporaryDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-models-test-"));
  temporaryDirs.push(dir);
  return dir;
}

describe("models CLI", () => {
  afterEach(async () => {
    process.exitCode = undefined;
    logError.mockReset();
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  it("registers models refresh", () => {
    const program = new Command();
    registerModelCommands(program);

    const models = program.commands.find(
      (command) => command.name() === "models"
    );
    const refresh = models?.commands.find(
      (command) => command.name() === "refresh"
    );

    expect(refresh).toBeDefined();
    expect(refresh?.description()).toBe(
      "Refresh Pi model catalogs from the network"
    );
  });

  it("refreshes the network catalog in CONFIG_DIR and reports the store path", async () => {
    const configDir = await makeTemporaryDir();
    const refresh = vi.fn().mockResolvedValue({
      aborted: false,
      errors: new Map(),
    });
    const createRuntime = vi.fn().mockResolvedValue({ refresh });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runModelRefreshCommand({ configDir, createRuntime });

    expect(createRuntime).toHaveBeenCalledWith({
      authPath: path.join(configDir, "auth.json"),
      modelsPath: path.join(configDir, "models.json"),
      allowModelNetwork: true,
      refreshOnCreate: false,
    });
    expect(refresh).toHaveBeenCalledWith({
      allowNetwork: true,
      force: true,
      signal: expect.any(AbortSignal),
    });
    expect(log).toHaveBeenNthCalledWith(1, "Refreshing model catalog...");
    expect(log).toHaveBeenNthCalledWith(
      2,
      `Model catalog refreshed: ${path.join(configDir, "models-store.json")}`
    );
  });

  it.each([
    {
      name: "provider failure",
      result: {
        aborted: false,
        errors: new Map([["anthropic", new Error("catalog unavailable")]]),
      },
      message: "Model catalog refresh failed: anthropic: catalog unavailable",
    },
    {
      name: "timeout",
      result: { aborted: true, errors: new Map() },
      message: "Model catalog refresh timed out after 30 seconds",
    },
  ])("reports $name and sets a failing exit code", async ({ result, message }) => {
    const configDir = await makeTemporaryDir();
    const program = new Command();
    program.exitOverride();
    registerModelCommands(program, {
      configDir,
      createRuntime: vi.fn().mockResolvedValue({
        refresh: vi.fn().mockResolvedValue(result),
      }),
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await program.parseAsync(["node", "yoplai", "models", "refresh"]);

    expect(logError).toHaveBeenCalledWith(
      "Model catalog refresh failed",
      expect.objectContaining({ message })
    );
    expect(process.exitCode).toBe(1);
  });
});
