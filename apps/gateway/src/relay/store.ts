import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveHomeDir } from "@yoplai/shared";

/** Facts about a link that the browser sign-in made. A link with no `managed` field is a manual link or an open link. */
export type ManagedLink = {
  /** The stable link ID of the remote. A re-link keeps it. */
  linkId: string;
  account: { email: string | null; name: string | null };
  deviceLabel: string;
  /** When the key expires, as an ISO time, or null when the remote named no expiry. */
  expiresAt: string | null;
  linkedAt: string;
};

export type RemoteGateway = {
  name: string;
  url: string;
  token?: string;
  managed?: ManagedLink;
  /**
   * Random value that the store sets on each new link. A link that another
   * process removes and creates again with equal values gets a new generation.
   * An older file can lack it.
   */
  generation?: string;
};

/** Holds the linked remote gateways. Callers read the credential through this interface only. */
export interface RemoteGatewayStore {
  list(): RemoteGateway[];
  save(gateway: RemoteGateway): void;
  remove(name: string): boolean;
  /**
   * Counts the changes that this store object made to one name, and keeps counting after the name is removed. A caller
   * that saw a free name reads this count first. A later removal then still shows that the name changed.
   */
  mutationVersion(name: string): number;
  /**
   * Saves a link only when the stored link still has the generation that the caller saw. `null` means that no link of
   * this name may exist. `expectedVersion` is the `mutationVersion` that the caller saw. Returns false and writes
   * nothing on a mismatch. A saved link always gets a new generation.
   */
  saveIfGeneration(gateway: RemoteGateway, expected: string | null, expectedVersion?: number): boolean;
  /** Removes a link only when it still has this generation. */
  removeIfGeneration(name: string, expected: string | undefined): boolean;
}

export const REMOTE_GATEWAYS_FILE = "remote-gateways.json";

/** JSON file with mode 0600. The file is read on each call, so a running gateway sees a new entry. */
export function createFileRemoteGatewayStore(
  filePath: string = path.join(resolveHomeDir(), REMOTE_GATEWAYS_FILE)
): RemoteGatewayStore {
  const write = (gateways: RemoteGateway[]) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(gateways, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(tmpPath, filePath);
  };
  const versions = new Map<string, number>();
  const version = (name: string) => versions.get(name) ?? 0;
  const bump = (name: string) => versions.set(name, version(name) + 1);
  const list = (): RemoteGateway[] => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(parsed) ? (parsed as RemoteGateway[]) : [];
    } catch {
      return [];
    }
  };
  return {
    list,
    save(gateway) {
      const gateways = list();
      const existing = gateways.find((item) => item.name === gateway.name);
      // An equal save changes nothing, so existing grants stay valid. Any other save starts a new link.
      const unchanged = existing?.generation !== undefined && existing.url === gateway.url && existing.token === gateway.token;
      const generation = unchanged ? existing.generation : randomUUID();
      if (!unchanged) bump(gateway.name);
      write([...gateways.filter((item) => item.name !== gateway.name), { ...gateway, generation }]);
    },
    remove(name) {
      const gateways = list();
      const remaining = gateways.filter((item) => item.name !== name);
      if (remaining.length === gateways.length) return false;
      write(remaining);
      bump(name);
      return true;
    },
    mutationVersion: version,
    saveIfGeneration(gateway, expected, expectedVersion) {
      const gateways = list();
      const existing = gateways.find((item) => item.name === gateway.name);
      if (expectedVersion !== undefined && version(gateway.name) !== expectedVersion) return false;
      if (expected === null ? existing !== undefined : existing?.generation !== expected) return false;
      bump(gateway.name);
      write([...gateways.filter((item) => item.name !== gateway.name), { ...gateway, generation: randomUUID() }]);
      return true;
    },
    removeIfGeneration(name, expected) {
      const gateways = list();
      const existing = gateways.find((item) => item.name === name);
      if (!existing || existing.generation !== expected) return false;
      write(gateways.filter((item) => item.name !== name));
      bump(name);
      return true;
    },
  };
}
