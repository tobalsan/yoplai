import { BASE_GATEWAY_PORT, BASE_UI_PORT, type LaunchPlan, type LaunchPorts } from "./launch-plan.js";
import { LogBuffer } from "./log-buffer.js";
import { findFreePort } from "./ports.js";
import { startGroup, stopGroup, type GroupChild } from "./process-group.js";
import { waitForReady } from "./ready.js";

const READY_TIMEOUT_MS = 120_000;

export interface Stack {
  uiUrl: string;
  uiOrigin: string;
  stop: () => Promise<void>;
}

export interface StackHooks {
  log: LogBuffer;
  /** Build the launch plan from the chosen free ports. */
  createPlan: (ports: LaunchPorts) => LaunchPlan;
  /** Called when a child exits after the stack is ready. */
  onCrash: (reason: string) => void;
}

/** A start in progress. stop() works at any time, including before the children exist. */
export interface StackStart {
  ready: Promise<Stack>;
  stop: () => Promise<void>;
}

/** Pick free ports, start every child of the plan in its own group, wait until ready. */
export function startStack(hooks: StackHooks): StackStart {
  const children: GroupChild[] = [];
  let cancelled = false;
  let stopping = false;
  let ready = false;
  let failure: string | null = null;

  const stopChildren = async () => {
    stopping = true;
    await Promise.all(
      children.map(({ child }) => (child.pid ? stopGroup(child.pid) : Promise.resolve()))
    );
  };

  const run = async (): Promise<Stack> => {
    const plan = hooks.createPlan({
      gatewayPort: await findFreePort(BASE_GATEWAY_PORT),
      uiPort: await findFreePort(BASE_UI_PORT),
    });
    if (cancelled) throw new Error("Start cancelled");
    for (const launch of plan.children) {
      children.push(
        startGroup({
          ...launch,
          onLine: (line) => {
            hooks.log.push(line);
            console.log(line);
          },
          onExit: (code, signal) => {
            if (stopping) return;
            failure = `${launch.name} exited (${signal ?? `code ${code}`})`;
            if (ready) hooks.onCrash(failure);
          },
        })
      );
    }
    try {
      await waitForReady(plan.readyUrls, {
        timeoutMs: READY_TIMEOUT_MS,
        shouldAbort: () => cancelled || failure !== null,
      });
    } catch (err) {
      await stopChildren();
      throw new Error(failure ?? (err as Error).message);
    }
    if (cancelled) {
      await stopChildren();
      throw new Error("Start cancelled");
    }
    ready = true;
    return { uiUrl: plan.uiUrl, uiOrigin: new URL(plan.uiUrl).origin, stop: stopChildren };
  };

  const result = run();
  return {
    ready: result,
    stop: async () => {
      cancelled = true;
      await result.catch(() => undefined);
      await stopChildren();
    },
  };
}
