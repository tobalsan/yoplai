import fs from "node:fs/promises";
import type { AgentConfig, ChannelCommand } from "@yoplai/shared";
import { CONFIG_DIR, getAgent, loadConfig } from "../config/index.js";
import type { GatewayExtensionContext } from "../extensions/context.js";
import { requireActorExecution, type ExtensionRuntime } from "../extensions/runtime.js";
import { durableAgentEligible, durableModeFor } from "../durable-mode/resolve.js";
import { logError } from "../logging.js";
import type { OpsMetrics } from "../server/ops-metrics.js";
import type { DurableHostOptions } from "./host.js";
import { durableStorePath } from "./store-path.js";
import { DeliveryWorker, mayUseChannel } from "./delivery.js";
import type { RoomEvent, RoomStore } from "../rooms/store.js";

export class DurableWeb {
  private readonly hosts = new Map<string, ReturnType<typeof import("./host.js").DurableHost.open>>();
  private closing?: Promise<void>;
  private recovering?: Promise<void>;
  private readonly delivery?: DeliveryWorker;
  private readonly unsubscribeRooms?: () => void;

  constructor(
    private readonly runtime: ExtensionRuntime,
    private readonly metrics: OpsMetrics,
    private readonly options: DurableHostOptions = {},
    channels?: GatewayExtensionContext,
    private readonly rooms?: RoomStore,
  ) {
    this.unsubscribeRooms = rooms?.onEvent((event) => this.onRoomEvent(event));
    if (!channels) return;
    this.delivery = new DeliveryWorker(async (signal) => {
      for (const opening of this.hosts.values()) {
        if (signal.aborted) return;
        const host = await opening.catch(() => undefined);
        await host?.deliveries.scan(channels, signal);
      }
    });
    const checkChannel = ({ agentId, owner, actor, route }: Pick<ChannelCommand, "agentId" | "owner" | "actor" | "route">) => async () => {
      if (this.closing) throw new Error("Gateway is shutting down.");
      const allowed = await mayUseChannel(agentId, owner, actor, route, channels);
      if (this.closing) throw new Error("Gateway is shutting down.");
      return allowed;
    };
    channels.connectChannelInput(async (input) => {
      const agent = getAgent(input.agentId);
      const eligible = checkChannel(input);
      if (!agent || input.surface !== input.actor.surface || !await eligible()) return { status: "not_durable" };
      return (await this.host(agent)).submitChannel(input, eligible);
    });
    channels.connectChannelCommand(async (input) => {
      const agent = getAgent(input.agentId);
      const eligible = checkChannel(input);
      if (!agent || !await eligible()) return { status: "not_durable" };
      if (input.command === "ignored") return { status: "ignored" };
      return (await this.host(agent)).stopChannel(input, eligible);
    });
    channels.connectWebhookInput(async (input) => {
      const agent = await this.backgroundAgent(input.agentId, input.owner);
      return agent ? (await this.host(agent)).submitWebhook(input) : { status: "not_durable" };
    });
    channels.connectJobTick(async (input) => {
      const agent = await this.backgroundAgent(input.agentId, input.owner);
      return agent ? (await this.host(agent)).runJobTick(input) : { status: "not_durable" };
    });
  }

  private onRoomEvent(event: RoomEvent) {
    if (!this.rooms || this.closing || event.type === "memberRemoved") return;
    const { roomId } = event;
    const wake = (agentId: string, host: ReturnType<DurableWeb["host"]> | undefined) => {
      void host?.then((opened) => opened.wakeRoom(roomId)).catch((error: unknown) => {
        logError("Could not open Durable room agent", error, { agentId, roomId });
      });
    };
    if (event.type === "roomDeleted") {
      for (const [agentId, host] of this.hosts) wake(agentId, host);
      return;
    }
    if (event.type === "agentRemoved") {
      wake(event.agentId, this.hosts.get(event.agentId));
      return;
    }
    const agentIds = event.type === "agentAdded" ? [event.agentId] : this.rooms.agentsForRoom(roomId);
    for (const agentId of agentIds) {
      const agent = getAgent(agentId);
      if (durableAgentEligible(agent)) wake(agentId, this.host(agent));
    }
  }

  private async backgroundAgent(agentId: string, owner: string) {
    if (this.closing) throw new Error("Gateway is shutting down.");
    const config = loadConfig();
    const multiUser = config.extensions?.multiUser?.enabled;
    if (!owner || (!multiUser && owner !== "local")) return;
    const agent = getAgent(agentId);
    if (!agent || !await durableModeFor(owner === "local" ? undefined : owner, agent)) return;
    try {
      await requireActorExecution(agentId, config, owner);
      return agent;
    } catch {
      return undefined;
    }
  }

  host(agent: AgentConfig) {
    if (this.closing) throw new Error("Gateway is shutting down.");
    let host = this.hosts.get(agent.id);
    if (!host) {
      host = import("./host.js").then(({ DurableHost }) => DurableHost.open(CONFIG_DIR, agent, this.runtime, this.metrics, {
        ...this.options, wakeDelivery: this.options.deliveryFixture?.suppressWake ? undefined : this.delivery?.wake,
      }, this.rooms));
      this.hosts.set(agent.id, host);
      void host.catch(() => this.hosts.delete(agent.id));
    }
    return host;
  }

  resumeExisting(agents: readonly AgentConfig[]) {
    return this.recovering ??= this.openExisting(agents);
  }

  private async openExisting(agents: readonly AgentConfig[]) {
    await Promise.all(agents.filter(durableAgentEligible).map(async (agent) => {
      try {
        const store = await fs.stat(durableStorePath(CONFIG_DIR, agent.id)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        // Shutdown can begin while the filesystem check is pending.
        const hasRoomEvents = this.rooms?.roomsForAgent(agent.id).some(({ roomId }) => this.rooms!.lastSeq(roomId) > 0);
        if ((store?.isFile() || hasRoomEvents) && !this.closing) await this.host(agent);
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
    this.unsubscribeRooms?.();
    await this.delivery?.close();
    await Promise.all([...this.hosts.values()].map(async (opening) => {
      const host = await opening.catch(() => undefined);
      await host?.close();
    }));
  }
}
