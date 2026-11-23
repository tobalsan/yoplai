import { isDeepStrictEqual } from "node:util";
import type { AgentConfig } from "./types.js";

type StopBot = () => void | Promise<void>;
const START_TIMEOUT_MS = 5_000;

/** Apply per-agent settings without restarting the extension or its shared bot. */
export function createChannelBotReconciler<Settings>(
  channel: string,
  readSettings: (agent: AgentConfig) => Settings | undefined
) {
  const running = new Map<string, { settings: Settings; stop: StopBot }>();
  const failed = new Map<string, { settings: Settings; retryAfter: number }>();
  return async function reconcile(
    agents: AgentConfig[],
    start: (agent: AgentConfig, settings: Settings) => Promise<StopBot | undefined>
  ): Promise<void> {
    const wanted = new Map(agents.flatMap((agent) => {
      const settings = readSettings(agent);
      return settings === undefined ? [] : [[agent.id, { agent, settings }] as const];
    }));

    for (const [id, bot] of running) {
      if (isDeepStrictEqual(bot.settings, wanted.get(id)?.settings)) continue;
      try {
        await bot.stop();
        running.delete(id);
      } catch {
        console.error(`[${channel}] Failed to stop bot for agent ${id}`);
      }
    }

    for (const [id, attempt] of failed) {
      if (!isDeepStrictEqual(attempt.settings, wanted.get(id)?.settings)) failed.delete(id);
    }

    await Promise.all([...wanted].map(async ([id, { agent, settings }]) => {
      if (running.has(id)) return;
      if ((failed.get(id)?.retryAfter ?? 0) > Date.now()) return;
      try {
        const stop = await start(agent, settings);
        if (stop) {
          running.set(id, { settings, stop });
          failed.delete(id);
        } else {
          failed.set(id, { settings, retryAfter: Date.now() + START_TIMEOUT_MS });
        }
      } catch {
        failed.set(id, { settings, retryAfter: Date.now() + START_TIMEOUT_MS });
        console.error(`[${channel}] Failed to start bot for agent ${id}`);
      }
    }));
  };
}

export function createChannelBotRegistry<Bot>() {
  const agents = new Map<string, Bot>();
  let component: Bot | undefined;

  return {
    getActiveBot: (agentId: string) => agents.get(agentId),
    getActiveBots: () => agents,
    registerActiveBot: (agentId: string, bot: Bot) => { agents.set(agentId, bot); },
    getComponentBot: () => component,
    registerComponentBot: (bot: Bot) => { component = bot; },
    clearActiveBots: () => {
      agents.clear();
      component = undefined;
    },
  };
}

export async function startRegisteredChannelBot<Bot extends { start(signal?: AbortSignal): Promise<void>; stop(): Promise<void> }>(
  bots: Map<string, Bot>,
  agentId: string,
  candidate: Bot | null | Promise<Bot | null>
): Promise<StopBot | undefined> {
  const bot = await candidate;
  if (!bot) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Channel bot startup timed out");
        controller.abort(error);
        reject(error);
      }, START_TIMEOUT_MS);
    });
    await Promise.race([bot.start(controller.signal), deadline]);
  } catch (error) {
    await bot.stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  bots.set(agentId, bot);
  return async () => {
    await bot.stop();
    bots.delete(agentId);
  };
}
