import { spawn } from "node:child_process";
import type { Command } from "commander";
import { readEnv } from "@yoplai/shared";
import { loadConfig } from "../config/index.js";
import { getRemoteGatewayStore } from "../relay/state.js";
import { fetchRemote } from "../relay/remote.js";
import { LINK_OWNER_PAGE_PATH, checkRemoteOrigin, isValidGatewayName } from "../relay/link.js";
import type { RemoteGateway, RemoteGatewayStore } from "../relay/store.js";

type ConnectOptions = { name?: string; token?: string; browser?: boolean };

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

/**
 * Links a gateway with a token that the user copied. This path is explicit and stays for older remotes. It follows
 * the same address rule as the browser link: an origin only, with https:// except for 127.0.0.1 and [::1].
 */
export async function connectRemoteGateway(
  url: string,
  options: { name?: string; token: string },
  store: RemoteGatewayStore = getRemoteGatewayStore()
): Promise<RemoteGateway> {
  const checked = checkRemoteOrigin(url);
  if (!checked.ok) throw new Error(checked.message);
  const name = options.name ?? checked.value.defaultName;
  if (!isValidGatewayName(name)) {
    throw new Error(`Invalid gateway name "${name}". Use letters, digits, ".", "_" or "-". Set one with --name.`);
  }
  // A browser link owns a key on the remote. A token that replaced it would hide the key, and a later disconnect
  // would skip the revoke. The user disconnects the browser link first, which revokes the key.
  const refuseBrowserLink = () => {
    if (store.list().find((item) => item.name === name)?.managed) {
      throw new Error(`"${name}" is a browser link. Run "yoplai disconnect ${name}" first, then connect with a token.`);
    }
  };
  refuseBrowserLink();
  const gateway: RemoteGateway = { name, url: checked.value.origin, token: options.token };
  await verifyRemoteGateway(gateway);
  refuseBrowserLink();
  store.save(gateway);
  return gateway;
}

/** The running local gateway, which owns the browser link. The CLI never opens a callback listener. */
export function resolveLocalGatewayBase(): string {
  let port = 4000;
  try {
    port = loadConfig().gateway?.port ?? 4000;
  } catch {
    // No readable config: the default port applies.
  }
  const fromEnv = Number(readEnv("GATEWAY_PORT"));
  return `http://127.0.0.1:${Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : port}`;
}

function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The address is printed too, so the user can open it by hand.
  }
}

