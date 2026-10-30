import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  REASON_TYPES,
  lint,
  listOpenPlans,
  nudgeText,
  rulesText,
  type Limits,
  type LintResult,
  type ReplyMode,
} from "human-chat";
import type { AgentConfig, Extension, ExtensionRunInfo, StreamEvent } from "@yoplai/shared";
import type { HistoryEvent } from "../sdk/types.js";
import { logWarn } from "../logging.js";
import { isNoReply } from "../agents/no-reply.js";

type RunParams = ExtensionRunInfo;

const HUMAN_SOURCES = new Set(["web", "telegram", "discord", "slack", "mattermost", "irc"]);

const key = (agentId: string, sessionId: string) => `${agentId}\0${sessionId}`;
/** The shaped turn that runs now, by agent + session. Holds the declaration of `reply_mode`. */
const active = new Map<string, ShapedTurn>();

/** An interactive human turn. Allowlist: no known source means skip. */
export function isHumanTurn(run?: RunParams): boolean {
  return (
    HUMAN_SOURCES.has(run?.source ?? "") &&
    run?.sender?.kind !== "agent" &&
    !run?.background &&
    !run?.sessionId?.startsWith("compact:")
  );
}

function shapeConfig(agent: AgentConfig): Record<string, unknown> | undefined {
  const extensions = agent.extensions as Record<string, unknown> | undefined;
  if (!extensions || !("human-chat" in extensions)) return undefined;
  // A bare `human-chat:` key is null: on, with no options.
  const config = (extensions["human-chat"] ?? {}) as Record<string, unknown>;
  return config.enabled === false ? undefined : config;
}

/** Reads the limit keys. The core drops missing or invalid values and fills its defaults. */
export function limitsFromConfig(config: Record<string, unknown>): Partial<Limits> {
  return {
    maxSentences: config.max_sentences as number | undefined,
    sentenceLeeway: config.sentence_leeway as number | undefined,
    maxSentenceWords: config.max_sentence_words as number | undefined,
    wordLeeway: config.word_leeway as number | undefined,
  };
}

/** True when the agent has the adapter on, for any turn. */
export function humanChatEnabled(agent: AgentConfig): boolean {
  return shapeConfig(agent) !== undefined;
}

/** True while a shaped turn of the session runs: its draft must not leave the gateway. */
export function isShapingSession(agentId: string, sessionId: string): boolean {
  return active.has(key(agentId, sessionId));
}

export const humanChatExtension: Extension = {
  id: "human-chat",
  displayName: "Human chat",
  description: "Short-turn chat replies, enforced by a linter.",
  dependencies: [],
  factory: true,
  routePrefixes: [],
  configSchema: z.object({ log: z.string().optional() }),
  validateConfig: () => ({ valid: true, errors: [] }),
  registerRoutes: () => {},
  async start() {},
  async stop() {},
  capabilities: () => [],
  getSystemPromptContributions(agent, hook) {
    const config = shapeConfig(agent);
    return config && isHumanTurn(hook?.run) ? rulesText(limitsFromConfig(config)) : undefined;
  },
  getAgentTools(agent, hook) {
    // The host looks up the tool for `execution` after the model called it, so the turn was human then.
    if (!shapeConfig(agent) || (!hook?.execution && !isHumanTurn(hook?.run))) return [];
    return [
      {
        name: "reply_mode",
        description:
          "Declare long mode for the current reply when it needs more than 1-5 sentences. Applies to this turn only.",
        parameters: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["long"] },
            type: { type: "string", enum: [...REASON_TYPES] },
            note: { type: "string", description: "Short reason, for the log" },
          },
          required: ["mode", "type", "note"],
        },
        execute(raw, context) {
          const { mode, type, note } = (raw ?? {}) as Record<string, unknown>;
          if (mode !== "long" || !(REASON_TYPES as readonly unknown[]).includes(type)) {
            throw new Error(`Invalid reply_mode. mode must be "long"; type must be one of: ${REASON_TYPES.join(", ")}`);
          }
          if (typeof note !== "string" || note.trim().split(/\s+/).filter(Boolean).length < 3) {
            throw new Error("Invalid reply_mode. note must be a short reason of at least 3 words.");
          }
          active.get(key(agent.id, context.sessionId ?? ""))?.declare({
            mode: "long",
            type: type as (typeof REASON_TYPES)[number],
            note,
          });
          return "Long mode on for this reply.";
        },
      },
    ];
  },
};

