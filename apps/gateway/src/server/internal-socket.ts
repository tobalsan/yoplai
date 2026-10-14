import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { internalTools } from "./internal-tools.js";
import type { GatewayConfig } from "@yoplai/shared";
import {
  GATEWAY_SOCKET_NAME,
  getGatewaySocketDir,
  usesGatewaySocket,
} from "../agents/container.js";
import { logError } from "../logging.js";

/**
 * Only the /internal routes, which authenticate every call with a per-run
 * agent token. Nothing else of the gateway (notably /api, unauthenticated in
 * single-user mode) is reachable through the socket a container can open.
 */
export function createInternalSocketApp(routes: Hono = internalTools): Hono {
  const app = new Hono();
  app.route("/internal", routes);
  return app;
}

export function getGatewaySocketPath(socketDir: string): string {
  return path.join(socketDir, GATEWAY_SOCKET_NAME);
}

/**
 * Serves /internal on a Unix socket so sandboxed runs reach the gateway
 * without any network path to the host. Rootless Docker blocks the host
 * loopback, so host.docker.internal is unreachable from its containers.
 */
export async function startInternalSocketServer(
  socketDir: string,
  app: Hono = createInternalSocketApp()
): Promise<{ server: Server; socketPath: string; close(): void }> {
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(socketDir, 0o700);
  const socketPath = getGatewaySocketPath(socketDir);
  removeStaleSocket(socketPath);

  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The container connects as the gateway's own uid (rootful `--user`) or as
  // its user-namespace root, which is that same uid (rootless).
  fs.chmodSync(socketPath, 0o600);

  return {
    server,
    socketPath,
    close() {
      server.close();
      removeStaleSocket(socketPath);
    },
  };
}

function removeStaleSocket(socketPath: string): void {
  try {
    if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Starts the socket whenever the socket transport is configured, whether or
 * not an agent is sandboxed yet: an agent can enable its sandbox later through
 * a config reload, and its first run must find the socket listening.
 * Switching `sandbox.gatewayTransport` itself takes a gateway restart.
 */
export async function startConfiguredInternalSocket(
  config: GatewayConfig,
  homeDir: string,
  start: typeof startInternalSocketServer = startInternalSocketServer
): Promise<Awaited<ReturnType<typeof startInternalSocketServer>> | undefined> {
  if (!usesGatewaySocket(config.sandbox ?? {})) return undefined;
  try {
    const socket = await start(getGatewaySocketDir(homeDir));
    console.log(`Sandbox gateway socket listening on ${socket.socketPath}`);
    process.once("SIGTERM", () => socket.close());
    process.once("SIGINT", () => socket.close());
    return socket;
  } catch (error) {
    logError("[gateway] Sandbox gateway socket failed to start", error);
    return undefined;
  }
}
