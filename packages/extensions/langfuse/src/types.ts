import type { ModelUsage } from "@yoplai/shared";
import type {
  LangfuseGenerationClient,
  LangfuseSpanClient,
  LangfuseTraceClient,
} from "langfuse";

export type SpanState = {
  span: LangfuseSpanClient;
  id: string;
  name: string;
  input: unknown;
  startedAt: number;
};

export type GenerationState = {
  generation: LangfuseGenerationClient;
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
  trace: LangfuseTraceClient;
  currentGeneration?: GenerationState;
  pendingUserInput?: string;
  pendingSystemPrompt?: string;
  output: string[];
  lastActivity: number;
};
