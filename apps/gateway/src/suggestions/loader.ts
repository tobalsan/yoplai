import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { SuggestionSchema, type Suggestion } from "@yoplai/shared/types";

/** Reads workspace-authored suggestions without letting malformed files affect requests. */
export async function loadSuggestions(workspaceDir: string): Promise<Suggestion[]> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, "suggestions.yaml"), "utf8");
    const parsed = yaml.load(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const result = SuggestionSchema.safeParse(entry);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}
