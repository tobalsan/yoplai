import { describe, expect, it } from "vitest";
import { FILE_INPUT_ACCEPT, isSupportedFile } from "./attachments";

describe("attachment allowlist", () => {
  it("offers and accepts JSON and legacy PowerPoint with standard or generic browser MIME types", () => {
    const accept = FILE_INPUT_ACCEPT.split(",");
    for (const [filename, mimeType, extension] of [
      ["data.json", "application/json", ".json"],
      ["deck.ppt", "application/vnd.ms-powerpoint", ".ppt"],
    ]) {
      expect(accept).toContain(mimeType);
      expect(accept).toContain(extension);
      for (const type of [mimeType, "", "application/octet-stream"]) {
        expect(isSupportedFile(new File(["document"], filename, { type }))).toBe(true);
      }
    }
    expect(isSupportedFile(new File(["unknown"], "payload.exe", { type: "application/octet-stream" }))).toBe(false);
  });
});
