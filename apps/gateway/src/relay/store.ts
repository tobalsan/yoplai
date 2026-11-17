import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveHomeDir } from "@yoplai/shared";

export type RemoteGateway = {
  name: string;
  url: string;
  token?: string;
};

/** Holds the linked remote gateways. Callers read the credential through this interface only. */
export interface RemoteGatewayStore {
  list(): RemoteGateway[];
  save(gateway: RemoteGateway): void;
  remove(name: string): boolean;
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
      write([...list().filter((item) => item.name !== gateway.name), gateway]);
    },
    remove(name) {
      const gateways = list();
      const remaining = gateways.filter((item) => item.name !== name);
      if (remaining.length === gateways.length) return false;
      write(remaining);
      return true;
    },
  };
}
