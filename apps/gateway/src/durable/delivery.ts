import type { ChannelActor, ChannelRoute } from "@yoplai/shared";
import { getAgent, loadConfig } from "../config/index.js";
import { durableModeFor } from "../durable-mode/resolve.js";
import type { GatewayExtensionContext } from "../extensions/context.js";
import { requireActorExecution } from "../extensions/runtime.js";
import { logWarn } from "../logging.js";

export async function mayUseChannel(
  agentId: string, owner: string, actor: ChannelActor, route: ChannelRoute, channels: GatewayExtensionContext,
  verifyDestination = false,
) {
  const { ingress, destination } = route;
  if (route.sink !== ingress.surface || destination.channel !== ingress.channel || !ingress.channel ||
      actor.surface !== ingress.surface || destination.user !== undefined) return false;
  if (ingress.surface === "slack" ? actor.surface !== "slack" || ingress.team !== actor.team
    : actor.surface !== "mattermost" || ingress.server !== actor.server) return false;
  if (await channels.resolveChannelOwner(ingress.surface, { agentId, ingress, actor, verifyDestination }) !== owner) return false;
  if (!await durableModeFor(owner === "local" ? undefined : owner, getAgent(agentId))) return false;
  try {
    await requireActorExecution(agentId, loadConfig(), owner);
    return true;
  } catch {
    return false;
  }
}

/** One scan at a time, including outcome commits. A periodic scan covers lost wakes. */
export class DeliveryWorker {
  private readonly abort = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  private scanning?: Promise<void>;

  constructor(private readonly scan: (signal: AbortSignal) => Promise<void>) {
    this.timer = setInterval(this.wake, 250).unref();
  }

  wake = () => {
    if (this.abort.signal.aborted || this.scanning) return;
    this.scanning = this.scan(this.abort.signal).catch(() => {
      logWarn("Durable channel delivery scan failed");
    }).finally(() => { this.scanning = undefined; });
  };

  async close() {
    clearInterval(this.timer);
    this.abort.abort();
    await this.scanning;
  }
}
