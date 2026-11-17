import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer, type VerifyClientCallbackAsync } from "ws";
import type {
  AgentStatusChangeEvent,
  AgentStreamEvent,
  WsClientMessage,
  WsServerMessage,
} from "@yoplai/shared";
import { getAgent, isAgentActive } from "../config/index.js";
import { agentEventBus, runAgent } from "../agents/index.js";
import { getSessionEntry } from "../sessions/index.js";
import { getSessionCurrentTurn, isStreaming } from "../agents/index.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { normalizeRunRequest } from "./run-request.js";
import { RelayWsBridge } from "../relay/ws.js";
import { DEVICE_MAX_MESSAGE_BYTES, getDeviceRegistry, LOCAL_DEVICE_USER } from "../relay/device-registry.js";

type RequestAuthContext =
  import("@yoplai/extension-multi-user").RequestAuthContext;

type WsRequest = IncomingMessage & {
  authContext?: RequestAuthContext | null;
};

const CHAT_PATH = "/ws";
const DEVICE_PATH = "/ws/device";

type Subscription = { agentId: string; sessionKey: string; sessionId?: string };

export type WsBrokerAuthAdapter = {
  isMultiUserEnabled: () => boolean;
  validateWebSocketRequest: (
    request: Request
  ) => Promise<RequestAuthContext | null>;
  canAccessAgent: (
    authContext: RequestAuthContext | null,
    agentId: string
  ) => Promise<boolean>;
  getExtensionRuntime: () => ExtensionRuntime;
  /**
   * False when the credential behind a socket no longer works: a revoked, replaced, expired, disabled, or deleted
   * key. A cookie session always counts as active. The check reads fresh state, so it must stay cheap.
   */
  isAuthContextActive?: (authContext: RequestAuthContext) => boolean;
};

/** A socket whose key stops is closed within this time even when it sends nothing. */
const AUTH_RECHECK_MS = 5000;
const CLOSE_CREDENTIAL_INVALID = 1008;

export class WsBroker {
  private readonly subscriptions = new Map<WebSocket, Subscription>();
  private readonly connectedClients = new Set<WebSocket>();
  private readonly authContexts = new Map<WebSocket, RequestAuthContext>();
  private readonly deviceContexts = new Map<WebSocket, RequestAuthContext>();
  private authAdapter: WsBrokerAuthAdapter | undefined;

  constructor(private readonly options: { recheckMs?: number } = {}) {}
  private readonly statusSubscribers = new Set<WebSocket>();
  /** Counts the subscribe and unsubscribe messages of each page socket. A late authorization checks it. */
  private readonly subscribeGenerations = new Map<WebSocket, number>();
  private readonly relayBridges = new Map<WebSocket, RelayWsBridge>();
  private readonly disposers: Array<() => void> = [];
  private wss: WebSocketServer | null = null;
  private deviceWss: WebSocketServer | null = null;

