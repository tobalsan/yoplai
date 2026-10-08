import fs from "node:fs";
import path from "node:path";
import {
  OAuthConnectionSchema,
  type CredentialScope,
  type OAuthConnection,
} from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";
import { CredentialStore, type CredentialKey } from "../credentials/store.js";
import { TokenCipher } from "./crypto.js";
import { resolveTokenCipher } from "./encryption.js";

export function connectionScope(connection: OAuthConnection): CredentialScope {
  if (connection.scope === "personal") {
    if (!connection.userId) throw new Error("Personal credentials require a userId");
    return { type: "personal", userId: connection.userId };
  }
  return { type: "team" };
}

/**
 * Credential-store agentId for personal grants, which are shared across agents.
 * Starts with NUL: agent ids are folder names and can never contain it.
 */
const PERSONAL_SHARED_AGENT_ID = "\0personal-shared";

/** Stored at the shared personal key on disconnect so stale legacy rows are not re-promoted. */
interface PersonalTombstone {
  tombstone: true;
  provider: string;
  userId: string;
  deletedAt: number;
}

function isTombstone(payload: unknown): payload is PersonalTombstone {
  return typeof payload === "object" && payload !== null &&
    (payload as { tombstone?: unknown }).tombstone === true;
}

/** OAuth adapter over generic scoped credentials; legacy files remain team-only. */
export class OAuthConnectionStore {
  #dir: string;
  #cipher: TokenCipher | undefined;
  #credentials: CredentialStore;

  constructor(
    dir: string = path.join(CONFIG_DIR, "oauth"),
    cipher: TokenCipher | null | undefined = undefined
  ) {
    this.#dir = dir;
    this.#cipher = cipher === undefined ? resolveTokenCipher() : cipher ?? undefined;
    this.#credentials = new CredentialStore(dir, this.#cipher ?? null);
  }

  #legacyFile(agentId: string, provider: string): string {
    const safe = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(this.#dir, `${safe(agentId)}__${safe(provider)}.json`);
  }

  #getLegacy(agentId: string, provider: string): OAuthConnection | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.#legacyFile(agentId, provider), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = OAuthConnectionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    const connection = parsed.data;
    // Check exact row identity: legacy sanitized names can collide.
    if (connection.agentId !== agentId || connection.provider !== provider ||
        connection.scope === "personal") return undefined;
    return {
      ...connection,
      scope: "team",
      accessToken: this.#cipher?.decrypt(connection.accessToken) ?? connection.accessToken,
      refreshToken: connection.refreshToken === undefined ? undefined :
        this.#cipher?.decrypt(connection.refreshToken) ?? connection.refreshToken,
    };
  }

  #key(agentId: string, provider: string, scope: CredentialScope): CredentialKey {
    return {
      agentId: scope.type === "personal" ? PERSONAL_SHARED_AGENT_ID : agentId,
      integration: provider,
      scope,
    };
  }

  /** Read and validate one stored row; personal rows may come from any agent. */
  #read(
    key: CredentialKey,
    agentId: string,
    provider: string,
    scope: CredentialScope
  ): OAuthConnection | undefined {
    const payload = this.#credentials.get<OAuthConnection>(key);
    if (payload === undefined || isTombstone(payload)) return undefined;
    const parsed = OAuthConnectionSchema.safeParse(payload);
    if (!parsed.success) return undefined;
    const connection = parsed.data;
    const storedScope = connectionScope(connection);
    if (connection.provider !== provider || storedScope.type !== scope.type ||
        (scope.type === "personal" && connection.userId !== scope.userId) ||
        (scope.type === "team" && connection.agentId !== agentId)) return undefined;
    return connection;
  }

  get(
    agentId: string,
    provider: string,
    scope: CredentialScope = { type: "team" }
  ): OAuthConnection | undefined {
    if (scope.type === "personal" &&
        isTombstone(this.#credentials.get<unknown>(this.#key(agentId, provider, scope)))) {
      return undefined;
    }
    const shared = this.#read(this.#key(agentId, provider, scope), agentId, provider, scope);
    if (shared || scope.type === "team") return shared ?? this.#getLegacy(agentId, provider);
    // Lazily promote a legacy per-agent personal grant to the shared key.
    const legacyKey: CredentialKey = { agentId, integration: provider, scope };
    const legacy = this.#read(legacyKey, agentId, provider, scope);
    if (!legacy || legacy.agentId !== agentId) return undefined;
    this.save(legacy);
    this.#credentials.delete(legacyKey);
    return legacy;
  }

  save(connection: OAuthConnection): OAuthConnection {
    const validated = OAuthConnectionSchema.parse(connection);
    const scope = connectionScope(validated);
    const normalized = { ...validated, scope: scope.type };
    this.#credentials.save(this.#key(validated.agentId, validated.provider, scope), normalized);
    if (scope.type === "team" && this.#getLegacy(validated.agentId, validated.provider)) {
      fs.unlinkSync(this.#legacyFile(validated.agentId, validated.provider));
    }
    return normalized;
  }

  update(
    agentId: string,
    provider: string,
    patch: Partial<OAuthConnection>,
    scope: CredentialScope = { type: "team" }
  ): OAuthConnection | undefined {
    const existing = this.get(agentId, provider, scope);
    if (!existing) return undefined;
    return this.save({
      ...existing,
      ...patch,
      agentId: scope.type === "personal" ? existing.agentId : agentId,
      provider,
      scope: scope.type,
      userId: scope.type === "personal" ? scope.userId : undefined,
      updatedAt: Date.now(),
    });
  }

  delete(agentId: string, provider: string, scope: CredentialScope = { type: "team" }): void {
    if (scope.type === "personal") {
      const tombstone: PersonalTombstone = {
        tombstone: true,
        provider,
        userId: scope.userId,
        deletedAt: Date.now(),
      };
      this.#credentials.save(this.#key(agentId, provider, scope), tombstone);
      this.#credentials.delete({ agentId, integration: provider, scope });
      return;
    }
    this.#credentials.delete(this.#key(agentId, provider, scope));
    if (scope.type === "team" && this.#getLegacy(agentId, provider)) {
      fs.unlinkSync(this.#legacyFile(agentId, provider));
    }
  }
}

let defaultStore: OAuthConnectionStore | undefined;

export function getOAuthConnectionStore(): OAuthConnectionStore {
  defaultStore ??= new OAuthConnectionStore();
  return defaultStore;
}
