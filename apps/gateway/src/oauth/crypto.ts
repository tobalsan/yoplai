import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * Token-at-rest encryption for the OAuth connection store.
 *
 * OAuth tokens (access + refresh) are live credentials: a leaked token file or
 * DB row hands an attacker a working Google grant. To make a leaked row inert,
 * the store encrypts token fields with AES-256-GCM before persisting and only
 * decrypts them in memory on read.
 *
 * The encryption secret comes from instance config/env
 * (`oauth.encryptionKey`, typically a `$env:` ref). The 32-byte AES key is
 * derived from that secret with scrypt **once per cipher instance** over a fixed
 * application salt, so the operator can supply a passphrase of any length
 * without paying the (deliberately expensive) KDF cost on every read/write —
 * token resolution runs on the hot per-tool-call path. Semantic security comes
 * from a fresh random IV per encryption, not from a per-ciphertext salt.
 *
 * Ciphertext format (all bytes base64-joined after the version tag):
 *   `enc:v2:base64(iv[12] | authTag[16] | ciphertext)`
 * The `enc:` prefix lets readers distinguish ciphertext from legacy plaintext
 * and makes it trivial to assert "no plaintext token was persisted" in tests.
 * `enc:v1:` envelopes (per-ciphertext scrypt salt) are still decrypted for
 * backward compatibility and are re-encrypted as v2 on the next save.
 */

const PREFIX_V2 = "enc:v2:";
const PREFIX_V1 = "enc:v1:";
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/**
 * Fixed application salt for the once-per-instance key derivation. A constant
 * salt is sound here because the input secret is a high-entropy operator key
 * (not a low-entropy user password being protected against rainbow tables); the
 * per-encryption random IV is what guarantees distinct ciphertexts.
 *
 * FROZEN KEY MATERIAL — never rename, re-brand or reformat these bytes. They are
 * a scrypt input, not prose: every `enc:v2:` token already on disk was encrypted
 * under a key derived from this exact string, so changing a single byte makes
 * every persisted OAuth token fail its GCM auth tag and silently disconnects
 * every connected account. The `aihub` spelling predates the yoplai rename and
 * must stay. A new salt requires a new `enc:v3:` prefix, not an edit here.
 */
const KDF_SALT = Buffer.from("aihub-oauth-token-at-rest-v2", "utf8");

/** True when the value is one of our AES-GCM ciphertext envelopes. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX_V2) || value.startsWith(PREFIX_V1);
}

export class TokenCipher {
  #secret: Buffer;
  #key: Buffer;

  constructor(secret: string) {
    if (!secret) {
      throw new Error("TokenCipher requires a non-empty encryption secret");
    }
    this.#secret = Buffer.from(secret, "utf8");
    this.#key = scryptSync(this.#secret, KDF_SALT, KEY_LEN);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return PREFIX_V2 + Buffer.concat([iv, tag, ciphertext]).toString("base64");
  }

  decrypt(value: string): string {
    if (value.startsWith(PREFIX_V2)) {
      return this.#decryptV2(value.slice(PREFIX_V2.length));
    }
    if (value.startsWith(PREFIX_V1)) {
      return this.#decryptV1(value.slice(PREFIX_V1.length));
    }
    // Legacy plaintext (written before encryption was enabled): pass through
    // so existing connections keep working. They are re-encrypted on next save.
    return value;
  }

  #decryptV2(payload: string): string {
    const raw = Buffer.from(payload, "base64");
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAuthTag(tag);
    return (
      decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8")
    );
  }

  // v1 envelope: salt[16] | iv[12] | tag[16] | ciphertext, key = scrypt(secret, salt).
  #decryptV1(payload: string): string {
    const raw = Buffer.from(payload, "base64");
    const salt = raw.subarray(0, SALT_LEN);
    const iv = raw.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag = raw.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
    const ciphertext = raw.subarray(SALT_LEN + IV_LEN + TAG_LEN);
    const key = scryptSync(this.#secret, salt, KEY_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return (
      decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8")
    );
  }
}
