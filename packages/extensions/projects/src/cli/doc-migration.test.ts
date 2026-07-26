import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { createProjectsCommand } from "./index.js";
import { registerSlicesCommands } from "./slices.js";
import {
  migrateProjectPitchFromReadme,
  migrateSliceSpecsFromReadme,
} from "./doc-migration.js";

let prevHome: string | undefined;
let homeDir: string;
let projectsRoot: string;

async function setupProject(
  id: string,
  body = "Pitch body\n"
): Promise<string> {
  const dir = path.join(projectsRoot, `${id}_test`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "README.md"),
    `---\nid: ${JSON.stringify(id)}\ntitle: "Test"\nstatus: "active"\n---\n${body}`,
    "utf8"
  );
  return dir;
}

async function setupSlice(
  projectId: string,
  sliceId: string,
  body = "Specs body\n"
): Promise<string> {
  const projectDir = await setupProject(projectId);
  const sliceDir = path.join(projectDir, "slices", sliceId);
  await fs.mkdir(sliceDir, { recursive: true });
  await fs.writeFile(
    path.join(sliceDir, "README.md"),
    `---\nid: ${JSON.stringify(sliceId)}\nproject_id: ${JSON.stringify(projectId)}\ntitle: "Slice"\nstatus: "todo"\n---\n${body}`,
    "utf8"
  );
  return sliceDir;
}

function createSlicesProgram(): Command {
  const program = new Command("slices");
  program.exitOverride();
  registerSlicesCommands(program);
  return program;
}

beforeEach(async () => {
  prevHome = process.env.YOPLAI_HOME;
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-home-"));
  projectsRoot = path.join(homeDir, "projects");
  await fs.mkdir(projectsRoot, { recursive: true });
  process.env.YOPLAI_HOME = homeDir;
  await fs.writeFile(
    path.join(homeDir, "yoplai.json"),
    JSON.stringify({
      agents: [],
      extensions: { projects: { root: projectsRoot } },
    }),
    "utf8"
  );
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = prevHome;
  await fs.rm(homeDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("doc migration helpers", () => {
  it("projects pitch copies README body and logs through the command", async () => {
    const projectDir = await setupProject("PRO-101", "Legacy pitch\n");
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ""));
    });
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      errors.push(String(msg ?? ""));
    });

    await createProjectsCommand()
      .exitOverride()
      .parseAsync(["node", "projects", "pitch", "PRO-101", "--from-readme"]);

    await expect(
      fs.readFile(path.join(projectDir, "PITCH.md"), "utf8")
    ).resolves.toBe("Legacy pitch\n");
    expect(logs[0]).toBe("PITCH.md written from README.md for PRO-101.");
    expect(errors).toEqual([]);
  });

  it("projects pitch refuses overwrite unless --force is passed", async () => {
    const projectDir = await setupProject("PRO-102", "New pitch\n");
    await fs.writeFile(path.join(projectDir, "PITCH.md"), "Existing\n", "utf8");

    await expect(migrateProjectPitchFromReadme("PRO-102")).rejects.toThrow(
      "PITCH.md already exists for PRO-102. Use --force to overwrite."
    );
    await expect(
      fs.readFile(path.join(projectDir, "PITCH.md"), "utf8")
    ).resolves.toBe("Existing\n");

    await migrateProjectPitchFromReadme("PRO-102", { force: true });
    await migrateProjectPitchFromReadme("PRO-102", { force: true });
    await expect(
      fs.readFile(path.join(projectDir, "PITCH.md"), "utf8")
    ).resolves.toBe("New pitch\n");
  });

  it("projects pitch reports missing README", async () => {
    const projectDir = path.join(projectsRoot, "PRO-103_test");
    await fs.mkdir(projectDir, { recursive: true });

    await expect(migrateProjectPitchFromReadme("PRO-103")).rejects.toThrow(
      "README.md not found for PRO-103"
    );
  });

  it("projects pitch writes an empty body for frontmatter-only README", async () => {
    const projectDir = await setupProject("PRO-104", "");

    await migrateProjectPitchFromReadme("PRO-104");

    await expect(
      fs.readFile(path.join(projectDir, "PITCH.md"), "utf8")
    ).resolves.toBe("");
  });

  it("slices specs copies README body and logs through the command", async () => {
    const sliceDir = await setupSlice(
      "PRO-201",
      "PRO-201-S01",
      "Legacy specs\n"
    );
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ""));
    });
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      errors.push(String(msg ?? ""));
    });

    await createSlicesProgram().parseAsync([
      "node",
      "slices",
      "specs",
      "PRO-201-S01",
      "--from-readme",
    ]);

    await expect(
      fs.readFile(path.join(sliceDir, "SPECS.md"), "utf8")
    ).resolves.toBe("Legacy specs\n");
    expect(logs[0]).toBe("SPECS.md written from README.md for PRO-201-S01.");
    expect(errors).toEqual([]);
  });

  it("slices specs refuses overwrite unless --force is passed", async () => {
    const sliceDir = await setupSlice(
      "PRO-202",
      "PRO-202-S01",
      "Migrated specs\n"
    );
    await fs.writeFile(
      path.join(sliceDir, "SPECS.md"),
      "Existing specs\n",
      "utf8"
    );

    await expect(migrateSliceSpecsFromReadme("PRO-202-S01")).rejects.toThrow(
      "SPECS.md already exists for PRO-202-S01. Use --force to overwrite."
    );
    await expect(
      fs.readFile(path.join(sliceDir, "SPECS.md"), "utf8")
    ).resolves.toBe("Existing specs\n");

    await migrateSliceSpecsFromReadme("PRO-202-S01", { force: true });
    await migrateSliceSpecsFromReadme("PRO-202-S01", { force: true });
    await expect(
      fs.readFile(path.join(sliceDir, "SPECS.md"), "utf8")
    ).resolves.toBe("Migrated specs\n");
  });

  it("slices specs reports missing README", async () => {
    const projectDir = await setupProject("PRO-203");
    await fs.mkdir(path.join(projectDir, "slices", "PRO-203-S01"), {
      recursive: true,
    });

    await expect(migrateSliceSpecsFromReadme("PRO-203-S01")).rejects.toThrow(
      "README.md not found for PRO-203-S01"
    );
  });

  it("slices specs writes an empty body for frontmatter-only README", async () => {
    const sliceDir = await setupSlice("PRO-204", "PRO-204-S01", "");

    await migrateSliceSpecsFromReadme("PRO-204-S01");

    await expect(
      fs.readFile(path.join(sliceDir, "SPECS.md"), "utf8")
    ).resolves.toBe("");
  });
});
