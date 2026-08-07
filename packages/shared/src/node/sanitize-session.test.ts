import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeSessionFile,
  sanitizeSessionFile,
} from "./sanitize-session.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true }))
  );
});

describe("sanitizeSessionFile", () => {
  it("redacts nested credentials and signed URL parameters in Pi JSONL", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-sanitize-"));
    tempDirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    const canary = "disposable-private-canary";
    await fs.writeFile(
      file,
      `${JSON.stringify({
        toolCall: { arguments: { authorization: `Bearer ${canary}` } },
        toolResult: `https://files.example.test/report.csv?X-Amz-Signature=${canary}&page=2`,
      })}\n`
    );

    await sanitizeSessionFile(file);

    const stored = await fs.readFile(file, "utf8");
    expect(stored).not.toContain(canary);
    expect(stored).toContain("https://files.example.test/report.csv?");
    expect(stored).toContain("page=2");
  });

  it("keeps raw Pi writes out of the durable session file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-sanitize-"));
    tempDirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    const canary = "disposable-runtime-canary";
    const runtime = await createRuntimeSessionFile(file);

    await fs.writeFile(
      runtime.file,
      `${JSON.stringify({ authorization: canary })}\n`
    );
    await expect(fs.readFile(file, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await runtime.persist();

    await expect(fs.readFile(file, "utf8")).resolves.not.toContain(canary);
  });
});
