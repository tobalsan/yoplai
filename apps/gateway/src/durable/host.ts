import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  AgentDoc, CompactionTask, configure, createRegistry, defineExtension, GenerationTask, Harness, hook, InboxDoc, LiveDoc, ProviderDoc,
  type AgentChange, type Conversation, type ConversationCreateOptions, type ConversationId, type ConversationView, type EntryDraft, type EntryId, type Extension, type LiveState, type SettledSubmissionRecord, type Submission, type SubmissionId, type TaskId,
} from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  DEFAULT_RETRY_BASE_DELAY_SECONDS, DEFAULT_RETRY_MAX_ATTEMPTS, DURABLE_MAIN_SESSION_ID, runFailureMessage, type AgentConfig, type FeedWindow, type FullHistoryMessage,
  type ChannelAdmission, type ChannelInput, type JobTickInput, type JobTickResult, type WebhookAdmission, type WebhookInput, type DurableStopResult, type HistoryViewMode, type RunAgentResult, type SimpleHistoryMessage, type StreamEvent, type WsActiveTurnSnapshot, type WsServerMessage,
} from "@yoplai/shared";
import { getAgent, loadConfig } from "../config/index.js";
import { durableModeFor } from "../durable-mode/resolve.js";
import { isSafeModelAccessError } from "../desktop/model-auth.js";
import { messageText, oneLine } from "../history/condense.js";
import { buildHandoff } from "../history/handoff.js";
import { historyPage } from "../history/page.js";
import { logError, logWarn } from "../logging.js";
import type { OpsMetrics } from "../server/ops-metrics.js";
import { createDurableModels, type DurableModelsFactory } from "./models.js";
import { COMPACTION_MEMORY_CHARS, compactionInputCeiling, createMainCompactionSettings, summarizeCompaction } from "./compaction.js";

import { ThreadError, type WebSender } from "./contract.js";
import { requireActorExecution, type ExtensionRuntime } from "../extensions/runtime.js";
import { feedDetail, feedItems, feedSearch } from "./feed-projection.js";
import { getMcpAppView } from "../mcp-apps/capture.js";
import { DurableFeed, emptyFeedWindow, entryId, observeFeed, runIdFor, type FeedSelector } from "./feed.js";
import { createReplyReview, draftDigest, WITHHELD_REPLY } from "./review.js";
import { abortWithoutFallback, durableFailureKind, getModelPolicy, originalFallbackInput, reserveFallback, setModelPolicy, settleFallback } from "./fallback.js";
import { durableExecutionEnv } from "./env.js";
import { durableInstructions } from "./prompt.js";
import { MemoryKeeper, type KeeperOptions } from "./keeper.js";
import { createMemoryTools } from "./memory-tools.js";
import { MemoryDoc, putThreadDigest, renderMemory, threadDigest } from "./memory.js";
import { durableSessionHistory, type ReadableConversation } from "./session-history.js";
import { createDurableTools, DurableAccessDenied } from "./tools.js";
import { AbortedRuns, ChildDigestEntry, ChildInputEntry, ChildSeedEntry, type BackgroundChild, type MainIdentityMap, FailureNoteEntry, InputEntry, MainMap, ReviewDoc, ThreadMap, ThreadNoteEntry, ThreadSeedEntry, type ThreadRecord } from "./state.js";
import { describeThread, firstLine, threadRef } from "./threads.js";
import { durableStorePath } from "./store-path.js";
import { DeliveryQueue, type DeliveryFixture } from "./outbox.js";

import { handoffTranscript } from "./background.js";

const CHILD_DIGEST_CHARS = 500;
const context = BACKGROUND_CONTEXT;
const toolSearch = createToolSearchExtension();
const routingWarnings = new Set<string>();
export type DurableHostOptions = {
  createModels?: DurableModelsFactory;
  afterMainCommit?: () => void | Promise<void>;
  afterChildSettlement?: () => void | Promise<void>;
  afterThreadArchive?: () => void | Promise<void>;
  fixture?: { extension: Extension; invisibleTools?: readonly string[] };
  wakeDelivery?: () => void;
  deliveryFixture?: DeliveryFixture;
  keeper?: KeeperOptions;
};

type Admission = { surface: "web"; sender: WebSender; text: string; requestId: string } | ChannelInput;
const CHANNEL_NO_LONGER_ELIGIBLE = Symbol("channel-no-longer-eligible");
type ChildAdmission = Omit<BackgroundChild, "id"> & {
  key: string;
  text: string;
  deliveryId?: string;
  signal?: AbortSignal;
};

export class DurableHost {
  readonly deliveries: DeliveryQueue;
  private readonly feed: DurableFeed;
  private readonly keeper: MemoryKeeper;
  private readonly settlingChildren = new Map<ConversationId, Promise<RunAgentResult>>();
  private readonly waitingDigests = new Set<string>();
  private readonly childKeys = new Map<ConversationId, string>();
  private readonly threadIds = new Map<ConversationId, string>();
  private readonly mainWaiters = new Map<string, Set<(id: ConversationId) => void>>();
  private readonly admissions = new Map<ConversationId, Promise<void>>();
  private readonly conversationMutations = new Map<ConversationId, Promise<void>>();
  private readonly listeners = new Map<string, Set<(event: WsServerMessage) => void>>();
  private readonly feedListeners = new Map<ConversationId, Set<() => void>>();

  private constructor(
    private readonly harness: Harness,
    private readonly models: Awaited<ReturnType<DurableModelsFactory>>,
    private readonly agent: AgentConfig,
    private readonly runtime: ExtensionRuntime,
    private readonly providerConversations: Map<string, ConversationId>,
    private readonly owners: Map<ConversationId, string>,
    private readonly tools: ReturnType<typeof createDurableTools>,
    private readonly boundary: Extension,
    private readonly codemode: ReturnType<typeof createCodemodeExtension>,
    private readonly sandbox: CodemodeSandbox,
    private readonly review: ReturnType<typeof createReplyReview>,
    private readonly memoryTools: Extension,
    private readonly options: DurableHostOptions,
  ) {
    this.deliveries = new DeliveryQueue(harness, agent.id, async (conversation, submission) => {
      const status = await submission.status(context);
      if (status.status === "queued" || status.status === "placed") return "waiting";
      const result = await this.effectiveSettlement(conversation, status, false);
      if (!result) return "waiting";
      if (result.status === "unanswered") {
        if (result.reason !== "aborted") await this.recordFailure(conversation, submission.id, result);
        return undefined;
      }
      if (result.type === "write") return undefined;
      const answer = await this.publicAnswer(conversation, result.answer);
      if (answer?.text) return result.answer;
    }, async (conversation, id) => (await this.publicAnswer(conversation, id))?.text, (id) => {
      for (const changed of this.feedListeners.get(id) ?? []) changed();
    }, options.deliveryFixture);
    this.feed = new DurableFeed(harness, agent, (selected) => {
      const names = tools.invisibleNames(selected);
      for (const name of options.fixture?.invisibleTools ?? []) names.add(name);
      return names;
    }, (conversation, callId) => {
      const owner = this.owners.get(conversation.id);
      if (owner === undefined) return;
      return getMcpAppView({ agentId: agent.id, sessionId: this.sessionRef(conversation.id), userId: owner === "local" ? undefined : owner }, callId);
    }, this.deliveries);
    this.keeper = new MemoryKeeper(harness, this.feed, models, agent.id, options.keeper);
  }

