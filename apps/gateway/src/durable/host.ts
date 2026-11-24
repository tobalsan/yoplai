import fs from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc, AssistantEntry, configure, createRegistry, defineExtension, GenerationTask, Harness, hook, InboxDoc, LiveDoc, ProviderDoc,
  type AgentChange, type Conversation, type ConversationId, type ConversationView, type Cursor, type EntryRecord, type Extension, type LiveState, type Submission, ToolResultEntry,
} from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  DEFAULT_RETRY_BASE_DELAY_SECONDS, DEFAULT_RETRY_MAX_ATTEMPTS, DURABLE_MAIN_SESSION_ID, McpAppViewReferenceSchema, runFailureMessage, type AgentConfig, type ContentBlock, type FullHistoryMessage,
  type HistoryViewMode, type McpAppViewReference, type RunAgentResult, type SimpleHistoryMessage, type StreamEvent, type WsActiveTurnSnapshot, type WsServerMessage,
} from "@yoplai/shared";
import { getAgent } from "../config/index.js";
import { isSafeModelAccessError } from "../desktop/model-auth.js";
import { messageText } from "../history/condense.js";
import { activeContextUsage, historyPage } from "../history/page.js";
import { logWarn } from "../logging.js";
import { createDurableModels, type DurableModelsFactory } from "./models.js";

import type { WebSender } from "./contract.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { createReplyReview, draftDigest, WITHHELD_REPLY } from "./review.js";
import { durableFailureKind, getModelPolicy, originalFallbackInput, reserveFallback, setModelPolicy, settleFallback } from "./fallback.js";
import { durableExecutionEnv } from "./env.js";
import { durableInstructions } from "./prompt.js";
import { createDurableTools } from "./tools.js";
import { FailureNoteEntry, InputEntry, MainMap, ReviewDoc } from "./state.js";

const context = BACKGROUND_CONTEXT;
const toolSearch = createToolSearchExtension();
const routingWarnings = new Set<string>();
export type DurableHostOptions = {
  createModels?: DurableModelsFactory;
  afterMainCommit?: () => void | Promise<void>;
};

export class DurableHost {
  private readonly admissions = new Map<ConversationId, Promise<void>>();
  private readonly listeners = new Map<string, Set<(event: WsServerMessage) => void>>();

  private constructor(
    private readonly harness: Harness,
    private readonly agent: AgentConfig,
    private readonly runtime: ExtensionRuntime,
    private readonly providerConversations: Map<string, ConversationId>,
    private readonly owners: Map<ConversationId, string>,
    private readonly tools: ReturnType<typeof createDurableTools>,
    private readonly boundary: Extension,
    private readonly codemode: ReturnType<typeof createCodemodeExtension>,
    private readonly sandbox: CodemodeSandbox,
    private readonly review: ReturnType<typeof createReplyReview>,
    private readonly afterMainCommit?: DurableHostOptions["afterMainCommit"],
  ) {}

  static async open(home: string, agent: AgentConfig, runtime: ExtensionRuntime, options: DurableHostOptions) {
    const provider = agent.model.provider;
    if (!provider) throw new Error("Durable requires model.provider to be set.");
    const directory = path.join(home, "agents", agent.id, "durable");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const storage = await openNodeSqliteStorage(path.join(directory, "agent.sqlite"));
    const registry = createRegistry();
    let harness: Harness | undefined;
    const providerConversations = new Map<string, ConversationId>();
    const models = (options.createModels ?? createDurableModels)(agent, async (sessionId) => {
      const id = sessionId && providerConversations.get(sessionId);
      if (harness && id) return getModelPolicy(harness, id);
    });
    const owners = new Map<ConversationId, string>();
    const tools = createDurableTools(agent.id, runtime, registry, (id) => owners.get(id));
    const review = createReplyReview(agent, runtime, tools.authority, () => {
      if (!harness) throw new Error("Durable host is not open.");
      return harness;
    });
    const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
    const codemode = createCodemodeExtension({ sandbox, models: false });
    registry.install(codemode);
    let host: DurableHost;
    const boundary = defineExtension({
      name: "yoplai-run-boundary",
      hooks: [hook(GenerationTask, {
        async afterRun(_run, api, context) {
          const inbox = await api.snapshot(InboxDoc, api.conversationId, context);
          if (inbox?.items.some(({ mode }) => mode !== "write")) await host.configureQueuedRun(api.conversationId);
          return undefined;
        },
      })],
    });
    registry.install(boundary);
    registry.install(review.extension);
    registry.install(CodingTools);
    registry.install(toolSearch);
    registry.install(tools.gate);
    try {
      harness = await Harness.open(storage, {
        models,
        registry,
        env({ conversationId }) {
          const { agent, config } = tools.authority(conversationId);
          return durableExecutionEnv(agent, config);
        },
        settings() {
          const current = getAgent(agent.id) ?? agent;
          return {
            compaction: { enabled: false }, steeringMode: "all", followUpMode: "all",
            retry: {
              maxRetries: (current.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS) - 1,
              baseDelayMs: Math.round((current.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY_SECONDS) * 1000),
            },
          };
        },
      }, context);
      host = new DurableHost(harness, agent, runtime, providerConversations, owners, tools, boundary, codemode, sandbox, review, options.afterMainCommit);
      await host.resume();
      return host;
    } catch (error) {
      if (harness) await harness.close(context);
      else await storage.close(context);
      await sandbox.close();
      throw error;
    }
  }

