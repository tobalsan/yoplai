import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadWebhookSecrets,
  saveWebhookSecrets,
} from "@yoplai/extension-webhooks";
import { rotateWebhookSecret } from "./webhooks.js";

describe("webhooks CLI", () => {
  it("rotates an existing webhook secret and returns the new URL", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-webhooks-"));
    saveWebhookSecrets(dataDir, {
      "sales:notion": "old-secret",
      "sales:github": "unchanged",
    });

    const result = rotateWebhookSecret({
      agentId: "sales",
      webhookName: "notion",
      dataDir,
      baseUrl: "http://localhost:4000/",
    });

    expect(result.key).toBe("sales:notion");
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.secret).not.toBe("old-secret");
    expect(result.url).toBe(
      `http://localhost:4000/hooks/sales/notion/${result.secret}`
    );
    expect(loadWebhookSecrets(dataDir)).toEqual({
      "sales:notion": result.secret,
      "sales:github": "unchanged",
    });
  });

  it("errors when the webhook secret does not exist", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-webhooks-"));
    saveWebhookSecrets(dataDir, { "sales:notion": "secret" });

    expect(() =>
      rotateWebhookSecret({
        agentId: "sales",
        webhookName: "zendesk",
        dataDir,
        baseUrl: "http://localhost:4000",
      })
    ).toThrow(/Webhook secret not found for sales:zendesk/);
  });
});
