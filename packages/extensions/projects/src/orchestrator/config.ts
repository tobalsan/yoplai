import {
  ProjectsOrchestratorConfigSchema,
  type GatewayConfig,
  type ProjectsOrchestratorConfig,
} from "@yoplai/shared";

export type OrchestratorConfig = ProjectsOrchestratorConfig;

export function getOrchestratorConfig(
  config: GatewayConfig
): OrchestratorConfig {
  return ProjectsOrchestratorConfigSchema.parse(
    config.extensions?.projects?.orchestrator ?? {}
  );
}
