/**
 * `yoplai eval run` subcommand.
 *
 * Headless single-turn agent invocation for Harbor evals. Reads an
 * instruction file, runs one agent turn, and writes result.json +
 * trajectory.json (ATIF) to the configured output paths.
 *
 * See docs/plans/harbor-evals-for-yoplai-migration.md §2 for the contract.
 */

import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { runEval } from "./runtime.js";
import { logError } from "../logging.js";

type EvalRunOpts = {
  agent: string;
  instructionFile: string;
  output: string;
  trace: string;
  config?: string;
  model?: string;
};

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

export function registerEvalCommands(program: Command): void {
  const evalCmd = program
    .command("eval")
    .description("Headless eval entrypoints (used by Harbor tasks)");

  evalCmd
    .command("run")
    .description("Run one agent turn against an instruction file")
    .requiredOption("-a, --agent <id>", "Agent id from yoplai.json")
    .requiredOption(
      "-i, --instruction-file <path>",
      "Path to instruction text file"
    )
    .option(
      "-o, --output <path>",
      "Where to write result.json",
      "/logs/agent/result.json"
    )
    .option(
      "-t, --trace <path>",
      "Where to write ATIF trajectory.json",
      "/logs/agent/trajectory.json"
    )
    .option("-c, --config <path>", "Override yoplai.json path")
    .option("-m, --model <id>", "Override the agent's configured model")
    .action(async (opts: EvalRunOpts) => {
      let instruction: string;
      try {
        instruction = await fs.readFile(opts.instructionFile, "utf-8");
      } catch (err) {
        logError(
          `Failed to read instruction file ${opts.instructionFile}`,
          err
        );
        process.exit(2);
      }

      try {
        const { result, trajectory } = await runEval({
          agentId: opts.agent,
          instruction,
          modelOverride: opts.model,
          configPath: opts.config ? path.resolve(opts.config) : undefined,
        });

        await writeJsonAtomic(opts.output, result);
        await writeJsonAtomic(opts.trace, trajectory);

        // Exit 0 on completed runs even if the agent produced a "wrong"
        // answer — that's the verifier's job. Non-zero only on infra
        // errors (caught above + below).
        if (result.status === "error") {
          logError("Agent run errored", result.error);
        }
        process.exit(0);
      } catch (err) {
        logError("eval run failed", err);
        process.exit(1);
      }
    });
}
