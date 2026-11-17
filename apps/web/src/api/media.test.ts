import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadFiles } from "./media";

describe("uploadFiles", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the agent of an upload as a query parameter and not in the form", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ path: "/p", mimeType: "text/plain", filename: "f.txt", size: 1 })
    );
    vi.stubGlobal("fetch", fetchMock);
    await uploadFiles([new File(["x"], "note.txt", { type: "text/plain" })], "pom@ams");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url, "http://ui.test").searchParams.get("agentId")).toBe("pom@ams");
    expect((init.body as FormData).has("agentId")).toBe(false);
  });
});