  private async mainId(user: string): Promise<ConversationId | undefined> {
    const map = await this.harness.snapshot(MainMap, context);
    return map?.conversations[`main:${user}`] as ConversationId | undefined;
  }

  /** Test seam for identity recovery. This ID never goes over HTTP or WebSocket. */
  async conversationIdFor(user: string): Promise<string | undefined> {
    const id = await this.mainId(user);
    return id === undefined ? undefined : String(id);
  }

  async submitWeb(
    sender: WebSender,
    { message, clientSendId }: { message: string; clientSendId: string },
    onEvent?: (event: StreamEvent) => void,
  ): Promise<RunAgentResult> {
    // Durable serializes commits on the Session line. The map and its ownerless
    // conversation are committed together before a separate admission.
    const id = await this.harness.commit(async (tx) => {
      const map = await tx.doc(MainMap);
      const key = `main:${sender.id}`;
      const existing = map.conversations[key] as ConversationId | undefined;
      if (existing !== undefined) return existing;
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      map.conversations[key] = created.id;
      return created.id;
    }, context);
    this.owners.set(id, sender.id);
    await this.registerProviderSession(id);
    await this.afterMainCommit?.();
    const conversation = await this.harness.conversation(id, context);
    if (!conversation) throw new Error("Could not open Durable Main.");
    const { submission, duplicate } = await this.admitWeb(conversation, sender, message, "web:" + clientSendId);
    const wait = await this.attachSubmission(conversation, submission, sender.id, !duplicate, onEvent);
    return wait();
  }

