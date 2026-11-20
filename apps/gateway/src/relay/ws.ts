import type { IncomingHttpHeaders } from "node:http";
import { WebSocket } from "ws";
import { getAgent } from "../config/index.js";
import { addGatewaySuffix } from "./agent-id.js";
import { getDeviceApprovals, type ApprovalEvent } from "./device-approvals.js";
import { getDeviceTurns, localChatName } from "./device-turns.js";
import { remoteWsHeaders, remoteWsUrl } from "./remote.js";
import { getLinkedGateways, isRelayEnabled, isTrustedRequest, resolveRemoteAgent } from "./state.js";
import type { RemoteGateway } from "./store.js";

type PageMessage = { type?: string; agentId?: string } & Record<string, unknown>;

/** `chat` is false while the link serves status messages only. */
type RemoteLink = { socket: WebSocket; queue: string[]; chat: boolean; generation: string | undefined };

export const CONNECT_TIMEOUT_MS = 10_000;
export const MAX_QUEUED_MESSAGES = 20;
export const MAX_PENDING_PAGE_TURNS = 20;
/** A closed status link is opened again after this delay, which doubles for each failed attempt up to the maximum. */
export const STATUS_RETRY_BASE_MS = 1_000;
export const MAX_STATUS_RETRY_DELAY_MS = 30_000;

/**
 * Carries the messages of one page socket to the remote gateways. It opens one
 * socket for each subscription gateway and each send, and closes them with the page socket.
 */
export class RelayWsBridge {
  private readonly links = new Map<string, RemoteLink>();
  private readonly trusted: boolean;
  /** The gateway of the active session subscription. Unset means a local agent or none. */
  private subscribedGateway: string | undefined;
  /** The remote agent and local chat name of the page subscription. Device approvals for them go to the page. */
  private subscription: { agentId: string; chat: string } | undefined;
  private readonly sendLinks = new Set<RemoteLink>();
  /** Set while the page wants status messages. A status link that closes is opened again. */
  private statusInterest: PageMessage | undefined;
  private readonly statusRetries = new Map<string, { attempts: number; timer?: NodeJS.Timeout }>();
  private closed = false;
  private readonly stopApprovals: (() => void) | undefined;

  constructor(
    private readonly page: WebSocket,
    headers: IncomingHttpHeaders | undefined,
    private readonly dropLocalSubscription: () => void,
    private readonly connectTimeoutMs = CONNECT_TIMEOUT_MS,
    private readonly statusRetryBaseMs = STATUS_RETRY_BASE_MS
  ) {
    this.trusted = isTrustedRequest(headers?.origin, [headers?.["x-forwarded-for"] ?? []].flat().join(","));
    // A page that is not trusted gets no approval request.
    this.stopApprovals = this.trusted ? getDeviceApprovals().subscribe((event) => this.sendApproval(event)) : undefined;
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
    this.closed = true;
    this.stopStatusRetries();
    this.stopApprovals?.();
    for (const link of [...this.links.values(), ...this.sendLinks]) link.socket.close();
    this.links.clear();
    this.sendLinks.clear();
  }

  private route(raw: string): boolean {
    let message: PageMessage;
    try {
      message = JSON.parse(raw) as PageMessage;
    } catch {
      return false;
    }
    // The answer belongs to the local gateway. It never goes to a remote gateway, and a page that is not trusted has no effect.
    if (message.type === "device_approval_answer") {
      if (
        this.trusted &&
        isRelayEnabled() &&
        typeof message.approvalId === "string" &&
        typeof message.approve === "boolean"
      ) {
        getDeviceApprovals().answer(
          message.approvalId,
          message.approve,
          (request, page) => page === this.page || this.subscribes(request.agentId, request.chat)
        );
      }
      return true;
    }
    if (!this.trusted) return false;
    const gateways = getLinkedGateways();
    if (gateways.length === 0) return false;

    if (message.type === "subscribeStatus") {
      this.stopStatusRetries();
      this.statusInterest = message;
      for (const gateway of gateways) this.sendTo(gateway, message, false);
      return false;
    }
    if (message.type === "unsubscribeStatus") {
      this.stopStatusRetries();
      this.sendToOpenLinks(raw);
      return false;
    }
    if (message.type === "unsubscribe") {
      this.sendToOpenLinks(raw);
      this.releaseChat(this.subscribedGateway);
      this.subscribedGateway = undefined;
      this.subscription = undefined;
      return false;
    }
    if (message.type !== "subscribe" && message.type !== "send") return false;
    if (typeof message.agentId !== "string") return false;
    const target = resolveRemoteAgent(message.agentId, gateways);
    const gateway = gateways.find((item) => item.name === target.gateway);
    if (message.type === "subscribe") {
      this.replaceSubscription(gateway?.name);
      this.subscription = gateway
        ? { agentId: message.agentId, chat: localChatName(message) }
        : undefined;
      if (gateway) this.sendPendingApprovals();
    }
    if (!gateway) return false;
    const forwarded: PageMessage = { ...message, agentId: target.agentId };
    if (message.type === "send") {
      // The token is new for each message. A value from the page never reaches the remote gateway.
      if (this.sendLinks.size >= MAX_PENDING_PAGE_TURNS) {
        this.page.send(JSON.stringify({ type: "error", message: "Too many pending device turns. Try again after a turn ends." }));
        return true;
      }
      let token: string;
      try {
        token = getDeviceTurns().issue({
          gateway: gateway.name,
          generation: gateway.generation,
          agentId: target.agentId,
          chat: localChatName(message),
          page: this.page,
        });
      } catch (error) {
        this.page.send(JSON.stringify({ type: "error", message: (error as Error).message }));
        return true;
      }
      forwarded.deviceTurnToken = token;
      this.sendTo(gateway, forwarded, true, token);
      return true;
    }
    this.sendTo(gateway, forwarded, true);
    return true;
  }

