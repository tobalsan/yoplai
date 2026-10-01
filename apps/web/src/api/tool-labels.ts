import type { ToolLabelTemplates } from "@yoplai/shared/tool-labels";
import { API_BASE, apiFetch as fetch } from "./core";

export async function fetchToolLabels(): Promise<ToolLabelTemplates> {
  const res = await fetch(`${API_BASE}/tool-labels`);
  if (!res.ok) throw new Error("Failed to load tool labels");
  return res.json();
}