  private async admitWeb(conversation: Conversation, sender: WebSender, message: string, requestId: string) {
    const id = conversation.id;
    const existing = await conversation.commit((tx) => tx.submissionByRequest(id, requestId), context);
    if (existing) {
      const submission = await this.harness.submission(existing.id, context);
      if (!submission) throw new Error("Could not find the admitted Durable input.");
      return { submission, duplicate: true };
    }

    // An inbox item supersedes an onYield continuation in Durable. Give reviewed
    // replies their rewrite before admitting a distinct input into that Main.
    const previous = this.admissions.get(id) ?? Promise.resolve();
    const admission = previous.then(async () => {
      const hold = this.review.holdsReplies();
      if (hold) await conversation.waitForIdle(context);
      const admit = async (seenFailure: LiveState["runFailure"], configuration?: Awaited<ReturnType<DurableHost["configureFor"]>>) => conversation.commit(async (tx) => {
        const existing = await tx.submissionByRequest(conversation.id, requestId);
        if (existing) return { submissionId: existing.id, duplicate: true };
        const live = await tx.doc(LiveDoc, id);
        if (live.run?.afterRun) return undefined;
        if (!live.run) {
          if (!configuration || live.runFailure?.taskId !== seenFailure?.taskId) return undefined;
          await configure(tx, id, configuration.change);
          await setModelPolicy(tx, id, configuration.primary, configuration.fallback);
        }
        const submissionId = await conversation.submit(tx, {
          type: "input",
          requestId,
          content: `[from ${sender.name.replace(/[\r\n[\]]/g, " ")} via web]\n${message}`,
          whenBusy: "steer",
          onAbort: "keep",
          entry: {
            kind: InputEntry.kind,
            data: { timestamp: Date.now(), sender, text: message, surface: "web", route: { surface: "web", user: sender.id } },
          },
        });
        return { submissionId, duplicate: false };
      }, context);
      let admission;
      while (!admission) {
        const live = await this.harness.snapshot(LiveDoc, id, context);
        if (live?.run?.afterRun) {
          await conversation.waitForIdle(context);
          continue;
        }
        const failedInput = live?.runFailure?.inputs[0];
        // Give settlement a chance to reserve fallback before replacing the failed turn with a new one.
        if (!live?.run && failedInput !== undefined) {
          const fallback = await reserveFallback(conversation, failedInput);
          if (fallback !== undefined) {
            const submission = await this.harness.submission(fallback, context);
            await submission?.wait(context);
            continue;
          }
        }
        const configuration = live?.run ? undefined : await this.configureFor(id);
        admission = await admit(live?.runFailure, configuration);
      }
      const { submissionId, duplicate } = admission;
      const submission = await this.harness.submission(submissionId, context);
      if (!submission) throw new Error("Could not find the admitted Durable input.");
      return { submission, duplicate, hold };
    });
    const tail = admission.then(async ({ submission, duplicate, hold }) => {
      if (hold && !duplicate) await submission.wait(context);
    }).catch(() => { /* The sender receives the admission or settlement error. */ });
    this.admissions.set(id, tail);
    void tail.then(() => {
      if (this.admissions.get(id) === tail) this.admissions.delete(id);
    });
    return admission;
  }

  private async configureFor(id: ConversationId) {
    const { agent, config, principal } = this.tools.authority(id);
    if (agent.modelRouting?.enabled && !routingWarnings.has(agent.id)) {
      routingWarnings.add(agent.id);
      logWarn("modelRouting is ignored for Durable agents", { agentId: agent.id });
    }
    const { installed, summary } = await this.tools.extensions(id);
    const provider = agent.model.provider;
    if (!provider) throw new Error("Durable requires model.provider to be set.");
    const change: AgentChange = {
      model: { provider, modelId: agent.model.model },
      thinkingLevel: agent.reasoning ?? agent.thinkLevel ?? null,
      extensions: [this.review.extension, CodingTools, this.tools.gate, this.boundary, ...installed, ...(agent.codemode ? [this.codemode] : []), ...(agent.toolDeferral?.enabled !== false ? [toolSearch] : [])],
      instructions: await durableInstructions(agent, config, principal, this.runtime, summary),
    };
    const fallback = agent.fallback_model;
    return {
      change,
      primary: {
        provider, modelId: agent.model.model,
        ...(agent.model.source ? { source: agent.model.source } : {}),
        ...(agent.auth?.mode ? { mode: agent.auth.mode } : {}),
      },
      fallback: fallback && { provider: fallback.provider, modelId: fallback.model },
    };
  }

  private async configureQueuedRun(id: ConversationId) {
    const { change, primary, fallback } = await this.configureFor(id);
    await this.harness.commit(async (tx) => {
      await configure(tx, id, change);
      await setModelPolicy(tx, id, primary, fallback);
    }, context);
  }

  private async registerProviderSession(id: ConversationId) {
    const provider = await this.harness.snapshot(ProviderDoc, id, context);
    if (provider) this.providerConversations.set(provider.sessionId, id);
  }

  private async resume() {
    const pending = (await this.harness.inspect(context)).submissions;
    const map = await this.harness.snapshot(MainMap, context);
    for (const [key, id] of Object.entries(map?.conversations ?? {})) {
      this.owners.set(id as ConversationId, key.slice("main:".length));
    }
    const routes = [];
    const configured = new Set<ConversationId>();
    for (const record of pending) {
      const user = this.owners.get(record.conversationId);
      if (!user) continue;
      const conversation = await this.harness.conversation(record.conversationId, context);
      if (!conversation || record.type === "write") continue;
      const id = record.type === "continue" ? await originalFallbackInput(this.harness, conversation, record.id) : record.id;
      if (id === undefined) continue;
      const submission = await this.harness.submission(id, context);
      if (!submission) continue;
      if (!configured.has(conversation.id)) {
        await this.registerProviderSession(conversation.id);
        const { change } = await this.configureFor(conversation.id);
        const current = await this.harness.snapshot(AgentDoc, conversation.id, context);
        await conversation.configure({ ...change, model: current?.model ?? change.model }, context);
        configured.add(conversation.id);
      }
      routes.push(await this.attachSubmission(conversation, submission, user, true));
    }
    this.harness.resume();
    for (const wait of routes) void wait().catch(() => { /* Settlement already notified the owning subscribers. */ });
  }

