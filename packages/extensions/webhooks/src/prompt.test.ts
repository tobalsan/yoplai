import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { interpolateWebhookPrompt, resolveWebhookPrompt } from "./prompt.js";

describe("webhook prompts", () => {
  it("treats non-text-file prompts as inline strings", async () => {
    await expect(
      resolveWebhookPrompt("Handle $WEBHOOK_PAYLOAD", "/tmp")
    ).resolves.toBe("Handle $WEBHOOK_PAYLOAD");
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
    ).resolves.toBe("Notion: $WEBHOOK_PAYLOAD");
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
