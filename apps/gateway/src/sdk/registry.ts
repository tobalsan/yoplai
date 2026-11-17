import type { SdkAdapter, SdkId } from "./types.js";
import { piAdapter } from "./pi/adapter.js";

const adapters: Record<SdkId, SdkAdapter> = {
  pi: piAdapter,
};

export function getSdkAdapter(id: SdkId): SdkAdapter {
  const adapter = adapters[id];
  if (!adapter) {
    throw new Error(`Unknown SDK: ${id}`);
  }
  return adapter;
}

export function getDefaultSdkId(): SdkId {
  return "pi";
}
