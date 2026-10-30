import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { interpolateWebhookPrompt, resolveWebhookPrompt } from "./prompt.js";

describe("webhook prompts", () => {
  it("treats non-text-file prompts as inline strings", async () => {
    await expect(
      resolveWebhookPrompt("Handle $WEBHOOK_PAYLOAD", "/tmp")
    ).resolves.toEqual({ prompt: "Handle $WEBHOOK_PAYLOAD", options: {} });
  });

  it("reads md and txt prompts relative to workspace", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-webhook-prompt-")
    );
    await fs.mkdir(path.join(workspace, "webhooks"));
    await fs.writeFile(
      path.join(workspace, "webhooks", "notion.md"),
      "Notion: $WEBHOOK_PAYLOAD",
      "utf8"
    );

    await expect(
      resolveWebhookPrompt("./webhooks/notion.md", workspace)
    ).resolves.toEqual({ prompt: "Notion: $WEBHOOK_PAYLOAD", options: {} });
  });

  it("rejects prompt files outside the workspace", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-webhook-prompt-")
    );
    const workspace = path.join(parent, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(parent, "secret.md"), "nope", "utf8");

    await expect(
      resolveWebhookPrompt("../secret.md", workspace)
    ).rejects.toThrow("Webhook prompt path must stay within agent workspace");
  });

  it.each([
    ["empty block", "---\n---\nHello", "Hello", { scriptTimeoutMs: 30000 }],
    [
      "comments only",
      "---\n# gate is optional\n---\nHello",
      "Hello",
      { scriptTimeoutMs: 30000 },
    ],
    [
      "CRLF",
      "---\r\nreasoning: high\r\n---\r\nHello\r\nworld",
      "Hello\r\nworld",
      { reasoning: "high", scriptTimeoutMs: 30000 },
    ],
    [
      "unclosed block",
      "---\nreasoning: high\nHello",
      "---\nreasoning: high\nHello",
      {},
    ],
    [
      "horizontal rule",
      "---\nA section\n--- decorated\nHello",
      "---\nA section\n--- decorated\nHello",
      {},
    ],
  ])(
    "resolves %s in a prompt file",
    async (_name, content, prompt, options) => {
      const workspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "yoplai-webhook-prompt-")
      );
      try {
        await fs.writeFile(path.join(workspace, "hook.txt"), content);
        await expect(
          resolveWebhookPrompt("hook.txt", workspace)
        ).resolves.toEqual({ prompt, options });
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    }
  );

  it("interpolates webhook variables", () => {
    const result = interpolateWebhookPrompt(
      "URL=$WEBHOOK_ORIGIN_URL HEADERS=$WEBHOOK_HEADERS BODY=$WEBHOOK_PAYLOAD",
      {
        originUrl: "https://example.test/hooks/agent/notion/secret",
        headers: { "content-type": "application/json" },
        payload: '{"ok":true}',
      }
    );

    expect(result).toBe(
      "URL=https://example.test/hooks/agent/notion/secret " +
        'HEADERS={"content-type":"application/json"} BODY={"ok":true}'
    );
  });
});
