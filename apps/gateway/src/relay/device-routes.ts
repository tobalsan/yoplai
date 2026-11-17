import fs from "node:fs";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { addGatewaySuffix } from "./agent-id.js";
import { getDeviceLinkStates } from "./device-links.js";
import { resolveDeviceMode } from "./device-gate.js";
import { deviceAgentKey, deviceChatKey, getDeviceSettingsStore, type DeviceSettingsStore } from "./device-settings.js";
import { getLinkedGateways, isRelayEnabled, isTrustedRequest, resolveRemoteAgent } from "./state.js";
import type { DeviceLinkState } from "./device-link-client.js";
import type { RemoteGateway } from "./store.js";

export type DeviceRoutesDeps = {
  isEnabled: () => boolean;
  getGateways: () => RemoteGateway[];
  getLinkStates: () => DeviceLinkState[];
  settings: () => DeviceSettingsStore;
};

const defaultDeps: DeviceRoutesDeps = {
  isEnabled: isRelayEnabled,
  getGateways: getLinkedGateways,
  getLinkStates: getDeviceLinkStates,
  settings: getDeviceSettingsStore,
};

function isExistingDirectory(folder: string): boolean {
  try {
    return path.isAbsolute(folder) && fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Local routes for the device links and the device settings. A request that is not trusted, or that
 * arrives while the relay is off, falls through to the next handler, as for an unknown route.
 */
export function relayDeviceApi(overrides: Partial<DeviceRoutesDeps> = {}): MiddlewareHandler {
  const deps = { ...defaultDeps, ...overrides };
  return async (c, next) => {
    const url = new URL(c.req.url);
    const route = url.pathname;
    const isDeviceRoute =
      route === "/api/relay/device-links" || route === "/api/relay/device-settings" || route === "/api/relay/agent-settings";
    if (
      !isDeviceRoute ||
      !deps.isEnabled() ||
      !isTrustedRequest(c.req.header("origin"), c.req.header("x-forwarded-for"))
    ) {
      return next();
    }
    const method = c.req.method;
    if (route === "/api/relay/device-links") {
      return method === "GET" ? c.json(deps.getLinkStates()) : next();
    }
    if (method !== "GET" && method !== "PUT") return next();

    const agentId = url.searchParams.get("agentId") ?? "";
    const target = resolveRemoteAgent(agentId, deps.getGateways());
    const link = deps.getGateways().find((gateway) => gateway.name === target.gateway);
    if (!link) return c.json({ error: "Unknown remote agent" }, 404);
    const store = deps.settings();
    const agentKey = deviceAgentKey(link, addGatewaySuffix(target.agentId, link.name));

    if (route === "/api/relay/agent-settings") {
      if (method === "PUT") {
        const body = await readJsonObject(c.req.raw);
        if (typeof body?.fullBackground !== "boolean") return c.json({ error: "fullBackground must be a boolean" }, 400);
        store.setAgentFullBackground(agentKey, body.fullBackground);
      }
      return c.json({ agentId, fullBackground: store.getAgentFullBackground(agentKey) });
    }

    const chat = url.searchParams.get("chat") ?? "";
    if (!chat) return c.json({ error: "chat is required" }, 400);
    const chatKey = deviceChatKey(link, addGatewaySuffix(target.agentId, link.name), chat);
    if (method === "PUT") {
      const body = await readJsonObject(c.req.raw);
      if (!body) return c.json({ error: "Invalid JSON body" }, 400);
      const current = store.getChat(chatKey);
      const folder = body.workspaceFolder;
      if (folder !== undefined && folder !== null && (typeof folder !== "string" || !isExistingDirectory(folder))) {
        return c.json({ error: "workspaceFolder must be an absolute path to a directory that exists" }, 400);
      }
      if (body.full !== undefined && typeof body.full !== "boolean") return c.json({ error: "full must be a boolean" }, 400);
      store.setChat(chatKey, {
        workspaceFolder: folder === undefined ? current.workspaceFolder : (folder ?? undefined),
        full: body.full ?? current.full,
      });
    }
    const settings = store.getChat(chatKey);
    return c.json({
      agentId,
      chat,
      workspaceFolder: settings.workspaceFolder ?? null,
      full: settings.full,
      // The executor ignores a workspace folder that does not exist, so the mode ignores it too.
      mode: resolveDeviceMode({
        ...settings,
        workspaceFolder: settings.workspaceFolder && isExistingDirectory(settings.workspaceFolder) ? settings.workspaceFolder : undefined,
      }),
    });
  };
}