  attach(server: Server, authAdapter: WsBrokerAuthAdapter): void {
    const shouldValidateWs = authAdapter.isMultiUserEnabled();
    const verifyClient: VerifyClientCallbackAsync | undefined = shouldValidateWs
      ? (info, done) => {
          const request = new Request("http://localhost/ws", {
            headers: new Headers(
              info.req.headers as Record<string, string>
            ),
          });

          authAdapter
            .validateWebSocketRequest(request)
            .then((authContext) => {
              (info.req as WsRequest).authContext = authContext;
              done(!!authContext, authContext ? undefined : 401);
            })
            .catch(() => done(false, 401));
        }
      : undefined;
    // One upgrade handler sends each request to its server, because a server with a `path` option refuses the other path.
    this.wss = new WebSocketServer({ noServer: true, verifyClient });
    this.deviceWss = new WebSocketServer({ noServer: true, verifyClient, maxPayload: DEVICE_MAX_MESSAGE_BYTES });

    this.wss.on("connection", (ws, request) => {
      this.handleConnection(ws, request as WsRequest, authAdapter);
    });
    this.deviceWss.on("connection", (ws, request) => {
      const authContext = (request as WsRequest).authContext;
      const userId = authContext?.user.id ?? LOCAL_DEVICE_USER;
      const isActive = authAdapter.isAuthContextActive;
      if (authContext && isActive) {
        // The registry checks the key before each call and result. The timer in `attach` closes an idle socket.
        this.deviceContexts.set(ws, authContext);
        ws.once("close", () => this.deviceContexts.delete(ws));
        getDeviceRegistry().accept(ws, userId, () => isActive(authContext));
        return;
      }
      getDeviceRegistry().accept(ws, userId);
    });
    server.on("upgrade", (request, socket, head) => {
      // The same rule as the `path` option of ws: the text before the first "?", with no URL parsing.
      const pathname = (request.url ?? "").split("?")[0];
      const target = pathname === CHAT_PATH ? this.wss : pathname === DEVICE_PATH ? this.deviceWss : null;
      if (!target) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      target.handleUpgrade(request, socket, head, (ws) => target.emit("connection", ws, request));
    });
    this.authAdapter = authAdapter;
    if (authAdapter.isAuthContextActive) {
      const timer = setInterval(() => this.recheckSockets(authAdapter.isAuthContextActive!), this.options.recheckMs ?? AUTH_RECHECK_MS);
      timer.unref();
      this.disposers.push(() => clearInterval(timer));
    }
    this.setupEventBroadcast(authAdapter);
    server.once("close", () => this.close());
  }

  /** Closes each socket whose key no longer works. */
  private recheckSockets(isActive: (authContext: RequestAuthContext) => boolean): void {
    for (const ws of [...this.authContexts.keys()]) this.socketActive(ws);
    for (const [ws, authContext] of [...this.deviceContexts]) {
      if (!isActive(authContext)) ws.close(CLOSE_CREDENTIAL_INVALID, "Credential no longer valid");
    }
  }

  /**
   * True while the credential of a chat socket works. Each call reads the current state and reuses no earlier answer,
   * so a revoked key stops the very next send. A failed check closes the socket.
   */
  private socketActive(ws: WebSocket): boolean {
    const authContext = this.authContexts.get(ws);
    const isActive = this.authAdapter?.isAuthContextActive;
    if (!authContext || !isActive) return true;
    const ok = isActive(authContext);
    if (!ok) ws.close(CLOSE_CREDENTIAL_INVALID, "Credential no longer valid");
    return ok;
  }

  close(): void {
    while (this.disposers.length > 0) {
      this.disposers.pop()?.();
    }
    for (const ws of this.connectedClients) {
      ws.close();
    }
    this.subscriptions.clear();
    this.connectedClients.clear();
    this.authContexts.clear();
    this.deviceContexts.clear();
    this.authAdapter = undefined;
    this.statusSubscribers.clear();
    this.wss?.close();
    this.wss = null;
    for (const client of this.deviceWss?.clients ?? []) client.terminate();
    this.deviceWss?.close();
    this.deviceWss = null;
    getDeviceRegistry().closeAll();
  }

  private handleConnection(
    ws: WebSocket,
    request: WsRequest | undefined,
    authAdapter: WsBrokerAuthAdapter
  ): void {
    this.connectedClients.add(ws);
    if (request?.authContext) {
      this.authContexts.set(ws, request.authContext);
    }

    const bridge = new RelayWsBridge(ws, request?.headers, () => {
      this.supersedeSubscribe(ws);
      this.subscriptions.delete(ws);
    });
    this.relayBridges.set(ws, bridge);
    ws.on("message", (raw) => {
      // Each client action checks the credential again, so a revoked key stops at the next message.
      if (!this.socketActive(ws)) return;
      const text = raw.toString();
      if (bridge.handle(text)) return;
      void this.handleMessage(ws, text, authAdapter);
    });

    ws.on("close", () => {
      this.subscriptions.delete(ws);
      this.subscribeGenerations.delete(ws);
      this.statusSubscribers.delete(ws);
      this.connectedClients.delete(ws);
      this.authContexts.delete(ws);
      this.relayBridges.get(ws)?.close();
      this.relayBridges.delete(ws);
    });
  }

