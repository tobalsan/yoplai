import type { ModelUsage } from "@yoplai/shared";
import type {
  LangfuseGeneration,
  LangfuseSpan,
  LangfuseTool,
} from "@langfuse/tracing";

export type SpanState = {
  span: LangfuseTool;
  id: string;
  name: string;
  input: unknown;
  startedAt: number;
};

export type GenerationState = {
  generation: LangfuseGeneration;
  openSpans: Map<string, SpanState>;
  output: string[];
  thinking: string[];
  metadata?: Record<string, unknown>;
  systemPrompt?: string;
  model?: string;
  provider?: string;
  usage?: ModelUsage;
  stopReason?: string;
  userInput?: string;
  status?: "success" | "error";
};

export type TraceState = {
  /** Root observation; represents the Langfuse trace. */
  trace: LangfuseSpan;
  traceName: string;
  /** `yoplai:<surface>:<agentId>:<rawSessionId>`; propagated to every observation. */
  sessionId: string;
  userId?: string;
  tags?: string[];
  /** String-only trace metadata propagated to every observation. */
  propagatedMetadata: Record<string, string>;
  currentGeneration?: GenerationState;
  pendingUserInput?: string;
  pendingSystemPrompt?: string;
  output: string[];
  lastActivity: number;
};
