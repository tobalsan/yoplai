import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
vi.mock("../config/index.js", () => ({
  get CONFIG_DIR() {
    return dir;
  },
}));

const { aggregateMcpCandidates, readMcpIconCache, readTopExtensions, sanitizeTopExtensions, writeTopExtensions } = await import("./top-extensions.js");

describe("top-extensions store", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-top-"));
  });

  it("returns empty lists when file missing", () => {
    expect(readTopExtensions()).toEqual({ extensions: [], mcp: [] });
  });

  it("round-trips atomically", () => {
    writeTopExtensions({ extensions: ["gmail"], mcp: ["https://a.test/mcp"] });
    expect(readTopExtensions()).toEqual({ extensions: ["gmail"], mcp: ["https://a.test/mcp"] });
    expect(fs.readdirSync(dir)).toEqual(["top-extensions.json"]);
  });

  it("tolerates corrupt file", () => {
    fs.writeFileSync(path.join(dir, "top-extensions.json"), "{nope");
    expect(readTopExtensions()).toEqual({ extensions: [], mcp: [] });
  });

  it("sanitizes: normalizes, dedupes, drops unknown ids and non-http", () => {
    expect(
      sanitizeTopExtensions(
        {
          extensions: ["gmail", "gmail", "ghost", 5],
          mcp: ["HTTPS://A.test/mcp/", "https://a.test/mcp?x=1", "npx foo"],
        },
        new Set(["gmail"])
      )
    ).toEqual({ extensions: ["gmail"], mcp: ["https://a.test/mcp"] });
  });

  it("aggregates MCP servers across agents by normalized URL, http only", () => {
    expect(
      aggregateMcpCandidates([
        { agentId: "a", name: "linear", config: { url: "https://mcp.linear.app/mcp" } },
        { agentId: "b", name: "linear_2", config: { url: "HTTPS://MCP.linear.app/mcp/?x=1" } },
        { agentId: "b", name: "linear_2", config: { url: "https://mcp.linear.app/mcp" } },
        { agentId: "a", name: "local", config: { command: "npx" } },
        { agentId: "a", name: "other", config: { url: "https://o.test/mcp" } },
      ])
    ).toEqual([
      { url: "https://mcp.linear.app/mcp", displayName: "linear", agentCount: 2 },
      { url: "https://o.test/mcp", displayName: "other", agentCount: 1 },
    ]);
  });

  it("adds cached MCP website icons by hostname, then root domain", () => {
    fs.mkdirSync(path.join(dir, "mcp"));
    fs.writeFileSync(
      path.join(dir, "mcp", "icons.json"),
      JSON.stringify({ "mcp.linear.app": "https://linear.app/icon.png", "claap.io": "https://claap.io/icon.png", bad: 1 })
    );
    const icons = readMcpIconCache();
    expect(icons).toEqual({ "mcp.linear.app": "https://linear.app/icon.png", "claap.io": "https://claap.io/icon.png" });
    expect(
      aggregateMcpCandidates(
        [
          { agentId: "a", name: "linear", config: { url: "https://mcp.linear.app/mcp" } },
          { agentId: "a", name: "claap", config: { url: "https://api.claap.io/mcp" } },
          { agentId: "a", name: "other", config: { url: "https://o.test/mcp" } },
        ],
        icons
      ).map((candidate) => [candidate.displayName, candidate.iconUrl])
    ).toEqual([
      ["claap", "https://claap.io/icon.png"],
      ["linear", "https://linear.app/icon.png"],
      ["other", undefined],
    ]);
  });

  it("treats a missing MCP icon cache as empty", () => {
    expect(readMcpIconCache()).toEqual({});
  });
});