  private async handleMessage(
    ws: WebSocket,
    raw: string,
    authAdapter: WsBrokerAuthAdapter
  ): Promise<void> {
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(raw) as WsClientMessage;
    } catch {
      this.send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    const authContext = this.authContexts.get(ws) ?? null;

    if (msg.type === "subscribe") {
      const generation = this.supersedeSubscribe(ws);
      await this.subscribeToSession(ws, msg, authContext, authAdapter, generation);
      return;
    }

    if (msg.type === "unsubscribe") {
      this.supersedeSubscribe(ws);
      this.subscriptions.delete(ws);
      return;
    }

    if (msg.type === "subscribeStatus") {
      this.statusSubscribers.add(ws);
      return;
    }

    if (msg.type === "unsubscribeStatus") {
      this.statusSubscribers.delete(ws);
      return;
    }

    if (msg.type === "send") {
      await this.handleSend(ws, msg, authContext, authAdapter);
      return;
    }

    this.send(ws, { type: "error", message: "Unknown message type" });
  }

  private supersedeSubscribe(ws: WebSocket): number {
    const generation = (this.subscribeGenerations.get(ws) ?? 0) + 1;
    this.subscribeGenerations.set(ws, generation);
    return generation;
  }

  private async subscribeToSession(
    ws: WebSocket,
    msg: Extract<WsClientMessage, { type: "subscribe" }>,
    authContext: RequestAuthContext | null,
    authAdapter: WsBrokerAuthAdapter,
    generation: number
  ): Promise<void> {
    const agent = getAgent(msg.agentId);
    if (!agent || !isAgentActive(msg.agentId)) {
      this.send(ws, { type: "error", message: "Agent not found" });
      return;
    }
    if (!(await authAdapter.canAccessAgent(authContext, msg.agentId))) {
      this.send(ws, { type: "error", message: "Forbidden" });
      return;
    }
    if (this.subscribeGenerations.get(ws) !== generation) return;

    this.subscriptions.set(ws, {
      agentId: msg.agentId,
      sessionKey: msg.sessionKey,
      sessionId: msg.sessionId,
    });
    const entry = msg.sessionId
      ? null
      : await getSessionEntry(
          msg.agentId,
          msg.sessionKey,
          authContext?.session.userId
        );
    const sessionId = msg.sessionId ?? entry?.sessionId;
    if (!sessionId || !isStreaming(msg.agentId, sessionId)) return;

    const turn = getSessionCurrentTurn(msg.agentId, sessionId);
    if (!turn) return;
    this.send(ws, {
      type: "active_turn",
      agentId: msg.agentId,
      sessionId,
      userText: turn.userFlushed ? null : turn.userText,
      userTimestamp: turn.userTimestamp,
      startedAt: turn.startTimestamp,
      thinking: turn.thinkingText,
      text: turn.assistantText,
      toolCalls: turn.toolCalls.map((tc) => ({
        id: tc.id,
        parentToolCallId: tc.parentToolCallId,
        name: tc.name,
        arguments: tc.args,
        status: tc.status,
        view: tc.view,
      })),
      toolResults: turn.toolResults,
    });
  }

