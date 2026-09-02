import path from "node:path";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { completeSimple as defaultCompleteSimple } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { GatewayConfig, LeadSession } from "@yoplai/shared";
import { getProjectsContext } from "../context.js";
import { findLeadSession, updateLeadSessionInProject } from "./store.js";
import { readLeadTranscript } from "./transcript.js";

const TITLE_PROMPT =
  "Return a concise 4-6 word title summarizing this chat. No quotes. No punctuation at the end.";
const TITLE_TIMEOUT_MS = 10_000;
const NEW_SESSION_TITLE = "New session";
const warned = new Set<string>();

type TitleModel = Model<Api>;

type AutoTitleDeps = {
  completeSimple?: typeof defaultCompleteSimple;
  getAvailableModels?: () => TitleModel[] | Promise<TitleModel[]>;
  timeoutMs?: number;
  warn?: (message: string) => void;
};

let testDeps: AutoTitleDeps = {};

export function setAutoTitleDepsForTests(deps: AutoTitleDeps): void {
  testDeps = deps;
  warned.clear();
}

export function resetAutoTitleDepsForTests(): void {
  testDeps = {};
  warned.clear();
}

function warnOnce(
  key: string,
  message: string,
  warn?: (message: string) => void
) {
  if (warned.has(key)) return;
  warned.add(key);
  warn?.(message);
}

function isUnsafeTitleModel(modelId: string): boolean {
  return /opus|thinking/i.test(modelId);
}

function configuredAutoTitleModel(config: GatewayConfig): string | undefined {
  return config.extensions?.sessions?.autoTitleModel?.trim() || undefined;
}

function modelKey(model: Pick<TitleModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function matchesModelRef(
  model: Pick<TitleModel, "provider" | "id">,
  ref: string
): boolean {
  return ref === model.id || ref === modelKey(model);
}

function modelRefIncludesHaiku(
  model: Pick<TitleModel, "provider" | "id" | "name">
): boolean {
  return /haiku/i.test(`${model.provider} ${model.id} ${model.name}`);
}

function byCheapest(a: TitleModel, b: TitleModel): number {
  const aCost = (a.cost?.input ?? 0) + (a.cost?.output ?? 0);
  const bCost = (b.cost?.input ?? 0) + (b.cost?.output ?? 0);
  return aCost - bCost;
}

async function loadAvailableModelsFromHost(
  dataDir: string
): Promise<TitleModel[]> {
  const runtime = await ModelRuntime.create({
    authPath: path.join(dataDir, "auth.json"),
    modelsPath: path.join(dataDir, "models.json"),
  });
  return [...(await runtime.getAvailable())];
}

function loadAvailableModels(deps: AutoTitleDeps): Promise<TitleModel[]> {
  const load = deps.getAvailableModels ?? testDeps.getAvailableModels;
  return load
    ? Promise.resolve(load())
    : loadAvailableModelsFromHost(getProjectsContext().getDataDir());
}

export async function resolveAutoTitleModel(
  config: GatewayConfig,
  deps: AutoTitleDeps = {}
): Promise<string | null> {
  const configured = configuredAutoTitleModel(config);
  if (configured) {
    if (isUnsafeTitleModel(configured)) {
      const warn =
        deps.warn ?? testDeps.warn ?? getProjectsContext().logger.warn;
      warnOnce(
        `unsafe:${configured}`,
        `Refusing unsafe auto-title model: ${configured}`,
        warn
      );
      return null;
    }
    return configured;
  }

  const models = await loadAvailableModels(deps);
  const haiku = models
    .filter(
      (model) =>
        model.provider === "anthropic" &&
        modelRefIncludesHaiku(model) &&
        !isUnsafeTitleModel(model.id)
    )
    .sort(byCheapest)[0];
  if (!haiku) {
    const warn = deps.warn ?? testDeps.warn ?? getProjectsContext().logger.warn;
    warnOnce(
      "missing-haiku",
      "No available Anthropic Haiku model configured for lead-session auto-title",
      warn
    );
    return null;
  }
  return modelKey(haiku);
}

async function resolveTitleModelObject(
  config: GatewayConfig,
  deps: AutoTitleDeps = {}
): Promise<TitleModel | null> {
  const ref = await resolveAutoTitleModel(config, deps);
  if (!ref) return null;
  const models = await loadAvailableModels(deps);
  const model = models.find((item) => matchesModelRef(item, ref));
  if (!model) {
    warnOnce(
      `unavailable:${ref}`,
      `Auto-title model is not available: ${ref}`,
      deps.warn ?? testDeps.warn ?? getProjectsContext().logger.warn
    );
    return null;
  }
  if (isUnsafeTitleModel(model.id)) {
    warnOnce(
      `unsafe:${ref}`,
      `Refusing unsafe auto-title model: ${ref}`,
      deps.warn ?? testDeps.warn ?? getProjectsContext().logger.warn
    );
    return null;
  }
  return model;
}

function textFromAssistant(message: AssistantMessage): string {
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join(" ");
}

export function normalizeGeneratedTitle(title: string): string {
  const cleaned = title
    .replace(/^["'`]+|["'`.!?:;,\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 60) return cleaned;
  const truncated = cleaned.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim();
}

async function completeWithTimeout(
  model: TitleModel,
  context: Context,
  deps: AutoTitleDeps
): Promise<AssistantMessage> {
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? testDeps.timeoutMs ?? TITLE_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout>;
  try {
    const complete =
      deps.completeSimple ?? testDeps.completeSimple ?? defaultCompleteSimple;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort(new Error("Lead-session auto-title timed out"));
        reject(new Error("Lead-session auto-title timed out"));
      }, timeoutMs);
    });
    return await Promise.race([
      complete(model, context, {
        maxTokens: 32,
        temperature: 0,
        signal: controller.signal,
        timeoutMs,
        maxRetries: 0,
      }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeout!);
  }
}

async function generateTitle(
  config: GatewayConfig,
  userText: string,
  assistantText: string,
  deps: AutoTitleDeps
): Promise<string | null> {
  const model = await resolveTitleModelObject(config, deps);
  if (!model) return null;
  const result = await completeWithTimeout(
    model,
    {
      systemPrompt: TITLE_PROMPT,
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: `User: ${userText}\n\nAssistant: ${assistantText}`,
        },
      ],
    },
    deps
  );
  const title = normalizeGeneratedTitle(textFromAssistant(result));
  return title || null;
}

