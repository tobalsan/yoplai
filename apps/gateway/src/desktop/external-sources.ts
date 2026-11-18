import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AnyModel } from "@earendil-works/pi-ai";
import { writeJsonAtomic } from "../util/atomic-write.js";
import { CODEX_EXPIRED, isLiteralKey } from "./literal-key.js";
import type { ExternalCredential } from "./model-auth.js";

export const EXTERNAL_SOURCES = ["codex", "claude-code", "opencode", "pi"] as const;
export const EXTERNAL_OAUTH_PROVIDERS = ["openai-codex", "anthropic"] as const;
export type ExternalSource = typeof EXTERNAL_SOURCES[number];
const TRUSTED_OAUTH_ENDPOINTS: Readonly<Record<typeof EXTERNAL_OAUTH_PROVIDERS[number], string>> = {
  "openai-codex": "https://chatgpt.com/backend-api",
  anthropic: "https://api.anthropic.com",
};
const entries = Object.entries;
const sourcePaths = { codex: ".codex/auth.json", opencode: ".local/share/opencode/auth.json", pi: ".pi/agent/auth.json" } as const;
const keychainService = "Claude Code-credentials";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}
function knownOAuthProvider(provider: string): provider is typeof EXTERNAL_OAUTH_PROVIDERS[number] {
  return EXTERNAL_OAUTH_PROVIDERS.some((id) => id === provider);
}

