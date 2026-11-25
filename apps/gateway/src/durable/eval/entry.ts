import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { preflight, run } from "./runner.js";
import { FULL, HAIKU } from "./scenario.js";

export function requirePaid(optIn: string | undefined) {
  if (optIn !== "1") throw new Error("Paid eval refused: set YOPLAI_EVAL_PAID=1 only after approving the projection.");
}

export function settings(args: string[]) {
  const { values } = parseArgs({ args, options: {
    full: { type: "boolean" }, model: { type: "string", multiple: true }, "cache-retention": { type: "string" },
    "output-dir": { type: "string" }, "preflight-only": { type: "boolean" },
  } });
  const retention = values["cache-retention"];
  if (retention && retention !== "long" && retention !== "default") throw new Error("Expected --cache-retention long or default");
  const models = [...new Set([...(values.model ?? (values.full ? [] : [HAIKU])), ...(values.full ? [FULL] : [])])];
  return { models, full: Boolean(values.full), retention, preflightOnly: values["preflight-only"],
    dir: values["output-dir"] ?? path.join(os.homedir(), "Documents", "artifacts") };
}

export async function prepare(model: string, full: boolean) {
  const variant = full ? "full" : "cheap";
  const cut = await preflight(model, variant);
  const baseline = await preflight(model, "baseline");
  return { model, variant, cut, baseline } as const;
}

export async function pair(plan: Awaited<ReturnType<typeof prepare>>, options: { faux?: boolean; long?: boolean }) {
  const apiKey = options.faux ? undefined : getEnvApiKey(plan.model.split("/")[0]!);
  if (!options.faux && !apiKey) throw new Error(`No environment API key for ${plan.model}`);
  const cut = await run(plan.model, plan.variant, plan.cut, { ...options, apiKey, idle: options.faux ? async () => {} : undefined });
  const baseline = await run(plan.model, "baseline", plan.baseline, { ...options, apiKey });
  return { model: plan.model, cut, baseline };
}
