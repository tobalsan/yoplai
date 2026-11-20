import type { GatewayConfig } from "@yoplai/shared";
import { loadConfig, reloadConfig, setLoadedConfig } from "../config/index.js";
import { resolveStartupConfig } from "../config/validate.js";
import { reconcileExternal, withExtensionMutation } from "./registry.js";

/** Read and publish the config under the extension mutation lock. */
export async function reloadAfterExtensionWrite(verify?: () => Promise<void>): Promise<GatewayConfig> {
  return withExtensionMutation(async () => {
    const previous = verify ? loadConfig() : undefined;
    try {
      const reloaded = await resolveStartupConfig(reloadConfig());
      setLoadedConfig(reloaded);
      await verify?.();
      try {
        await reconcileExternal(reloaded);
      } catch (error) {
        console.warn(
          `[extensions] runtime reconcile after enable failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return reloaded;
    } catch (error) {
      if (previous) setLoadedConfig(previous);
      throw error;
    }
  }, true);
}