export type LinkClientDeps = {
  gatewayBase: string;
  fetch: typeof fetch;
  print: (line: string) => void;
  open: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultLinkClientDeps = (): LinkClientDeps => ({
  gatewayBase: resolveLocalGatewayBase(),
  fetch: (input, init) => globalThis.fetch(input, init),
  print: (line) => console.log(line),
  open: openInBrowser,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
});

type StartAnswer = {
  status?: string;
  name?: string;
  attemptId?: string;
  controlToken?: string;
  expiresAt?: string;
  consentUrl?: string;
  recoveryNote?: string;
  message?: string;
  error?: string;
};
type StatusAnswer = { status?: string; message?: string; ownerPageUrl?: string; name?: string };

async function callGateway<T>(deps: LinkClientDeps, route: string, init: RequestInit): Promise<{ status: number; body: T }> {
  let response: Response;
  try {
    response = await deps.fetch(`${deps.gatewayBase}${route}`, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error(`Cannot reach the local gateway at ${deps.gatewayBase}. Start it with "yoplai gateway", then try again.`);
  }
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}

const jsonPost = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * Links a remote gateway with a browser sign-in, through the running local gateway. The remote gateway shows a
 * consent page, and the user approves it in a browser on this computer. A remote with no sign-in (single-user) links
 * with no page and no key. The CLI prints no key, code, or state, because it never sees them.
 */
export async function linkWithBrowser(
  url: string,
  options: { name?: string; openBrowser: boolean },
  overrides: Partial<LinkClientDeps> = {}
): Promise<{ name: string }> {
  const deps = { ...defaultLinkClientDeps(), ...overrides };
  const started = await callGateway<StartAnswer>(deps, "/api/relay/link/start", jsonPost({ remote: url, ...(options.name ? { name: options.name } : {}) }));
  if (started.status >= 400) throw new Error(started.body.message ?? `The local gateway refused the link (HTTP ${started.status}).`);
  if (started.body.status === "linked" && started.body.name) return { name: started.body.name };
  const { attemptId, controlToken, consentUrl, expiresAt } = started.body;
  if (!attemptId || !controlToken || !consentUrl) throw new Error("The local gateway gave an unexpected answer.");
  if (started.body.recoveryNote) deps.print(started.body.recoveryNote);
  deps.print("Open this address in a browser on this computer, sign in, and approve the link:");
  deps.print(`  ${consentUrl}`);
  if (options.openBrowser) deps.open(consentUrl);
  deps.print("Waiting for your approval...");
  const deadline = Math.max(deps.now(), Date.parse(expiresAt ?? "") || 0) + 10_000;
  for (;;) {
    await deps.sleep(1000);
    const polled = await callGateway<StatusAnswer>(deps, `/api/relay/link/status/${attemptId}`, { headers: { "x-link-control": controlToken } });
    if (polled.status >= 400) throw new Error(polled.body.message ?? "The local gateway lost this link attempt. Start again.");
    const { status, message } = polled.body;
    if (status === "linked") return { name: polled.body.name ?? options.name ?? "" };
    if (status === "denied") throw new Error("The link was refused on the remote gateway.");
    if (status === "uncertain") throw new Error(message ?? `Revoke the key on the owner page at ${LINK_OWNER_PAGE_PATH}, then link again.`);
    if (status && status !== "pending" && status !== "exchanging") throw new Error(message ?? `The link ended with the state "${status}". Start again.`);
    if (deps.now() > deadline) throw new Error("The link request expired. Start again.");
  }
}

type DisconnectResult = { revoked?: "remote" | "already" | "not_needed" | "skipped"; message?: string };

/**
 * Removes a link. A browser link revokes its key on the remote first, through the running gateway. While the
 * gateway is down, only a link with no managed key goes away here, or a link that the user removes with --local-only.
 */
export async function disconnectRemoteGateway(
  name: string,
  options: { localOnly?: boolean },
  store: RemoteGatewayStore = getRemoteGatewayStore(),
  overrides: Partial<LinkClientDeps> = {}
): Promise<string> {
  const deps = { ...defaultLinkClientDeps(), ...overrides };
  const entry = store.list().find((gateway) => gateway.name === name);
  if (!entry) throw new Error(`No linked gateway named "${name}".`);
  let answer: { status: number; body: DisconnectResult };
  try {
    answer = await callGateway<DisconnectResult>(deps, "/api/relay/link/disconnect", jsonPost({ name, localOnly: options.localOnly === true }));
  } catch (error) {
    if (entry.managed && !options.localOnly) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} The link "${name}" has a key on the remote gateway, so it stays. Use --local-only to remove it from this computer only.`);
    }
    store.removeIfGeneration(name, entry.generation);
    return `Removed "${name}" from this computer.${entry.managed ? " The remote key stays valid until it is revoked or it expires." : ""}`;
  }
  if (answer.status >= 400) throw new Error(answer.body.message ?? `The local gateway refused the removal (HTTP ${answer.status}).`);
  if (answer.body.revoked === "skipped") return `Removed "${name}" from this computer. The remote key stays valid until it is revoked or it expires.`;
  if (answer.body.revoked === "remote") return `Revoked the key on the remote gateway and removed "${name}".`;
  if (answer.body.revoked === "already") return `The remote gateway no longer accepted the key. Removed "${name}".`;
  return `Removed "${name}".`;
}

export function registerConnectCommands(program: Command): void {
  program
    .command("connect <url>")
    .description("Link a remote gateway. Its agents show on this gateway as <agentId>@<name>")
    .option("--name <name>", "Gateway name (default: host name of the URL)")
    .option("--token <token>", "Link with a user token that you copied, with no browser sign-in")
    .option("--no-browser", "Print the sign-in address and do not open a browser")
    .action(async (url: string, options: ConnectOptions) => {
      try {
        if (options.token) {
          const gateway = await connectRemoteGateway(url, { name: options.name, token: options.token });
          console.log(`Linked ${gateway.url} as "${gateway.name}".`);
          return;
        }
        const linked = await linkWithBrowser(url, { name: options.name, openBrowser: options.browser !== false });
        console.log(`Linked "${linked.name}".`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command("disconnect <name>")
    .description("Remove a linked remote gateway. A browser link revokes its key first")
    .option("--local-only", "Remove the link from this computer only. The remote key stays valid until it is revoked")
    .action(async (name: string, options: { localOnly?: boolean }) => {
      try {
        console.log(await disconnectRemoteGateway(name, options));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command("remotes")
    .description("List linked remote gateways")
    .action(() => {
      const gateways = getRemoteGatewayStore().list();
      if (gateways.length === 0) console.log("No linked gateways.");
      for (const gateway of gateways) {
        const kind = gateway.managed ? "\t(browser link)" : gateway.token ? "\t(token)" : "";
        console.log(`${gateway.name}\t${gateway.url}${kind}`);
      }
    });
}
