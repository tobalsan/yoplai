import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  NUDGE_TEXT,
  REASON_TYPES,
  RULES_TEXT,
  lint,
  listOpenPlans,
  type LintResult,
  type ReplyMode,
} from "chat-shape";
import type { AgentConfig, Extension, StreamEvent } from "@yoplai/shared";
import type { HistoryEvent } from "../sdk/types.js";
import { logWarn } from "../logging.js";
import { isNoReply } from "../agents/no-reply.js";

type RunParams = { source?: string; sender?: { kind: string }; background?: boolean };

const HUMAN_SOURCES = new Set(["web", "telegram", "discord", "slack", "mattermost", "irc"]);

/** Declarations of `reply_mode`, for the current turn only. Key: agent + session. */
const declared = new Map<string, ReplyMode>();
const key = (agentId: string, sessionId: string) => `${agentId}\0${sessionId}`;

function shapeConfig(agent: AgentConfig): Record<string, unknown> | undefined {
  const value = (agent.extensions as Record<string, unknown> | undefined)?.["chat-shape"];
  if (value === undefined || value === null) return undefined;
  const config = value as Record<string, unknown>;
  return config.enabled === false ? undefined : config;
}

export const chatShapeExtension: Extension = {
  id: "chat-shape",
  displayName: "Chat shape",
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
  getSystemPromptContributions: (agent) => (shapeConfig(agent) ? RULES_TEXT : undefined),
  getAgentTools(agent) {
    if (!shapeConfig(agent)) return [];
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
          declared.set(key(agent.id, context.sessionId ?? ""), {
            mode: "long",
            type: type as (typeof REASON_TYPES)[number],
            note: String(note ?? ""),
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
  const human =
    HUMAN_SOURCES.has(params.source ?? "") &&
    params.sender?.kind !== "agent" &&
    !params.background &&
    !sessionId.startsWith("compact:");
  if (!human) return undefined;
  const log = typeof config.log === "string" ? config.log : path.join(workspaceDir, "data", "chat-shape", "long-mode.jsonl");
  return new ShapedTurn(agent.id, sessionId, log);
}

export class ShapedTurn {
  readonly nudge = NUDGE_TEXT;
  private segments: string[] = [""];
  private held: HistoryEvent[] = [];
  private rewriting = false;

  constructor(
    private readonly agentId: string,
    private readonly sessionId: string,
    private readonly logPath: string
  ) {}

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
    return lint(text, { mode: declared.get(key(this.agentId, this.sessionId)) ?? { mode: "short" } });
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
      logWarn("[chat-shape] log write failed", { agentId: this.agentId, error: String(error) });
    }
  }

  end(): void {
    declared.delete(key(this.agentId, this.sessionId));
  }
}
