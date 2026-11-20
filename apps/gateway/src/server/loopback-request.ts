import { isIP } from "node:net";
import type { Context } from "hono";
import { isLoopbackAddress } from "../relay/state.js";

export function requestPeerAddress(c: Context): string | undefined {
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
}

export function loopbackGatewayHosts(port: number): string[] {
  return ["127.0.0.1", "localhost", "[::1]"].map((name) => `${name}:${port}`);
}

function loopbackNode(raw: string): boolean {
  const value = raw.trim();
  const node = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  if (isLoopbackAddress(node)) return true;
  const parts = /^(?:\[([\da-f:.]+)\]|([\d.]+))(?::(\d{1,5}))?$/i.exec(node);
  if (!parts || (parts[3] && (+parts[3] === 0 || +parts[3] > 65535))) return false;
  if (parts[1] && isIP(parts[1]) !== 6) return false;
  return isLoopbackAddress(parts[1] ?? parts[2]);
}

export function loopbackForwarding(headers: Headers): boolean {
  const chain = headers.get("x-forwarded-for");
  if (chain !== null && !chain.split(",").every(loopbackNode)) return false;
  const realIp = headers.get("x-real-ip");
  if (realIp !== null && !loopbackNode(realIp)) return false;
  const forwarded = headers.get("forwarded");
  return forwarded === null || forwarded.split(",").every((hop) => {
    const params = new Map<string, string>();
    for (const part of hop.split(";")) {
      const match = /^\s*([a-z]+)\s*=\s*("[^"\r\n]*"|[^\s"=]+)\s*$/i.exec(part);
      if (!match) return false;
      const name = match[1].toLowerCase();
      if (params.has(name)) return false;
      params.set(name, match[2]);
    }
    const client = params.get("for");
    const proxy = params.get("by");
    return client !== undefined && loopbackNode(client) && (proxy === undefined || loopbackNode(proxy));
  });
}
