import type { Command } from "commander";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { generateAgentAvatar, type AvatarServiceDeps } from "./service.js";
import { defaultAvatarStyle, listAvatarStyles, resolveAvatarStyle } from "./styles.js";

type AvatarCommandDeps = {
  loadConfig(): GatewayConfig;
  service?: AvatarServiceDeps;
  log?: (line: string) => void;
};

/**
 * `yoplai agent avatar [agentId]`: generate avatars from the host, one agent or
 * all of them. The running gateway picks the agent.yaml change up on hot reload.
 */
export function registerAvatarCommand(agentCmd: Command, deps: AvatarCommandDeps): void {
  agentCmd
    .command("avatar [agentId]")
    .description("Generate an agent avatar image in a chosen style")
    .option("--all", "Generate for every configured agent")
    .option("-s, --style <id>", "Style id (see --list-styles)")
    .option("--list-styles", "List the available styles and exit")
    .action(async (agentId: string | undefined, opts: { all?: boolean; style?: string; listStyles?: boolean }) => {
      const log = deps.log ?? ((line: string) => console.log(line));
      const config = deps.loadConfig();
      if (opts.listStyles) {
        const fallback = defaultAvatarStyle(config);
        for (const style of listAvatarStyles(config)) log(`${style.id}${style.id === fallback ? " (default)" : ""}: ${style.label}`);
        return;
      }
      const agents: AgentConfig[] = opts.all ? config.agents : config.agents.filter((agent) => agent.id === agentId);
      const usageError = !agentId === !opts.all ? "Give one agent id, or --all" : agents.length === 0 ? `Agent not found: ${agentId}` : undefined;
      if (usageError) {
        log(usageError);
        process.exitCode = 1;
        return;
      }
      try {
        // Fail on a typo before spending an image on the first agent.
        resolveAvatarStyle(config, opts.style);
      } catch (error) {
        log((error as Error).message);
        process.exitCode = 1;
        return;
      }
      let failed = 0;
      for (const agent of agents) {
        try {
          const result = await generateAgentAvatar(agent, config, opts.style, deps.service);
          log(`${agent.id}: ${result.file} (${result.style})`);
        } catch (error) {
          failed += 1;
          log(`${agent.id}: failed: ${(error as Error).message}`);
        }
      }
      if (failed > 0) process.exitCode = 1;
    });
}
