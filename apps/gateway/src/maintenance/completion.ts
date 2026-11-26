import path from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { completeSimple as defaultCompleteSimple } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, GatewayConfig, RequiredModelConfig } from "@yoplai/shared";
import { getAgent, loadConfig, CONFIG_DIR } from "../config/index.js";
import { logWarn } from "../logging.js";

type CompletionModel = Model<Api>;

export type MaintenanceCompletionParams = {
  agentId: string;
  /** Session the completion belongs to; opencode routes requests by it. */
  sessionId?: string;
  userId?: string;
  system: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  onLength?: (text: string) => string;
  /** Called once per completion, so callers can log why `null` came back. */
  onOutcome?: (outcome: MaintenanceOutcome) => void;
};

export type MaintenanceOutcome = {
  /** Raw failure detail for the caller; do not log it. */
  error?: string;
  failureKind?: "timeout" | "empty" | "provider_error";
  /** The model's stop reason, when a response arrived. */
  stopReason?: Awaited<ReturnType<typeof defaultCompleteSimple>>["stopReason"];
  elapsedMs: number;
};

type MaintenanceCompletionDeps = {
  getConfig?: () => GatewayConfig;
  getAgent?: (agentId: string) => AgentConfig | undefined;
  createRuntime?: (signal?: AbortSignal) => Promise<ModelRuntime>;
  completeSimple?: typeof defaultCompleteSimple;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  onUsage?: (usage: Awaited<ReturnType<typeof defaultCompleteSimple>>["usage"]) => void;
};

const warned = new Set<string>();
let testDeps: MaintenanceCompletionDeps = {};

export function setMaintenanceCompletionDepsForTests(
  deps: MaintenanceCompletionDeps
): void {
  testDeps = deps;
  warned.clear();
}

export function resetMaintenanceCompletionDepsForTests(): void {
  testDeps = {};
  warned.clear();
}

function warnOnce(
  key: string,
  message: string,
  fields: Record<string, unknown>,
  deps: MaintenanceCompletionDeps
): void {
  if (warned.has(key)) return;
  warned.add(key);
  (deps.warn ?? testDeps.warn ?? logWarn)(message, fields);
}

function createModelRuntime(signal?: AbortSignal): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(CONFIG_DIR, "auth.json"),
    modelsPath: path.join(CONFIG_DIR, "models.json"),
    signal,
  });
}

function modelFor(
  config: GatewayConfig,
  agent: AgentConfig | undefined
): RequiredModelConfig | null {
  if (config.maintenance) return config.maintenance;
  if (!agent?.model.provider) return null;
  return { provider: agent.model.provider, model: agent.model.model };
}

/** Opencode rejects requests that carry no session id (400 MissingSessionID). */
export function sessionHeaders(
  model: { provider: string; baseUrl: string },
  sessionId: string | undefined
): Record<string, string> | undefined {
  if (!sessionId) return undefined;
  const opencode =
    model.provider === "opencode" ||
    model.provider === "opencode-go" ||
    model.baseUrl.includes("opencode.ai");
  return opencode
    ? { "x-opencode-session": sessionId, "x-opencode-client": "yoplai" }
    : undefined;
}

function responseText(response: Awaited<ReturnType<typeof defaultCompleteSimple>>): string {
  return response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Run one small gateway-owned completion. Authentication deliberately stays in
 * ModelRuntime so stored OAuth, stored keys, and host environment keys follow
 * the same provider-owned resolution path as normal Pi runtime use.
 */
export async function completeMaintenance(
  params: MaintenanceCompletionParams,
  deps: MaintenanceCompletionDeps = {}
): Promise<string | null> {
  const activeDeps = { ...testDeps, ...deps };
  let ref = "agent-model";
  let phase = "start";
  let stopReason: MaintenanceOutcome["stopReason"];
  let failureKind: NonNullable<MaintenanceOutcome["failureKind"]> = "provider_error";
  const startedAt = Date.now();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeoutError = new Error(
      `Maintenance completion timed out after ${params.timeoutMs}ms`
    );
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        failureKind = "timeout";
        controller.abort(timeoutError);
        reject(timeoutError);
      }, params.timeoutMs);
    });
    const run = (async () => {
      const config = (activeDeps.getConfig ?? loadConfig)();
      const agent = (activeDeps.getAgent ?? getAgent)(params.agentId);
      const selected = modelFor(config, agent);
      ref = selected ? `${selected.provider}/${selected.model}` : ref;
      if (!selected) {
        throw new Error(`No model configured for agent: ${params.agentId}`);
      }
      phase = "create-runtime";
      const runtime = await (activeDeps.createRuntime ?? createModelRuntime)(
        controller.signal
      );
      phase = "complete";
      const model = runtime.getModel(selected.provider, selected.model) as
        | CompletionModel
        | undefined;
      if (!model) throw new Error(`Model not found: ${ref}`);
      const complete = activeDeps.completeSimple ?? runtime.completeSimple.bind(runtime);
      const response = await complete(
        model,
        {
          systemPrompt: params.system,
          messages: [
            {
              role: "user",
              timestamp: Date.now(),
              content: params.prompt,
            },
          ],
        } satisfies Context,
        {
          maxTokens: params.maxTokens,
          // No temperature: reasoning models (e.g. openai-codex) reject it.
          maxRetries: 0,
          timeoutMs: params.timeoutMs,
          signal: controller.signal,
          headers: sessionHeaders(model, params.sessionId),
        }
      );
      activeDeps.onUsage?.(response.usage);
      stopReason = response.stopReason;
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage ?? "Maintenance completion failed");
      }
      const text = responseText(response);
      if (!text) {
        failureKind = "empty";
        throw new Error("Maintenance completion returned no text");
      }
      phase = "done";
      return response.stopReason === "length" && params.onLength ? params.onLength(text) : text;
    })();
    const text = await Promise.race([run, timedOut]);
    params.onOutcome?.({ stopReason, elapsedMs: Date.now() - startedAt });
    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.onOutcome?.({ error: message, failureKind, stopReason, elapsedMs: Date.now() - startedAt });
    warnOnce(
      `${ref}:${message}`,
      "[maintenance] completion failed",
      {
        agentId: params.agentId,
        model: ref,
        failureKind,
        phase,
        elapsedMs: Date.now() - startedAt,
      },
      activeDeps
    );
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export const MaintenanceCompletion = { complete: completeMaintenance };
