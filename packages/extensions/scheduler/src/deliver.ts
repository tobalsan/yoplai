import type {
  AgentConfig,
  DeliverTarget,
  ExtensionContext,
} from "@yoplai/shared";

/**
 * Fits the smallest supported channel message limit (Telegram's 4096) with room
 * left for transport metadata. Longer results are truncated, never dropped.
 */
export const MAX_DELIVERY_CHARS = 4000;
const TRUNCATION_MARKER = "\n[truncated]";

/**
 * A sink is a network call whose client may retry for minutes (or hang on a
 * black-holed socket). The scheduler awaits this fan-out inside its single
 * timer loop, so an unbounded wait would stall every agent's jobs; a slow
 * target is downgraded to the same recorded warning as a failing one.
 */
export const DELIVERY_TIMEOUT_MS = 30_000;

export type DeliveryOutcome = { target: string; ok: boolean; error?: string };

export type DeliveryRun = {
  jobName: string;
  status: "ok" | "error";
  /** A gate that chose not to wake the agent delivers nothing — that is the point. */
  silentTick?: boolean;
  /** Agent response, or script stdout for script-only jobs. */
  response?: string;
  errorMessage?: string;
};

/**
 * What a resolved run pushes to its targets, or `undefined` when it stays
 * silent. A failure ALWAYS delivers: a watchdog must not fail quietly.
 */
export function deliveryText(run: DeliveryRun): string | undefined {
  if (run.status === "error") {
    const error = run.errorMessage?.trim() || "Scheduler job failed";
    return truncate(`Cron job "${run.jobName}" failed:\n${error}`);
  }
  if (run.silentTick) return undefined;
  const response = run.response?.trim();
  if (!response) return undefined;
  return truncate(response);
}

/**
 * Pushes a resolved run to every configured target. A missing sink or a
 * throwing sink is a recorded warning: it never flips the run's status and
 * never stops the remaining targets from being attempted.
 */
export async function deliverRunResult(input: {
  ctx: ExtensionContext;
  agent: AgentConfig;
  targets?: DeliverTarget[];
  run: DeliveryRun;
}): Promise<DeliveryOutcome[]> {
  const targets = input.targets ?? [];
  if (targets.length === 0) return [];
  const text = deliveryText(input.run);
  if (text === undefined) return [];

  const outcomes: DeliveryOutcome[] = [];
  for (const target of targets) {
    const sink = input.ctx.getDeliverySink(target.target);
    if (!sink) {
      const error = `no delivery sink registered for "${target.target}"`;
      input.ctx.logger.warn(`[scheduler] Delivery skipped: ${error}`);
      outcomes.push({ target: target.target, ok: false, error });
      continue;
    }
    try {
      await withTimeout(
        sink({
          agent: input.agent,
          destination: { channel: target.channel, user: target.user },
          text,
        })
      );
      outcomes.push({ target: target.target, ok: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      input.ctx.logger.warn(
        `[scheduler] Delivery to ${target.target} failed: ${error}`
      );
      outcomes.push({ target: target.target, ok: false, error });
    }
  }
  return outcomes;
}

async function withTimeout(pending: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`delivery timed out after ${DELIVERY_TIMEOUT_MS}ms`)),
          DELIVERY_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_DELIVERY_CHARS) return text;
  let end = MAX_DELIVERY_CHARS - TRUNCATION_MARKER.length;
  // Never leave a lone high surrogate behind when the cut lands mid-character.
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
  return `${text.slice(0, end)}${TRUNCATION_MARKER}`;
}
