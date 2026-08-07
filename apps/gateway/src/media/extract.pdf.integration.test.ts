import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import { extractPdfBuffer } from "./extract.js";
import { registerContainerToken, removeContainerToken } from "../sdk/container/tokens.js";
import { createInternalTools } from "../server/internal-tools.js";

const englishFixture = fileURLToPath(new URL("./__fixtures__/scanned-english.pdf", import.meta.url));
const frenchFixture = fileURLToPath(new URL("./__fixtures__/scanned-french.pdf", import.meta.url));
const mixedFixture = fileURLToPath(new URL("./__fixtures__/mixed.pdf", import.meta.url));
const tokens: string[] = [];

afterEach(() => {
  for (const token of tokens.splice(0)) removeContainerToken(token);
});

describe("PDF OCR gateway integration", () => {
  it("automatically OCRs scanned English, French, and only the sparse mixed page", async () => {
    await expect(extractPdfBuffer(await fs.readFile(englishFixture))).resolves.toContain("HELLO OCR ENGLISH");
    const french = await extractPdfBuffer(await fs.readFile(frenchFixture));
    expect(french.normalize("NFD").replace(/\p{Diacritic}/gu, "")).toContain("BONJOUR ELEVE FRANCAIS");
    const mixed = await extractPdfBuffer(await fs.readFile(mixedFixture));
    expect(mixed).toContain("MIXED PDF TEXT LAYER CONTENT THAT SHOULD NOT BE OC");
    expect(mixed.match(/HELLO OCR ENGLISH/g)).toHaveLength(1);
  }, 30_000);

  it("extracts a scanned PDF through the authenticated container callback", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-ocr-workspace-"));
    const token = "ocr-integration-token";
    tokens.push(token);
    await fs.copyFile(englishFixture, path.join(workspace, "scan.pdf"));
    registerContainerToken(token, {
      agentId: "agent-1", sessionId: "session-1", runId: "run-1", containerName: "container-1",
      roots: { workspace, data: path.join(workspace, "data"), uploads: path.join(workspace, "uploads") },
    });
    const app = createInternalTools({
      getConfig: () => ({ agents: [{ id: "agent-1" }], extensions: {} }) as unknown as GatewayConfig,
      getRuntime: () => ({}) as never,
    });

    try {
      const response = await app.request("/tools", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Agent-Id": "agent-1", "X-Agent-Token": token },
        body: JSON.stringify({ tool: "extract_document", args: { path: "/workspace/scan.pdf" }, agentId: "agent-1", agentToken: token, sessionId: "session-1", runId: "run-1", containerName: "container-1" }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ text: expect.stringContaining("HELLO OCR ENGLISH") });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
