import { afterEach, describe, expect, it, vi } from "vitest";
import type { FullHistoryMessage } from "@yoplai/shared";
import {
  autoTitleSession,
  normalizeGeneratedTitle,
  resetSessionAutoTitleDepsForTests,
} from "./session-auto-title.js";

const firstExchange: FullHistoryMessage[] = [
  {
    role: "user",
    timestamp: 1,
    content: [{ type: "text", text: "Help me plan a product launch" }],
  },
  {
    role: "assistant",
    timestamp: 2,
    content: [{ type: "text", text: "Start with audience, milestones, and launch risks." }],
  },
];

afterEach(() => resetSessionAutoTitleDepsForTests());

describe("core session auto-title", () => {
  it("writes a normalized title after the first assistant reply", async () => {
    const appendMetaIfAbsent = vi.fn(async () => true);
    const invalidate = vi.fn();
    const complete = vi.fn(async () => ' " Product launch planning! " ');

    await expect(autoTitleSession({ agentId: "agent", sessionId: "session" }, {
      getHistory: async () => firstExchange,
      hasTitle: async () => false,
      complete,
      appendMetaIfAbsent,
      invalidate,
    })).resolves.toBe("Product launch planning");

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Help me plan a product launch"),
    }));
    expect(appendMetaIfAbsent).toHaveBeenCalledWith("agent", "session", "title", "Product launch planning", undefined);
    expect(invalidate).toHaveBeenCalledWith("agent", "session", undefined);
  });

  it("preserves any existing title meta, including an empty manual rename", async () => {
    const complete = vi.fn();

    await expect(autoTitleSession({ agentId: "agent", sessionId: "session" }, {
      getHistory: async () => firstExchange,
      hasTitle: async () => true,
      complete,
    })).resolves.toBeNull();

    expect(complete).not.toHaveBeenCalled();
  });

  it("does not overwrite a rename made while generation is in flight", async () => {
    const appendMetaIfAbsent = vi.fn(async () => false);

    await expect(autoTitleSession({ agentId: "agent", sessionId: "session" }, {
      getHistory: async () => firstExchange,
      hasTitle: async () => false,
      complete: async () => "Generated title",
      appendMetaIfAbsent,
    })).resolves.toBeNull();

    expect(appendMetaIfAbsent).toHaveBeenCalledOnce();
  });

  it("titles a first turn that used tools across several assistant steps", async () => {
    const complete = vi.fn(async () => "Zendesk connectivity check");
    const toolTurn: FullHistoryMessage[] = [
      firstExchange[0],
      { role: "assistant", timestamp: 2, content: [{ type: "text", text: "" }] },
      { role: "toolResult", timestamp: 3, content: [{ type: "text", text: "ok" }] } as FullHistoryMessage,
      { role: "assistant", timestamp: 4, content: [{ type: "text", text: "Zendesk is reachable." }] },
    ];

    await expect(autoTitleSession({ agentId: "agent", sessionId: "session" }, {
      getHistory: async () => toolTurn,
      hasTitle: async () => false,
      complete,
      appendMetaIfAbsent: async () => true,
      invalidate: () => {},
    })).resolves.toBe("Zendesk connectivity check");

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Assistant: Zendesk is reachable."),
    }));
  });

  it("titles a later turn when the session is still untitled", async () => {
    const complete = vi.fn(async () => "Product launch planning");

    await expect(autoTitleSession({ agentId: "agent", sessionId: "session" }, {
      getHistory: async () => [
        firstExchange[0],
        { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "aborted mid-thought" }] } as FullHistoryMessage,
        { ...firstExchange[0], timestamp: 3 },
        { ...firstExchange[1], timestamp: 4 },
      ],
      hasTitle: async () => false,
      complete,
      appendMetaIfAbsent: async () => true,
      invalidate: () => {},
    })).resolves.toBe("Product launch planning");
  });

  it("does not title a session that already has one", async () => {
    const complete = vi.fn();

    await expect(autoTitleSession({ agentId: "agent", sessionId: "session" }, {
      getHistory: async () => firstExchange,
      hasTitle: async () => true,
      complete,
    })).resolves.toBeNull();

    expect(complete).not.toHaveBeenCalled();
  });

  it("matches lead-title normalization and caps long output", () => {
    expect(normalizeGeneratedTitle('  "Release planning and launch readiness."  ')).toBe("Release planning and launch readiness");
    expect(normalizeGeneratedTitle("This title is intentionally longer than sixty characters by several words")).toBe("This title is intentionally longer than sixty characters by");
  });

  it("asks for the conversation language", async () => {
    const complete = vi.fn(async () => "Planification du budget");

    await autoTitleSession({ agentId: "agent", sessionId: "session" }, {
      getHistory: async () => [
        { role: "user", timestamp: 1, content: [{ type: "text", text: "Aide-moi à planifier le budget" }] },
        { role: "assistant", timestamp: 2, content: [{ type: "text", text: "Commençons par les dépenses." }] },
      ],
      hasTitle: async () => false,
      complete,
      appendMetaIfAbsent: async () => true,
    });

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringContaining("conversation's language"),
    }));
  });
});
