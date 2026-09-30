import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CredentialScope } from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";
import { TokenCipher, isEncrypted } from "../oauth/crypto.js";
import { resolveTokenCipher } from "../oauth/encryption.js";

export interface CredentialKey {
  agentId: string;
  integration: string;
  scope: CredentialScope;
}

/** Provider-independent JSON payloads, encrypted in full at rest. */
export class CredentialStore {
  #dir: string;
  #cipher: TokenCipher | undefined;

  constructor(
    dir: string = path.join(CONFIG_DIR, "credentials"),
    cipher: TokenCipher | null | undefined = undefined
  ) {
    this.#dir = dir;
    this.#cipher = cipher === undefined ? resolveTokenCipher() : cipher ?? undefined;
  }

  #fileFor(key: CredentialKey): string {
    if (key.scope.type === "personal" && !key.scope.userId) {
      throw new Error("Personal credentials require a userId");
    }
    // Hash exact components: sanitizing user IDs permits collisions and paths.
    const identity = JSON.stringify([
      key.agentId,
      key.integration,
      key.scope.type,
      key.scope.type === "personal" ? key.scope.userId : null,
    ]);
    const hash = createHash("sha256").update(identity).digest("hex");
    return path.join(this.#dir, `credential-${hash}.json`);
  }

  get<T>(key: CredentialKey): T | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.#fileFor(key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const encrypted: unknown = JSON.parse(raw);
    if (typeof encrypted !== "string" || !isEncrypted(encrypted)) {
      throw new Error("Credential payload is not encrypted");
    }
    if (!this.#cipher) throw new Error("oauth.encryptionKey is required to read credentials");
    return JSON.parse(this.#cipher.decrypt(encrypted)) as T;
  }

  save<T>(key: CredentialKey, payload: T): T {
    const file = this.#fileFor(key);
    if (!this.#cipher) {
      throw new Error("Refusing to persist credentials in plaintext: oauth.encryptionKey is not configured");
    }
    const encrypted = this.#cipher.encrypt(JSON.stringify(payload));
    fs.mkdirSync(this.#dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(encrypted), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return payload;
  }

  delete(key: CredentialKey): void {
    try {
      fs.unlinkSync(this.#fileFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
