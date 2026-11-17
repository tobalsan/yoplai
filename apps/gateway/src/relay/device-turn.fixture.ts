import { getDeviceTurns } from "./device-turns.js";

/** Makes a turn token for a chat of the remote agent `pom` on the gateway `ams`, as the relay does for a chat message. */
export function issueTestTurn(chat = "session:s1", options: { gateway?: string; agentId?: string; page?: unknown } = {}): string {
  return getDeviceTurns().issue({
    gateway: options.gateway ?? "ams",
    agentId: options.agentId ?? "pom",
    chat,
    page: options.page,
  });
}
