import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { repairSessionTools } from "./repair-session-tools.js";

const exec = promisify(execFile);
const script = fileURLToPath(
  new URL("./repair-session-tools.ts", import.meta.url)
);
const dirs: string[] = [];
const tool = {
  name: "scheduler_create_job",
  description: "Create a job",
  parameters: {
    type: "object",
    properties: { credentialMode: { type: "string" } },
  },
};
const poisoned = { ...tool, parameters: "[REDACTED]" };
const system = {
  type: "message",
  message: { role: "system", toolsAdded: [tool] },
};
const compacted = {
  type: "compaction",
  systemMessage: { role: "system", toolsAdded: [poisoned] },
};

describe("repairSessionTools", () => {
  it("rejects later, redacted, and non-system sources", () => {
    const input = [
      { type: "message", message: { role: "system", toolsAdded: [poisoned] } },
      { type: "message", message: { role: "user", toolsAdded: [tool] } },
      compacted,
      system,
    ];

    expect(repairSessionTools(input)).toEqual({
      lines: input,
      restored: [],
      unrestorable: ["scheduler_create_job"],
    });
  });

  it("uses the latest earlier clean declaration, including clean compactions, without mutating input", () => {
    const newer = {
      ...tool,
      description: "Updated declaration",
      parameters: { type: "object" },
    };
    const clean = {
      type: "compaction",
      systemMessage: { role: "system", toolsAdded: [newer] },
    };
    const redactedDescription = { ...tool, description: "Bearer [REDACTED]" };
    const target = {
      type: "compaction",
      systemMessage: { role: "system", toolsAdded: [redactedDescription] },
    };
    const input = [system, clean, target];
    const original = JSON.stringify(input);

    const result = repairSessionTools(input);

    expect(result).toEqual({
      lines: [system, clean, clean],
      restored: ["scheduler_create_job"],
      unrestorable: [],
    });
    expect(JSON.stringify(input)).toBe(original);
  });
});

async function fixture(content: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repair-session-"));
  dirs.push(dir);
  const file = path.join(dir, "users", "alice", "sessions", "session.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return { dir, file };
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe("repair-session-tools CLI", () => {
  it("preserves the session and existing backup if backup creation fails", async () => {
    const content = `${JSON.stringify(system)}\n${JSON.stringify(compacted)}`;
    const { file } = await fixture(content);
    await fs.writeFile(`${file}.bak`, "previous backup");

    await expect(
      exec(process.execPath, ["--import", "tsx", script, "--write", file])
    ).rejects.toMatchObject({ code: 1 });

    expect(await fs.readFile(file, "utf8")).toBe(content);
    expect(await fs.readFile(`${file}.bak`, "utf8")).toBe("previous backup");
  });

  it("does nothing on a second write and creates no backup for a clean file", async () => {
    const { dir, file } = await fixture(
      `${JSON.stringify(system)}\n${JSON.stringify(compacted)}`
    );
    await exec(process.execPath, ["--import", "tsx", script, "--write", file]);
    const repaired = await fs.readFile(file, "utf8");
    const backup = await fs.readFile(`${file}.bak`, "utf8");
    const before = await fs.stat(file);
    const cleanFile = path.join(dir, "clean.jsonl");
    await fs.writeFile(cleanFile, JSON.stringify(system));

    const { stdout } = await exec(process.execPath, [
      "--import",
      "tsx",
      script,
      "--write",
      dir,
    ]);

    expect(stdout).not.toContain(": repaired");
    expect(await fs.readFile(file, "utf8")).toBe(repaired);
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(`${file}.bak`, "utf8")).toBe(backup);
    await expect(fs.stat(`${cleanFile}.bak`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves the entire file untouched when one tool lacks an earlier verbatim source", async () => {
    const missing = { ...poisoned, name: "scheduler_update_job" };
    const entry = {
      ...compacted,
      systemMessage: { role: "system", toolsAdded: [poisoned, missing] },
    };
    const content = [system, entry]
      .map((line) => JSON.stringify(line))
      .join("\n");
    const { file } = await fixture(content);

    const { stdout } = await exec(process.execPath, [
      "--import",
      "tsx",
      script,
      "--write",
      file,
    ]);

    expect(stdout).toContain("restore: scheduler_create_job");
    expect(stdout).toContain("unrestorable: scheduler_update_job");
    expect(await fs.readFile(file, "utf8")).toBe(content);
    await expect(fs.stat(`${file}.bak`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes restored declarations with a backup, preserving unrelated lines and endings", async () => {
    const content = `  ${JSON.stringify(system)}\r\nnot JSON\n${JSON.stringify(compacted)}\r\n`;
    const { file } = await fixture(content);

    await exec(process.execPath, ["--import", "tsx", script, "--write", file]);

    expect(await fs.readFile(`${file}.bak`, "utf8")).toBe(content);
    expect(await fs.readFile(file, "utf8")).toBe(
      `  ${JSON.stringify(system)}\r\nnot JSON\n${JSON.stringify({
        type: "compaction",
        systemMessage: { role: "system", toolsAdded: [tool] },
      })}\r\n`
    );
  });

  it("dry-runs recursively over per-user sessions without writing", async () => {
    const content = `${JSON.stringify(system)}\n${JSON.stringify(compacted)}\n`;
    const { dir, file } = await fixture(content);

    const { stdout } = await exec(process.execPath, [
      "--import",
      "tsx",
      script,
      dir,
    ]);

    expect(stdout).toContain(file);
    expect(stdout).toContain("restore: scheduler_create_job");
    expect(stdout).toContain("dry run");
    expect(await fs.readFile(file, "utf8")).toBe(content);
    await expect(fs.stat(`${file}.bak`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
