import type { IncomingHttpHeaders } from "node:http";
import { WebSocket } from "ws";
import { getAgent } from "../config/index.js";
import { addGatewaySuffix } from "./agent-id.js";
import { remoteWsHeaders, remoteWsUrl } from "./remote.js";
import { getLinkedGateways, isTrustedRequest, resolveRemoteAgent } from "./state.js";
import type { RemoteGateway } from "./store.js";

type PageMessage = { type?: string; agentId?: string } & Record<string, unknown>;

/** `chat` is false while the link serves status messages only. */
type RemoteLink = { socket: WebSocket; queue: string[]; chat: boolean };

export const CONNECT_TIMEOUT_MS = 10_000;
export const MAX_QUEUED_MESSAGES = 20;

/**
 * Carries the messages of one page socket to the remote gateways. It opens one
 * socket for each remote gateway that the page uses, and closes them with the page socket.
 */
export class RelayWsBridge {
  private readonly links = new Map<string, RemoteLink>();
  private readonly trusted: boolean;
  /** The gateway of the active session subscription. Unset means a local agent or none. */
  private subscribedGateway: string | undefined;

  constructor(
    private readonly page: WebSocket,
    headers: IncomingHttpHeaders | undefined,
    private readonly dropLocalSubscription: () => void,
    private readonly connectTimeoutMs = CONNECT_TIMEOUT_MS
  ) {
    this.trusted = isTrustedRequest(headers?.origin, [headers?.["x-forwarded-for"] ?? []].flat().join(","));
  }

  /** Returns true when the message belongs to a remote agent. A failure never reaches the caller. */
  handle(raw: string): boolean {
    try {
      return this.route(raw);
    } catch (error) {
      console.error("[relay] websocket forward failed", error);
      return false;
    }
  }

  close(): void {
    for (const link of this.links.values()) link.socket.close();
    this.links.clear();
  }

  private route(raw: string): boolean {
    if (!this.trusted) return false;
    let message: PageMessage;
    try {
      message = JSON.parse(raw) as PageMessage;
    } catch {
      return false;
    }
    const gateways = getLinkedGateways();
    if (gateways.length === 0) return false;

    if (message.type === "subscribeStatus") {
      for (const gateway of gateways) this.sendTo(gateway, message, false);
      return false;
    }
    if (message.type === "unsubscribeStatus") {
      this.sendToOpenLinks(raw);
      return false;
    }
    if (message.type === "unsubscribe") {
      this.sendToOpenLinks(raw);
      this.releaseChat(this.subscribedGateway);
      this.subscribedGateway = undefined;
      return false;
    }
    if (message.type !== "subscribe" && message.type !== "send") return false;
    if (typeof message.agentId !== "string") return false;
    const target = resolveRemoteAgent(message.agentId, gateways);
    const gateway = gateways.find((item) => item.name === target.gateway);
    if (message.type === "subscribe") this.replaceSubscription(gateway?.name);
    if (!gateway) return false;
    this.sendTo(gateway, { ...message, agentId: target.agentId }, true);
    return true;
  }

  /** A page socket has one session subscription. A new one replaces the previous one. */
  private replaceSubscription(gatewayName: string | undefined): void {
    const previous = this.subscribedGateway;
    if (previous !== undefined && previous !== gatewayName) {
      const link = this.links.get(previous);
      if (link) this.deliver(link, JSON.stringify({ type: "unsubscribe" }));
      this.releaseChat(previous);
    }
    if (gatewayName !== undefined) this.dropLocalSubscription();
    this.subscribedGateway = gatewayName;
  }

  /** The page no longer uses the chat stream of this gateway, so its close must not close the page. */
  private releaseChat(gatewayName: string | undefined): void {
    const link = gatewayName === undefined ? undefined : this.links.get(gatewayName);
    if (link) link.chat = false;
  }

  private sendToOpenLinks(payload: string): void {
    for (const link of this.links.values()) this.deliver(link, payload);
  }

  private deliver(link: RemoteLink, payload: string): void {
    if (link.socket.readyState === WebSocket.OPEN) {
      link.socket.send(payload);
      return;
    }
    if (link.queue.length >= MAX_QUEUED_MESSAGES) {
      this.page.close();
      return;
    }
    link.queue.push(payload);
  }

  private sendTo(gateway: RemoteGateway, message: PageMessage, chat: boolean): void {
    const payload = JSON.stringify(message);
    const existing = this.links.get(gateway.name);
    if (existing) {
      existing.chat ||= chat;
      this.deliver(existing, payload);
      return;
    }
    const socket = new WebSocket(remoteWsUrl(gateway), {
      headers: remoteWsHeaders(gateway),
      handshakeTimeout: this.connectTimeoutMs,
    });
    const link: RemoteLink = { socket, queue: [payload], chat };
    this.links.set(gateway.name, link);
    socket.on("open", () => {
      for (const queued of link.queue.splice(0)) socket.send(queued);
    });
    socket.on("message", (data) => this.toPage(gateway.name, data.toString()));
    socket.on("error", () => {
      if (!link.chat) return;
      this.toPage(gateway.name, JSON.stringify({ type: "error", message: `Gateway ${gateway.name} is offline` }));
    });
    // A failed chat stream looks like a local agent whose socket closes: the page sees the close.
    // A failed status link stays silent, so one offline gateway does not interrupt the page.
    socket.on("close", () => {
      if (this.links.get(gateway.name) === link) this.links.delete(gateway.name);
      if (link.chat) this.page.close();
    });
  }

  private toPage(gatewayName: string, raw: string): void {
    if (this.page.readyState !== WebSocket.OPEN) return;
    try {
      const event = JSON.parse(raw) as PageMessage;
      if (typeof event.agentId === "string") {
        event.agentId = addGatewaySuffix(event.agentId, gatewayName);
        if (getAgent(event.agentId)) return;
      }
      this.page.send(JSON.stringify(event));
    } catch {
      this.page.send(raw);
    }
  }
}
