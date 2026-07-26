import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runConfigMigrateCommand, runConfigValidateCommand } from "./index.js";

describe("yoplai projects config commands", () => {
  let prevHome: string | undefined;
  let prevHomeDir: string | undefined;
  let prevConfig: string | undefined;
  let tmpHome = "";
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    prevHomeDir = process.env.YOPLAI_HOME;
    prevConfig = process.env.YOPLAI_CONFIG;
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-config-cli-"));
    process.env.HOME = tmpHome;
    process.env.YOPLAI_HOME = path.join(tmpHome, ".yoplai");
    delete process.env.YOPLAI_CONFIG;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    if (prevConfig === undefined) delete process.env.YOPLAI_CONFIG;
    else process.env.YOPLAI_CONFIG = prevConfig;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("prints dry-run migration summary without writing", async () => {
    const configPath = path.join(tmpHome, ".yoplai", "yoplai.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          agents: [
            {
              id: "main",
              name: "Main",
              workspace: "~/agents/main",
              model: { provider: "anthropic", model: "claude" },
              discord: {
                token: "$env:DISCORD_TOKEN",
                channelId: "123",
              },
              heartbeat: { every: "30m" },
            },
          ],
          scheduler: { enabled: true },
          projects: { root: "~/projects" },
        },
        null,
        2
      )
    );

    runConfigMigrateCommand({ dryRun: true });

    const output = logSpy.mock.calls.map(([line]) => String(line));
    expect(output).toContain(`Config path: ${configPath}`);
    expect(output).toContain("Config version: 1 (legacy)");
    expect(output).toContain("Migration would:");
    expect(
      output.some((line) =>
        line.includes('Move agent "main" discord config -> extensions.discord')
      )
    ).toBe(true);
    expect(output).toContain("No changes written (dry run).");

    const file = await fs.readFile(configPath, "utf8");
    expect(file).not.toContain('"version": 2');
  });

  it("writes migrated config and backup", async () => {
    const configPath = path.join(tmpHome, "custom.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          agents: [
            {
              id: "main",
              name: "Main",
              workspace: "~/agents/main",
              model: { provider: "anthropic", model: "claude" },
            },
          ],
        },
        null,
        2
      )
    );

    runConfigMigrateCommand({ config: configPath });

    const migrated = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      version?: number;
      extensions?: Record<string, unknown>;
    };
    const backupPath = configPath.replace(/\.json$/i, ".v1.json");
    const backup = await fs.readFile(backupPath, "utf8");
    const output = logSpy.mock.calls.map(([line]) => String(line));

    expect(migrated.version).toBe(2);
    expect(backup).not.toContain('"version": 2');
    expect(output).toContain(`Migrated ${configPath} from v1 -> v2`);
    expect(output).toContain(`Backup saved to ${backupPath}`);
  });

  it("validates config through migrated v2 shape", async () => {
    const configPath = path.join(tmpHome, ".yoplai", "yoplai.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          agents: [
            {
              id: "main",
              name: "Main",
              workspace: "~/agents/main",
              model: { provider: "anthropic", model: "claude" },
            },
          ],
        },
        null,
        2
      )
    );

    runConfigValidateCommand();

    const output = logSpy.mock.calls.map(([line]) => String(line));
    expect(output).toContain(`Config path: ${configPath}`);
    expect(output).toContain("Config version: 1 (legacy)");
    expect(output).toContain("Agents: main");
    expect(output).toContain("Components: none");
    expect(output).toContain("Config is valid");
  });
});
