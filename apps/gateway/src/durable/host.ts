import fs from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry, configure, createRegistry, Harness, LiveDoc,
  type AgentChange, type Conversation, type ConversationId, type ConversationView, type Cursor, type EntryRecord, type LiveState, type Submission, ToolResultEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { resolveSystemFiles } from "@yoplai/shared/node/system-files";
import {
  classifyRunFailure, DURABLE_MAIN_SESSION_ID, runFailureMessage, type AgentConfig, type FullHistoryMessage,
  type HistoryViewMode, type RunAgentResult, type SimpleHistoryMessage, type StreamEvent, type WsActiveTurnSnapshot, type WsServerMessage,
} from "@yoplai/shared";
import { resolveWorkspaceDir } from "../config/index.js";
import { messageText } from "../history/condense.js";
import { activeContextUsage, historyPage } from "../history/page.js";
import { logWarn } from "../logging.js";
import { createDurableModels, type DurableModelsFactory } from "./models.js";

import type { WebSender } from "./contract.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { createReplyReview, draftDigest, WITHHELD_REPLY } from "./review.js";
import { FailureNoteEntry, InputEntry, MainMap, ReviewDoc } from "./state.js";

const context = BACKGROUND_CONTEXT;
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
    private readonly configuration: AgentChange,
    private readonly review: ReturnType<typeof createReplyReview>,
    private readonly afterMainCommit?: DurableHostOptions["afterMainCommit"],
  ) {}

  static async open(home: string, agent: AgentConfig, runtime: ExtensionRuntime, options: DurableHostOptions) {
    const provider = agent.model.provider;
    if (!provider) throw new Error("Durable requires model.provider to be set.");
    const workspaceDir = resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace);
    const files = await resolveSystemFiles({
      workspaceDir,
      systemFiles: agent.system_files,
    });
    const instructions = [
      ...files.map(({ content }) => content),
      "User messages carry a [from <name> via web] header.",
    ].join("\n\n");
    const models = (options.createModels ?? createDurableModels)(agent);
    const directory = path.join(home, "agents", agent.id, "durable");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const storage = await openNodeSqliteStorage(path.join(directory, "agent.sqlite"));
    const registry = createRegistry();
    let harness: Harness | undefined;
    const review = createReplyReview(agent, workspaceDir, runtime, () => {
      if (!harness) throw new Error("Durable host is not open.");
      return harness;
    });
    registry.install(review.extension);
    try {
      harness = await Harness.open(storage, {
        models,
        registry,
        settings: { compaction: { enabled: false }, steeringMode: "all", followUpMode: "all", retry: { enabled: true } },
      }, context);
      const host = new DurableHost(harness, agent, {
        model: { provider, modelId: agent.model.model }, instructions, extensions: [review.extension],
      }, review, options.afterMainCommit);
      await host.resume();
      return host;
    } catch (error) {
      if (harness) await harness.close(context);
      else await storage.close(context);
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
      await configure(tx, created.id, this.configuration);
      map.conversations[key] = created.id;
      return created.id;
    }, context);
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
      const { submissionId, duplicate } = await conversation.commit(async (tx) => {
        const existing = await tx.submissionByRequest(conversation.id, requestId);
        if (existing) return { submissionId: existing.id, duplicate: true };
        await configure(tx, id, this.configuration);
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

  private async resume() {
    const pending = (await this.harness.inspect(context)).submissions;
    const map = await this.harness.snapshot(MainMap, context);
    const owners = new Map(Object.entries(map?.conversations ?? {}).map(([key, id]) => [id, key.slice("main:".length)]));
    const routes = [];
    const configured = new Set<ConversationId>();
    for (const record of pending) {
      const user = owners.get(record.conversationId);
      if (!user) continue;
      const conversation = await this.harness.conversation(record.conversationId, context);
      const submission = await this.harness.submission(record.id, context);
      if (!conversation || !submission) continue;
      if (!configured.has(conversation.id)) {
        await conversation.configure(this.configuration, context);
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
    const result = await submission.wait(context);
    if (result.status === "unanswered") {
      const kind = result.reason === "no_model" ||
        (result.reason === "model_error" && typeof result.detail === "string" && result.detail.startsWith("Provider is not configured:"))
        ? "provider_not_configured"
        : classifyRunFailure(result.detail);
      // These legacy notices describe input removal or admin notifications.
      const durableKind = kind === "safety_refusal" || kind === "quota" ? "generic" : kind;
      const requestId = "failed:" + submission.id;
      const recorded = await conversation.commit(async (tx) => {
        if (await tx.submissionByRequest(conversation.id, requestId)) return false;
        const phrase = durableKind === "provider_not_configured" ? "model provider not configured" : "model error";
        await conversation.submit(tx, {
          type: "write",
          requestId,
          entry: {
            kind: FailureNoteEntry.kind,
            data: { submissionId: submission.id, kind: durableKind },
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
      throw new Error(runFailureMessage(durableKind, this.agent.language ?? "en"));
    }
    if (result.status !== "done" || result.type !== "input") {
      throw new Error("Yoplai could not complete the turn.");
    }
    const [input, answer] = await conversation.commit(async (tx) => [
      await tx.entry(result.entry),
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
    const review = await this.harness.snapshot(ReviewDoc, conversation.id, context);
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
      entries.push(...page.items);
      for (const entry of page.items) {
        if (InputEntry.is(entry)) {
          full.push({ role: "user", content: [{ type: "text", text: entry.data.text }], timestamp: entry.data.timestamp });
        } else if (FailureNoteEntry.is(entry)) {
          const { kind } = entry.data;
          const note = entry.model?.[0];
          if (!note) continue;
          full.push({
            role: "assistant",
            content: [{ type: "text", text: runFailureMessage(kind, this.agent.language ?? "en") }],
            timestamp: note.timestamp,
            meta: { stopReason: "error", failure: { kind } },
          });
        } else if (AssistantEntry.is(entry) && entry.byTaskId !== undefined) {
          const decision = review?.byTask[entry.byTaskId];
          if (decision?.state !== "stream" && decision?.state !== "approved") continue;
          for (const message of entry.model ?? []) {
            if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
            if (decision.state === "approved" && decision.digest !== draftDigest(message.content)) continue;
            const content = message.content.map((block) => {
              switch (block.type) {
                case "text": return { type: block.type, text: block.text } as const;
                case "thinking": return { type: block.type, thinking: block.thinking } as const;
                case "toolCall": return { type: block.type, id: block.id, name: block.name, arguments: block.arguments } as const;
              }
            });
            for (const block of content) if (block.type === "toolCall") toolCalls.add(block.id);
            full.push({
              role: "assistant", content, timestamp: decision.answeredAt ?? message.timestamp,
              meta: { api: message.api, provider: message.provider, model: message.model, usage: message.usage, stopReason: message.stopReason },
            });
          }
        } else if (ToolResultEntry.is(entry)) {
          for (const message of entry.model ?? []) {
            if (message.role !== "toolResult" || !toolCalls.has(message.toolCallId)) continue;
            full.push({
              role: "toolResult", toolCallId: message.toolCallId, toolName: message.toolName,
              content: message.content.flatMap((block) => block.type === "text" ? [{ type: "text", text: block.text }] : []),
              isError: message.isError, timestamp: message.timestamp,
            });
          }
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
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
    }
  }
}
