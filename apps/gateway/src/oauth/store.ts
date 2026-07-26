import fs from "node:fs";
import path from "node:path";
import {
  OAuthConnectionSchema,
  type OAuthConnection,
} from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";
import { TokenCipher } from "./crypto.js";
import { resolveTokenCipher } from "./encryption.js";

/**
 * File-backed store for OAuth connections. Connections are scoped to a single
 * (agent, provider) pair — one connection per pair, not per user. Persisted as
 * one JSON file per pair under `$YOPLAI_HOME/oauth/`.
 *
 * Token fields (access + refresh) are encrypted at rest with AES-256-GCM using
 * the configured encryption secret (`oauth.encryptionKey`); a leaked token file
 * then yields ciphertext, not a live Google grant. Tokens are only decrypted in
 * memory on read.
 *
 * The store **fails closed**: if no encryption secret is configured, {@link save}
 * throws rather than persisting plaintext tokens, so a missing key can never
 * create a new plaintext token row. Reads remain tolerant of legacy plaintext
 * rows written before encryption was enabled (they are re-encrypted on next
 * save).
 */
export class OAuthConnectionStore {
  #dir: string;
  #cipher: TokenCipher | undefined;

  /**
   * @param cipher token cipher. When omitted, it is resolved from instance
   *   config (`oauth.encryptionKey`) via {@link resolveTokenCipher}; pass `null`
   *   to force the no-cipher state without touching config (tests). With no
   *   cipher, {@link save} fails closed, but reads still work (legacy plaintext
   *   passes through), so the gateway can boot and surface existing connections
   *   even without a key.
   */
  constructor(
    dir: string = path.join(CONFIG_DIR, "oauth"),
    cipher: TokenCipher | null | undefined = undefined
  ) {
    this.#dir = dir;
    // `undefined` => resolve from config; `null` => explicitly no cipher.
    this.#cipher = cipher === undefined ? resolveTokenCipher() : cipher ?? undefined;
  }

  #fileFor(agentId: string, provider: string): string {
    const safe = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(this.#dir, `${safe(agentId)}__${safe(provider)}.json`);
  }

  get(agentId: string, provider: string): OAuthConnection | undefined {
    const file = this.#fileFor(agentId, provider);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = OAuthConnectionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    return this.#decryptTokens(parsed.data);
  }

  save(connection: OAuthConnection): OAuthConnection {
    const validated = OAuthConnectionSchema.parse(connection);
    fs.mkdirSync(this.#dir, { recursive: true });
    const file = this.#fileFor(validated.agentId, validated.provider);
    const onDisk = this.#encryptTokens(validated);
    fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
    // `mode` is only honored on create; enforce 0600 on overwrite too so a
    // pre-existing looser file is tightened.
    fs.chmodSync(file, 0o600);
    return validated;
  }

  /**
   * Encrypt token fields for persistence. Fails closed: without a configured
   * cipher this throws instead of writing plaintext, guaranteeing a token row is
   * never persisted in the clear.
   */
  #encryptTokens(connection: OAuthConnection): OAuthConnection {
    if (!this.#cipher) {
      throw new Error(
        "Refusing to persist OAuth tokens in plaintext: oauth.encryptionKey is " +
          "not configured. Set oauth.encryptionKey (e.g. " +
          "$env:OAUTH_ENCRYPTION_KEY) to encrypt tokens at rest."
      );
    }
    return {
      ...connection,
      accessToken: this.#cipher.encrypt(connection.accessToken),
      refreshToken:
        connection.refreshToken !== undefined
          ? this.#cipher.encrypt(connection.refreshToken)
          : undefined,
    };
  }

  /** Decrypt token fields read from disk; passes plaintext through untouched. */
  #decryptTokens(connection: OAuthConnection): OAuthConnection {
    if (!this.#cipher) return connection;
    return {
      ...connection,
      accessToken: this.#cipher.decrypt(connection.accessToken),
      refreshToken:
        connection.refreshToken !== undefined
          ? this.#cipher.decrypt(connection.refreshToken)
          : undefined,
    };
  }

  /**
   * Apply a partial update to a stored connection and persist it. Returns the
   * updated connection, or undefined when there is nothing stored for the pair.
   */
  update(
    agentId: string,
    provider: string,
    patch: Partial<OAuthConnection>
  ): OAuthConnection | undefined {
    const existing = this.get(agentId, provider);
    if (!existing) return undefined;
    return this.save({ ...existing, ...patch, updatedAt: Date.now() });
  }

  delete(agentId: string, provider: string): void {
    const file = this.#fileFor(agentId, provider);
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

let defaultStore: OAuthConnectionStore | undefined;

export function getOAuthConnectionStore(): OAuthConnectionStore {
  defaultStore ??= new OAuthConnectionStore();
  return defaultStore;
}
