// Shared by the device link tests. A remote gateway stand-in: a real WsBroker on a plain HTTP server.
// The test file must mock "../config/index.js", "../agents/index.js", "../sessions/index.js", and "../server/run-request.js".
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtensionRuntime } from "../extensions/runtime.js";

export async function startRemoteServer(multiUser: boolean) {
  const { WsBroker } = await import("../server/ws-broker.js");
  const server = createServer();
  const broker = new WsBroker();
  broker.attach(server, {
    isMultiUserEnabled: () => multiUser,
    validateWebSocketRequest: async (request) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      return token ? ({ user: { id: `user-${token}` }, session: { userId: `user-${token}` } } as never) : null;
    },
    canAccessAgent: async () => true,
    getExtensionRuntime: () => ({} as ExtensionRuntime),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, broker, port: (server.address() as AddressInfo).port };
}

export async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
