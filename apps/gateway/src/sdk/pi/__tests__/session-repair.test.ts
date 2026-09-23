import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { repairOrphanedToolCalls } from "../session-repair.js";

type ToolResultMessage = AgentMessage & {
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

function makeSession(messages: AgentMessage[]) {
  const state = { messages };
  return {
    agent: {
      state,
    },
  };
}

describe("repairOrphanedToolCalls", () => {
  it("no-ops on empty session", () => {
    const session = makeSession([]);
    repairOrphanedToolCalls(session);
    expect(session.agent.state.messages).toHaveLength(0);
  });

  it("no-ops when session has only user messages", () => {
    const session = makeSession([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      } as AgentMessage,
    ]);
    repairOrphanedToolCalls(session);
    expect(session.agent.state.messages).toHaveLength(1);
  });

  it("no-ops when last assistant has stopReason endTurn", () => {
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "hi" }] } as AgentMessage,
      {
        role: "assistant",
        stopReason: "endTurn",
        content: [{ type: "text", text: "Hello!" }],
      } as unknown as AgentMessage,
    ]);
    repairOrphanedToolCalls(session);
    expect(session.agent.state.messages).toHaveLength(2);
  });

  it("no-ops when toolResult already present after toolUse", () => {
    const session = makeSession([
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "tc1", name: "bash" }],
      } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "tc1",
        content: [{ type: "text", text: "output" }],
      } as AgentMessage,
    ]);
    repairOrphanedToolCalls(session);
    expect(session.agent.state.messages).toHaveLength(2);
  });

  it("repairs single orphaned tool call", () => {
    const session = makeSession([
      {
        role: "user",
        content: [{ type: "text", text: "run it" }],
      } as AgentMessage,
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "tc_abc", name: "bash" }],
      } as AgentMessage,
    ]);
    repairOrphanedToolCalls(session);

    const result = session.agent.state.messages;
    expect(result).toHaveLength(3);
    expect(result[2].role).toBe("toolResult");
    expect((result[2] as ToolResultMessage).toolCallId).toBe("tc_abc");
    expect((result[2] as ToolResultMessage).toolName).toBe("bash");
    expect((result[2] as ToolResultMessage).isError).toBe(true);
  });

  it("repairs multiple orphaned tool calls", () => {
    const session = makeSession([
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "tc1", name: "bash" },
          { type: "toolCall", id: "tc2", name: "read" },
        ],
      } as AgentMessage,
    ]);
    repairOrphanedToolCalls(session);

    const result = session.agent.state.messages;
    expect(result).toHaveLength(3);
    expect(result[1].role).toBe("toolResult");
    expect((result[1] as ToolResultMessage).toolCallId).toBe("tc1");
    expect(result[2].role).toBe("toolResult");
    expect((result[2] as ToolResultMessage).toolCallId).toBe("tc2");
    expect((result[1] as ToolResultMessage).isError).toBe(true);
    expect((result[2] as ToolResultMessage).isError).toBe(true);
  });

  it("uses canonical session manager append when available", () => {
    const session = makeSession([
      {
        role: "user",
        content: [{ type: "text", text: "run it" }],
      } as AgentMessage,
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "tc_abc", name: "bash" }],
      } as AgentMessage,
    ]);
    const appendMessage = vi.fn();
    const refreshContext = vi.fn();

    repairOrphanedToolCalls({
      ...session,
      sessionManager: { appendMessage },
      refreshContext,
    });

    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage.mock.calls[0]?.[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "tc_abc",
      toolName: "bash",
      isError: true,
    });
    expect(refreshContext).toHaveBeenCalledTimes(1);
    expect(session.agent.state.messages).toHaveLength(2);
  });

  it("repairs canonical provider context when a later user message exists", () => {
    const manager = SessionManager.inMemory(process.cwd());
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "run it" }],
      timestamp: 1,
    });
    manager.appendMessage({
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "tc_abc", name: "bash", arguments: {} },
      ],
      timestamp: 2,
    } as Parameters<typeof manager.appendMessage>[0]);
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "and then?" }],
      timestamp: 3,
    });
    const state = { messages: manager.buildSessionProjection().messages };
    const refreshContext = () => {
      state.messages = manager.buildSessionProjection().messages;
    };

    repairOrphanedToolCalls({
      agent: { state },
      sessionManager: manager,
      refreshContext,
    });

    const context = manager.buildSessionProjection().messages;
    expect(typeof (context[2] as { timestamp?: number }).timestamp).toBe("number");
    expect(context.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect((context[2] as ToolResultMessage).toolCallId).toBe("tc_abc");
    expect(
      (context[3] as { content: Array<{ text: string }> }).content[0].text
    ).toBe("and then?");
    expect(state.messages).toEqual(context);
  });

  it("fails closed if canonical edits after the orphan cannot be replayed", () => {
    const manager = SessionManager.inMemory(process.cwd());
    const firstUserId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "run it" }],
      timestamp: 1,
    });
    manager.appendMessage({
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "tc_abc", name: "bash", arguments: {} },
      ],
      timestamp: 2,
    } as Parameters<typeof manager.appendMessage>[0]);
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "and then?" }],
      timestamp: 3,
    });
    manager.appendContextEdit(firstUserId, {
      content: [{ type: "text", text: "edited instruction" }],
    });
    const state = { messages: manager.buildSessionProjection().messages };
    const leafBefore = manager.getLeafId();
    const refreshContext = vi.fn();

    expect(() =>
      repairOrphanedToolCalls({ agent: { state }, sessionManager: manager, refreshContext })
    ).toThrow("Cannot repair orphaned tool calls in canonical session context");
    expect(manager.getLeafId()).toBe(leafBefore);
    expect(manager.buildSessionProjection().messages).toEqual(state.messages);
    expect(refreshContext).not.toHaveBeenCalled();
  });

  it("no-ops when toolUse has no toolCall blocks", () => {
    const session = makeSession([
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "text", text: "thinking..." }],
      } as AgentMessage,
    ]);
    repairOrphanedToolCalls(session);
    expect(session.agent.state.messages).toHaveLength(1);
  });
});