function firstText(
  role: "user" | "assistant",
  transcript: Awaited<ReturnType<typeof readLeadTranscript>>
): string {
  const message = transcript.messages.find((item) => item.role === role);
  if (!message) return "";
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function maybeAutoTitleLeadSession(args: {
  config: GatewayConfig;
  session: LeadSession;
  projectDir: string;
  hadUserMessageBeforeSend: boolean;
}): void {
  if (args.hadUserMessageBeforeSend || args.session.titleLocked) return;
  void autoTitleLeadSession(args).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    warnOnce(
      `job:${args.session.id}`,
      `Lead-session auto-title failed: ${message}`,
      getProjectsContext().logger.warn
    );
  });
}

export async function autoTitleLeadSession(args: {
  config: GatewayConfig;
  session: LeadSession;
  projectDir: string;
  deps?: AutoTitleDeps;
}): Promise<LeadSession | null> {
  const warn =
    args.deps?.warn ?? testDeps.warn ?? getProjectsContext().logger.warn;
  try {
    const fresh = await findLeadSession(args.config, args.session.id);
    if (
      !fresh.ok ||
      fresh.session.titleLocked ||
      fresh.session.title !== NEW_SESSION_TITLE
    ) {
      return null;
    }
    const transcript = await readLeadTranscript(args.projectDir, fresh.session);
    const userText = firstText("user", transcript);
    const assistantText = firstText("assistant", transcript);
    if (!userText || !assistantText) return null;

    const title = await generateTitle(
      args.config,
      userText,
      assistantText,
      args.deps ?? {}
    );
    if (!title) return null;

    const updated = await updateLeadSessionInProject(
      args.projectDir,
      args.session.id,
      (current) => {
        if (current.titleLocked || current.title !== NEW_SESSION_TITLE)
          return null;
        return { ...current, title, updatedAt: new Date().toISOString() };
      }
    );
    if (!updated) return null;
    getProjectsContext().emit("lead_session.changed", {
      type: "lead_session_changed",
      kind: "updated",
      session: updated,
    });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnOnce(
      `failure:${args.session.id}`,
      `Lead-session auto-title failed: ${message}`,
      warn
    );
    return null;
  }
}
