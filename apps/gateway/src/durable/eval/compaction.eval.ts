import { it } from "vitest";
import { pair, prepare, requirePaid, settings } from "./entry.js";
import { report } from "./report.js";
import { projection } from "./runner.js";
import { FULL, HAIKU } from "./scenario.js";

it("runs the opt-in Durable compaction eval", async () => {
  const opts = settings(JSON.parse(process.env.YOPLAI_EVAL_ARGS ?? "[]"));
  const plans = [];
  for (const model of opts.models) plans.push(await prepare(model, opts.full && model === FULL));
  if (opts.preflightOnly) return;
  const dry = [];
  for (const plan of plans) dry.push(await pair(plan, { faux: true }));
  console.log(projection(dry));
  requirePaid(process.env.YOPLAI_EVAL_PAID);
  for (const plan of plans) {
    const { model, cut, baseline } = await pair(plan, { long: plan.variant !== "full" && (opts.retention === "long" || (!opts.retention && plan.model === HAIKU)) });
    console.log(`Report: ${await report(opts.dir, model, cut, baseline, plan.variant === "full")}`);
  }
}, 2 * 60 * 60 * 1000);
