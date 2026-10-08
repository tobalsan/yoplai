import { afterEach, describe, expect, it, vi } from "vitest";
import { removeMcpServer } from "./mcp-servers";

afterEach(() => vi.unstubAllGlobals());

describe("removeMcpServer", () => {
  it("explains that only admins can remove on 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Team configuration is unavailable", { status: 403 })));
    await expect(removeMcpServer("scribe", "docs")).rejects.toThrow("Only admins can remove this MCP server.");
  });

  it("keeps the generic message for other failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    await expect(removeMcpServer("scribe", "docs")).rejects.toThrow("Failed to remove MCP server.");
  });
});
