import type {
  StreamEvent,
  AgentConfig,
  ThinkLevel,
  AgentContext,
  ContainerDeliveryContext,
  FileAttachment,
  HistoryEvent,
  RequiredModelConfig,
} from "@yoplai/shared";
import type { ExtensionRuntime } from "../extensions/runtime.js";

export type { HistoryEvent } from "@yoplai/shared";

// SDK identifiers
export type SdkId = "pi" | "openclaw";

// SDK capabilities
export type SdkCapabilities = {
  queueWhileStreaming: boolean;
  interrupt: boolean;
  toolEvents: boolean;
  fullHistory: boolean;
};

// Run parameters passed to adapter
export type SdkRunParams = {
  agentId: string;
  agent: AgentConfig;
  userId?: string;
  sessionId: string;
  sessionKey?: string;
  message: string;
  attachments?: FileAttachment[]; // file attachments (paths from upload)
  workspaceDir: string;
  thinkLevel?: ThinkLevel;
  model?: RequiredModelConfig;
  context?: AgentContext; // Structured context (Discord metadata, etc.)
  extensionRuntime?: ExtensionRuntime;
  onEvent: (event: StreamEvent) => void;
  onHistoryEvent: (event: HistoryEvent) => void;
  onSessionHandle?: (handle: unknown) => void;
  abortSignal: AbortSignal;
};

// Run result from adapter
export type SdkRunResult = {
  text: string;
  aborted?: boolean;
};

// SDK adapter interface
export type SdkAdapter = {
  id: SdkId;
  displayName: string;
  capabilities: SdkCapabilities;
  resolveDisplayModel(agent: AgentConfig): {
    provider?: string;
    model?: string;
  };
  run(params: SdkRunParams): Promise<SdkRunResult>;
  queueMessage?: (
    handle: unknown,
    message: string,
    context?: ContainerDeliveryContext
  ) => Promise<void>;
  abort?: (handle: unknown) => void;
};
