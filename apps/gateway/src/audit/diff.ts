import { isDeepStrictEqual } from "node:util";
import type { SettingsAuditChange } from "@yoplai/shared";

/** Compare resolved values in memory; secret values never leave this helper. */
export function diffSettings(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  secretFields: readonly string[] = []
): SettingsAuditChange[] {
  const secrets = new Set(secretFields);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap<SettingsAuditChange>((field) => {
    if (isDeepStrictEqual(before[field], after[field])) return [];
    if (secrets.has(field)) return [{ field, secret: after[field] === undefined || after[field] === null || after[field] === "" ? "removed" as const : "set" as const }];
    return [{ field, ...(before[field] !== undefined ? { before: before[field] } : {}), ...(after[field] !== undefined ? { after: after[field] } : {}) }];
  });
}
