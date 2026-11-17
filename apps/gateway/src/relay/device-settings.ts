import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveHomeDir } from "@yoplai/shared";

export type ChatDeviceSettings = {
  /** Absolute path of the start directory. Unset means the home directory. */
  workspaceFolder?: string;
  full: boolean;
};

/** Holds the device settings of the user. Callers read and write them through this interface only. */
export interface DeviceSettingsStore {
  getChat(chatKey: string): ChatDeviceSettings;
  setChat(chatKey: string, settings: ChatDeviceSettings): void;
  /** True when the background calls of the remote agent get full permissions. */
  getAgentFullBackground(agentKey: string): boolean;
  setAgentFullBackground(agentKey: string, enabled: boolean): void;
}

export const DEVICE_SETTINGS_FILE = "device-settings.json";

/**
 * The link that a grant belongs to. The name is only a locator that a later link can reuse. The generation names one saved
 * link, so a grant never moves to a link that replaces it. A link from an older store file has no generation.
 */
export type LinkIdentity = { name: string; generation?: string };

/** The chat key is the link, the remote agent ID, and the local chat name. JSON keeps two different tuples from sharing a key. */
export function deviceChatKey(link: LinkIdentity, agentId: string, chat: string): string {
  return JSON.stringify([link.generation ?? null, link.name, agentId, chat]);
}

/** The key of the background switch of one remote agent on one link. */
export function deviceAgentKey(link: LinkIdentity, agentId: string): string {
  return JSON.stringify([link.generation ?? null, link.name, agentId]);
}

type SettingsFile = {
  chats: Record<string, { workspaceFolder?: string; full?: boolean }>;
  agents: Record<string, { fullBackground?: boolean }>;
};

/** JSON file with mode 0600. The file is read on each call, so a running gateway sees each change. */
export function createFileDeviceSettingsStore(
  filePath: string = path.join(resolveHomeDir(), DEVICE_SETTINGS_FILE)
): DeviceSettingsStore {
  const read = (): SettingsFile => {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SettingsFile>;
      return { chats: parsed.chats ?? {}, agents: parsed.agents ?? {} };
    } catch {
      return { chats: {}, agents: {} };
    }
  };
  const write = (file: SettingsFile) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmpPath, filePath);
  };
  return {
    getChat(chatKey) {
      const chat = read().chats[chatKey];
      return { ...(chat?.workspaceFolder ? { workspaceFolder: chat.workspaceFolder } : {}), full: chat?.full === true };
    },
    setChat(chatKey, settings) {
      const file = read();
      file.chats[chatKey] = {
        ...(settings.workspaceFolder ? { workspaceFolder: settings.workspaceFolder } : {}),
        ...(settings.full ? { full: true } : {}),
      };
      write(file);
    },
    getAgentFullBackground(agentKey) {
      return read().agents[agentKey]?.fullBackground === true;
    },
    setAgentFullBackground(agentKey, enabled) {
      const file = read();
      file.agents[agentKey] = { fullBackground: enabled };
      write(file);
    },
  };
}

let store: DeviceSettingsStore | undefined;

export function getDeviceSettingsStore(): DeviceSettingsStore {
  store ??= createFileDeviceSettingsStore();
  return store;
}
