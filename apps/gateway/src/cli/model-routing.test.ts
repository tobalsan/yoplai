import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerModelRoutingCommands } from "./model-routing.js";

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

it("requires --since before reading history", async () => {
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  registerModelRoutingCommands(program);
  await expect(program.parseAsync(["node", "yoplai", "model-routing", "report"]))
    .rejects.toThrow("required option '--since <date>' not specified");
});

it("prints a JSON session row from local history without message text", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "routing-cli-"));
  try {
    await fs.mkdir(path.join(dir, "history"));
    await fs.writeFile(path.join(dir, "history/agent-fresh.jsonl"), [
      JSON.stringify({ type: "history", agentId: "agent", sessionId: "fresh", role: "user", timestamp: 1793577600000, content: "PRIVATE-CLI-CANARY" }),
      JSON.stringify({ type: "meta", key: "modelRouteAttempt", value: {
        v: 1, at: 1793577600001, mode: "shadow", tableVersion: "v1", threshold: 0.8, seq: 1,
        userMessageAt: 1793577600000, predicate: { result: "no", probability: 0.1, latencyMs: 2 },
        decision: "none", noLockReason: "predicate-no", actual: "openai/usual", totalMs: 3,
      } }),
    ].join("\n"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = new Command().exitOverride();
    registerModelRoutingCommands(program, { configDir: dir, agentIds: ["agent"] });
    await program.parseAsync(["node", "yoplai", "model-routing", "report", "--since", "2026-11-01", "--json"]);
    const output = log.mock.calls[0]?.[0] as string;
    expect(JSON.parse(output).sessions).toEqual([
      expect.objectContaining({ owner: "single-user", agent: "agent", session: "fresh", tableVersion: "v1", state: "shadow", actual: "openai/usual" }),
    ]);
    expect(output).not.toContain("PRIVATE-");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

it("prints Markdown with no data for an empty home", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "routing-cli-empty-"));
  try {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = new Command().exitOverride();
    registerModelRoutingCommands(program, { configDir: dir, agentIds: [] });
    await program.parseAsync(["node", "yoplai", "model-routing", "report", "--since", "2026-11-01"]);
    expect(log.mock.calls[0]?.[0]).toContain("# Model routing report");
    expect(log.mock.calls[0]?.[0]).toContain("no data");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

it("writes a filtered report to --out with repeatable agents and an exclusive until", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "routing-cli-filter-"));
  try {
    await fs.mkdir(path.join(dir, "history"));
    for (const [agent, day] of [["a", "02"], ["b", "03"], ["c", "02"]]) {
      await fs.writeFile(path.join(dir, `history/${agent}-session.jsonl`), [
        JSON.stringify({ type: "history", role: "user", timestamp: Date.parse(`2026-11-${day}T00:00:00Z`), content: "PRIVATE-FILTER-CANARY" }),
        JSON.stringify({ type: "meta", key: "modelRoute", value: {
          version: 1, kind: "usual", mode: "shadow", provider: "openai", model: "usual",
          category: "work", score: 0.7, tableVersion: "v1", reason: "score<0.8", decidedAt: `2026-11-${day}T00:00:01.000Z`,
        } }),
      ].join("\n"));
    }
    const output = path.join(dir, "report.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = new Command().exitOverride();
    registerModelRoutingCommands(program, { configDir: dir, agentIds: ["a", "b", "c"] });
    await program.parseAsync(["node", "yoplai", "model-routing", "report", "--since", "2026-11-01", "--until", "2026-11-03", "--agent", "a", "--agent", "b", "--json", "--out", output]);
    const text = await fs.readFile(output, "utf8");
    expect(JSON.parse(text).sessions.map((row: { agent: string }) => row.agent)).toEqual(["a"]);
    expect(text).not.toContain("PRIVATE-");
    expect(log).not.toHaveBeenCalled();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

it.each(["yesterday", "2026-02-30", "2026-11-01junk"])("rejects non-ISO or impossible --since %s", async (date) => {
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  registerModelRoutingCommands(program, { configDir: "/not-read", agentIds: [] });
  await expect(program.parseAsync(["node", "yoplai", "model-routing", "report", "--since", date]))
    .rejects.toThrow("Expected an ISO date");
});
