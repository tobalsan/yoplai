import { mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

// Replace (do not merge) the ordinary test globs.
const { test, ...config } = base;
export default mergeConfig(config, {
  test: { ...test, include: ["apps/gateway/src/durable/eval/compaction.eval.ts"], fileParallelism: false },
});
