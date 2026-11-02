import { InvalidArgumentError, type Command } from "commander";
import fs from "node:fs/promises";
import { z } from "zod";
import { CONFIG_DIR, loadConfig } from "../config/index.js";

type ReportDeps = { configDir?: string; agentIds?: string[] };

function isoDate(value: string): number {
  if (!z.union([z.string().date(), z.string().datetime({ offset: true })]).safeParse(value).success) {
    throw new InvalidArgumentError("Expected an ISO date (YYYY-MM-DD or a timestamp with timezone)");
  }
  return Date.parse(value);
}

export function registerModelRoutingCommands(program: Command, deps: ReportDeps = {}): void {
  program.command("model-routing").description("Evaluate local model routing telemetry")
    .command("report").description("Report fresh-session routing decisions")
    .requiredOption("--since <date>", "Include sessions starting at or after this ISO date", isoDate)
    .option("--until <date>", "Include sessions starting before this ISO date", isoDate)
    .option("--agent <id>", "Include this agent (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--json", "Print JSON, including one row per session")
    .option("--out <file>", "Write the report to a file")
    .action(async (options: { since: number; until?: number; agent: string[]; json?: boolean; out?: string }) => {
      const [{ buildRoutingReport, renderRoutingReport }, { readRoutingSessions }] = await Promise.all([
        import("../model-routing/report.js"), import("../model-routing/session-reader.js"),
      ]);
      const sessions = await readRoutingSessions(deps.configDir ?? CONFIG_DIR,
        deps.agentIds ?? loadConfig().agents.map((agent) => agent.id));
      const report = buildRoutingReport(sessions, { since: options.since, until: options.until, agents: options.agent });
      const output = options.json ? JSON.stringify(report, null, 2) : renderRoutingReport(report);
      if (options.out) await fs.writeFile(options.out, `${output}\n`);
      else console.log(output);
    });
}
