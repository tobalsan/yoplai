import { isLocalHostname } from "./remote-dashboard";

/**
 * The import prompt of a remote gateway holds the root import address that the remote builds from its public base address.
 * An address that points at the local machine or the private network cannot work for another client, and the remote then
 * has no public base address set. The page never replaces this address with the local relay or a browser address.
 * Returns a message for the user, or nothing when the address is usable.
 */
export function importAddressProblem(prompt: string): string | undefined {
  const match = /https?:\/\/[^\s"'<>]+?\/api\/skills\/import(?![\w-])/.exec(prompt);
  if (!match) return "The import prompt of this gateway has no import address. Update the gateway.";
  let url: URL;
  try { url = new URL(match[0]); }
  catch { return "The import address of this gateway is not valid."; }
  // A remote import prompt holds a secret token. Over plain HTTP on a public address it would cross the network unprotected.
  if (url.protocol !== "https:" && !isLocalHostname(url.hostname)) {
    return `The import address of this gateway is ${url.origin}, which uses plain HTTP. Set server.baseUrl on the gateway to an HTTPS public address, expose /api/skills/import at the root of that address, and try again.`;
  }
  if (isLocalHostname(url.hostname)) {
    return `The import address of this gateway is ${url.origin}, which only works on that gateway. Set server.baseUrl on the gateway to its public address, expose /api/skills/import at the root of that address, and try again.`;
  }
  return undefined;
}