  private async handleSend(
    ws: WebSocket,
    msg: Extract<WsClientMessage, { type: "send" }>,
    authContext: RequestAuthContext | null,
    authAdapter: WsBrokerAuthAdapter
  ): Promise<void> {
    if (authContext?.impersonator) {
      this.send(ws, {
        type: "error",
        code: "read_only_impersonation",
        message: "read_only_impersonation",
      });
      return;
    }

    const agent = getAgent(msg.agentId);
    if (!agent || !isAgentActive(msg.agentId)) {
      this.send(ws, { type: "error", message: "Agent not found" });
      return;
    }
    if (!(await authAdapter.canAccessAgent(authContext, msg.agentId))) {
      this.send(ws, { type: "error", message: "Forbidden" });
      return;
    }

    let terminalEventSent = false;
    try {
      const normalized = await normalizeRunRequest({
        agent,
        input: msg,
        authContext,
        extensionRuntime: authAdapter.getExtensionRuntime(),
        source: "web",
        onEvent: (event) => {
          if (event.type === "error" || event.type === "done") terminalEventSent = true;
          this.send(ws, event);
        },
        defaultSessionId: "default",
      });
      if (normalized.type === "validation_error") {
        this.send(ws, { type: "error", message: normalized.message });
        return;
      }
      if (normalized.type === "immediate") {
        for (const event of normalized.events) this.send(ws, event);
        return;
      }

      await runAgent(normalized.params);
    } catch (err) {
      if (terminalEventSent) return;
      this.send(ws, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private setupEventBroadcast(authAdapter: WsBrokerAuthAdapter): void {
    this.disposers.push(
      agentEventBus.onStreamEvent((event) => {
        void this.broadcastStreamEvent(event);
      })
    );
    this.disposers.push(
      agentEventBus.onStatusChange((event) => {
        void this.broadcastStatusEvent(event, authAdapter);
      })
    );
    this.disposers.push(
      agentEventBus.onFileChanged((event) => {
        for (const ws of this.connectedClients) this.send(ws, event);
      })
    );
    this.disposers.push(
      agentEventBus.onAgentChanged((event) => {
        for (const ws of this.connectedClients) this.send(ws, event);
      })
    );
    const onSubagentChanged = (event: unknown) => {
      for (const ws of this.connectedClients) {
        this.send(ws, event as WsServerMessage);
      }
    };
    agentEventBus.on("subagent.changed", onSubagentChanged);
    this.disposers.push(() =>
      agentEventBus.off("subagent.changed", onSubagentChanged)
    );
    const onOrchestratorEvent = (event: unknown) => {
      for (const ws of this.connectedClients) {
        this.send(ws, event as WsServerMessage);
      }
    };
    for (const eventName of [
      "orchestrator.run.claimed",
      "orchestrator.run.finished",
      "orchestrator.run.needs_human",
      "orchestrator.run.event",
      "orchestrator.workflow.changed",
    ]) {
      agentEventBus.on(eventName, onOrchestratorEvent);
      this.disposers.push(() =>
        agentEventBus.off(eventName, onOrchestratorEvent)
      );
    }
  }

  private async broadcastStreamEvent(
    event: AgentStreamEvent
  ): Promise<void> {
    for (const [ws, sub] of this.subscriptions) {
      if (sub.agentId !== event.agentId) continue;

      const sessionId = sub.sessionId ?? (await getSessionEntry(
        sub.agentId,
        sub.sessionKey,
        this.authContexts.get(ws)?.session.userId
      ))?.sessionId;
      if (sessionId !== event.sessionId) continue;

      const { agentId, sessionId: eventSessionId, ...streamEvent } = event;
      this.send(ws, streamEvent);
      // Send history_updated after terminal events so subscribers reload state.
      // Errors are terminal too: clients need to reconcile after a failed run.
      if (event.type === "done" || event.type === "error") {
        this.send(ws, { type: "history_updated", agentId, sessionId: eventSessionId });
      }
    }
  }

  private async broadcastStatusEvent(
    event: AgentStatusChangeEvent,
    authAdapter: WsBrokerAuthAdapter
  ): Promise<void> {
    const statusMessage = {
      type: "status" as const,
      agentId: event.agentId,
      status: event.status,
      sessionId: event.sessionId,
      sessionStatus: event.sessionStatus,
      ...(event.completion ? { completion: event.completion } : {}),
    };
    const access = await Promise.all(
      [...this.statusSubscribers].map(async (ws) => ({
        ws,
        allowed: await authAdapter.canAccessAgent(
          this.authContexts.get(ws) ?? null,
          event.agentId
        ),
      }))
    );
    for (const { ws, allowed } of access) {
      if (allowed) this.send(ws, statusMessage);
    }
  }

  private send(ws: WebSocket, event: WsServerMessage): void {
    if (ws.readyState === WebSocket.OPEN && this.socketActive(ws)) {
      ws.send(JSON.stringify(event));
    }
  }
}
