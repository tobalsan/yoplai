import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { GATEWAY_LINK_CALLBACK_PATH } from "@yoplai/shared";

/** Reserved prefix of a managed link key. Only the gateway link service may create a key with it. */
export const MANAGED_KEY_PREFIX = "gl_";
export const KEY_NAME_DEVICE_MAX = 12;
export const DEVICE_LABEL_MAX = 64;

export function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** PKCE S256: base64url of the SHA-256 digest of the verifier. */
export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const CALLBACK_PATTERN = new RegExp(`^http://127\\.0\\.0\\.1:([1-9][0-9]{0,4})${GATEWAY_LINK_CALLBACK_PATH.replace(/\//g, "\\/")}$`);

/**
 * The only accepted callback: HTTP, the literal `127.0.0.1`, an explicit valid port, and the fixed path. The pattern
 * rejects credentials, a query, a fragment, a host name, other loopback spellings, and a leading-zero port.
 */
export function isValidCallbackUri(value: string): boolean {
  const match = CALLBACK_PATTERN.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}

/** A label for the consent page: no control, format, or line characters, collapsed spaces, bounded length. */
export function sanitizeDeviceLabel(raw: string): string | null {
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  return Array.from(cleaned).slice(0, DEVICE_LABEL_MAX).join("");
}

/** The device part of a key name: ASCII letters, digits, `.`, `_`, `-`, at most 12 characters, `device` when empty. */
export function keyNameDevice(label: string): string {
  const ascii = label.replace(/[^A-Za-z0-9._-]/g, "").slice(0, KEY_NAME_DEVICE_MAX);
  return ascii.length > 0 ? ascii : "device";
}

export function newLinkId(): string {
  return randomUUID();
}

/** Eight lowercase hexadecimal characters of a link ID. The name is a display aid, never an identity. */
export function shortLinkId(linkId: string): string {
  return linkId.replace(/-/g, "").toLowerCase().replace(/[^0-9a-f]/g, "0").padEnd(8, "0").slice(0, 8);
}

/** `Desktop: <device> (<id8>)`, at most 32 characters (9 + 12 + 2 + 8 + 1). */
export function managedKeyName(deviceLabel: string, linkId: string): string {
  return `Desktop: ${keyNameDevice(deviceLabel)} (${shortLinkId(linkId)})`;
}

/** A random 128-bit issuance ID (22 characters) and the candidate key prefix that the service stores before it creates the key. */
export function newIssuance(): { id: string; prefix: string } {
  const id = randomBase64Url(16);
  return { id, prefix: `${MANAGED_KEY_PREFIX}${id}` };
}

export function isReservedPrefix(prefix: unknown): boolean {
  return typeof prefix === "string" && prefix.toLowerCase().startsWith(MANAGED_KEY_PREFIX);
}

/**
 * The consent nonce binds the request ID, the session ID, the action context, and the request expiry. It is a MAC of
 * those values under a key derived from the session secret, so no state is stored and a nonce of one session does not
 * work in another.
 */
export function consentNonce(secret: string, requestId: string, sessionId: string, expiresAt: number): string {
  const key = createHash("sha256").update(`yoplai-gateway-link-consent:${secret}`).digest();
  return createHmac("sha256", key).update(`consent\n${requestId}\n${sessionId}\n${expiresAt}`).digest("base64url");
}

/**
 * True when a JSON object text names one key twice at its top level. `JSON.parse` keeps the last value and hides the
 * first, so a body with a repeated key is a body that two readers can read in two ways.
 */
export function hasDuplicateTopLevelKey(text: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      let after = end + 1;
      while (after < text.length && /\s/.test(text[after]!)) after++;
      if (depth === 1 && text[after] === ":") {
        let key: string;
        try {
          key = JSON.parse(text.slice(index, end + 1)) as string;
        } catch {
          return true;
        }
        if (seen.has(key)) return true;
        seen.add(key);
      }
      index = end + 1;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    index++;
  }
  return false;
}
