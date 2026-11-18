export const CODEX_EXPIRED = "Your Codex login expired. Open Codex once, or sign in here.";

export function isLiteralKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key === key.trim() && !key.startsWith("!") && !/\$\{[^}]*\}|\$[A-Za-z_]/.test(key) && [...key].every((char) => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127);
}
