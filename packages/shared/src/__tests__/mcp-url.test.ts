import { describe, expect, it } from "vitest";
import { normalizeMcpServerUrl } from "../mcp-url.js";

describe("normalizeMcpServerUrl", () => {
  it("lowercases host, drops query/hash/trailing slash, keeps path", () => {
    expect(normalizeMcpServerUrl("HTTPS://MCP.Linear.app/Mcp/?a=1#x")).toBe("https://mcp.linear.app/Mcp");
    expect(normalizeMcpServerUrl("https://x.test/")).toBe("https://x.test");
    expect(normalizeMcpServerUrl("http://x.test:8080/a/b//")).toBe("http://x.test:8080/a/b");
  });
  it("returns null for non-http or invalid", () => {
    expect(normalizeMcpServerUrl("stdio://foo")).toBeNull();
    expect(normalizeMcpServerUrl("npx foo")).toBeNull();
    expect(normalizeMcpServerUrl("")).toBeNull();
  });
});
