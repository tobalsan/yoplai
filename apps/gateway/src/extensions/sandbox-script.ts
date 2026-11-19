import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import {
  getScriptMounts,
  resolveScriptLaunch,
  runScriptProcess,
  ScriptExecutionError,
  ScriptPathError,
  trackRunningScript,
  type RunScriptInput,
  type RunScriptResult,
} from "@yoplai/shared/node/script";
import { buildContainerArgs, buildVolumeMounts, resolveSandboxNetwork } from "../agents/container.js";
import { logWarn } from "../logging.js";

const CLEANUP_TIMEOUT_MS = 5000;

export async function runSandboxedScript(
  agent: AgentConfig,
  config: GatewayConfig,
  homeDir: string,
  input: RunScriptInput
): Promise<RunScriptResult> {
  const name = `yoplai-script-${agent.id}-${randomUUID()}`;
  const abort = new AbortController();
  let finish!: (cleanupFailed: boolean) => void;
  const finished = new Promise<boolean>((resolve) => { finish = resolve; });
  const untrack = trackRunningScript(input.owner, async () => {
    abort.abort();
    if (await finished) {
      await removeScriptContainer(name);
      untrack();
    }
  });
  let createAttempted = false;
  let result: RunScriptResult;
  let cleanupError: unknown;
  let deadline: NodeJS.Timeout | undefined;

  try {
    const sandbox = config.sandbox ?? {};
    const mounts = buildVolumeMounts(agent, sandbox, homeDir, undefined, undefined, config.onecli);
    const launch = await resolveScriptLaunch(input.workspaceDir, input.script, getScriptMounts(agent, homeDir));
    if (!agent.sandbox?.workspaceWritable) {
      // Docker needs the nested bind target to exist under a read-only mount.
      await fs.mkdir(path.join(input.workspaceDir, "data"), { recursive: true });
    }
    const containerPath = launch.containerPath!;
    const shellScript = launch.command === "bash";
    const createArgs = buildContainerArgs(agent, sandbox, mounts, homeDir, undefined, config.onecli, undefined, {
      name,
      command: shellScript ? "bash" : containerPath,
      args: shellScript ? [containerPath] : [],
      env: input.env,
      keepStdin: input.stdin !== undefined,
    });
    if (abort.signal.aborted) throw new ScriptExecutionError("script failed (exit signal)", "signal", "");
    deadline = setTimeout(() => abort.abort(new DOMException("Script deadline exceeded", "TimeoutError")), input.timeoutMs);
    const setup = { timeoutMs: input.timeoutMs };
    const options = { signal: abort.signal };
    const createOptions = input.env === undefined ? options : { ...options, env: { ...process.env, ...input.env } };

    createAttempted = true;
    await runScriptProcess("docker", createArgs, setup, createOptions).catch((error: unknown) => {
      throw dockerSetupError("create", error);
    });

    const extraNetwork = config.onecli?.sandbox?.network;
    if (extraNetwork && extraNetwork !== resolveSandboxNetwork(agent, sandbox)) {
      await runScriptProcess(
        "docker", ["network", "connect", extraNetwork, name], setup, options
      ).catch((error: unknown) => { throw dockerSetupError("network attach", error); });
    }

    result = await runScriptProcess(
      "docker", ["start", "-a", ...(input.stdin === undefined ? [] : ["-i"]), name], input, options
    ).catch(async (error: unknown) => {
      if (!(error instanceof ScriptExecutionError)) throw dockerSetupError("start", error);
      if (error.reason !== "exit") throw error;
      // The Docker client also exits nonzero if the sandbox could not start.
      const state = await runScriptProcess("docker", [
        "inspect", "--format", "{{if .State.OOMKilled}}oom{{else if .State.Error}}failed{{else}}{{.State.Status}}{{end}}", name,
      ], setup, options).catch((error: unknown) => {
        if (error instanceof ScriptExecutionError && (error.reason === "signal" || error.reason === "timeout")) throw error;
        return undefined;
      });
      if (state?.stdout.trim() === "exited") throw error;
      if (state?.stdout.trim() === "oom") {
        const message = error.message.replace(/^script failed \(exit \d+\)/, "script failed (exit signal)");
        throw new ScriptExecutionError(message, "signal", error.stderrTail);
      }
      throw dockerSetupError("start", error);
    });
  } catch (error) {
    if (error instanceof ScriptExecutionError) throw error;
    throw new ScriptExecutionError(error instanceof Error ? error.message : String(error), "spawn", "", undefined,
      error instanceof ScriptPathError ? { cause: error } : undefined);
  } finally {
    clearTimeout(deadline);
    try {
      if (createAttempted) await removeScriptContainer(name);
    } catch (error) {
      cleanupError = error;
      logWarn(`Could not remove sandbox script container ${name}`);
    } finally {
      if (!cleanupError) untrack();
      finish(!!cleanupError);
    }
  }
  if (cleanupError) throw cleanupError;
  return result;
}

async function removeScriptContainer(name: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await runScriptProcess("docker", ["rm", "-f", name], { timeoutMs: CLEANUP_TIMEOUT_MS });
      return;
    } catch (error) {
      if (error instanceof ScriptExecutionError && error.stderrTail.includes("No such container")) return;
      if (attempt === 1) throw dockerSetupError("remove", error);
    }
  }
}

function dockerSetupError(stage: string, error: unknown): ScriptExecutionError {
  const reason = error instanceof ScriptExecutionError && error.reason !== "exit" ? error.reason : "spawn";
  const detail = error instanceof Error ? error.message : String(error);
  const stderr = error instanceof ScriptExecutionError ? error.stderrTail : "";
  return new ScriptExecutionError(`Sandbox script container ${stage} failed: ${detail}`, reason, stderr);
}