  private subscribes(agentId: string, chat: string): boolean {
    const sub = this.subscription;
    return sub !== undefined && sub.agentId === agentId && sub.chat === chat;
  }

  private sendApproval(event: ApprovalEvent): void {
    if (this.page.readyState !== WebSocket.OPEN || !isRelayEnabled()) return;
    if (event.page !== this.page && !this.subscribes(event.message.agentId, event.message.chat)) return;
    this.page.send(JSON.stringify(event.message));
  }

  /** A page that subscribes later gets each approval that still waits. */
  private sendPendingApprovals(): void {
    const sub = this.subscription;
    if (!sub) return;
    for (const message of getDeviceApprovals().pendingFor(sub.agentId, sub.chat)) {
      if (this.page.readyState === WebSocket.OPEN) this.page.send(JSON.stringify(message));
    }
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

  private sendTo(gateway: RemoteGateway, message: PageMessage, chat: boolean, turnToken?: string): void {
    const payload = JSON.stringify(message);
    let existing = turnToken === undefined ? this.links.get(gateway.name) : undefined;
    if (existing && existing.generation !== gateway.generation) {
      // A link that replaced this name made the retained socket obsolete. It ends quietly, and the new link opens its own.
      this.links.delete(gateway.name);
      existing.chat = false;
      existing.socket.close();
      existing = undefined;
    }
    if (existing) {
      existing.chat ||= chat;
      this.deliver(existing, payload);
      return;
    }
    const socket = new WebSocket(remoteWsUrl(gateway), {
      headers: remoteWsHeaders(gateway),
      handshakeTimeout: this.connectTimeoutMs,
    });
    const link: RemoteLink = { socket, queue: [payload], chat, generation: gateway.generation };
    if (turnToken === undefined) this.links.set(gateway.name, link);
    else {
      this.sendLinks.add(link);
    }
    let finished = false;
    socket.on("open", () => {
      if (turnToken === undefined) this.statusRetries.delete(gateway.name);
      if (!isRelayEnabled()) {
        link.queue.length = 0;
        link.chat = false;
        finished = true;
        if (turnToken !== undefined) getDeviceTurns().end(turnToken);
        socket.close();
        return;
      }
      for (const queued of link.queue.splice(0)) socket.send(queued);
    });
    socket.on("message", (data) => {
      if (turnToken !== undefined && finished) return;
      const terminal = this.toPage(gateway.name, data.toString(), turnToken);
      if (turnToken !== undefined && terminal) {
        finished = true;
        socket.close();
      }
    });
    socket.on("error", () => {
      if (!link.chat) return;
      this.toPage(gateway.name, JSON.stringify({ type: "error", message: `Gateway ${gateway.name} is offline` }), turnToken);
      if (turnToken !== undefined) {
        finished = true;
        if (isRelayEnabled()) this.page.close();
      }
    });
    // A failed chat stream looks like a local agent whose socket closes: the page sees the close.
    // A failed status link stays silent, so one offline gateway does not interrupt the page.
    socket.on("close", () => {
      if (this.links.get(gateway.name) === link) this.links.delete(gateway.name);
      if (turnToken !== undefined) {
        this.sendLinks.delete(link);
        if (!finished && isRelayEnabled()) this.page.close();
      } else if (isRelayEnabled()) {
        if (link.chat) this.page.close();
        else this.retryStatus(gateway);
      }
    });
  }

  private stopStatusRetries(): void {
    this.statusInterest = undefined;
    for (const retry of this.statusRetries.values()) clearTimeout(retry.timer);
    this.statusRetries.clear();
  }

  /** The remote gateway closed its status link, for example after a restart. Open it again, with a capped growing delay, while the page wants status. */
  private retryStatus(gateway: RemoteGateway): void {
    const message = this.statusInterest;
    if (!message || this.closed || this.page.readyState !== WebSocket.OPEN) return;
    const retry = this.statusRetries.get(gateway.name) ?? { attempts: 0 };
    if (retry.timer) return;
    this.statusRetries.set(gateway.name, retry);
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      retry.attempts += 1;
      const current = getLinkedGateways().find((item) => item.name === gateway.name);
      if (!this.statusInterest || !current || this.closed || this.links.has(current.name)) return;
      this.sendTo(current, this.statusInterest, false);
    }, Math.min(this.statusRetryBaseMs * 2 ** retry.attempts, MAX_STATUS_RETRY_DELAY_MS));
  }

  private toPage(gatewayName: string, raw: string, turnToken?: string): boolean {
    try {
      const event = JSON.parse(raw) as PageMessage;
      // Only the local gateway makes device approval messages. A remote gateway must not send them to the page.
      if (typeof event.type === "string" && event.type.startsWith("device_approval_")) return false;
      const terminal = event.type === "error" || (event.type === "done" && (event.meta as { queued?: boolean } | undefined)?.queued !== true);
      if (terminal && turnToken !== undefined) getDeviceTurns().end(turnToken);
      if (!isRelayEnabled()) return terminal;
      if (typeof event.agentId === "string") {
        event.agentId = addGatewaySuffix(event.agentId, gatewayName);
        if (getAgent(event.agentId)) return terminal;
      }
      if (this.page.readyState === WebSocket.OPEN) this.page.send(JSON.stringify(event));
      return terminal;
    } catch {
      if (this.page.readyState === WebSocket.OPEN && isRelayEnabled()) this.page.send(raw);
      return false;
    }
  }
}
