import { randomBytes } from "node:crypto";

/** A turn token stops working this long after its creation, when no `done` or `error` event ends it first. */
export const TURN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

export type DeviceTurn = {
  gateway: string;
  /** Remote agent ID with the gateway suffix. */
  agentId: string;
  /** Local chat name. */
  chat: string;
  /** Page socket of the turn. The registry never reads it. */
  page: unknown;
};

/** The local chat name of a message or subscription: the explicit session ID wins over the session key. */
export function localChatName(message: Record<string, unknown>): string {
  if (typeof message.sessionId === "string" && message.sessionId !== "") return `session:${message.sessionId}`;
  return `key:${typeof message.sessionKey === "string" && message.sessionKey !== "" ? message.sessionKey : "main"}`;
}

/** Holds the chat turns that this gateway forwarded. Memory only. */
export class DeviceTurns {
  private readonly turns = new Map<string, DeviceTurn>();

  /** Makes the secret token of a new turn. */
  issue(turn: DeviceTurn): string {
    const token = randomBytes(32).toString("base64url");
    this.turns.set(token, turn);
    setTimeout(() => this.end(token), TURN_TOKEN_TTL_MS).unref();
    return token;
  }

  /** Gives the turn of a token that did not end, or undefined. */
  find(token: string | undefined): DeviceTurn | undefined {
    return token === undefined ? undefined : this.turns.get(token);
  }

  end(token: string): void {
    this.turns.delete(token);
  }
}

const turns = new DeviceTurns();

export function getDeviceTurns(): DeviceTurns {
  return turns;
}
