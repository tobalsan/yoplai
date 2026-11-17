import { getDeviceTurns } from "./device-turns.js";
import type { LinkIdentity } from "./device-settings.js";

/** The saved link `ams` of the device tests. A link that replaces it under the same name has another generation. */
export const AMS: LinkIdentity = { name: "ams", generation: "ams-link-1" };

/** Makes a turn token for a chat of the remote agent `pom` on the gateway `ams`, as the relay does for a chat message. */
export function issueTestTurn(chat = "session:s1", options: { gateway?: string; generation?: string; agentId?: string; page?: unknown } = {}): string {
  return getDeviceTurns().issue({
    gateway: options.gateway ?? AMS.name,
    generation: "generation" in options ? options.generation : AMS.generation,
    agentId: options.agentId ?? "pom",
    chat,
    page: options.page,
  });
}
