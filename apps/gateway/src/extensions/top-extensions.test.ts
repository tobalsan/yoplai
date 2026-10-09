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

const { aggregateMcpCandidates, readMcpIconCache, readSharedMcpServerSources, readTopExtensions, sanitizeTopExtensions, writeTopExtensions } = await import("./top-extensions.js");

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

  it("labels MCP candidates with their configured displayName", () => {
    expect(
      aggregateMcpCandidates([
        { agentId: "a", name: "googleapis", config: { url: "https://calendarmcp.googleapis.com/mcp/v1", displayName: "Google Calendar" } },
        { agentId: "b", name: "zeta", config: { url: "https://z.test/mcp", displayName: "  " } },
      ]).map((candidate) => candidate.displayName)
    ).toEqual(["Google Calendar", "zeta"]);
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

  it("reads shared catalog servers, counting agents that enabled them", () => {
    fs.writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: {
        atlassian: { url: "https://mcp.atlassian.com/v1/mcp/", serverTitle: "Atlassian MCP" },
        pipedrive: { url: "https://mcp.pipedrive.ai/mcp", serverTitle: "Pipedrive", displayName: "Pipedrive CRM" },
        unused: { url: "https://unused.test/mcp" },
        bad: "nope",
      } })
    );
    const agentDir = (id: string, sharedServers: string[]) => {
      const workspace = path.join(dir, id);
      fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(workspace, "mcp.json"), JSON.stringify({ mcpServers: {}, sharedServers }));
      return { id, workspace };
    };
    const shared = readSharedMcpServerSources([agentDir("a", ["atlassian", "pipedrive"]), agentDir("b", ["atlassian"]), { id: "c" }]);
    expect(
      aggregateMcpCandidates([{ agentId: "a", name: "atl", config: { url: "https://mcp.atlassian.com/v1/mcp" } }, ...shared])
        .map((candidate) => [candidate.displayName, candidate.agentCount])
    ).toEqual([
      // Reported name beats config keys; local "atl" on agent a counts once.
      ["Atlassian MCP", 2],
      // Admin override beats the reported name.
      ["Pipedrive CRM", 1],
      // Enabled by nobody: still star-able.
      ["unused", 0],
    ]);
  });

  it("treats a missing shared catalog as empty", () => {
    expect(readSharedMcpServerSources()).toEqual([]);
  });

  it("treats a missing MCP icon cache as empty", () => {
    expect(readMcpIconCache()).toEqual({});
  });
});