  private async attachSubmission(
    conversation: Conversation, submission: Submission, user: string, notify: boolean,
    onEvent?: (event: StreamEvent) => void,
  ) {
    let streamed = "";
    const watch = notify ? await conversation.watch(context) : undefined;
    let acceptingPartials = true;
    const onView = async (view: ConversationView) => {
      const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
      const turn = await this.activeTurn(conversation.id, live, view.entries);
      if (!turn || !acceptingPartials) return;
      this.publish(user, turn);
      if (!live?.run?.inputs.includes(submission.id) || !turn.text.startsWith(streamed)) return;
      const delta = turn.text.slice(streamed.length);
      if (delta) {
        onEvent?.({ type: "text", data: delta });
        streamed = turn.text;
      }
    };
    if (watch) {
      await onView(watch.value);
      watch.start(async (call) => {
        if (call.kind === "value") await onView(call.value);
      });
    }
    return async () => {
      try {
        const response = await this.settle(conversation, submission);
        acceptingPartials = false;
        await watch?.stop();
        const text = response.payloads[0]?.text ?? "";
        if (text.startsWith(streamed)) {
          const remaining = text.slice(streamed.length);
          if (remaining) onEvent?.({ type: "text", data: remaining });
          onEvent?.({ type: "done", meta: response.meta });
        } else {
          onEvent?.({ type: "error", message: "The reply changed while streaming." });
        }
        return response;
      } catch (error) {
        acceptingPartials = false;
        onEvent?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        await watch?.stop();
        if (notify) this.publish(user, { type: "history_updated", agentId: this.agent.id, sessionId: DURABLE_MAIN_SESSION_ID });
      }
    };
  }

  private async settle(conversation: Conversation, submission: Submission): Promise<RunAgentResult> {
    const original = await submission.wait(context);
    const result = original.status === "unanswered" && original.type === "input" && original.reason === "model_error"
      ? await settleFallback(this.harness, conversation, submission.id, this.agent.id) ?? original
      : original;
    if (result.status === "unanswered") {
      const kind = result.reason === "no_model" ||
        (result.reason === "model_error" && typeof result.detail === "string" && result.detail.startsWith("Provider is not configured:"))
        ? "provider_not_configured"
        : durableFailureKind(result.detail);
      // These legacy notices describe input removal or admin notifications.
      const durableKind = kind === "safety_refusal" || kind === "quota" ? "generic" : kind;
      const accessError = result.reason === "model_error" &&
        typeof result.detail === "string" && isSafeModelAccessError(result.detail) ? result.detail : undefined;
      const requestId = "failed:" + submission.id;
      const recorded = await conversation.commit(async (tx) => {
        if (await tx.submissionByRequest(conversation.id, requestId)) return false;
        const phrase = durableKind === "provider_not_configured" ? "model provider not configured" : "model error";
        await conversation.submit(tx, {
          type: "write",
          requestId,
          entry: {
            kind: FailureNoteEntry.kind,
            data: { submissionId: submission.id, kind: durableKind, ...(accessError && { accessError }) },
            model: [{ role: "user", content: `[previous reply failed: ${phrase}]`, timestamp: Date.now() }],
          },
        });
        return true;
      }, context);
      if (recorded) {
        logWarn("Durable turn failed", {
          agentId: this.agent.id, conversationId: conversation.id, submissionId: submission.id,
          reason: result.reason, kind: durableKind,
        });
      }
      throw new Error(accessError ?? runFailureMessage(durableKind, this.agent.language ?? "en"));
    }
    if (result.status !== "done" || result.type === "write" || original.entry === undefined) {
      throw new Error("Yoplai could not complete the turn.");
    }
    const [input, answer] = await conversation.commit(async (tx) => [
      await tx.entry(original.entry!),
      await tx.entry(result.answer),
    ], context);
    const review = await this.harness.snapshot(ReviewDoc, conversation.id, context);
    const decision = answer?.byTaskId === undefined ? undefined : review?.byTask[answer.byTaskId];
    const assistant = answer?.model?.find((item) => item.role === "assistant");
    if (!assistant || (decision?.state !== "stream" &&
        !(decision?.state === "approved" && decision.digest === draftDigest(assistant.content)))) {
      throw new Error(WITHHELD_REPLY);
    }
    const text = assistant.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    return {
      payloads: text ? [{ text }] : [],
      meta: {
        durationMs: InputEntry.is(input) ? Math.max(0, (decision.answeredAt ?? assistant.timestamp) - input.data.timestamp) : 0,
        sessionId: DURABLE_MAIN_SESSION_ID,
      },
    };
  }

