import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fallbackPath, parseProbedPath, probeShell, probeShellPath } from "./shell-path.js";

describe("parseProbedPath", () => {
  it("reads the PATH between the markers and ignores shell noise", () => {
    const output = "Welcome!\n__YOPLAI_PATH_START__/a/bin:/b/bin__YOPLAI_PATH_END__\nbye";
    expect(parseProbedPath(output)).toBe("/a/bin:/b/bin");
  });

  it("returns undefined for missing or empty markers", () => {
    expect(parseProbedPath("no markers")).toBeUndefined();
    expect(parseProbedPath("__YOPLAI_PATH_START__/a/bin")).toBeUndefined();
    expect(parseProbedPath("__YOPLAI_PATH_START____YOPLAI_PATH_END__")).toBeUndefined();
  });
});

describe("fallbackPath", () => {
  it("adds the Homebrew folders once and keeps the app PATH", () => {
    expect(fallbackPath("/usr/bin:/bin:/usr/local/bin")).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    expect(fallbackPath(undefined)).toBe("/opt/homebrew/bin:/usr/local/bin");
  });
});

describe("probeShell", () => {
  it("uses an absolute SHELL and falls back to zsh", () => {
    expect(probeShell("/bin/bash")).toBe("/bin/bash");
    expect(probeShell("bash")).toBe("/bin/zsh");
    expect(probeShell(undefined)).toBe("/bin/zsh");
  });
});

describe("probeShellPath", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A fake shell script. The probe calls it with -ilc. */
  function fakeShell(body: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-shell-"));
    dirs.push(dir);
    const file = path.join(dir, "shell.sh");
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  it("returns the PATH of the shell", async () => {
    const shell = fakeShell(`printf '__YOPLAI_PATH_START__/probe/bin:/usr/bin__YOPLAI_PATH_END__'`);
    expect(await probeShellPath({ shell, parentEnv: { PATH: "/usr/bin" } })).toBe("/probe/bin:/usr/bin");
  });

  it("falls back when the shell prints no markers", async () => {
    const shell = fakeShell(`echo nothing`);
    expect(await probeShellPath({ shell, parentEnv: { PATH: "/usr/bin" } })).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin");
  });

  it("falls back and kills the shell group after the time limit", async () => {
    const marker = path.join(os.tmpdir(), `yoplai-probe-survivor-${process.pid}`);
    const shell = fakeShell(`(/bin/sleep 2; /usr/bin/touch ${marker}) &\n/bin/sleep 30`);
    const started = Date.now();

    const result = await probeShellPath({ shell, parentEnv: { PATH: "/usr/bin" }, timeoutMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(Date.now() - started).toBeLessThan(2000 + 2500);
    expect(result).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("falls back when the output passes the size limit", async () => {
    const shell = fakeShell(`/usr/bin/head -c 200000 /dev/zero | /usr/bin/tr '\\0' 'a'\n/bin/sleep 30`);
    const started = Date.now();

    const result = await probeShellPath({ shell, parentEnv: { PATH: "/usr/bin" }, maxOutputBytes: 1024 });

    expect(Date.now() - started).toBeLessThan(2500);
    expect(result).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin");
  });

  it("falls back when the shell does not exist", async () => {
    expect(await probeShellPath({ shell: "/no/such/shell", parentEnv: { PATH: "/usr/bin" } })).toBe(
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin"
    );
  });
});
