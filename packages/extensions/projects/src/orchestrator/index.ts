import { notify, type GatewayConfig } from "@yoplai/shared";
import {
  createOrchestratorAttemptTracker,
  createStallTracker,
  dispatchOrchestratorTick,
} from "./dispatcher.js";
import {
  getOrchestratorConfig,
  type OrchestratorConfig,
} from "./config.js";
import { createHitlBurstBuffer } from "./hitl.js";

export type OrchestratorDaemon = {
  stop(): Promise<void>;
};

export function resolveHitlNotifyChannel(
  config: GatewayConfig,
  channel: string | undefined
): string | undefined {
  if (!channel) return undefined;
  if (config.notifications?.channels?.[channel]) return channel;
  throw new Error(
    `Orchestrator HITL channel "${channel}" is not configured in notifications.channels`
  );
}


export function startOrchestratorDaemon(
  config: GatewayConfig
): OrchestratorDaemon | null {
  const orchestratorConfig = getOrchestratorConfig(config);
  if (!orchestratorConfig.enabled) return null;

  const attempts = createOrchestratorAttemptTracker();
  const stalls = createStallTracker();
  const hitlChannel = resolveHitlNotifyChannel(
    config,
    orchestratorConfig.hitl_channel
  );
  const hitl = hitlChannel
    ? createHitlBurstBuffer({
        notify: async (message) => {
          const summary = await notify({
            config: config.notifications,
            channel: hitlChannel,
            message,
            surface: "both",
            discordToken: config.extensions?.discord?.token,
            slackToken: config.extensions?.slack?.token,
          });
          if (!summary.ok) {
            throw new Error("all notification surfaces failed");
          }
        },
        log: console.error,
      })
    : undefined;
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await dispatchOrchestratorTick(config, orchestratorConfig, {
        attempts,
        stalls,
        hitl,
      });
    } catch (error) {
      console.error(
        `component=orchestrator action=tick_failed error=${JSON.stringify(
          error instanceof Error ? error.message : String(error)
        )}`
      );
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, orchestratorConfig.poll_interval_ms);
  void tick();

  return {
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      attempts.clear();
      stalls.clear();
      await hitl?.stop();
    },
  };
}

export { getOrchestratorConfig, type OrchestratorConfig };
export { SliceDispatchPolicy } from "./dispatch-policy.js";
export { OrchestratorPromptFactory } from "./prompt-factory.js";
export { OrchestratorRunPlanner } from "./run-planner.js";