/** `/topics`: open topics of the plans in `<workspace>/topics/`; no model call. */
export function topicsReply(workspaceDir: string): string {
  let plans: ReturnType<typeof listOpenPlans> = [];
  try {
    plans = listOpenPlans(path.join(workspaceDir, "topics"), 7);
  } catch {
    // no topics directory yet
  }
  if (!plans.length) return "No open topics.";
  return plans
    .flatMap((plan) => [plan.title, ...plan.open.map((topic, i) => `${i === 0 ? ">" : " "} ${topic}`)])
    .join("\n");
}

/** Holds, lints, and logs one human turn. Undefined (= adapter off) when the agent or the turn does not qualify. */
export function startShapedTurn(
  agent: AgentConfig,
  params: RunParams,
  sessionId: string,
  workspaceDir: string
): ShapedTurn | undefined {
  const config = shapeConfig(agent);
  if (!config) return undefined;
  if (!isHumanTurn({ ...params, sessionId })) return undefined;
  const log = typeof config.log === "string" ? config.log : path.join(workspaceDir, "data", "human-chat", "long-mode.jsonl");
  return new ShapedTurn(agent.id, sessionId, log, limitsFromConfig(config));
}

export class ShapedTurn {
  readonly nudge: string;
  private segments: string[] = [""];
  private held: HistoryEvent[] = [];
  private rewriting = false;
  private declaration: ReplyMode | undefined;

  constructor(
    private readonly agentId: string,
    private readonly sessionId: string,
    private readonly logPath: string,
    private readonly limits: Partial<Limits> = {}
  ) {
    this.nudge = nudgeText(limits);
  }

  /** Start the turn: from now until `end()` its state is the only turn state of the session. */
  begin(): void {
    active.set(key(this.agentId, this.sessionId), this);
  }

  declare(mode: ReplyMode): void {
    this.declaration = mode;
  }

  /** Returns true when the event is held. Tool events pass through and start a new text segment. */
  holdEvent(event: StreamEvent): boolean {
    if (event.type === "text") {
      this.segments[this.segments.length - 1] += event.data;
      return true;
    }
    if (event.type.startsWith("tool_") && this.segments[this.segments.length - 1]) this.segments.push("");
    return false;
  }

  /** History is held so a failed draft never reaches the stored chat. */
  holdHistory(event: HistoryEvent): void {
    if (this.rewriting && ["user", "system_prompt", "system_context"].includes(event.type)) return;
    this.held.push(event);
  }

  release(): HistoryEvent[] {
    const events = this.held;
    this.held = [];
    return events;
  }

  lint(): LintResult {
    const text = this.segments.filter((s) => s && !isNoReply(s)).join("\n\n");
    return lint(text, { mode: this.declaration ?? { mode: "short" }, limits: this.limits });
  }

  /** Drop the draft (text and stored history). The rewrite run starts clean. */
  startRewrite(): void {
    this.rewriting = true;
    this.segments = [""];
    this.held = this.held.filter((e) => e.type !== "assistant_text");
  }

  flushText(emit: (event: StreamEvent) => void): void {
    const text = this.segments.filter((s) => s && !isNoReply(s)).join("\n\n");
    this.segments = [""];
    if (text) emit({ type: "text", data: text });
  }

  async log(result: LintResult): Promise<void> {
    const base = { ts: new Date().toISOString(), agent: this.agentId, session: this.sessionId };
    let line: Record<string, unknown> | undefined;
    if (!result.ok && this.rewriting) {
      line = { ...base, event: "rewrite_failed", rules: result.violations.map((v) => v.rule) };
    } else if (result.ok && result.mode.mode === "long") {
      line = { ...base, type: result.mode.type, note: result.mode.note, words: result.stats.words };
    }
    if (!line) return;
    try {
      await fs.mkdir(path.dirname(this.logPath), { recursive: true });
      await fs.appendFile(this.logPath, `${JSON.stringify(line)}\n`);
    } catch (error) {
      logWarn("[human-chat] log write failed", { agentId: this.agentId, error: String(error) });
    }
  }

  end(): void {
    this.declaration = undefined;
    if (active.get(key(this.agentId, this.sessionId)) === this) active.delete(key(this.agentId, this.sessionId));
  }
}
