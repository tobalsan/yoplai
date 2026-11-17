/**
 * The import prompt of a remote gateway holds the root import address that the remote builds from its configured base
 * address. A hostname check cannot show that an importing client reaches the address, and it cannot show that an
 * operator set the address on purpose. The check below only refuses an address that cannot work for any other client or
 * that sends the secret token in the clear. A private address, an internal name, and a tailnet name stay allowed, because
 * a configured private HTTPS origin can serve a client that has access to it. The page never replaces the address, never
 * resolves a name, never probes the endpoint, and never sends the token anywhere else.
 * Returns a message for the user, or nothing when the address passes.
 */
export const IMPORT_ENDPOINT_PATH = "/api/skills/import";
export const IMPORT_REACH_NOTE = "The importing client must reach this HTTPS address. Expose /api/skills/import at the origin root.";

/** The first whole address token of the prompt, delimited by white space. The function never cuts a token. */
function promptAddress(prompt: string): string | undefined {
  return /(?:^|\s)(https?:\/\/\S+)/.exec(prompt)?.[1];
}

/** Loopback and unspecified destinations. No other client can use them. */
function isLoopbackOrUnspecified(hostname: string): boolean {
  // A final DNS dot names the same host. The URL parser has already lower-cased the name and turned numeric forms
  // such as `127.1` and `0x7f.1` into dotted quads.
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("[")) {
    const address = host.slice(1, -1);
    if (address === "::1" || address === "::") return true;
    // An IPv4-mapped address, in the form that the URL parser writes: `::ffff:7f00:1` or `::ffff:0:0`.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
    if (mapped) {
      const first = parseInt(mapped[1], 16) >> 8;
      return first === 127 || first === 0;
    }
    return false;
  }
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  return !!octets && (octets[0] === 127 || octets[0] === 0);
}

export function importAddressProblem(prompt: string): string | undefined {
  const token = promptAddress(prompt);
  if (!token) return "The import prompt of this gateway has no import address. Update the gateway.";
  let url: URL;
  try { url = new URL(token); }
  catch { return "The import address of this gateway is not valid."; }
  if (url.protocol !== "https:") {
    return `The import address of this gateway is ${url.origin}, which uses plain HTTP. Set server.baseUrl on the gateway to an HTTPS address, expose ${IMPORT_ENDPOINT_PATH} at the root of that address, and try again.`;
  }
  // The whole token must be the endpoint. A path prefix, a query, a fragment, credentials, and a second address inside the
  // token are not the endpoint, even when the text holds the endpoint path.
  if (url.username || url.password || /[?#]/.test(token) || url.pathname !== IMPORT_ENDPOINT_PATH) {
    return `The import address of this gateway is not the root endpoint. It must be an HTTPS address with the exact path ${IMPORT_ENDPOINT_PATH}, with no credentials, query, or fragment. Set server.baseUrl on the gateway to the origin, and try again.`;
  }
  if (isLoopbackOrUnspecified(url.hostname)) {
    return `The import address of this gateway is ${url.origin}, which only works on that gateway. Set server.baseUrl on the gateway to an address that the importing client can reach, expose ${IMPORT_ENDPOINT_PATH} at the root of that address, and try again.`;
  }
  return undefined;
}
