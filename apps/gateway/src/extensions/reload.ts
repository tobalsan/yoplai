import type { GatewayConfig } from "@yoplai/shared";
import { reloadConfig, setLoadedConfig } from "../config/index.js";
import { resolveStartupConfig } from "../config/validate.js";
import { reloadExtensions } from "./registry.js";

/**
 * Reload the gateway config after an `agent.yaml` write.
 *
 * This clears the config cache, so the next run and the next catalog read see
 * the change. It also brings a newly enabled extension online without a
 * gateway restart (ALG-349). It reconciles the extension set under the same lock as catalog changes.
 */
export async function reloadAfterExtensionWrite(): Promise<GatewayConfig> {
  const rawReloaded = reloadConfig();
  const reloaded = await resolveStartupConfig(rawReloaded);
  setLoadedConfig(reloaded);
  try {
    await reloadExtensions(reloaded);
  } catch (error) {
    console.warn(
      `[extensions] runtime reconcile after enable failed: ${(error as Error).message}`
    );
  }
  return reloaded;
}
