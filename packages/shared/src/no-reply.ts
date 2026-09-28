export const NO_REPLY_TOKEN = "NO_REPLY";

/** Normalize the intentionally silent response token for display and delivery. */
export function isNoReply(text: string): boolean {
  let normalized = text.trim();
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1).trimEnd();

  while (
    (normalized.startsWith("**") && normalized.endsWith("**") && normalized.length >= 4) ||
    (normalized.startsWith("*") && normalized.endsWith("*") && normalized.length >= 2) ||
    (normalized.startsWith("`") && normalized.endsWith("`") && normalized.length >= 2)
  ) {
    if (normalized.startsWith("**") && normalized.endsWith("**")) {
      normalized = normalized.slice(2, -2).trim();
    } else {
      normalized = normalized.slice(1, -1).trim();
    }
  }

  return normalized === NO_REPLY_TOKEN;
}
