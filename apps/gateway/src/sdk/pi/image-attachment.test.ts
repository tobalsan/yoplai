import { describe, expect, it, vi } from "vitest";

const getFullHistory = vi.hoisted(() => vi.fn());
const getMediaFileMetadata = vi.hoisted(() => vi.fn());

vi.mock("../../history/store.js", () => ({ getFullHistory }));
vi.mock("../../media/metadata.js", () => ({ getMediaFileMetadata }));

import { findSessionImageAttachment } from "./adapter.js";

describe("findSessionImageAttachment", () => {
  const path = "/media/inbound/image.png";
  const history = [{ role: "user", content: [{ type: "file", direction: "inbound", mimeType: "image/png", fileId: "file-1" }] }];

  it("rejects metadata from another session", async () => {
    getFullHistory.mockResolvedValue(history);
    getMediaFileMetadata.mockResolvedValue({ path, mimeType: "image/png", filename: "image.png", size: 1, agentId: "agent", sessionId: "other" });
    await expect(findSessionImageAttachment("agent", "session", undefined, path)).resolves.toBeUndefined();
  });

  it("accepts the image recorded in the requesting session", async () => {
    getFullHistory.mockResolvedValue(history);
    getMediaFileMetadata.mockResolvedValue({ path, mimeType: "image/png", filename: "image.png", size: 1, agentId: "agent", sessionId: "session" });
    await expect(findSessionImageAttachment("agent", "session", "user", path)).resolves.toMatchObject({ path, mimeType: "image/png" });
    expect(getFullHistory).toHaveBeenCalledWith("agent", "session", "user");
  });
});
