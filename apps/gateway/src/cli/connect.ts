import type { Command } from "commander";
import { getRemoteGatewayStore } from "../relay/state.js";
import { fetchRemote } from "../relay/remote.js";
import type { RemoteGateway, RemoteGatewayStore } from "../relay/store.js";

const GATEWAY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type ConnectOptions = { name?: string; token?: string };

/** Call the remote gateway one time. Throws a clear error when the URL or the token is wrong. */
async function verifyRemoteGateway(gateway: RemoteGateway): Promise<void> {
  let response: Response;
  try {
    response = await fetchRemote(gateway, "/api/agents", {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error(`Cannot reach ${gateway.url}. Check the URL and that the gateway runs.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `The remote gateway refused the token (HTTP ${response.status}). Use --token with a valid user token.`
    );
  }
  const body: unknown = response.ok ? await response.json().catch(() => null) : null;
  if (!Array.isArray(body)) {
    throw new Error(`${gateway.url} did not answer like a Yoplai gateway (HTTP ${response.status}).`);
  }
}

export async function connectRemoteGateway(
  url: string,
  options: ConnectOptions,
  store: RemoteGatewayStore = getRemoteGatewayStore()
): Promise<RemoteGateway> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The URL must start with http:// or https://");
  }
  const name = options.name ?? parsed.hostname;
  if (!GATEWAY_NAME_RE.test(name)) {
    throw new Error(`Invalid gateway name "${name}". Use letters, digits, ".", "_" or "-". Set one with --name.`);
  }
  const gateway: RemoteGateway = {
    name,
    url: parsed.origin + parsed.pathname.replace(/\/+$/, ""),
    ...(options.token ? { token: options.token } : {}),
  };
  await verifyRemoteGateway(gateway);
  store.save(gateway);
  return gateway;
}

export function registerConnectCommands(program: Command): void {
  program
    .command("connect <url>")
    .description("Link a remote gateway. Its agents show on this gateway as <agentId>@<name>")
    .option("--name <name>", "Gateway name (default: host name of the URL)")
    .option("--token <token>", "User token of the remote gateway (not needed without multi-user mode)")
    .action(async (url: string, options: ConnectOptions) => {
      try {
        const gateway = await connectRemoteGateway(url, options);
        console.log(`Linked ${gateway.url} as "${gateway.name}".`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command("disconnect <name>")
    .description("Remove a linked remote gateway")
    .action((name: string) => {
      if (!getRemoteGatewayStore().remove(name)) {
        console.error(`No linked gateway named "${name}".`);
        process.exit(1);
      }
      console.log(`Removed "${name}".`);
    });

  program
    .command("remotes")
    .description("List linked remote gateways")
    .action(() => {
      const gateways = getRemoteGatewayStore().list();
      if (gateways.length === 0) console.log("No linked gateways.");
      for (const gateway of gateways) {
        console.log(`${gateway.name}\t${gateway.url}${gateway.token ? "\t(token)" : ""}`);
      }
    });
}
