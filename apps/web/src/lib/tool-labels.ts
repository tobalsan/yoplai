import { createSignal } from "solid-js";
import type { ToolLabelTemplates } from "@yoplai/shared/tool-labels";
import { fetchToolLabels } from "../api/tool-labels";

const [toolLabelTemplates, setToolLabelTemplates] =
  createSignal<ToolLabelTemplates>({});

export { toolLabelTemplates };

/** Load generated label templates; failures keep the previous map (fallback labels still work). */
export async function refreshToolLabels(): Promise<void> {
  try {
    setToolLabelTemplates(await fetchToolLabels());
  } catch {
    // Friendly labels are cosmetic.
  }
}
