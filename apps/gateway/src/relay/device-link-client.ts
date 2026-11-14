import os from "node:os";
import { WebSocket } from "ws";
import {
  DEVICE_CLOSE_INVALID_MESSAGE,
  DEVICE_CLOSE_REPLACED,
  DEVICE_CLOSE_UNSUPPORTED_VERSION,
  DEVICE_PROTOCOL_VERSION,
  parseDeviceLinkMessage,
  type DeviceCall,
} from "@yoplai/shared";
import type { DeviceExecutor } from "./device-exec.js";
import { remoteDeviceUrl, remoteWsHeaders } from "./remote.js";
import type { RemoteGateway } from "./store.js";

export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
export const GATEWAY_CHECK_MS = 5000;

export type DeviceLinkState = { name: string; connected: boolean };

export type DeviceLinkManagerOptions = {
  executor: DeviceExecutor;
  /** The linked gateways. The list is empty while the relay is off. */
  getGateways: () => RemoteGateway[];
  deviceName?: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  checkIntervalMs?: number;
};

/** One outbound link to the `/ws/device` path of a linked gateway. It connects again after a drop. */
class DeviceLinkClient {
  private socket: WebSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delayMs: number;
  private stopped = false;
  private connected = false;
  /** True after a log line for a failure, until the next good connection. */
  private failureLogged = false;

  constructor(
    readonly gateway: RemoteGateway,
    private readonly options: DeviceLinkManagerOptions
  ) {
    this.delayMs = options.reconnectMinMs ?? RECONNECT_MIN_MS;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close();
  }

  private connect(): void {
    const socket = new WebSocket(remoteDeviceUrl(this.gateway), {
      headers: remoteWsHeaders(this.gateway),
      handshakeTimeout: 10_000,
    });
    this.socket = socket;
    /** Each running call of this link. A drop aborts them all. */
    const calls = new Map<string, AbortController>();
    let ready = false;

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: DEVICE_PROTOCOL_VERSION,
          deviceName: this.options.deviceName ?? os.hostname(),
        })
      );
    });
    socket.on("message", (raw) => {
      const message = parseDeviceLinkMessage(raw.toString());
      if (!message) {
        socket.close(DEVICE_CLOSE_INVALID_MESSAGE, "Invalid device link message");
        return;
      }
      if (message.type === "hello") {
        if (message.protocolVersion !== DEVICE_PROTOCOL_VERSION) {
          this.logFailure(new Error(`it uses protocol version ${message.protocolVersion}`));
          socket.close(
            DEVICE_CLOSE_UNSUPPORTED_VERSION,
            `Unsupported protocol version ${message.protocolVersion}. This gateway uses ${DEVICE_PROTOCOL_VERSION}.`
          );
          return;
        }
        ready = true;
        this.connected = true;
        this.failureLogged = false;
        this.delayMs = this.options.reconnectMinMs ?? RECONNECT_MIN_MS;
        return;
      }
      if (!ready) {
        socket.close(DEVICE_CLOSE_INVALID_MESSAGE, "The first message must be hello");
        return;
      }
      if (message.type === "call") this.runCall(socket, calls, message);
      if (message.type === "cancel") calls.get(message.callId)?.abort();
    });
    // The close event follows an error, so this handler only keeps the process alive.
    socket.on("error", (error) => this.logFailure(error));
    socket.on("close", (code) => {
      this.connected = false;
      if (code === DEVICE_CLOSE_REPLACED) {
        // Another relay of the same user took the place of this link. A new link would replace it again.
        console.warn(`[relay] device link to ${this.gateway.name} was replaced by another relay of the same user. It stays closed.`);
        this.stopped = true;
      }
      for (const controller of calls.values()) controller.abort();
      calls.clear();
      if (this.socket === socket) this.socket = undefined;
      this.scheduleReconnect();
    });
  }

  private runCall(socket: WebSocket, calls: Map<string, AbortController>, call: DeviceCall): void {
    const controller = new AbortController();
    calls.set(call.callId, controller);
    const send = (payload: Record<string, unknown>) => {
      if (controller.signal.aborted || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "result", callId: call.callId, ...payload }));
    };
    this.options.executor
      .execute(call, this.gateway.name, controller.signal)
      .then(
        (result) => send({ ok: true, content: result.content, details: result.details }),
        (error: unknown) => send({ ok: false, error: error instanceof Error ? error.message : String(error) })
      )
      .finally(() => calls.delete(call.callId));
  }

  private logFailure(error: Error): void {
    if (this.failureLogged || this.stopped) return;
    this.failureLogged = true;
    console.warn(`[relay] device link to ${this.gateway.name} failed: ${error.message}. It tries again quietly.`);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.connect(), this.delayMs);
    this.delayMs = Math.min(this.delayMs * 2, this.options.reconnectMaxMs ?? RECONNECT_MAX_MS);
  }
}

/**
 * Keeps one device link for each linked gateway. `yoplai connect` and `yoplai disconnect` run in
 * another process, so the manager checks the list of gateways on a timer.
 */
export class DeviceLinkManager {
  private readonly clients = new Map<string, DeviceLinkClient>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: DeviceLinkManagerOptions) {}

  start(): void {
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), this.options.checkIntervalMs ?? GATEWAY_CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    for (const client of this.clients.values()) client.stop();
    this.clients.clear();
  }

  states(): DeviceLinkState[] {
    return [...this.clients.entries()].map(([name, client]) => ({ name, connected: client.isConnected }));
  }

  private reconcile(): void {
    const gateways = new Map(this.options.getGateways().map((gateway) => [gateway.name, gateway]));
    for (const [name, client] of this.clients) {
      const wanted = gateways.get(name);
      if (wanted && wanted.url === client.gateway.url && wanted.token === client.gateway.token) continue;
      client.stop();
      this.clients.delete(name);
    }
    for (const [name, gateway] of gateways) {
      if (this.clients.has(name)) continue;
      const client = new DeviceLinkClient(gateway, this.options);
      this.clients.set(name, client);
      client.start();
    }
  }
}