  async subscribe(user: string, listener: (event: WsServerMessage) => void): Promise<() => void> {
    const listeners = this.listeners.get(user) ?? new Set();
    this.listeners.set(user, listeners);
    let updateSeen = false;
    const onUpdate = (event: WsServerMessage) => {
      updateSeen = true;
      listener(event);
    };
    listeners.add(onUpdate);
    const unsubscribe = () => {
      listeners.delete(onUpdate);
      if (!listeners.size) this.listeners.delete(user);
    };
    try {
      const id = await this.mainId(user);
      const conversation = id === undefined ? undefined : await this.harness.conversation(id, context);
      if (conversation) {
        const watch = await conversation.watch(context);
        try {
          const turn = await this.activeTurn(conversation.id, watch.value.docs[LiveDoc.definition.kind] as LiveState | undefined, watch.value.entries);
          if (turn && !updateSeen) listener(turn);
        } finally {
          await watch.stop();
        }
      }
      return unsubscribe;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  private publish(user: string, event: WsServerMessage) {
    for (const listener of this.listeners.get(user) ?? []) listener(event);
  }

  private async activeTurn(
    conversationId: ConversationId,
    live: LiveState | undefined,
    entries: readonly EntryRecord[],
  ): Promise<WsActiveTurnSnapshot | null> {
    if (!live?.run?.inputs.length) return null;
    const first = entries.find((entry) => entry.id === live.run?.first);
    const partial = live.generation?.message;
    const timestamp = InputEntry.is(first) ? first.data.timestamp : partial?.timestamp ?? Date.now();
    const review = partial ? await this.harness.snapshot(ReviewDoc, conversationId, context) : undefined;
    const blocks = review?.byTask[live.run.taskId]?.state === "stream" ? partial?.content ?? [] : [];
    return {
      type: "active_turn", agentId: this.agent.id, sessionId: DURABLE_MAIN_SESSION_ID,
      userText: null, userTimestamp: timestamp, startedAt: timestamp,
      text: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"),
      thinking: blocks.flatMap((block) => block.type === "thinking" ? [block.thinking] : []).join(""),
      toolCalls: [],
    };
  }

  async history(user: string, view: HistoryViewMode, limit?: number, before?: string) {
    const id = await this.mainId(user);
    const conversation = id === undefined ? undefined : await this.harness.conversation(id, context);
    if (!conversation) return { messages: [], view };
    const entries: EntryRecord[] = [];
    const toolCalls = new Set<string>();
    const full: FullHistoryMessage[] = [];
    const views = new Map<string, McpAppViewReference>();
    const hiddenCalls = new Set<string>();
    const finishedCalls = new Set<string>();
    const selected = (await this.harness.snapshot(AgentDoc, conversation.id, context))?.extensions;
    const hiddenNames = this.tools.invisibleNames(Array.isArray(selected) ? selected : []);
    const review = await this.harness.snapshot(ReviewDoc, conversation.id, context);
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
      entries.push(...page.items);
      for (const entry of page.items) {
        if (InputEntry.is(entry)) {
          full.push({ role: "user", content: [{ type: "text", text: entry.data.text }], timestamp: entry.data.timestamp });
        } else if (FailureNoteEntry.is(entry)) {
          const { kind, accessError } = entry.data;
          const note = entry.model?.[0];
          if (!note) continue;
          full.push({
            role: "assistant",
            content: [{ type: "text", text: isSafeModelAccessError(accessError) ? accessError : runFailureMessage(kind, this.agent.language ?? "en") }],
            timestamp: note.timestamp,
            meta: { stopReason: "error", failure: { kind } },
          });
        } else if (AssistantEntry.is(entry) && entry.byTaskId !== undefined) {
          const decision = review?.byTask[entry.byTaskId];
          for (const message of entry.model ?? []) {
            if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
            const showText = decision?.state === "stream" ||
              (decision?.state === "approved" && decision.digest === draftDigest(message.content));
            const blocks = showText ? message.content : message.stopReason === "toolUse"
              ? message.content.filter(({ type }) => type === "toolCall") : [];
            const content = blocks.map((block) => {
              switch (block.type) {
                case "text": return { type: block.type, text: block.text } as const;
                case "thinking": return { type: block.type, thinking: block.thinking } as const;
                case "toolCall": return { type: block.type, id: block.id, name: block.name, arguments: block.arguments } as const;
              }
            });
            if (!content.length) continue;
            for (const block of content) if (block.type === "toolCall") toolCalls.add(block.id);
            full.push({
              role: "assistant", content, timestamp: decision?.answeredAt ?? message.timestamp,
              meta: { api: message.api, provider: message.provider, model: message.model, usage: message.usage, stopReason: message.stopReason },
            });
          }
        } else if (ToolResultEntry.is(entry)) {
          for (const message of entry.model ?? []) {
            if (message.role !== "toolResult" || !toolCalls.has(message.toolCallId)) continue;
            finishedCalls.add(message.toolCallId);
            const details = message.details as { kind?: string; hidden?: boolean; view?: unknown; diff?: unknown; result?: { diff?: unknown } } | undefined;
            if (details?.kind === "yoplai.tool" && details.hidden) {
              hiddenCalls.add(message.toolCallId);
              continue;
            }
            const view = details?.kind === "yoplai.tool" ? McpAppViewReferenceSchema.safeParse(details.view).data : undefined;
            if (view) views.set(message.toolCallId, view);
            const diff = details?.kind === "yoplai.tool" ? details.result?.diff : details?.diff;
            full.push({
              role: "toolResult", toolCallId: message.toolCallId, toolName: message.toolName,
              content: message.content.flatMap((block) => block.type === "text" ? [{ type: "text", text: block.text }] : []),
              isError: message.isError, timestamp: message.timestamp,
              ...(view ? { view } : {}),
              ...(typeof diff === "string" ? { details: { diff } } : {}),
            });
          }
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    for (let index = full.length - 1; index >= 0; index--) {
      const message = full[index];
      if (message.role !== "assistant") continue;
      message.content = message.content.flatMap<ContentBlock>((block) => {
        if (block.type !== "toolCall") return [block];
        if (hiddenCalls.has(block.id) || (!finishedCalls.has(block.id) && hiddenNames.has(block.name))) return [];
        const view = views.get(block.id);
        return [view ? { ...block, view } : block];
      });
      if (!message.content.length) full.splice(index, 1);
    }
    if (!full.length) return { messages: [], view };
    const live = await this.harness.snapshot(LiveDoc, conversation.id, context);
    const activeTurn = await this.activeTurn(conversation.id, live, entries);
    const messages: (FullHistoryMessage | SimpleHistoryMessage)[] = view === "full" ? full : full.flatMap((item) => {
      if (item.role !== "user" && item.role !== "assistant") return [];
      const content = messageText(item);
      return content ? [{
        role: item.role, content, timestamp: item.timestamp,
        ...(item.role === "assistant" && item.meta?.failure ? { meta: item.meta } : {}),
      }] : [];
    });
    let page;
    try {
      page = limit === undefined ? { messages, historyOffset: 0 } : historyPage(messages, limit, before);
    } catch {
      return { error: "Invalid history cursor" as const };
    }
    return {
      ...page,
      activeContextUsage: activeContextUsage(full),
      sessionId: DURABLE_MAIN_SESSION_ID,
      view,
      isStreaming: activeTurn !== null,
      activeTurn,
    };
  }

  async close(): Promise<void> {
    try {
      await this.harness.close(context);
    } finally {
      this.review.close();
      await this.sandbox.close();
    }
  }
}
