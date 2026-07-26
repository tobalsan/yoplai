import { pathToFileURL } from "node:url";
import {
  CONTAINER_EVENT_PREFIX,
  CONTAINER_OUTPUT_END,
  CONTAINER_OUTPUT_START,
  ContainerInputSchema,
  ContainerOutputSchema,
  ContainerRunnerProtocolEventSchema,
  type ContainerInput,
  type ContainerOutput,
  type ContainerRunnerProtocolEvent,
} from "@yoplai/shared";
import { startIpcPoller, type IpcCleanup } from "./ipc.js";
import { configureProxy, proxyClient } from "./proxy.js";
import { abortActiveAgent, runAgent, sendFollowUpMessage } from "./runner.js";

export const OUTPUT_START = CONTAINER_OUTPUT_START;
export const OUTPUT_END = CONTAINER_OUTPUT_END;
export const EVENT_PREFIX = CONTAINER_EVENT_PREFIX;

export { proxyClient };

type AgentRunnerDeps = {
  readStdin?: () => Promise<string>;
  writeStdout?: (chunk: string) => void;
  writeStderr?: (chunk: string) => void;
  runAgent?: (
    input: ContainerInput,
    onStreamEvent?: (event: ContainerRunnerProtocolEvent) => void
  ) => Promise<ContainerOutput>;
  startIpcPoller?: typeof startIpcPoller;
};

export async function runAgentRunner(
  deps: AgentRunnerDeps = {}
): Promise<void> {
  const read = deps.readStdin ?? readStdin;
  const writeStdout =
    deps.writeStdout ?? ((chunk) => process.stdout.write(chunk));
  const writeStderr =
    deps.writeStderr ?? ((chunk) => process.stderr.write(chunk));
  const run = deps.runAgent ?? runAgent;
  const startPoller = deps.startIpcPoller ?? startIpcPoller;

  const input = parseInput(await read());
  configureProxy(input.onecli);
  configureSdkBaseUrls(input.onecli);
  let cleanup: IpcCleanup | undefined;

  try {
    cleanup = startPoller(
      input.ipcDir,
      async (message) => {
        writeStderr(
          `[agent-runner] Received follow-up IPC message ${JSON.stringify(
            message
          )}\n`
        );
        await sendFollowUpMessage(message);
      },
      () => {
        writeStderr("[agent-runner] Received close IPC sentinel\n");
        abortActiveAgent();
      }
    );

    const output = ContainerOutputSchema.parse(
      await run(input, (event) => {
        writeStreamEvent(event, writeStdout);
      })
    );
    writeProtocolOutput(output, writeStdout);
  } finally {
    cleanup?.();
  }
}

export function writeStreamEvent(
  event: ContainerRunnerProtocolEvent,
  writeStdout: (chunk: string) => void = (chunk) => process.stdout.write(chunk)
): void {
  writeStdout(
    `${EVENT_PREFIX}${JSON.stringify(
      ContainerRunnerProtocolEventSchema.parse(event)
    )}\n`
  );
}

export function writeProtocolOutput(
  output: ContainerOutput,
  writeStdout: (chunk: string) => void = (chunk) => process.stdout.write(chunk)
): void {
  writeStdout(`${OUTPUT_START}\n`);
  writeStdout(`${JSON.stringify(output)}\n`);
  writeStdout(`${OUTPUT_END}\n`);
}

function parseInput(raw: string): ContainerInput {
  return ContainerInputSchema.parse(JSON.parse(raw));
}

function configureSdkBaseUrls(onecli: ContainerInput["onecli"]): void {
  if (!onecli?.enabled) return;

  process.env.ANTHROPIC_BASE_URL ??= onecli.url;
  process.env.OPENAI_BASE_URL ??= `${onecli.url.replace(/\/$/, "")}/v1`;
}

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runAgentRunner().catch((error: unknown) => {
    console.error("[agent-runner] Fatal error", error);
    writeProtocolOutput({
      text: "",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