type Keychain = { exists(): Promise<boolean>; read(): Promise<string> };
const run = promisify(execFile);
const systemKeychain: Keychain = {
  async exists() {
    if (process.platform !== "darwin" || process.env.YOPLAI_DEV === "1") return false;
    try {
      await run("/usr/bin/security", ["find-generic-password", "-s", keychainService], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  },
  async read() {
    if (process.platform !== "darwin" || process.env.YOPLAI_DEV === "1") throw new Error("Access denied");
    const { stdout } = await run("/usr/bin/security", ["find-generic-password", "-s", keychainService, "-w"], { timeout: 60_000 });
    return stdout;
  },
};

type Entry = { provider: string; type: ExternalCredential["type"]; key?: string; expires?: number; supported: boolean };
type Consent = Partial<Record<ExternalSource, "enabled" | "denied">>;

function oauthEntry(provider: string, value: unknown, expires: unknown, account?: unknown): Entry {
  const entry: Entry = { provider, type: "oauth", supported: knownOAuthProvider(provider) };
  if (!entry.supported || !isLiteralKey(value)) return entry;
  if (provider === "openai-codex") {
    try {
      const parts = value.split(".");
      if (parts.length !== 3) return entry;
      const payload = object(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
      const claim = object(payload?.["https://api.openai.com/auth"]);
      const accountId = claim?.chatgpt_account_id;
      const exp = payload?.exp;
      if (typeof accountId !== "string" || !accountId || typeof account !== "string" || account !== accountId || typeof exp !== "number" || !Number.isFinite(exp)) return entry;
      entry.key = value;
      entry.expires = exp * 1000;
    } catch { /* No credential. */ }
  } else if (value.startsWith("sk-ant-oat") && typeof expires === "number" && Number.isFinite(expires)) {
    entry.key = value;
    entry.expires = expires;
  }
  return entry;
}

function parseSource(source: ExternalSource, raw: string): Entry[] {
  const data = object(JSON.parse(raw.replace(/^\uFEFF/, "")));
  if (!data) return [];
  if (source === "codex") {
    const tokens = object(data.tokens);
    return tokens ? [oauthEntry("openai-codex", tokens.access_token, undefined, tokens.account_id)] : [];
  }
  if (source === "claude-code") {
    const oauth = object(data.claudeAiOauth);
    return oauth ? [oauthEntry("anthropic", oauth.accessToken, oauth.expiresAt)] : [];
  }
  return entries(data).flatMap(([provider, value]): Entry[] => {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(provider)) return [];
    const cred = object(value);
    if (!cred) return [];
    if (cred.type === "api" || cred.type === "api_key") return [{ provider, type: "api_key", supported: true, key: isLiteralKey(cred.key) ? cred.key : undefined }];
    if (cred.type === "oauth") return [source === "pi" ? oauthEntry(provider, cred.access, cred.expires, cred.accountId) : { provider, type: "oauth", supported: false }];
    return [];
  });
}

export function isExternalSource(value: string): value is ExternalSource {
  return EXTERNAL_SOURCES.some((source) => source === value);
}

export function createExternalSources(home: string, deps: { userHome?: () => string; keychain?: Keychain } = {}) {
  const file = path.join(home, "desktop-model-sources.json");
  const keychain = deps.keychain ?? systemKeychain;
  const userHome = deps.userHome ?? os.homedir;
  const externalPath = (source: Exclude<ExternalSource, "claude-code">) => path.join(userHome(), sourcePaths[source]);
  let pending = Promise.resolve();
  let keychainDenied = false;
  let keychainRead: Promise<string> | undefined;

  async function consent(): Promise<Consent> {
    try {
      const data = object(JSON.parse(await fs.readFile(file, "utf8")));
      return Object.fromEntries(EXTERNAL_SOURCES.flatMap((source) => {
        const state = data?.[source];
        return state === "enabled" || state === "denied" ? [[source, state]] : [];
      }));
    } catch {
      return {};
    }
  }

  function update(source: ExternalSource, state?: "enabled" | "denied") {
    const write = pending.then(async () => {
      const data = await consent();
      if (state) data[source] = state;
      else delete data[source];
      await writeJsonAtomic(file, data);
    });
    pending = write.catch(() => undefined);
    return write;
  }

  async function read(source: ExternalSource, enabled: Consent): Promise<Entry[]> {
    if (enabled[source] !== "enabled" || (source === "claude-code" && keychainDenied)) return [];
    let raw: string;
    if (source === "claude-code") {
      keychainRead ??= keychain.read().finally(() => { keychainRead = undefined; });
      try {
        raw = await keychainRead;
      } catch {
        if (!keychainDenied) {
          keychainDenied = true;
          await update(source, "denied").catch(() => undefined);
        }
        return [];
      }
    } else {
      try {
        raw = await fs.readFile(externalPath(source), "utf8");
      } catch {
        return [];
      }
    }
    try { return parseSource(source, raw); } catch { return []; }
  }

  async function statusOf(source: ExternalSource, enabled: Consent) {
    const detected = source === "claude-code"
      ? await keychain.exists()
      : await fs.access(externalPath(source)).then(() => true, () => false);
    const providers = detected ? await read(source, enabled) : [];
    const denied = enabled[source] === "denied" || (source === "claude-code" && keychainDenied);
    return {
      source, detected, enabled: enabled[source] === "enabled" && !denied, denied,
      ...(denied ? { message: "Access denied" } : {}),
      providers: providers.map(({ provider, type, supported, key, expires }) => ({
        provider, type, available: Boolean(key) && (expires === undefined || expires > Date.now()),
        ...(!supported ? { message: "Not supported yet" } : {}),
      })),
    };
  }

  return {
    async status() {
      const enabled = await consent();
      return Promise.all(EXTERNAL_SOURCES.map((source) => statusOf(source, enabled)));
    },
    async enable(source: ExternalSource, enabled: boolean) {
      if (source === "claude-code") keychainDenied = false;
      await update(source, enabled ? "enabled" : undefined);
      return enabled ? statusOf(source, await consent()) : { source, enabled: false };
    },
    async resolve(provider: string, model: AnyModel | undefined, mode?: ExternalCredential["type"]): Promise<ExternalCredential | undefined> {
      const enabled = await consent();
      for (const source of EXTERNAL_SOURCES) {
        if (source === "codex" && provider !== "openai-codex" || source === "claude-code" && provider !== "anthropic") continue;
        const row = (await read(source, enabled)).find((entry) => entry.provider === provider && (!mode || entry.type === mode));
        if (!row?.key) continue;
        if (row.type === "oauth") {
          if (!knownOAuthProvider(provider) || !model || model.baseUrl.replace(/\/$/, "") !== TRUSTED_OAUTH_ENDPOINTS[provider]) continue;
          if (row.expires === undefined || row.expires <= Date.now()) {
            if (provider === "openai-codex") throw new Error(CODEX_EXPIRED);
            continue;
          }
        }
        return { type: row.type, key: row.key, source };
      }
      return undefined;
    },
  };
}

let sharedHome: string | undefined;
let shared: ReturnType<typeof createExternalSources>;
export function getExternalSources(home: string) {
  if (!shared || sharedHome !== home) {
    sharedHome = home;
    shared = createExternalSources(home);
  }
  return shared;
}
