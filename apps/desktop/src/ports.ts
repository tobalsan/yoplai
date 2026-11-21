import net from "node:net";

/** True when nothing listens on 127.0.0.1:<port>. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/** Return the first free port from basePort upward. */
export async function findFreePort(
  basePort: number,
  options: { maxAttempts?: number; isFree?: (port: number) => Promise<boolean> } = {}
): Promise<number> {
  const maxAttempts = options.maxAttempts ?? 50;
  const isFree = options.isFree ?? isPortFree;
  for (let offset = 0; offset < maxAttempts; offset++) {
    if (await isFree(basePort + offset)) return basePort + offset;
  }
  throw new Error(`No free port found in range ${basePort}-${basePort + maxAttempts - 1}`);
}

export interface PickedPorts {
  gatewayPort: number;
  uiPort: number;
  appsPort: number;
}

/** Base ports of the gateway, the UI, and the MCP Apps listener. */
export const BASE_PORTS: PickedPorts = { gatewayPort: 4000, uiPort: 3000, appsPort: 4001 };

/** Pick three different free ports. Each search skips the ports that are already picked. */
export async function pickPorts(isFree: (port: number) => Promise<boolean> = isPortFree): Promise<PickedPorts> {
  const picked = new Set<number>();
  const pick = async (basePort: number): Promise<number> => {
    const port = await findFreePort(basePort, { isFree: async (candidate) => !picked.has(candidate) && (await isFree(candidate)) });
    picked.add(port);
    return port;
  };
  const gatewayPort = await pick(BASE_PORTS.gatewayPort);
  const uiPort = await pick(BASE_PORTS.uiPort);
  const appsPort = await pick(BASE_PORTS.appsPort);
  return { gatewayPort, uiPort, appsPort };
}
