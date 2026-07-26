import type { ContainerOutput } from "@yoplai/shared";
import {
  CONTAINER_EVENT_PREFIX,
  CONTAINER_OUTPUT_END,
  CONTAINER_OUTPUT_START,
  ContainerOutputSchema,
  LEGACY_CONTAINER_EVENT_PREFIX,
  LEGACY_CONTAINER_OUTPUT_END,
  LEGACY_CONTAINER_OUTPUT_START,
} from "@yoplai/shared";

const BENIGN_STDERR_PATTERNS = [
  /^\[agent-runner\] Running agent .+ with SDK .+$/,
];

export const OUTPUT_START = CONTAINER_OUTPUT_START;
export const OUTPUT_END = CONTAINER_OUTPUT_END;
export const EVENT_PREFIX = CONTAINER_EVENT_PREFIX;

let warnedLegacyMarkers = false;

function warnLegacyMarkersOnce(): void {
  if (warnedLegacyMarkers) return;
  warnedLegacyMarkers = true;
  console.warn(
    "[container] Received legacy ---AIHUB_*--- protocol markers; this container image predates the yoplai rename. Rebuild the sandbox image to pick up the current agent-runner."
  );
}

export type ContainerProtocolFrame = {
  type: "event";
  payload: string;
};

export class ContainerProtocolDecoder {
  private stdoutLineBuffer = "";
  private outputLines: string[] = [];
  private inOutputBlock = false;

  write(chunk: Buffer | string): ContainerProtocolFrame[] {
    this.stdoutLineBuffer += chunk.toString();
    const lines = this.stdoutLineBuffer.split("\n");
    this.stdoutLineBuffer = lines.pop() ?? "";
    return this.processLines(lines);
  }

  flush(): ContainerProtocolFrame[] {
    if (!this.stdoutLineBuffer) return [];
    const line = this.stdoutLineBuffer;
    this.stdoutLineBuffer = "";
    return this.processLines([line]);
  }

  parseOutput(): ContainerOutput | undefined {
    return parseProtocolOutput(this.outputLines);
  }

  private processLines(lines: string[]): ContainerProtocolFrame[] {
    const frames: ContainerProtocolFrame[] = [];
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (line === OUTPUT_START || line === LEGACY_CONTAINER_OUTPUT_START) {
        if (line === LEGACY_CONTAINER_OUTPUT_START) warnLegacyMarkersOnce();
        this.inOutputBlock = true;
        this.outputLines = [];
        continue;
      }
      if (line === OUTPUT_END || line === LEGACY_CONTAINER_OUTPUT_END) {
        if (line === LEGACY_CONTAINER_OUTPUT_END) warnLegacyMarkersOnce();
        this.inOutputBlock = false;
        continue;
      }
      if (this.inOutputBlock) {
        this.outputLines.push(line);
        continue;
      }
      if (line.startsWith(EVENT_PREFIX)) {
        const payload = line.slice(EVENT_PREFIX.length).trim();
        if (payload) frames.push({ type: "event", payload });
        continue;
      }
      if (line.startsWith(LEGACY_CONTAINER_EVENT_PREFIX)) {
        warnLegacyMarkersOnce();
        const payload = line.slice(LEGACY_CONTAINER_EVENT_PREFIX.length).trim();
        if (payload) frames.push({ type: "event", payload });
      }
    }
    return frames;
  }
}

export function parseProtocolOutput(
  lines: string[]
): ContainerOutput | undefined {
  if (!lines.length) return undefined;
  const payload = lines.join("\n").trim();
  if (!payload) return undefined;
  return ContainerOutputSchema.parse(JSON.parse(payload));
}

export function getMeaningfulStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter(
      (line) =>
        !BENIGN_STDERR_PATTERNS.some((pattern) => pattern.test(line.trim()))
    )
    .join("\n")
    .trim();
}
