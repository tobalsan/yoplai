export type ToolStep = {
  callId: string;
  name: string;
  arguments: unknown;
  result?: { id: string; text: string; isError: boolean };
};

export type TranscriptEntry = {
  /** Stable public identifier of the original transcript entry. */
  id: string;
  role: "user" | "assistant";
  author?: { id?: string; name?: string };
  text: string;
  timestamp?: number;
  toolCalls?: ToolStep[];
};
