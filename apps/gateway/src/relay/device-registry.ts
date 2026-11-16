import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  DEVICE_CLOSE_INVALID_MESSAGE,
  DEVICE_OFFLINE_CALL_TEXT,
  DEVICE_CLOSE_REPLACED,
  DEVICE_CLOSE_UNSUPPORTED_VERSION,
  DEVICE_PROTOCOL_VERSION,
  parseDeviceLinkMessage,
  type DeviceCall,
  type DeviceResult,
} from "@yoplai/shared";

/** Deadline of one device call. It is shorter than the 300 s default of a sandbox tool call. */
export const DEVICE_CALL_TIMEOUT_MS = 270_000;

/** Largest message on a device socket, on the two sides. */
export const DEVICE_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/** Close code of a device socket whose key stopped working. It is the policy violation code of WebSocket. */
const DEVICE_CLOSE_UNAUTHORIZED = 1008;

/** Registry key of a gateway with no multi-user mode. One relay then serves each run. */
export const LOCAL_DEVICE_USER = "local";

export type DeviceCallRequest = Omit<DeviceCall, "type" | "callId">;
export type DeviceCallResult = { content: unknown[]; details?: unknown };

type PendingCall = {
  resolve: (result: DeviceCallResult) => void;
  reject: (error: Error) => void;
};

/** One relay link after its hello. It owns the pending calls that this link carries. */
class DeviceConnection {
  readonly pending = new Map<string, PendingCall>();

  constructor(
    readonly socket: WebSocket,
    readonly deviceName: string | undefined,
    /** False when the credential of this socket stopped working. Only a multi-user remote sets it. */
    readonly isAuthorized: () => boolean = () => true
  ) {}

  failPending(error: Error): void {
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }
}

/** Maps a user ID to the one relay of that user. */
export class DeviceRegistry {
  private readonly connections = new Map<string, DeviceConnection>();

  has(userId: string): boolean {
    return this.connections.has(userId);
  }

  /** Closes each device socket, fails its pending calls, and clears the registry. */
  closeAll(): void {
    const connections = [...this.connections.values()];
    this.connections.clear();
    for (const connection of connections) {
      connection.failPending(new Error("The gateway stopped"));
      connection.socket.close(1001, "Gateway stopping");
    }
  }

  /**
   * Takes over a new device socket. The relay is online after its valid hello. `isAuthorized` is checked before each
   * message and each call, and a socket that fails it closes, which fails its pending calls.
   */
  accept(socket: WebSocket, userId: string, isAuthorized: () => boolean = () => true): void {
    let connection: DeviceConnection | undefined;
    const closeWith = (code: number, reason: string) => socket.close(code, reason);

    socket.on("message", (raw) => {
      if (!isAuthorized()) {
        socket.close(DEVICE_CLOSE_UNAUTHORIZED, "Credential no longer valid");
        return;
      }
      const message = parseDeviceLinkMessage(raw.toString());
      if (!message) {
        closeWith(DEVICE_CLOSE_INVALID_MESSAGE, "Invalid device link message");
        return;
      }
      if (!connection) {
        if (message.type !== "hello") {
          closeWith(DEVICE_CLOSE_INVALID_MESSAGE, "The first message must be hello");
          return;
        }
        if (message.protocolVersion !== DEVICE_PROTOCOL_VERSION) {
          closeWith(
            DEVICE_CLOSE_UNSUPPORTED_VERSION,
            `Unsupported protocol version ${message.protocolVersion}. This gateway uses ${DEVICE_PROTOCOL_VERSION}.`
          );
          return;
        }
        connection = new DeviceConnection(socket, message.deviceName, isAuthorized);
        const previous = this.connections.get(userId);
        this.connections.set(userId, connection);
        if (previous) {
          previous.failPending(new Error(`${DEVICE_OFFLINE_CALL_TEXT} The link was replaced by a new connection during the call.`));
          previous.socket.close(DEVICE_CLOSE_REPLACED, "Replaced by a new connection");
        }
        socket.send(JSON.stringify({ type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION }));
        return;
      }
      if (message.type === "result") this.settle(connection, message);
    });

    // An invalid frame raises an error event. Without a handler it would stop the process.
    // ws closes the socket after the error, and the close handler fails the pending calls.
    socket.on("error", () => socket.terminate());

    socket.on("close", () => {
      if (!connection) return;
      if (this.connections.get(userId) === connection) this.connections.delete(userId);
      connection.failPending(new Error(`${DEVICE_OFFLINE_CALL_TEXT} The link dropped during the call, so the call may have run.`));
    });
  }

  /** Sends a call to the relay of the user and waits for its result. */
  call(
    userId: string,
    request: DeviceCallRequest,
    signal?: AbortSignal,
    timeoutMs = DEVICE_CALL_TIMEOUT_MS
  ): Promise<DeviceCallResult> {
    const connection = this.connections.get(userId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) {
      return Promise.reject(new Error(DEVICE_OFFLINE_CALL_TEXT));
    }
    if (!connection.isAuthorized()) {
      connection.socket.close(DEVICE_CLOSE_UNAUTHORIZED, "Credential no longer valid");
      return Promise.reject(new Error(DEVICE_OFFLINE_CALL_TEXT));
    }
    if (signal?.aborted) return Promise.reject(new Error("The device call was cancelled"));

    const callId = randomUUID();
    return new Promise<DeviceCallResult>((resolve, reject) => {
      const finish = (error?: Error, result?: DeviceCallResult) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        connection.pending.delete(callId);
        if (error) reject(error);
        else resolve(result ?? { content: [] });
      };
      const cancel = (error: Error) => {
        if (!connection.pending.has(callId)) return;
        if (connection.socket.readyState === connection.socket.OPEN) {
          connection.socket.send(JSON.stringify({ type: "cancel", callId }));
        }
        finish(error);
      };
      const onAbort = () => cancel(new Error("The device call was cancelled"));
      const timer = setTimeout(
        () => cancel(new Error(`The device call timed out after ${Math.round(timeoutMs / 1000)} seconds`)),
        timeoutMs
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      connection.pending.set(callId, {
        resolve: (result) => finish(undefined, result),
        reject: (error) => finish(error),
      });
      connection.socket.send(JSON.stringify({ type: "call", callId, ...request }));
    });
  }

  private settle(connection: DeviceConnection, result: DeviceResult): void {
    const pending = connection.pending.get(result.callId);
    if (!pending) return;
    if (result.ok) pending.resolve({ content: result.content ?? [], details: result.details });
    else pending.reject(new Error(result.error ?? "The device call failed"));
  }
}

let registry = new DeviceRegistry();

export function getDeviceRegistry(): DeviceRegistry {
  return registry;
}

/** Replaces the registry. Tests use this to start clean. */
export function resetDeviceRegistry(): DeviceRegistry {
  registry = new DeviceRegistry();
  return registry;
}
