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
