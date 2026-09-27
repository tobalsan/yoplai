import fs from "node:fs/promises";
import http from "node:http";
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

  it("keeps system-message tool declarations verbatim while redacting other entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-sanitize-"));
    tempDirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    const canary = "disposable-tool-schema-canary";
    const toolsAdded = [
      {
        name: "list_issues",
        description: "List issues. Pass assignee or signature filters.",
        parameters: {
          type: "object",
          properties: {
            assignee: { type: "string", description: "User id or name" },
            signature: { type: "string" },
          },
          required: ["assignee"],
        },
      },
    ];
    const toolsRemoved = [{ name: "design_signoff" }];
    const systemEntry = {
      type: "message",
      id: "sys1",
      message: {
        role: "system",
        content: `apiKey=${canary}`,
        toolsAdded,
        toolsRemoved,
        timestamp: 1,
      },
    };
    const userEntry = {
      type: "message",
      id: "user1",
      message: {
        role: "user",
        content: `Use Bearer ${canary}`,
        apiKey: canary,
        timestamp: 2,
      },
    };
    await fs.writeFile(
      file,
      `${JSON.stringify(systemEntry)}\n${JSON.stringify(userEntry)}\n`
    );

    await sanitizeSessionFile(file);

    const [storedSystem, storedUser] = (await fs.readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(storedSystem.message.toolsAdded).toEqual(toolsAdded);
    expect(storedSystem.message.toolsRemoved).toEqual(toolsRemoved);
    expect(storedSystem.message.content).toBe("apiKey=[REDACTED]");
    expect(storedUser.message.apiKey).toBe("[REDACTED]");
    expect(storedUser.message.content).toBe("Use Bearer [REDACTED]");
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

  it("uses a signed URL before persisting its redacted representation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-sanitize-"));
    tempDirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    const canary = "disposable-signed-url-canary";
    let requestUrl: string | undefined;
    const server = http.createServer((request, response) => {
      requestUrl = request.url;
      response.end("downloaded");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );

    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No test port");
      const signedUrl = `http://127.0.0.1:${address.port}/report.csv?X-Amz-Signature=${canary}&page=2`;
      const runtime = await createRuntimeSessionFile(file);

      await fs.writeFile(
        runtime.file,
        `${JSON.stringify({ url: signedUrl })}\n`
      );
      const { url: executionUrl } = JSON.parse(
        await fs.readFile(runtime.file, "utf8")
      ) as { url: string };
      await expect(fetch(executionUrl)).resolves.toMatchObject({ ok: true });
      expect(requestUrl).toContain(canary);
      await runtime.persist();

      const stored = await fs.readFile(file, "utf8");
      expect(stored).not.toContain(canary);
      expect(stored).toContain(`/report.csv?X-Amz-Signature=[REDACTED]&page=2`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
