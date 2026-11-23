import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { resolveAgentEnv, resolveWorkspaceDir } from "../config/index.js";
import { buildOnecliEnv, type OnecliEnv } from "../config/onecli.js";

const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"] as const satisfies readonly (keyof OnecliEnv)[];

export function durableExtensionEnv(agent: AgentConfig, config: GatewayConfig) {
  const env = resolveAgentEnv(agent, config);
  for (const key of proxyKeys) delete env[key];
  return env;
}

export function durableExecutionEnv(agent: AgentConfig, config: GatewayConfig) {
  const proxy = buildOnecliEnv(config, agent.id);
  const shellEnv: NodeJS.ProcessEnv = durableExtensionEnv(agent, config);
  for (const key of proxyKeys) shellEnv[key] = proxy?.[key];
  return new NodeExecutionEnv({
    cwd: resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace),
    shellEnv,
  });
}
