import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseWakeAgent,
  resolveScriptPath,
  runScript,
  terminateRunningScripts,
} from "./script.js";

async function writeScript(
  dir: string,
  name: string,
  body: string,
  { executable = false }: { executable?: boolean } = {}
): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, body, "utf8");
  if (executable) await fs.chmod(filePath, 0o755);
  return filePath;
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runScript", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("exit 0 runs an executable script directly and captures stdout", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-script-"));
    await writeScript(tmpDir, "run", "#!/bin/sh\necho hello world\n", {
      executable: true,
    });

    const result = await runScript({
      workspaceDir: tmpDir,
      script: "run",
      timeoutMs: 5000,
    });

    expect(result.stdout.trim()).toBe("hello world");
    expect(result.finalStdoutLine).toBe("hello world");
  });

  it("non-zero exit throws an error message with the exit code", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-script-"));
    await writeScript(
      tmpDir,
      "fail",
      "#!/bin/sh\necho oops error >&2\nexit 3\n",
      { executable: true }
    );

    await expect(
      runScript({ workspaceDir: tmpDir, script: "fail", timeoutMs: 5000 })
    ).rejects.toThrow(/^script failed \(exit 3\)/);
  });

  it("kills the child (and its foreground grandchild) on timeout, no orphan left", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-script-"));
    const pidFile = path.join(tmpDir, "sleep.pid");
    await writeScript(
      tmpDir,
      "sleep.sh",
      `#!/bin/bash\nsleep 30 &\necho $! > "${pidFile}"\nwait\n`
    );

    await expect(
      runScript({ workspaceDir: tmpDir, script: "sleep.sh", timeoutMs: 200 })
    ).rejects.toThrow(/^script exceeded the 200ms timeout and was killed/);

    const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
    expect(Number.isInteger(pid)).toBe(true);

    // Give the OS a brief moment to finish reaping the killed grandchild.
    const deadline = Date.now() + 1000;
    let alive = await isPidAlive(pid);
    while (alive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      alive = await isPidAlive(pid);
    }
    expect(alive).toBe(false);
  });

  it("finishes when the script exits after backgrounding a process that holds stdout", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-script-"));
    await writeScript(tmpDir, "background.sh", "sleep 3 &\necho rotated\nexit 0\n");

    const result = await runScript({
      workspaceDir: tmpDir,
      script: "background.sh",
      timeoutMs: 1000,
    });

    expect(result.stdout.trim()).toBe("rotated");
  });

  it("terminates still-running scripts on scheduler stop", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-script-"));
    const pidFile = path.join(tmpDir, "child.pid");
    await writeScript(
      tmpDir,
      "long.sh",
      `echo $$ > "${pidFile}"\nsleep 30\n`
    );

    const pending = runScript({
      workspaceDir: tmpDir,
      script: "long.sh",
      timeoutMs: 30_000,
    });

    let pid = Number.NaN;
    const deadline = Date.now() + 2000;
    while (Number.isNaN(pid) && Date.now() < deadline) {
      try {
        pid = Number((await fs.readFile(pidFile, "utf8")).trim());
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(Number.isInteger(pid)).toBe(true);

    terminateRunningScripts();
    await expect(pending).rejects.toThrow(/^script failed \(exit signal\)/);
    expect(await isPidAlive(pid)).toBe(false);
  });

  it("keeps the wakeAgent gate line when stdout is truncated", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-script-"));
    await writeScript(
      tmpDir,
      "chatty-gate.sh",
      "head -c 100000 /dev/zero | tr '\\0' x\necho\necho '{\"wakeAgent\":false}'\n"
    );

    const result = await runScript({
      workspaceDir: tmpDir,
      script: "chatty-gate.sh",
      timeoutMs: 5000,
    });

    expect(result.stdout.endsWith("[output truncated]")).toBe(true);
    expect(result.finalStdoutLine).toBe('{"wakeAgent":false}');
    expect(parseWakeAgent(result.finalStdoutLine)).toEqual({ wake: false });
  });

  it("caps captured output while streaming and marks truncation", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-script-"));
    await writeScript(
      tmpDir,
      "chatty.sh",
      "#!/bin/bash\nhead -c 200000 /dev/zero | tr '\\0' x\n"
    );

    const result = await runScript({
      workspaceDir: tmpDir,
      script: "chatty.sh",
      timeoutMs: 5000,
    });

    expect(result.stdout.endsWith("[output truncated]")).toBe(true);
    expect(result.stdout.length).toBeLessThan(70 * 1024);
  });

  it("runs .sh scripts under bash even without the executable bit", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-script-"));
    await writeScript(tmpDir, "run.sh", "echo from bash\n");

    const result = await runScript({
      workspaceDir: tmpDir,
      script: "run.sh",
      timeoutMs: 5000,
    });

    expect(result.stdout.trim()).toBe("from bash");
  });

  it("rejects a non-.sh script that is not executable", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-script-"));
    await writeScript(tmpDir, "run", "#!/bin/sh\necho hi\n");

    await expect(
      runScript({ workspaceDir: tmpDir, script: "run", timeoutMs: 5000 })
    ).rejects.toThrow(/is not executable/);
  });
});

describe("resolveScriptPath containment", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("rejects a '..' escape", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-script-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeScript(tmpDir, "secret.sh", "echo nope\n");

    await expect(
      resolveScriptPath(workspaceDir, "../secret.sh")
    ).rejects.toThrow();
  });

  it("rejects an absolute path", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-script-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    await expect(
      resolveScriptPath(workspaceDir, "/etc/passwd")
    ).rejects.toThrow();
  });

  it("rejects a symlink escape", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-script-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const outsideDir = path.join(tmpDir, "outside");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    const target = await writeScript(outsideDir, "secret.sh", "echo nope\n");
    await fs.symlink(target, path.join(workspaceDir, "link.sh"));

    await expect(
      resolveScriptPath(workspaceDir, "link.sh")
    ).rejects.toThrow();
  });
});

describe("parseWakeAgent", () => {
  it("wakeAgent: false suppresses the wake", () => {
    expect(parseWakeAgent('{"wakeAgent":false}')).toEqual({ wake: false });
  });

  it("wakeAgent: true with context wakes with serialized context", () => {
    expect(
      parseWakeAgent('{"wakeAgent":true,"context":{"count":2}}')
    ).toEqual({ wake: true, context: JSON.stringify({ count: 2 }) });
  });

  it("missing wakeAgent key defaults to waking", () => {
    expect(parseWakeAgent('{"context":{"a":1}}')).toEqual({
      wake: true,
      context: JSON.stringify({ a: 1 }),
    });
  });

  it("non-JSON final line defaults to waking", () => {
    expect(parseWakeAgent("not json")).toEqual({ wake: true });
  });

  it("no stdout (undefined final line) defaults to waking", () => {
    expect(parseWakeAgent(undefined)).toEqual({ wake: true });
  });
});
