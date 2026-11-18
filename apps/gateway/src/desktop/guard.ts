import { isIP } from "node:net";
import { readEnv } from "@yoplai/shared";
import type { Context, MiddlewareHandler } from "hono";
import { getGatewayListener, isRelayEnabled } from "../relay/state.js";
import { isLoopbackAddress, loopbackGatewayHosts, requestPeerAddress } from "../relay/link-routes.js";

export function desktopEnabled(): boolean {
  return process.env.YOPLAI_DESKTOP === "1";
}

function isDesktopLoopbackAddress(address: string): boolean {
  return isIP(address) !== 0 && isLoopbackAddress(address);
}

function loopbackNode(raw: string): boolean {
  const value = raw.trim();
  const node = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  if (isDesktopLoopbackAddress(node)) return true;
  const parts = /^(?:\[([\da-f:.]+)\]|([\d.]+))(?::(\d{1,5}))?$/i.exec(node);
  if (!parts || (parts[3] && (+parts[3] === 0 || +parts[3] > 65535))) return false;
  if (parts[1] && isIP(parts[1]) !== 6) return false;
  return isDesktopLoopbackAddress(parts[1] ?? parts[2]);
}

function loopbackForwarding(headers: Headers): boolean {
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

export function desktopSetupAllowed(c: Context, multiUser: boolean, uiPort: number): boolean {
  if (!desktopEnabled() || multiUser || !isRelayEnabled()) return false;
  const listener = getGatewayListener();
  const peer = requestPeerAddress(c) ?? (c.env as { peerAddress?: string } | undefined)?.peerAddress;
  if (!listener || !isDesktopLoopbackAddress(listener.address) || !peer || !isDesktopLoopbackAddress(peer)) return false;
  if (!loopbackForwarding(c.req.raw.headers)) return false;
  const host = c.req.header("host")?.toLowerCase();
  if (!host || !loopbackGatewayHosts(listener.port).includes(host)) return false;
  const configuredPort = Number(readEnv("UI_PORT"));
  const effectivePort = configuredPort > 0 && configuredPort < 65536 && Number.isInteger(configuredPort) ? configuredPort : uiPort;
  const origin = c.req.header("origin");
  if (origin !== undefined && !loopbackGatewayHosts(effectivePort).some((uiHost) => origin === `http://${uiHost}`)) return false;
  const site = c.req.header("sec-fetch-site");
  return site === undefined || site === "same-origin" || site === "none";
}

export function desktopSetupGuard(multiUser: () => boolean, uiPort: () => number): MiddlewareHandler {
  return async (c, next) => {
    if (!desktopEnabled() || !isRelayEnabled() || !desktopSetupAllowed(c, multiUser(), uiPort())) {
      return c.json({ error: "desktop_setup_unavailable" }, 403, { "cache-control": "no-store" });
    }
    if (c.req.raw.body !== null && !["GET", "HEAD"].includes(c.req.method)) {
      const mediaType = c.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") return c.json({ error: "json_required" }, 415, { "cache-control": "no-store" });
    }
    c.header("cache-control", "no-store");
    await next();
  };
}
