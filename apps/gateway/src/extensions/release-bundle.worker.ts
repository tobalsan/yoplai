import { parentPort, workerData } from "node:worker_threads";

const { indexPath, key } = workerData as { indexPath: string; key: string };
const { importExternalExtension } = import.meta.url.endsWith(".ts")
  ? await (await import("tsx/esm/api")).tsImport("@yoplai/shared", import.meta.url) as typeof import("@yoplai/shared")
  : await import("@yoplai/shared");
const extension = await importExternalExtension(indexPath, key);
parentPort!.postMessage(extension.id);
