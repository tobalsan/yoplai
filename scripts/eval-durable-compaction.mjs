import { spawnSync } from "node:child_process";

const { status, error } = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.durable-eval.config.ts"], {
  stdio: "inherit", env: { ...process.env, YOPLAI_EVAL_ARGS: JSON.stringify(process.argv.slice(2)) },
});
if (error) throw error;
process.exitCode = status ?? 1;