  static async open(home: string, agent: AgentConfig, runtime: ExtensionRuntime, metrics: OpsMetrics, options: DurableHostOptions) {
    const provider = agent.model.provider;
    if (!provider) throw new Error("Durable requires model.provider to be set.");
    let harness: Harness | undefined;
    const providerConversations = new Map<string, ConversationId>();
    const models = await (options.createModels ?? createDurableModels)(agent, async (sessionId) => {
      const id = sessionId && providerConversations.get(sessionId);
      if (harness && id) return getModelPolicy(harness, id);
    });
    const compactionSettings = createMainCompactionSettings(models);
    const store = durableStorePath(home, agent.id);
    await fs.mkdir(path.dirname(store), { recursive: true, mode: 0o700 });
    const storage = await openNodeSqliteStorage(store);
    const registry = createRegistry();
    const owners = new Map<ConversationId, string>();
    const memoryTools = createMemoryTools((id) => userMemoryKey(owners.get(id)));
    let host: DurableHost | undefined;
    const tools = createDurableTools(agent.id, runtime, registry, (id) => owners.get(id),
      (id) => host?.sessionRef(id) ?? DURABLE_MAIN_SESSION_ID,
      (id) => host?.childKeys.has(id) ?? false,
      () => metrics.increment("interrupted_tool_calls", agent.id), async (id, args) => {
        if (!host) throw new Error("Durable host is not open.");
        return host.sessionHistory(id, args);
      });
    const review = createReplyReview(agent, runtime, tools.authority, tools.invisibleNames, () => {
      if (!harness) throw new Error("Durable host is not open.");
      return harness;
    });
    const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
    const codemode = createCodemodeExtension({ sandbox, models: false });
    registry.install(codemode);
    const boundary = defineExtension({
      name: "yoplai-run-boundary",
      hooks: [hook(GenerationTask, {
        async afterRun(run, api, context) {
          host?.noteTurn(api.conversationId, run.last);
          const inbox = await api.snapshot(InboxDoc, api.conversationId, context);
          if (inbox?.items.some(({ mode }) => mode !== "write")) await host?.configureQueuedRun(api.conversationId);
          return undefined;
        },
      }), hook(CompactionTask, {
        beforeCompact(compaction, api, context) {
          return summarizeCompaction(compaction, api, context, async () => {
            const selected = (await api.snapshot(AgentDoc, api.conversationId, context))?.extensions;
            const names = tools.invisibleNames(Array.isArray(selected) ? selected : []);
            for (const name of options.fixture?.invisibleTools ?? []) names.add(name);
            return names;
          }, async () => {
            const key = userMemoryKey(owners.get(api.conversationId));
            if (key === undefined) return;
            const memory = await api.snapshot(MemoryDoc, key, context);
            return memory && renderMemory(memory, COMPACTION_MEMORY_CHARS);
          });
        },
      })],
    });
    registry.install(boundary);
    registry.install(review.extension);
    registry.install(memoryTools);
    registry.install(CodingTools);
    registry.install(toolSearch);
    registry.install(tools.gate);
    if (options.fixture) registry.install(options.fixture.extension);
    try {
      harness = await Harness.open(storage, {
        models,
        registry,
        async env({ conversationId }) {
          const { agent, config } = await tools.authority(conversationId);
          return durableExecutionEnv(agent, config);
        },
        settings() {
          const current = getAgent(agent.id) ?? agent;
          return {
            compaction: compactionSettings(current), steeringMode: "all", followUpMode: "all",
            ...(current.sandbox?.env?.PI_CACHE_RETENTION === "long" && { stream: { cacheRetention: "long" } }),
            retry: {
              maxRetries: (current.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS) - 1,
              baseDelayMs: Math.round((current.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY_SECONDS) * 1000),
            },
          };
        },
      }, context);
      host = new DurableHost(harness, models, agent, runtime, providerConversations, owners, tools, boundary, codemode, sandbox, review, memoryTools, options);
      await host.resume();
      return host;
    } catch (error) {
      if (host) await host.close();
      else {
        if (harness) await harness.close(context);
        else await storage.close(context);
        await sandbox.close();
      }
      throw error;
    }
  }

