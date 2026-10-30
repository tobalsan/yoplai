import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { REASON_TYPES, lint, listOpenPlans, nudgeText, rulesText, type Limits, type LintResult, type ReplyMode } from "human-chat";
import { isNoReply, type AgentConfig, type Extension, type ExtensionReplyReviewer, type ExtensionReplyReviewVerdict, type ExtensionRunInfo } from "@yoplai/shared";

const HUMAN_SOURCES = new Set(["web", "telegram", "discord", "slack", "mattermost", "irc"]);
const key = (agentId: string, sessionId: string) => `${agentId}\0${sessionId}`;
const active = new Map<string, HumanChatReviewer>();

function isHumanTurn(run?: ExtensionRunInfo): boolean {
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
  const config = (extensions["human-chat"] ?? {}) as Record<string, unknown>;
  return config.enabled === false ? undefined : config;
}

function limitsFromConfig(config: Record<string, unknown>): Partial<Limits> {
  return {
    maxSentences: config.max_sentences as number | undefined,
    sentenceLeeway: config.sentence_leeway as number | undefined,
    maxSentenceWords: config.max_sentence_words as number | undefined,
    wordLeeway: config.word_leeway as number | undefined,
  };
}

function topicsReply(workspaceDir: string): string {
  let plans: ReturnType<typeof listOpenPlans> = [];
  try {
    plans = listOpenPlans(path.join(workspaceDir, "topics"), 7);
  } catch {
    // No topics directory yet.
  }
  if (!plans.length) return "No open topics.";
  return plans
    .flatMap((plan) => [plan.title, ...plan.open.map((topic, i) => `${i === 0 ? ">" : " "} ${topic}`)])
    .join("\n");
}

class HumanChatReviewer implements ExtensionReplyReviewer {
  readonly nudge: string;
  private declaration: ReplyMode | undefined;
  private result: LintResult | undefined;

  constructor(
    private readonly agentId: string,
    private readonly sessionId: string,
    private readonly logPath: string,
    private readonly limits: Partial<Limits>
  ) {
    this.nudge = nudgeText(limits);
  }

  begin(): void {
    active.set(key(this.agentId, this.sessionId), this);
  }

  declare(mode: ReplyMode): void {
    this.declaration = mode;
  }

  review(draft: string) {
    if (isNoReply(draft)) {
      this.result = undefined;
      return { ok: true } as const;
    }
    const result = lint(draft, { mode: this.declaration ?? { mode: "short" }, limits: this.limits });
    this.result = result;
    return result.ok ? { ok: true } as const : { ok: false, rewriteHint: result.hint } as const;
  }

  async done(verdict: ExtensionReplyReviewVerdict, info: { rewritten: boolean }): Promise<void> {
    const result = this.result;
    if (!result) return;
    const base = { ts: new Date().toISOString(), agent: this.agentId, session: this.sessionId };
    let line: Record<string, unknown> | undefined;
    if (!verdict.ok && info.rewritten) {
      line = { ...base, event: "rewrite_failed", rules: result.violations.map((violation) => violation.rule) };
    } else if (verdict.ok && result.mode.mode === "long") {
      line = { ...base, type: result.mode.type, note: result.mode.note, words: result.stats.words };
    }
    if (!line) return;
    try {
      await fs.mkdir(path.dirname(this.logPath), { recursive: true });
      await fs.appendFile(this.logPath, `${JSON.stringify(line)}\n`);
    } catch (error) {
      console.warn("[human-chat] log write failed", { agentId: this.agentId, error: String(error) });
    }
  }

  end(): void {
    this.declaration = undefined;
    this.result = undefined;
    if (active.get(key(this.agentId, this.sessionId)) === this) active.delete(key(this.agentId, this.sessionId));
  }
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
  getChatCommands(agent, context) {
    if (!shapeConfig(agent) || !isHumanTurn({ ...context.run, sessionId: context.sessionId })) return [];
    return [{ command: "/topics", run: ({ workspaceDir }) => topicsReply(workspaceDir) }];
  },
  reviewsReplies: (agent) => shapeConfig(agent) !== undefined,
  getReplyReviewer(agent, context) {
    const config = shapeConfig(agent);
    if (!config || !isHumanTurn({ ...context.run, sessionId: context.sessionId })) return undefined;
    const log = typeof config.log === "string" ? config.log : path.join(context.workspaceDir, "data", "human-chat", "long-mode.jsonl");
    return new HumanChatReviewer(agent.id, context.sessionId, log, limitsFromConfig(config));
  },
  getSystemPromptContributions(agent, hook) {
    const config = shapeConfig(agent);
    return config && isHumanTurn(hook?.run) ? rulesText(limitsFromConfig(config)) : undefined;
  },
  getAgentTools(agent, hook) {
    if (!shapeConfig(agent) || (!hook?.execution && !isHumanTurn(hook?.run))) return [];
    return [{
      name: "reply_mode",
      core: true,
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
    }];
  },
};
