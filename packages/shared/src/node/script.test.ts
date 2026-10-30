import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveScriptPath, runScript, ScriptPathError, terminateRunningScripts } from "./script.js";

describe("shared script runner inputs", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-shared-script-"));
  });

  afterEach(async () => {
    terminateRunningScripts();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("writes the supplied stdin and closes it for a non-executable shell script", async () => {
    await fs.writeFile(path.join(workspaceDir, "stdin.sh"), "cat\n");
    const result = await runScript({
      workspaceDir,
      script: "stdin.sh",
      timeoutMs: 5000,
      stdin: '{"alert":"duplicate"}',
    });
    expect(result.stdout).toBe('{"alert":"duplicate"}');
  });

  it("survives a gate closing stdin without reading a one MiB body", async () => {
    await fs.writeFile(path.join(workspaceDir, "ignore.bash"), "exec 0<&-\necho ignored\n");
    const result = await runScript({
      workspaceDir,
      script: "ignore.bash",
      timeoutMs: 5000,
      stdin: "x".repeat(1024 * 1024),
    });
    expect(result.stdout).toBe("ignored\n");
  });

  it("merges supplied environment over inherited environment", async () => {
    await fs.writeFile(path.join(workspaceDir, "env.sh"),
      'printf "%s\\n%s\\n" "$YOPLAI_SCRIPT_TEST_VALUE" "$YOPLAI_SCRIPT_TEST_INHERITED"\n');
    process.env.YOPLAI_SCRIPT_TEST_VALUE = "inherited";
    process.env.YOPLAI_SCRIPT_TEST_INHERITED = "retained";
    try {
      const result = await runScript({
        workspaceDir,
        script: "env.sh",
        timeoutMs: 5000,
        env: { YOPLAI_SCRIPT_TEST_VALUE: "overridden" },
      });
      expect(result.stdout).toBe("overridden\nretained\n");
    } finally {
      delete process.env.YOPLAI_SCRIPT_TEST_VALUE;
      delete process.env.YOPLAI_SCRIPT_TEST_INHERITED;
    }
  });

  it("terminates one owner's scripts while leaving other owners and unowned scripts alive", async () => {
    await fs.writeFile(path.join(workspaceDir, "wait.sh"),
      'echo $$ > "$PID_FILE"\nwhile [ ! -f "$RELEASE_FILE" ]; do sleep 0.01; done\necho survived\n');
    const owners = ["webhooks", "scheduler", undefined];
    const pending = owners.map((owner, index) => runScript({
      workspaceDir,
      script: "wait.sh",
      timeoutMs: 10_000,
      owner,
      env: {
        PID_FILE: path.join(workspaceDir, `${index}.pid`),
        RELEASE_FILE: path.join(workspaceDir, "release"),
      },
    }).catch((error: unknown) => error));
    const pids: number[] = [];
    for (let index = 0; index < owners.length; index++) {
      await expect.poll(async () => {
        try {
          pids[index] = Number(await fs.readFile(path.join(workspaceDir, `${index}.pid`), "utf8"));
          return Number.isInteger(pids[index]);
        } catch {
          return false;
        }
      }).toBe(true);
    }

    terminateRunningScripts("webhooks");
    await expect(pending[0]).resolves.toMatchObject({ reason: "signal" });
    expect(() => process.kill(pids[0]!, 0)).toThrow();
    await fs.writeFile(path.join(workspaceDir, "release"), "");
    await expect(pending[1]).resolves.toMatchObject({ stdout: "survived\n" });
    await expect(pending[2]).resolves.toMatchObject({ stdout: "survived\n" });
  });

  it("distinguishes invalid containment from a missing script", async () => {
    const contained = path.join(workspaceDir, "contained");
    const outside = path.join(workspaceDir, "outside.sh");
    await fs.mkdir(contained);
    await fs.writeFile(outside, "echo outside\n");
    await fs.symlink(outside, path.join(contained, "escape.sh"));
    for (const script of [outside, "../outside.sh", "escape.sh"]) {
      await expect(resolveScriptPath(contained, script)).rejects.toBeInstanceOf(ScriptPathError);
    }
    await expect(resolveScriptPath(contained, "missing.sh")).rejects.not.toBeInstanceOf(ScriptPathError);
    await expect(runScript({ workspaceDir: contained, script: "missing.sh", timeoutMs: 5000 }))
      .rejects.toMatchObject({ reason: "spawn", stderrTail: "" });
  });
});