  private noteTurn(id: ConversationId, last: EntryId) {
    if (this.threadIds.has(id) || this.childKeys.has(id)) return;
    const key = userMemoryKey(this.owners.get(id));
    if (key !== undefined) this.keeper.noteTurn(key, id, last);
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

  /** A passive write fixture for entry kinds the HTTP interface cannot create. */
  async writePassiveEntry(owner: string, entry: EntryDraft) {
    const conversation = await this.mainFor(owner);
    if (!conversation) throw new Error("Seed a Durable Main before writing an entry.");
    await conversation.commit((tx) => conversation.submit(tx, { type: "write", entry }), context);
  }

  async submitWeb(
    sender: WebSender,
    { message, clientSendId, threadId }: { message: string; clientSendId: string; threadId?: string },
    onEvent?: (event: StreamEvent) => void,
  ): Promise<RunAgentResult> {
    const thread = threadId === undefined ? undefined : await this.requireThread(sender.id, threadId);
    if (thread?.closed) throw new ThreadError(409, "Thread is closed");
    const conversation = thread ? await this.threadConversation(thread) : await this.openMain(sender.id);
    if (thread) await this.registerProviderSession(conversation.id);
    const { submission, duplicate } = await this.admit(conversation, { surface: "web", sender, text: message, requestId: "web:" + clientSendId });
    const wait = await this.attachSubmission(conversation, submission, sender.id, !duplicate, onEvent);
    return wait();
  }

  async submitChannel(input: ChannelInput, eligible: () => Promise<boolean>): Promise<ChannelAdmission> {
    const conversation = await this.openMain(input.owner);
    const admitted = await this.admit(conversation, input, eligible).catch((error: unknown) => {
      if (error !== CHANNEL_NO_LONGER_ELIGIBLE && !(error instanceof DurableAccessDenied)) throw error;
    });
    if (!admitted) return { status: "not_durable" };
    const { submission, duplicate } = admitted;
    if (!duplicate) {
      void this.attachSubmission(conversation, submission, input.owner, true)
        .then((wait) => wait()).catch(() => { /* The public feed records settlement failures. */ });
    }
    return { status: "admitted", duplicate };
  }

  async submitWebhook(input: WebhookInput): Promise<WebhookAdmission> {
    const key = `webhook:${encodeURIComponent(input.name)}:${encodeURIComponent(input.deliveryId ?? input.requestId)}`;
    const child = await this.admitChild({
      key, owner: input.owner, kind: "webhook", name: input.name, text: input.text, deliveryId: input.deliveryId,
    });
    if (!child) return { status: "admitted", duplicate: true };
    void this.waitForChild(child.conversation, child.submission, input.owner).catch(() => { /* Failures are digested. */ });
    return { status: "admitted", duplicate: child.duplicate };
  }

  async runJobTick(input: JobTickInput): Promise<JobTickResult> {
    const key = `job:${input.jobId}:${input.tickTime}`;
    input.signal.throwIfAborted();
    input.onAdmitted?.(key);
    const admitted = await this.admitChild({
      key, owner: input.owner, kind: "job", name: input.jobName, text: input.prompt, signal: input.signal,
    });
    if (!admitted) throw new Error("Durable tick belongs to another owner.");
    const { conversation, submission } = admitted;
    let aborting: Promise<void> | undefined;
    const abort = () => {
      aborting ??= abortWithoutFallback(conversation);
      void aborting.catch(() => { /* Settlement or shutdown owns the caller's result. */ });
    };
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    try {
      const result = await this.waitForChild(conversation, submission, input.owner);
      input.signal.throwIfAborted();
      if (result.meta.aborted) throw new Error("Durable tick was stopped.");
      return { status: "done", result };
    } finally {
      input.signal.removeEventListener("abort", abort);
      await aborting?.catch(() => { /* The tick already reported its settlement. */ });
    }
  }

  private async admitChild({ key, owner, kind, name, text, deliveryId, signal }: ChildAdmission) {
    signal?.throwIfAborted();
    const child = await this.harness.commit(async (tx) => {
      const map = await tx.doc(MainMap);
      map.children ??= {};
      const children = map.children;
      if (children[key]) return { ...children[key] };
      const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
      return children[key] = { id, owner, kind, name };
    }, context);
    if (child.owner !== owner) return;
    const { id } = child;
    this.owners.set(id, owner);
    this.childKeys.set(id, key);
    await this.registerProviderSession(id);
    const conversation = await this.harness.conversation(id, context);
    if (!conversation) throw new Error("Could not open Durable background conversation.");

    const { submissionId, duplicate } = await this.mutateConversation(id, async () => {
      const existing = await conversation.commit((tx) => tx.submissionByRequest(id, key), context);
      if (existing) return { submissionId: existing.id, duplicate: true };
      const { change, primary, fallback } = await this.configureFor(id);
      signal?.throwIfAborted();
      const seedKey = key + ":seed";
      if (!await conversation.commit((tx) => tx.submissionByRequest(id, seedKey), context)) {
        const main = await this.mainFor(owner);
        const transcript = main ? handoffTranscript((await this.feed.read(main)).records) : [];
        const memory = await this.harness.snapshot(MemoryDoc, "user:" + owner, context);
        const memoryText = memory && renderMemory(memory, COMPACTION_MEMORY_CHARS);
        // At four characters per token, reserve at most a quarter of the smaller model ceiling for the handoff.
        const maxChars = Math.min(...[primary, fallback].flatMap((ref) => {
          const model = ref && this.models.getModel(ref.provider, ref.modelId);
          return model ? [compactionInputCeiling(model.contextWindow, model.maxTokens)] : [];
        }));
        const seed = buildHandoff({ transcript, memory: memoryText ? { text: memoryText } : undefined, maxChars }).text;
        // Durable accepts one submit per transaction. Persist the seed first and reuse it after a crash.
        await conversation.submit({
          type: "write", requestId: seedKey,
          entry: { kind: ChildSeedEntry.kind, model: [{ role: "user", timestamp: Date.now(), content: seed }] },
        }, context);
      }
      const timestamp = Date.now();
      const submissionId = await conversation.commit(async (tx) => {
        await configure(tx, id, change);
        await setModelPolicy(tx, id, primary, fallback);
        signal?.throwIfAborted();
        return conversation.submit(tx, {
          type: "input", requestId: key,
          content: kind === "webhook" ? `[from ${name.replace(/[\r\n[\]]/g, " ")} via webhook]\n${text}` : text,
          entry: { kind: ChildInputEntry.kind, data: { timestamp, surface: kind, name, owner, text, ...(deliveryId !== undefined && { deliveryId }) } },
        });
      }, context);
      return { submissionId, duplicate: false };
    });
    const submission = await this.harness.submission(submissionId, context);
    if (!submission) throw new Error("Could not find the admitted Durable background input.");
    return { conversation, submission, duplicate };
  }

  private waitForChild(conversation: Conversation, submission: Submission, owner: string) {
    let result = this.settlingChildren.get(conversation.id);
    if (!result) {
      result = this.attachSubmission(conversation, submission, owner, false).then((wait) => wait())
        .finally(() => this.settlingChildren.delete(conversation.id));
      this.settlingChildren.set(conversation.id, result);
    }
    return result;
  }

  private async writeChildDigest(id: ConversationId, status: "done" | "unanswered" | "aborted", answer?: string) {
    const key = this.childKeys.get(id);
    if (!key || this.waitingDigests.has(key)) return;
    const child = (await this.harness.snapshot(MainMap, context))?.children?.[key];
    if (!child) return;
    await this.options.afterChildSettlement?.();
    const main = await this.openMain(child.owner);
    const label = status === "done" ? "completed" : status === "aborted" ? "stopped" : "failed";
    const excerpt = answer ? oneLine(answer).slice(0, CHILD_DIGEST_CHARS) : "";
    const text = oneLine(child.name) + " " + label + (excerpt ? ": " + excerpt : ".");
    const writeIfIdle = () => main.commit(async (tx) => {
      if (await tx.submissionByRequest(main.id, key)) return true;
      // A model-visible write queued mid-run can enter the very next tool round.
      if ((await tx.doc(LiveDoc, main.id)).run) return false;
      const timestamp = Date.now();
      await main.submit(tx, {
        type: "write", requestId: key,
        entry: {
          kind: ChildDigestEntry.kind,
          data: { timestamp, text, surface: child.kind, name: child.name, key, status },
          model: [{ role: "user", timestamp, content: text }],
        },
      });
      return true;
    }, context);
    if (await writeIfIdle() || this.waitingDigests.has(key)) return;
    // The scheduler can deliver the tick even while a Main turn is still running.
    // The persisted child settlement can reconstruct this pending digest after a restart.
    this.waitingDigests.add(key);
    void (async () => {
      do { await main.waitForIdle(context); } while (!await writeIfIdle());
    })().catch((error: unknown) => {
      logError("Could not write Durable background digest", error, { agentId: this.agent.id });
    }).finally(() => this.waitingDigests.delete(key));
  }

  async createThread(owner: string, options: { messageId?: string; title?: string; dashboardId?: string }) {
    if (!await this.mayReadFeed(owner, owner)) throw new ThreadError(404, "Agent not found");
    const id = randomUUID();
    const { title, dashboardId, messageId } = options;
    const main = messageId === undefined ? undefined : await this.mainFor(owner);
    const forkedAt = main && messageId !== undefined ? await this.feed.forkPoint(main, messageId) : undefined;
    if (messageId !== undefined && forkedAt === undefined) throw new ThreadError(404, "Message not found");
    const metadata = {
      owner, createdAt: Date.now(), generation: 1, closed: false,
      ...(title !== undefined && { title }),
      ...(dashboardId !== undefined && { dashboardId }),
      ...(forkedAt !== undefined && { forkedAt, forkedFrom: messageId! }),
    };
    const create: ConversationCreateOptions = {
      ownership: { kind: "ownerless" },
      init: async (tx, conversationId) => {
        const map = await tx.doc(ThreadMap);
        map.threads[id] = { ...metadata, conversationId };
        if (main) {
          const parent = await tx.doc(ReviewDoc, main.id);
          const child = await tx.doc(ReviewDoc, conversationId);
          child.byTask = { ...parent.byTask };
        }
      },
    };
    const conversation = main && forkedAt !== undefined
      ? await main.fork(forkedAt, create, context)
      : await this.harness.createConversation(create, context);
    this.threadIds.set(conversation.id, id);
    this.owners.set(conversation.id, owner);
    await this.registerProviderSession(conversation.id);
    return this.describeThread(id, { ...metadata, conversationId: conversation.id });
  }

  private async requireThread(owner: string, id: string) {
    const map = await this.harness.snapshot(ThreadMap, context);
    const thread = map?.threads[id];
    if (thread?.owner !== owner || !await this.mayReadFeed(owner, owner)) {
      throw new ThreadError(404, "Thread not found");
    }
    return thread;
  }

  private async threadConversation(thread: ThreadRecord) {
    const conversation = await this.harness.conversation(thread.conversationId, context);
    if (!conversation) throw new ThreadError(404, "Thread not found");
    return conversation;
  }

  private async seedThread(conversation: Conversation, id: string) {
    await conversation.commit(async (tx) => {
      const thread = (await tx.doc(ThreadMap)).threads[id]!;
      if (thread.closed) throw new ThreadError(409, "Thread is closed");
      if (thread.seeded) return;
      const memory = await tx.doc(MemoryDoc, "user:" + thread.owner, null);
      const seed = renderMemory(memory, COMPACTION_MEMORY_CHARS);
      if (seed) await conversation.submit(tx, {
        type: "write",
        requestId: "thread-seed:" + id,
        entry: { kind: ThreadSeedEntry.kind, model: [{ role: "user", content: "Agent memory\n" + seed, timestamp: Date.now() }] },
      });
      thread.seeded = true;
    }, context);
  }

  private sessionRef(id: ConversationId) {
    const childKey = this.childKeys.get(id);
    if (childKey !== undefined) return childKey;
    const threadId = this.threadIds.get(id);
    return threadId === undefined ? DURABLE_MAIN_SESSION_ID : threadRef(threadId);
  }

  private async threadsFor(owner: string) {
    const map = await this.harness.snapshot(ThreadMap, context);
    return Object.fromEntries(Object.entries(map?.threads ?? {}).filter(([, thread]) => thread.owner === owner));
  }

  private async describeThread(id: string, thread: ThreadRecord) {
    const conversation = await this.harness.conversation(thread.conversationId, context);
    const items = conversation ? feedItems((await this.feed.read(conversation)).records) : [];
    return describeThread(id, thread, items);
  }

  async listThreads(owner: string) {
    if (!await this.mayReadFeed(owner, owner)) throw new ThreadError(404, "Agent not found");
    const threads = await this.threadsFor(owner);
    const descriptions = await Promise.all(Object.entries(threads).map(([id, thread]) => this.describeThread(id, thread)));
    return descriptions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  async closeThread(owner: string, id: string, generation: number) {
    if (id === DURABLE_MAIN_SESSION_ID || id === "main") throw new ThreadError(400, "Main cannot be closed");
    const record = await this.requireThread(owner, id);
    const conversation = await this.threadConversation(record);
    return this.mutateConversation(conversation.id, async () => {
      const thread = await this.requireThread(owner, id);
      if (thread.generation !== generation) throw new ThreadError(409, "Stale generation");
      if (!thread.closed) {
        await conversation.commit(async (tx) => {
          if ((await tx.doc(LiveDoc, conversation.id)).run) {
            throw new ThreadError(409, "Stop the thread before closing it");
          }
          (await tx.doc(ThreadMap)).threads[id]!.closed = true;
        }, context);
        await this.options.afterThreadArchive?.();
      }
      return this.finishThreadClose(id, { ...thread, closed: true }, conversation);
    });
  }

  async reopenThread(owner: string, id: string) {
    const record = await this.requireThread(owner, id);
    const conversation = await this.threadConversation(record);
    return this.mutateConversation(conversation.id, async () => {
      const thread = await this.requireThread(owner, id);
      if (!thread.closed) return this.describeThread(id, thread);
      const closed = await this.finishThreadClose(id, thread, conversation);
      const generation = thread.generation + 1;
      await conversation.commit(async (tx) => {
        const stored = (await tx.doc(ThreadMap)).threads[id]!;
        stored.closed = false;
        stored.generation = generation;
      }, context);
      return { ...closed, closed: false, generation };
    });
  }

  private async finishThreadClose(id: string, thread: ThreadRecord, conversation: Conversation) {
    const items = feedItems((await this.feed.read(conversation)).records);
    const description = describeThread(id, thread, items);
    const answer = items.filter(({ role }) => role === "assistant").at(-1);
    const digest = threadDigest(id, description.title, firstLine(answer?.text ?? "") || "no conclusion");
    if (thread.digestedGeneration !== thread.generation) {
      await this.harness.commit(async (tx) => {
        const stored = (await tx.doc(ThreadMap)).threads[id]!;
        const memory = await tx.doc(MemoryDoc, "user:" + thread.owner, null);
        memory.topics = putThreadDigest(memory.topics, digest);
        stored.digestedGeneration = thread.generation;
      }, context);
    }
    const main = await this.openMain(thread.owner);
    await main.commit((tx) => main.submit(tx, {
      type: "write",
      requestId: `thread-note:${id}:${thread.generation}`,
      entry: {
        kind: ThreadNoteEntry.kind,
        model: [{ role: "user", content: `[thread ${JSON.stringify(digest.title)} closed] ${digest.note}`, timestamp: Date.now() }],
      },
    }), context);
    return description;
  }

  private async openMain(owner: string) {
    // Durable serializes commits on the Session line. The map and its ownerless
    // conversation are committed together before a separate admission.
    const id = await this.harness.commit(async (tx) => {
      const map = await tx.doc(MainMap);
      const key = `main:${owner}`;
      const existing = map.conversations[key] as ConversationId | undefined;
      if (existing !== undefined) return existing;
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      map.conversations[key] = created.id;
      return created.id;
    }, context);
    this.owners.set(id, owner);
    for (const opened of this.mainWaiters.get(owner) ?? []) opened(id);
    await this.registerProviderSession(id);
    await this.options.afterMainCommit?.();
    const conversation = await this.harness.conversation(id, context);
    if (!conversation) throw new Error("Could not open Durable Main.");
    return conversation;
  }

  private async admit(conversation: Conversation, source: Admission, eligible?: () => Promise<boolean>) {
    const { requestId, surface, text } = source;
    const name = source.surface === "web" ? source.sender.name : source.actor.name;
    const id = conversation.id;
    const existing = await conversation.commit((tx) => tx.submissionByRequest(id, requestId), context);
    if (existing) {
      if (eligible && !await eligible()) throw CHANNEL_NO_LONGER_ELIGIBLE;
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
      const admit = (seenFailure: LiveState["runFailure"], configuration?: Awaited<ReturnType<DurableHost["configureFor"]>>) => this.mutateConversation(id, async () => {
        // Reviewed replies and fallback can delay the admission while the actor unlinks.
        if (eligible && !await eligible()) throw CHANNEL_NO_LONGER_ELIGIBLE;
        const threadId = this.threadIds.get(id);
        if (threadId !== undefined) await this.seedThread(conversation, threadId);
        return conversation.commit(async (tx) => {
          const existing = await tx.submissionByRequest(conversation.id, requestId);
          if (existing) return { submissionId: existing.id, duplicate: true };
          const live = await tx.doc(LiveDoc, id);
          if (live.run?.afterRun) return undefined;
          if (!live.run) {
            if (!configuration || live.runFailure?.taskId !== seenFailure?.taskId) return undefined;
            await configure(tx, id, configuration.change);
            await setModelPolicy(tx, id, configuration.primary, configuration.fallback);
          }
          const timestamp = Date.now();
          const submissionId = await conversation.submit(tx, {
            type: "input",
            requestId,
            content: `[from ${name.replace(/[\r\n[\]]/g, " ")} via ${surface}]\n${text}`,
            whenBusy: "steer",
            onAbort: "keep",
            entry: {
              kind: InputEntry.kind,
              data: source.surface === "web"
                ? { timestamp, text, surface, sender: source.sender, route: { surface: "web", user: source.sender.id } }
                : { timestamp, text, surface, owner: source.owner, actor: source.actor, route: source.route },
            },
          });
          if (source.surface !== "web") await this.deliveries.enqueue(tx, id, submissionId, source, timestamp);
          return { submissionId, duplicate: false };
        }, context);
      });
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
          const fallback = await reserveFallback(conversation, failedInput, this.threadIds.get(id));
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

  private mutateConversation<T>(id: ConversationId, operation: () => Promise<T>): Promise<T> {
    const previous = this.conversationMutations.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.conversationMutations.set(id, tail);
    void tail.then(() => {
      if (this.conversationMutations.get(id) === tail) this.conversationMutations.delete(id);
    });
    return result;
  }

  private async configureFor(id: ConversationId) {
    const { agent, config, principal } = await this.tools.authority(id);
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
      extensions: [this.review.extension, CodingTools, this.tools.gate, this.boundary, ...(principal.background ? [] : [this.memoryTools]), ...installed, ...(this.options.fixture ? [this.options.fixture.extension] : []), ...(agent.codemode ? [this.codemode] : []), ...(agent.toolDeferral?.enabled !== false ? [toolSearch] : [])],
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

  private async continueKeptInputs(conversation: Conversation, user: string) {
    const id = conversation.id;
    const inbox = await this.harness.snapshot(InboxDoc, id, context);
    const next = inbox?.items.find(({ mode }) => mode !== "write");
    if (!next) return;
    const live = await this.harness.snapshot(LiveDoc, id, context);
    const failed = live?.runFailure;
    if (live?.run || (failed && failed.reason !== "aborted") || !await this.mayReadFeed(user, user)) return;
    await this.configureQueuedRun(id);
    const threadId = this.threadIds.get(id);
    await conversation.commit(async (tx) => {
      if (threadId !== undefined && (await tx.doc(ThreadMap)).threads[threadId]?.closed) return;
      // A continue can reuse the failed run's first entry. Persist its cutoff
      // in the same commit as the new run so recovery cannot reuse the old ID.
      if (failed?.first !== undefined) {
        const stopped = await tx.doc(AbortedRuns, id);
        stopped.byFirst[failed.first] = [...(stopped.byFirst[failed.first] ?? []), failed.taskId];
      }
      await conversation.submit(tx, { type: "continue", requestId: "stop:keep:" + next.id });
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
    for (const [key, { id, owner }] of Object.entries(map?.children ?? {})) {
      this.owners.set(id, owner);
      this.childKeys.set(id, key);
    }
    const threads = await this.harness.snapshot(ThreadMap, context);
    for (const [threadId, { conversationId, owner }] of Object.entries(threads?.threads ?? {})) {
      this.owners.set(conversationId, owner);
      this.threadIds.set(conversationId, threadId);
    }
    const routes = [];
    const stopping: { conversation: Conversation; user: string }[] = [];
    const configured = new Set<ConversationId>();
    for (const record of pending) {
      const user = this.owners.get(record.conversationId);
      const child = this.childKeys.has(record.conversationId);
      const threadId = this.threadIds.get(record.conversationId);
      if (!user || (threadId !== undefined && threads?.threads[threadId]?.closed)) continue;
      const conversation = await this.harness.conversation(record.conversationId, context);
      if (!conversation || record.type === "write") continue;
      const id = record.type === "continue" ? await originalFallbackInput(this.harness, conversation, record.id) : record.id;
      if (id === undefined) continue;
      const submission = await this.harness.submission(id, context);
      if (!submission) continue;
      if (!configured.has(conversation.id)) {
        await this.registerProviderSession(conversation.id);
        const configuration = await this.configureFor(conversation.id).catch((error: unknown) => {
          if (!(error instanceof DurableAccessDenied)) throw error;
          // One ineligible owner cannot prevent the shared agent from opening.
          return undefined;
        });
        if (!configuration) continue;
        const current = await this.harness.snapshot(AgentDoc, conversation.id, context);
        await conversation.configure({ ...configuration.change, model: current?.model ?? configuration.change.model }, context);
        const run = (await this.harness.snapshot(LiveDoc, conversation.id, context))?.run;
        if (run) {
          const task = await this.harness.getTask(run.taskId, context);
          if (!child && task?.abortRequested && task.abortReason !== "restart") stopping.push({ conversation, user });
        } else if (!child) {
          await this.continueKeptInputs(conversation, user);
        }
        configured.add(conversation.id);
      }
      if (!child) routes.push(await this.attachSubmission(conversation, submission, user, true));
    }
    this.harness.resume();
    for (const { conversation, user } of stopping) {
      void this.mutateConversation(conversation.id, async () => {
        await conversation.waitForIdle(context);
        await this.continueKeptInputs(conversation, user);
      }).catch(() => { /* The persisted inbox can be recovered on the next open. */ });
    }
    for (const wait of routes) void wait().catch(() => { /* Settlement already notified the owning subscribers. */ });
    void this.recoverChildDigests(map).catch((error: unknown) => {
      logError("Could not recover Durable background digests", error, { agentId: this.agent.id });
    });
  }

  private async recoverChildDigests(map: MainIdentityMap | undefined) {
    for (const [key, child] of Object.entries(map?.children ?? {})) {
      const main = map?.conversations[`main:${child.owner}`] as ConversationId | undefined;
      const record = await this.harness.commit(async (tx) => {
        if (main !== undefined && await tx.submissionByRequest(main, key)) return;
        return tx.submissionByRequest(child.id, key);
      }, context);
      if (!record) continue;
      const conversation = await this.harness.conversation(child.id, context);
      const submission = await this.harness.submission(record.id, context);
      if (!conversation || !submission) continue;
      void this.waitForChild(conversation, submission, child.owner).catch(() => { /* Failures are digested. */ });
    }
  }

  private async attachSubmission(
    conversation: Conversation, submission: Submission, user: string, notify: boolean,
    onEvent?: (event: StreamEvent) => void,
  ) {
    let streamed = "";
    let streamedTask: TaskId | undefined;
    let readThrough: EntryId | undefined;
    let replyChanged = false;
    const publishMain = notify && !this.threadIds.has(conversation.id);
    const watch = publishMain ? await conversation.watch(context) : undefined;
    let acceptingPartials = true;
    const emitText = (taskId: TaskId | undefined, text: string) => {
      if (streamedTask !== taskId) {
        streamedTask = taskId;
        streamed = "";
      }
      if (!text.startsWith(streamed)) return false;
      const delta = text.slice(streamed.length);
      if (delta) {
        onEvent?.({ type: "text", data: delta });
        streamed = text;
      }
      return true;
    };
    const onView = async (view: ConversationView) => {
      const observed = observeFeed(view);
      const { live } = observed;
      const turn = await this.activeTurn(conversation, observed);
      if (!turn || !acceptingPartials) return;
      if (onEvent && !replyChanged && live?.run?.inputs.includes(submission.id)) {
        const after = readThrough ?? (await submission.status(context)).entry;
        const { through } = observed;
        if (!acceptingPartials) return;
        readThrough = after;
        if (after !== undefined && through !== null && through > after) {
          const rounds = await this.feed.replyRounds(conversation, after, through);
          if (!acceptingPartials) return;
          for (const { taskId, text } of rounds) replyChanged ||= !emitText(taskId, text);
          readThrough = through;
        }
        if (!acceptingPartials) return;
        if (!replyChanged) emitText(live.run.taskId, turn.text);
      }
      this.publish(user, turn);
    };
    if (watch) {
      await onView(watch.value);
      watch.start(async (call) => {
        if (call.kind === "value") await onView(call.value);
      });
    }
    return async () => {
      let answeredBy: TaskId | undefined;
      try {
        const { response, answerTask, inputEntry, answerEntry } = await this.settle(conversation, submission);
        answeredBy = answerTask;
        acceptingPartials = false;
        await watch?.stop();
        // A watch can coalesce commits or stop before it delivers the last change.
        // Finish any stored rounds before acknowledging the submission.
        if (response.meta.aborted) {
          onEvent?.({ type: "done", meta: response.meta });
          return response;
        }
        const after = readThrough ?? inputEntry;
        if (notify && onEvent && !replyChanged && after !== undefined && answerEntry !== undefined && after < answerEntry) {
          const rounds = await this.feed.replyRounds(conversation, after, answerEntry);
          for (const { taskId, text } of rounds) replyChanged ||= !emitText(taskId, text);
        }
        const text = response.payloads[0]?.text ?? "";
        if (!replyChanged && emitText(answerTask, text)) {
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
        this.options.wakeDelivery?.();
        if (publishMain) void this.publishSettlement(conversation, user, answeredBy).catch(() => { /* The harness may be closing. */ });
      }
    };
  }

  private async publishSettlement(conversation: Conversation, user: string, answeredBy?: TaskId) {
    if (answeredBy !== undefined) {
      const run = (await this.harness.snapshot(LiveDoc, conversation.id, context))?.run;
      // The answer is available before after-run tasks release the live turn.
      if (run?.afterRun && run.taskId === answeredBy) await this.harness.waitForTask(answeredBy, context);
    }
    this.publish(user, { type: "history_updated", agentId: this.agent.id, sessionId: DURABLE_MAIN_SESSION_ID });
  }

  private async effectiveSettlement(conversation: Conversation, original: Awaited<ReturnType<Submission["wait"]>>, wait: boolean) {
    if (original.status !== "unanswered" || original.type !== "input" || original.reason !== "model_error") return original;
    const fallback = await settleFallback(this.harness, conversation, original.id, this.agent.id, wait, this.threadIds.get(conversation.id));
    return fallback === "waiting" ? undefined : fallback ?? original;
  }

  private async publicAnswer(conversation: Conversation, id: EntryId) {
    const answer = await conversation.commit((tx) => tx.entry(id), context);
    const review = await this.harness.snapshot(ReviewDoc, conversation.id, context);
    const decision = answer?.byTaskId === undefined ? undefined : review?.byTask[answer.byTaskId];
    const assistant = answer?.model?.find((item) => item.role === "assistant");
    if (!assistant || (decision?.state !== "stream" &&
        !(decision?.state === "approved" && decision.digest === draftDigest(assistant.content)))) return;
    const text = assistant.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    return { task: answer?.byTaskId, text, timestamp: decision.answeredAt ?? assistant.timestamp };
  }

  private async settle(conversation: Conversation, submission: Submission): Promise<{
    response: RunAgentResult; answerTask?: TaskId; inputEntry?: EntryId; answerEntry?: EntryId;
  }> {
    const original = await submission.wait(context);
    const result = await this.effectiveSettlement(conversation, original, true) ?? original;
    if (result.status === "unanswered") {
      await this.writeChildDigest(conversation.id, result.reason === "aborted" ? "aborted" : "unanswered");
      if (result.reason === "aborted") {
        return { response: { payloads: [], meta: { durationMs: 0, sessionId: this.sessionRef(conversation.id), aborted: true } } };
      }
      throw new Error(await this.recordFailure(conversation, submission.id, result));
    }
    if (result.status !== "done" || result.type === "write" || original.entry === undefined) {
      throw new Error("Yoplai could not complete the turn.");
    }
    const input = await conversation.commit((tx) => tx.entry(original.entry!), context);
    const answer = await this.publicAnswer(conversation, result.answer);
    await this.writeChildDigest(conversation.id, "done", answer?.text ?? WITHHELD_REPLY);
    if (!answer) throw new Error(WITHHELD_REPLY);
    const { text } = answer;
    return {
      answerTask: answer.task,
      inputEntry: original.entry,
      answerEntry: result.answer,
      response: {
        payloads: text ? [{ text }] : [],
        meta: {
          durationMs: InputEntry.is(input) || ChildInputEntry.is(input) ? Math.max(0, answer.timestamp - input.data.timestamp) : 0,
          sessionId: this.sessionRef(conversation.id),
        },
      },
    };
  }

  private async recordFailure(conversation: Conversation, submissionId: SubmissionId, result: Extract<SettledSubmissionRecord, { status: "unanswered" }>) {
    const kind = result.reason === "no_model" ||
      (result.reason === "model_error" && typeof result.detail === "string" && result.detail.startsWith("Provider is not configured:"))
      ? "provider_not_configured"
      : durableFailureKind(result.detail);
    // These legacy notices describe input removal or admin notifications.
    const durableKind = kind === "safety_refusal" || kind === "quota" ? "generic" : kind;
    const accessError = result.reason === "model_error" &&
      typeof result.detail === "string" && isSafeModelAccessError(result.detail) ? result.detail : undefined;
    const requestId = "failed:" + submissionId;
    const recorded = await conversation.commit(async (tx) => {
      if (await tx.submissionByRequest(conversation.id, requestId)) return false;
      const phrase = durableKind === "provider_not_configured" ? "model provider not configured" : "model error";
      await conversation.submit(tx, {
        type: "write",
        requestId,
        entry: {
          kind: FailureNoteEntry.kind,
          data: { submissionId, kind: durableKind, ...(accessError && { accessError }) },
          model: [{ role: "user", content: `[previous reply failed: ${phrase}]`, timestamp: Date.now() }],
        },
      });
      return true;
    }, context);
    if (recorded) {
      logWarn("Durable turn failed", {
        agentId: this.agent.id, conversationId: conversation.id, submissionId,
        reason: result.reason, kind: durableKind,
      });
    }
    return accessError ?? runFailureMessage(durableKind, this.agent.language ?? "en");
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
          const turn = await this.activeTurn(conversation, observeFeed(watch.value));
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
    conversation: Conversation,
    observed: ReturnType<typeof observeFeed>,
    projection?: Awaited<ReturnType<DurableFeed["read"]>>,
  ): Promise<WsActiveTurnSnapshot | null> {
    const { live } = observed;
    if (!live?.run) return null;
    const id = live.run.first;
    const first = id === undefined ? undefined : (await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, context)).items[0];
    const partial = live.generation?.message;
    const timestamp = InputEntry.is(first) ? first.data.timestamp : partial?.timestamp ?? Date.now();
    const projected = await this.feed.live(conversation, observed, projection);
    if (!projected) return null;
    const attachedViews = projected.toolCalls.flatMap(({ id, parentToolCallId, name, view, status }) =>
      parentToolCallId && view && status === "done" ? [{ id, parentToolCallId, name, view, content: "", isError: false }] : []);
    return {
      type: "active_turn", agentId: this.agent.id, sessionId: DURABLE_MAIN_SESSION_ID,
      runId: projected.runId,
      userText: null, userTimestamp: timestamp, startedAt: timestamp,
      text: projected.text, thinking: projected.reasoning.join(""),
      toolCalls: projected.toolCalls.map(({ id, name, arguments: args, parentToolCallId, status, view }) => (
        { id, name, arguments: args, parentToolCallId, status, view }
      )),
      ...(attachedViews.length ? { toolResults: attachedViews } : {}),
    };
  }

  async mayReadFeed(owner: string, principal: string) {
    if (principal !== owner) return false;
    const agent = getAgent(this.agent.id);
    try {
      if (!await durableModeFor(principal === "local" ? undefined : principal, agent)) return false;
      await requireActorExecution(this.agent.id, loadConfig(), principal);
      return true;
    } catch {
      return false;
    }
  }

  private async mainFor(owner: string) {
    const id = await this.mainId(owner);
    return id === undefined ? undefined : this.harness.conversation(id, context);
  }

  async stop(principal: string, runId?: string, threadId?: string): Promise<DurableStopResult | { forbidden: true }> {
    const conversation = await this.feedConversation(principal, threadId);
    if (!conversation) {
      return await this.mayReadFeed(principal, principal) ? { status: "already_finished" } : { forbidden: true };
    }
    const id = conversation.id;
    return this.mutateConversation(id, async () => {
      if (!await this.mayReadFeed(principal, principal)) return { forbidden: true };
      const run = (await this.harness.snapshot(LiveDoc, id, context))?.run;
      if (!run || (runId !== undefined && runId !== await runIdFor(this.harness, conversation, run))) {
        return { status: "already_finished" };
      }
      await conversation.abort(context);
      await this.continueKeptInputs(conversation, principal);
      return { status: "stopped" };
    });
  }

  private async feedConversation(owner: string, threadId?: string) {
    return threadId === undefined ? this.mainFor(owner) : this.threadConversation(await this.requireThread(owner, threadId));
  }

  async feedWindow(owner: string, principal: string, limit: number, selector?: FeedSelector, threadId?: string) {
    if (!await this.mayReadFeed(owner, principal)) return { forbidden: true as const };
    const conversation = await this.feedConversation(owner, threadId);
    return { window: conversation ? await this.feed.window(conversation, limit, selector) : selector ? undefined : emptyFeedWindow };
  }

  private async waitForMain(owner: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const waiters = this.mainWaiters.get(owner) ?? new Set();
    this.mainWaiters.set(owner, waiters);
    return new Promise<ConversationId>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        if (waiters.delete(opened) && !waiters.size) this.mainWaiters.delete(owner);
      };
      const fail = (error: unknown) => { cleanup(); reject(error); };
      const abort = () => fail(signal.reason);
      const opened = (id: ConversationId) => { cleanup(); resolve(id); };
      waiters.add(opened);
      signal.addEventListener("abort", abort, { once: true });
      // Subscribe before reading again so a concurrent first send cannot be missed.
      void this.mainId(owner).then((id) => { if (id !== undefined) opened(id); }, fail);
    });
  }

  async watchFeed(
    owner: string, principal: string, limit: number, signal: AbortSignal,
    publish: (window: FeedWindow, snapshot: boolean) => void,
  ): Promise<"forbidden" | "unavailable"> {
    if (!await this.mayReadFeed(owner, principal)) return "forbidden";
    signal.throwIfAborted();
    let conversation = await this.mainFor(owner);
    if (!conversation) {
      publish(emptyFeedWindow, true);
      conversation = await this.harness.conversation(await this.waitForMain(owner, signal), context);
    }
    if (!conversation) return "unavailable";
    const main = conversation;
    const watch = await main.watch(withAbortSignal(signal, context));
    let latest: ConversationView | undefined = watch.value;
    let refresh = Promise.resolve();
    const read = async (value: ConversationView | undefined, snapshot: boolean) => {
      const window = await this.feed.window(main, limit, undefined, value && observeFeed(value));
      if (window && !signal.aborted) publish(window, snapshot);
    };
    const queueRead = (snapshot: boolean) => {
      const next = refresh.then(() => read(latest, snapshot));
      refresh = next.catch(() => { /* The feed or harness may be closing. */ });
      return next;
    };
    const listeners = this.feedListeners.get(main.id) ?? new Set<() => void>();
    this.feedListeners.set(main.id, listeners);
    const changed = () => { void queueRead(false).catch(() => undefined); };
    listeners.add(changed);
    try {
      await queueRead(true);
      watch.start(async (call) => {
        latest = call.kind === "value" ? call.value : undefined;
        await queueRead(call.kind === "failed");
      });
      await watch.closed;
      return "unavailable";
    } finally {
      listeners.delete(changed);
      if (!listeners.size) this.feedListeners.delete(main.id);
      await watch.stop();
    }
  }

  private async historyAudience(caller: ConversationId) {
    const owner = this.owners.get(caller);
    if (owner === undefined || !await this.mayReadFeed(owner, owner)) return [];
    const main = await this.mainFor(owner);
    const threads = await this.threadsFor(owner);
    const audience: ReadableConversation[] = [{
      ref: DURABLE_MAIN_SESSION_ID,
      current: main?.id === caller,
      read: async () => main ? this.feed.read(main) : { records: [] },
    }];
    for (const [id, record] of Object.entries(threads)) {
      audience.push({
        ref: threadRef(id),
        current: record.conversationId === caller,
        thread: { id, record },
        read: async () => this.feed.read(await this.threadConversation(record)),
      });
    }
    return audience;
  }

  private async sessionHistory(caller: ConversationId, args: unknown) {
    return durableSessionHistory(args, await this.historyAudience(caller));
  }
  async feedSearch(owner: string, principal: string, query: string, limit: number, threadId?: string) {
    if (!await this.mayReadFeed(owner, principal)) return { forbidden: true as const };
    const conversation = await this.feedConversation(owner, threadId);
    return { hits: conversation && query.trim() ? feedSearch((await this.feed.read(conversation)).records, query, limit) : [] };
  }

  async feedDetail(owner: string, principal: string, id: string, threadId?: string) {
    if (!await this.mayReadFeed(owner, principal)) return { forbidden: true as const };
    const conversation = await this.feedConversation(owner, threadId);
    const anchor = entryId(id);
    if (!conversation || anchor === undefined) return { detail: undefined };
    const { records } = await this.feed.read(conversation, { id: anchor, limit: 1 });
    return { detail: feedDetail(records, id) };
  }

  async history(user: string, view: HistoryViewMode, limit?: number, before?: string) {
    const id = await this.mainId(user);
    const conversation = id === undefined ? undefined : await this.harness.conversation(id, context);
    if (!conversation) return { messages: [], view };
    const observed = await this.feed.observe(conversation);
    const projection = await this.feed.read(conversation, undefined, observed);
    const full = projection.records.flatMap((record) => record.kind === "seam" ? [] : [record.message]);
    if (!full.length) return { messages: [], view };
    const activeTurn = await this.activeTurn(conversation, observed, projection);
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
      activeContextUsage: projection.contextUsage,
      sessionId: DURABLE_MAIN_SESSION_ID,
      view,
      isStreaming: activeTurn !== null,
      activeTurn,
    };
  }

  async close(): Promise<void> {
    this.keeper.close();
    try {
      await this.harness.close(context);
    } finally {
      this.review.close();
      await this.sandbox.close();
    }
  }
}

function userMemoryKey(owner: string | undefined) {
  return owner === undefined ? undefined : "user:" + owner;
}
