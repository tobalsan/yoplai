/**
 * Wire form of a skill ID for the `/api/skill-ids/:wireId` routes: `v1_` and the canonical unpadded base64url of the
 * complete UTF-8 ID. The wire form is one path segment. It never holds a separator, a percent escape, or padding.
 * The codec changes nothing in an ID. It keeps case, Unicode, slash, percent, colon, and `@` as they are. It never
 * decodes the ID again, and it never reads a gateway from its content. Browser and Node both run this file.
 */
export const SKILL_ID_WIRE_PREFIX = "v1_";

const WIRE_PATTERN = /^v1_[A-Za-z0-9_-]+$/;
// A lone surrogate has no UTF-8 form. The encoder would replace it, so such an ID has no wire form.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The wire form of an ID. An empty ID and an ID that is not well-formed Unicode have none. */
export function encodeSkillId(id: string): string {
  if (!id) throw new Error("A skill ID cannot be empty.");
  if (LONE_SURROGATE.test(id)) throw new Error("A skill ID must be well-formed Unicode.");
  return SKILL_ID_WIRE_PREFIX + toBase64Url(new TextEncoder().encode(id));
}

/**
 * The exact ID of a canonical wire form, or `undefined`. The function rejects padding, percent escapes, other
 * versions, malformed base64url, malformed UTF-8, an empty ID, and any form that is not the canonical encoding.
 */
export function decodeSkillId(wire: string): string | undefined {
  if (!WIRE_PATTERN.test(wire)) return undefined;
  const payload = wire.slice(SKILL_ID_WIRE_PREFIX.length);
  // One leftover base64 character cannot hold a whole byte.
  if (payload.length % 4 === 1) return undefined;
  let id: string;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payload.length % 4)) % 4);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    id = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (!id) return undefined;
  // `ignoreBOM` keeps a leading U+FEFF, which is valid Unicode. Noncanonical trailing bits change the encoding, so equality rejects them.
  return encodeSkillId(id) === wire ? id : undefined;
}
