import fs from "node:fs/promises";
import type { AgentConfig } from "@yoplai/shared";
import { CONFIG_DIR, getAgent } from "../config/index.js";
import type { GatewayExtensionContext } from "../extensions/context.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { logError } from "../logging.js";
import type { OpsMetrics } from "../server/ops-metrics.js";
import type { DurableHostOptions } from "./host.js";
import { durableStorePath } from "./store-path.js";
import { DeliveryWorker, mayUseChannel } from "./delivery.js";

export class DurableWeb {
  private readonly hosts = new Map<string, ReturnType<typeof import("./host.js").DurableHost.open>>();
  private closing?: Promise<void>;
  private recovering?: Promise<void>;
  private readonly delivery?: DeliveryWorker;

  constructor(
    private readonly runtime: ExtensionRuntime,
    private readonly metrics: OpsMetrics,
    private readonly options: DurableHostOptions = {},
    channels?: GatewayExtensionContext,
  ) {
    if (!channels) return;
    this.delivery = new DeliveryWorker(async (signal) => {
      for (const opening of this.hosts.values()) {
        if (signal.aborted) return;
        const host = await opening.catch(() => undefined);
        await host?.deliveries.scan(channels, signal);
      }
    });
    channels.connectChannelInput(async (input) => {
      if (this.closing) throw new Error("Gateway is shutting down.");
      const agent = getAgent(input.agentId);
      const eligible = async () => {
        const allowed = await mayUseChannel(input.agentId, input.owner, input.actor, input.route, channels);
        if (this.closing) throw new Error("Gateway is shutting down.");
        return allowed;
      };
      if (!agent || input.surface !== input.actor.surface || !await eligible()) return { status: "not_durable" };
      return (await this.host(agent)).submitChannel(input, eligible);
    });
  }

  host(agent: AgentConfig) {
    if (this.closing) throw new Error("Gateway is shutting down.");
    let host = this.hosts.get(agent.id);
    if (!host) {
      host = import("./host.js").then(({ DurableHost }) => DurableHost.open(CONFIG_DIR, agent, this.runtime, this.metrics, {
        ...this.options, wakeDelivery: this.options.deliveryFixture?.suppressWake ? undefined : this.delivery?.wake,
      }));
      this.hosts.set(agent.id, host);
      void host.catch(() => this.hosts.delete(agent.id));
    }
    return host;
  }

  resumeExisting(agents: readonly AgentConfig[]) {
    return this.recovering ??= this.openExisting(agents);
  }

  private async openExisting(agents: readonly AgentConfig[]) {
    await Promise.all(agents.filter((agent) => !agent.sandbox?.enabled).map(async (agent) => {
      try {
        const store = await fs.stat(durableStorePath(CONFIG_DIR, agent.id)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        // Shutdown can begin while the filesystem check is pending.
        if (store?.isFile() && !this.closing) await this.host(agent);
      } catch (error) {
        logError("Could not resume Durable agent", error, { agentId: agent.id });
      }
    }));
  }

  async deliveryMetrics() {
    await this.recovering;
    let pending = 0;
    let uncertain = 0;
    let oldest = Infinity;
    for (const opening of this.hosts.values()) {
      const host = await opening.catch(() => undefined);
      if (!host) continue;
      const counts = await host.deliveries.metrics();
      pending += counts.pending;
      uncertain += counts.uncertain;
      oldest = Math.min(oldest, counts.oldest);
    }
    return { queueAgeSeconds: Number.isFinite(oldest) ? Math.max(0, (Date.now() - oldest) / 1000) : 0, pending, uncertain };
  }

  close() {
    return this.closing ??= this.closeHosts();
  }

  private async closeHosts() {
    await this.delivery?.close();
    await Promise.all([...this.hosts.values()].map(async (opening) => {
      const host = await opening.catch(() => undefined);
      await host?.close();
    }));
  }
}
