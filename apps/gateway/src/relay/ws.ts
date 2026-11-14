import { WebSocket } from "ws";
import { addGatewaySuffix, removeGatewaySuffix } from "./agent-id.js";
import { remoteWsHeaders, remoteWsUrl } from "./remote.js";
import { getLinkedGateways } from "./state.js";
import type { RemoteGateway } from "./store.js";

type PageMessage = { type?: string; agentId?: string } & Record<string, unknown>;

type RemoteLink = { socket: WebSocket; queue: string[] };

/**
 * Carries the messages of one page socket to the remote gateways. It opens one
 * socket for each remote gateway that the page uses, and closes them with the page socket.
 */
export class RelayWsBridge {
  private readonly links = new Map<string, RemoteLink>();

  constructor(private readonly page: WebSocket) {}

  /** Returns true when the message belongs to a remote agent, or goes to the remote gateways too. */
  handle(raw: string): boolean {
    let message: PageMessage;
    try {
      message = JSON.parse(raw) as PageMessage;
    } catch {
      return false;
    }
    const gateways = getLinkedGateways();
    if (gateways.length === 0) return false;

    if (message.type === "subscribeStatus" || message.type === "unsubscribeStatus") {
      for (const gateway of gateways) this.sendTo(gateway, message);
      return false;
    }
    if (message.type === "unsubscribe") {
      for (const link of this.links.values()) link.socket.send(raw);
      return false;
    }
    if (message.type !== "subscribe" && message.type !== "send") return false;
    if (typeof message.agentId !== "string") return false;
    const target = removeGatewaySuffix(message.agentId, gateways.map((gateway) => gateway.name));
    const gateway = gateways.find((item) => item.name === target.gateway);
    if (!gateway) return false;
    this.sendTo(gateway, { ...message, agentId: target.agentId });
    return true;
  }

  close(): void {
    for (const link of this.links.values()) link.socket.close();
    this.links.clear();
  }

  private sendTo(gateway: RemoteGateway, message: PageMessage): void {
    const payload = JSON.stringify(message);
    const existing = this.links.get(gateway.name);
    if (existing) {
      if (existing.socket.readyState === WebSocket.OPEN) existing.socket.send(payload);
      else existing.queue.push(payload);
      return;
    }
    const socket = new WebSocket(remoteWsUrl(gateway), { headers: remoteWsHeaders(gateway) });
    const link: RemoteLink = { socket, queue: [payload] };
    this.links.set(gateway.name, link);
    socket.on("open", () => {
      for (const queued of link.queue.splice(0)) socket.send(queued);
    });
    socket.on("message", (data) => this.toPage(gateway.name, data.toString()));
    socket.on("error", () => {
      this.toPage(gateway.name, JSON.stringify({ type: "error", message: `Gateway ${gateway.name} is offline` }));
    });
    // Same result as a local agent whose socket closes: the page sees the close.
    socket.on("close", () => {
      this.links.delete(gateway.name);
      this.page.close();
    });
  }

  private toPage(gatewayName: string, raw: string): void {
    if (this.page.readyState !== WebSocket.OPEN) return;
    try {
      const event = JSON.parse(raw) as PageMessage;
      if (typeof event.agentId === "string") {
        event.agentId = addGatewaySuffix(event.agentId, gatewayName);
      }
      this.page.send(JSON.stringify(event));
    } catch {
      this.page.send(raw);
    }
  }
}
