import type { AgentMessage } from "@earendil-works/pi-agent-core";

type AssistantMsg = AgentMessage & {
  role: "assistant";
  stopReason?: string;
  content?: Array<{ type: string; id?: string; name?: string }>;
};

/**
 * Repair an orphaned tool-use turn at the tail of the message history.
 *
 * When the gateway is killed mid-run, the Pi session file can end with an
 * assistant message that has stopReason "toolUse" but no corresponding
 * toolResult messages. Sending this to the LLM API is invalid (Anthropic
 * requires tool_result after tool_use).
 *
 * This function detects that condition and appends synthetic toolResult
 * messages so the conversation sequence is valid.
 */
export function repairOrphanedToolCalls(agentSession: {
  agent: { state: { messages: AgentMessage[] } };
  sessionManager?: {
    appendMessage(message: AgentMessage): string;
    branch?(entryId: string): void;
    buildSessionProjection?(): {
      entries: Array<{ sourceEntry: { id: string }; messages: AgentMessage[] }>;
    };
    getBranch?(): Array<{ id: string; type: string }>;
  };
  refreshContext?: () => void;
}): void {
  const messages = agentSession.agent.state.messages;
  if (!messages || messages.length === 0) return;

  // Find the last assistant message
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return;

  const lastAssistant = messages[lastAssistantIdx] as AssistantMsg;

  // Only repair if stopReason is "toolUse"
  if (lastAssistant.stopReason !== "toolUse") return;

  // Check if there are already toolResult messages after this assistant message
  const hasToolResultAfter = messages
    .slice(lastAssistantIdx + 1)
    .some((m) => m.role === "toolResult");
  if (hasToolResultAfter) return;

  // Collect tool call IDs that need synthetic results
  const toolCalls = (lastAssistant.content ?? []).filter(
    (block) => block.type === "toolCall"
  ) as Array<{ id: string; name: string }>;

  if (toolCalls.length === 0) return;

  // Build synthetic toolResult messages
  const syntheticResults: AgentMessage[] = toolCalls.map((tc) => ({
    role: "toolResult",
    toolCallId: tc.id,
    toolName: tc.name,
    content: [
      {
        type: "text",
        text: "[Session interrupted — tool result unavailable. The gateway was restarted while this tool call was pending.]",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  } as AgentMessage));

  // Pi 0.87 derives provider context from SessionManager, not agent state.
  if (agentSession.sessionManager && agentSession.refreshContext) {
    const manager = agentSession.sessionManager;
    if (lastAssistantIdx < messages.length - 1) {
      const projection = manager.buildSessionProjection?.();
      let messageIndex = 0;
      let assistantEntryId: string | undefined;
      for (const entry of projection?.entries ?? []) {
        if (
          messageIndex <= lastAssistantIdx &&
          lastAssistantIdx < messageIndex + entry.messages.length
        ) {
          assistantEntryId = entry.sourceEntry.id;
          break;
        }
        messageIndex += entry.messages.length;
      }
      const branch = manager.getBranch?.();
      const assistantBranchIdx =
        branch?.findIndex((entry) => entry.id === assistantEntryId) ?? -1;
      if (
        !assistantEntryId ||
        !manager.branch ||
        assistantBranchIdx < 0 ||
        branch?.slice(assistantBranchIdx + 1).some((entry) => entry.type !== "message")
      ) {
        throw new Error(
          "Cannot repair orphaned tool calls in canonical session context"
        );
      }
      // Branch at the orphan, preserving the later messages after the missing
      // tool results. The old branch stays in the append-only session history.
      manager.branch(assistantEntryId);
    }
    for (const result of syntheticResults) manager.appendMessage(result);
    for (const message of messages.slice(lastAssistantIdx + 1))
      manager.appendMessage(message);
    agentSession.refreshContext();
    return;
  }

  // Fallback for tests/older SDK shapes, preserving the original repair.
  agentSession.agent.state.messages = [
    ...messages.slice(0, lastAssistantIdx + 1),
    ...syntheticResults,
  ];
}
