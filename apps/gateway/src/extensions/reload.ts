import type { GatewayConfig } from "@yoplai/shared";
import { reloadConfig, setLoadedConfig } from "../config/index.js";
import { resolveStartupConfig } from "../config/validate.js";
import { reconcileExternal, withExtensionMutation } from "./registry.js";

/** Read and publish the config under the extension mutation lock. */
export async function reloadAfterExtensionWrite(): Promise<GatewayConfig> {
  return withExtensionMutation(async () => {
    const reloaded = await resolveStartupConfig(reloadConfig());
    setLoadedConfig(reloaded);
    try {
      await reconcileExternal(reloaded);
    } catch (error) {
      console.warn(
        `[extensions] runtime reconcile after enable failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return reloaded;
  }, true);
}
