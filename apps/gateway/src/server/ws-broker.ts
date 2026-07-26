import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
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

type RequestAuthContext =
  import("@yoplai/extension-multi-user").RequestAuthContext;

type WsRequest = IncomingMessage & {
  authContext?: RequestAuthContext | null;
};

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
};

export class WsBroker {
  private readonly subscriptions = new Map<WebSocket, Subscription>();
  private readonly connectedClients = new Set<WebSocket>();
  private readonly authContexts = new Map<WebSocket, RequestAuthContext>();
  private readonly statusSubscribers = new Set<WebSocket>();
  private readonly disposers: Array<() => void> = [];
  private wss: WebSocketServer | null = null;

  attach(server: Server, authAdapter: WsBrokerAuthAdapter): void {
    const shouldValidateWs = authAdapter.isMultiUserEnabled();
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      verifyClient: shouldValidateWs
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
        : undefined,
    });

    this.wss.on("connection", (ws, request) => {
      this.handleConnection(ws, request as WsRequest, authAdapter);
    });
    this.setupEventBroadcast(authAdapter);
    server.once("close", () => this.close());
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
    this.statusSubscribers.clear();
    this.wss?.close();
    this.wss = null;
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

    ws.on("message", (raw) => {
      void this.handleMessage(ws, raw.toString(), authAdapter);
    });

    ws.on("close", () => {
      this.subscriptions.delete(ws);
      this.statusSubscribers.delete(ws);
      this.connectedClients.delete(ws);
      this.authContexts.delete(ws);
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
      await this.subscribeToSession(ws, msg, authContext, authAdapter);
      return;
    }

    if (msg.type === "unsubscribe") {
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

  private async subscribeToSession(
    ws: WebSocket,
    msg: Extract<WsClientMessage, { type: "subscribe" }>,
    authContext: RequestAuthContext | null,
    authAdapter: WsBrokerAuthAdapter
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
        name: tc.name,
        arguments: tc.args,
        status: tc.status,
      })),
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

    try {
      const normalized = await normalizeRunRequest({
        agent,
        input: msg,
        authContext,
        extensionRuntime: authAdapter.getExtensionRuntime(),
        source: "web",
        onEvent: (event) => this.send(ws, event),
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
    const onLeadSessionChanged = (event: unknown) => {
      for (const ws of this.connectedClients) {
        this.send(ws, event as WsServerMessage);
      }
    };
    agentEventBus.on("lead_session.changed", onLeadSessionChanged);
    this.disposers.push(() =>
      agentEventBus.off("lead_session.changed", onLeadSessionChanged)
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
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }
}
