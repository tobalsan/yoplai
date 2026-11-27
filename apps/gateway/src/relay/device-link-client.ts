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
import { DEVICE_MAX_MESSAGE_BYTES } from "./device-registry.js";
import type { DeviceExecutor } from "./device-exec.js";
import { remoteDeviceUrl, remoteWsHeaders } from "./remote.js";
import type { RemoteGateway } from "./store.js";

export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
export const GATEWAY_CHECK_MS = 5000;
/** Most running calls on one link. A call over the limit gets an error result. */
export const MAX_ACTIVE_CALLS = 20;

/**
 * `replaced` means another relay of the same user took this link's place. `unauthorized` means that the remote
 * refused the key at the upgrade. Both are separate from a key that the remote still accepts but cannot reach.
 */
export type DeviceLinkStatus = "connecting" | "connected" | "replaced" | "unauthorized";

export type DeviceLinkState = { name: string; connected: boolean; status: DeviceLinkStatus };

export type DeviceLinkManagerOptions = {
  executor: DeviceExecutor;
  /** The linked gateways. The list is empty while the relay is off. */
  getGateways: () => RemoteGateway[];
  /** Live runtime policy, checked independently of gateway reconciliation. */
  isRelayEnabled?: () => boolean;
  onConnected?: (gateway: RemoteGateway) => void;
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
  private status: DeviceLinkStatus = "connecting";
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

  get linkStatus(): DeviceLinkStatus {
    return this.status;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.terminate();
  }

  private connect(): void {
    if (this.options.isRelayEnabled?.() === false) {
      this.scheduleReconnect();
      return;
    }
    const socket = new WebSocket(remoteDeviceUrl(this.gateway), {
      headers: remoteWsHeaders(this.gateway),
      handshakeTimeout: 10_000,
      maxPayload: DEVICE_MAX_MESSAGE_BYTES,
    });
    this.socket = socket;
    /** Each running call of this link. A drop aborts them all. */
    const calls = new Map<string, AbortController>();
    let ready = false;

    socket.on("open", () => {
      if (this.options.isRelayEnabled?.() === false) {
        socket.close();
        return;
      }
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
        const firstHello = !ready;
        ready = true;
        this.connected = true;
        this.status = "connected";
        this.failureLogged = false;
        this.delayMs = this.options.reconnectMinMs ?? RECONNECT_MIN_MS;
        if (firstHello && !this.stopped && this.options.isRelayEnabled?.() !== false) {
          this.options.onConnected?.(this.gateway);
        }
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
    socket.on("error", (error) => {
      // ws reports a refused upgrade as "Unexpected server response: <status>".
      if (/Unexpected server response: (?:401|403)\b/.test(error.message)) this.status = "unauthorized";
      this.logFailure(error);
    });
    socket.on("close", (code) => {
      this.connected = false;
      if (code !== DEVICE_CLOSE_REPLACED && this.status !== "unauthorized") this.status = "connecting";
      if (code === DEVICE_CLOSE_REPLACED) {
        this.status = "replaced";
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
    if (this.options.isRelayEnabled?.() === false) return;
    const reject = (error: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "result", callId: call.callId, ok: false, error }));
      }
    };
    if (calls.has(call.callId)) return reject(`A call with the ID ${call.callId} is already active. This call did not run.`);
    if (calls.size >= MAX_ACTIVE_CALLS) return reject(`This link has ${MAX_ACTIVE_CALLS} active calls. This call did not run.`);
    const controller = new AbortController();
    calls.set(call.callId, controller);
    const send = (payload: Record<string, unknown>) => {
      if (controller.signal.aborted || socket.readyState !== WebSocket.OPEN || this.options.isRelayEnabled?.() === false) return;
      socket.send(JSON.stringify({ type: "result", callId: call.callId, ...payload }));
    };
    this.options.executor
      .execute(call, this.gateway, controller.signal)
      .then(
        (result) => send({ ok: true, content: result.content, details: result.details }),
        (error: unknown) => send({ ok: false, error: error instanceof Error ? error.message : String(error) })
      )
      .finally(() => {
        if (calls.get(call.callId) === controller) calls.delete(call.callId);
      });
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
    return [...this.clients.entries()].map(([name, client]) => ({ name, connected: client.isConnected, status: client.linkStatus }));
  }

  private reconcile(): void {
    const gateways = new Map(this.options.getGateways().map((gateway) => [gateway.name, gateway]));
    for (const [name, client] of this.clients) {
      const wanted = gateways.get(name);
      if (
        wanted &&
        wanted.generation === client.gateway.generation &&
        wanted.url === client.gateway.url &&
        wanted.token === client.gateway.token
      ) {
        continue;
      }
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
