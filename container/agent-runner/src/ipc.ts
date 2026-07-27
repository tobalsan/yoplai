import { promises as fs } from "node:fs";
import path from "node:path";

export type IpcCleanup = () => void;
export type IpcMessageHandler = (message: unknown) => void | Promise<void>;
export type IpcCloseHandler = () => void | Promise<void>;

export function startIpcPoller(
  ipcDir: string,
  onMessage: IpcMessageHandler,
  onClose: IpcCloseHandler
): IpcCleanup {
  const inputDir = path.join(ipcDir, "input");
  const seen = new Set<string>();
  let closed = false;
  let scanRunning = false;

  const scan = async (): Promise<void> => {
    if (closed || scanRunning) {
      return;
    }
    scanRunning = true;

    try {
      let entries: string[];
      try {
        entries = await fs.readdir(inputDir);
      } catch (error) {
        if (isMissingDirectory(error)) {
          return;
        }
        console.error("[agent-runner] IPC scan failed", error);
        return;
      }

      for (const entry of entries.sort()) {
        if (seen.has(entry)) {
          continue;
        }

        if (entry === "_close") {
          seen.add(entry);
          await onClose();
          continue;
        }

        if (!entry.endsWith(".json")) {
          continue;
        }

        const filePath = path.join(inputDir, entry);
        try {
          const raw = await fs.readFile(filePath, "utf8");
          const message = JSON.parse(raw) as unknown;
          seen.add(entry);
          await onMessage(message);
        } catch (error) {
          console.error(
            `[agent-runner] IPC message read failed: ${entry}`,
            error
          );
        }
      }
    } finally {
      scanRunning = false;
    }
  };

  const interval = setInterval(() => {
    void scan();
  }, 500);
  void scan();

  return () => {
    closed = true;
    clearInterval(interval);
  };
}

function isMissingDirectory(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
