import { describe, expect, it, vi } from "vitest";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

describe("Durable web Main", () => {
  it("answers a web send and reloads it with the compatibility history selectors", async () => {
    const gateway = await startDurableTestGateway();
    try {
      const response = await gateway.send("local", "Check the greenhouse", { clientSendId: "greenhouse-1" });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result).toMatchObject({
        payloads: [{ text: "The seedlings are ready." }],
        meta: { sessionId: "durable-main", durationMs: expect.any(Number) },
      });
      const history = await gateway.history("local", "?sessionKey=main");
      expect(history).toMatchObject({
        sessionId: "durable-main",
        messages: [
          { role: "user", content: "Check the greenhouse" },
          { role: "assistant", content: "The seedlings are ready." },
        ],
      });
      expect(await gateway.history("local", "?sessionKey=web-seed")).toEqual(history);
      expect(await gateway.history("local", "?sessionId=durable-main")).toEqual(history);
      const latest = await gateway.history("local", "?view=full&limit=1");
      expect(latest).toMatchObject({
        historyOffset: 1, nextCursor: expect.any(String),
        messages: [{ role: "assistant", content: [{ type: "text", text: "The seedlings are ready." }] }],
      });
      const earlier = await gateway.history("local", "?view=full&limit=1&before=" + latest.nextCursor);
      expect(earlier).toMatchObject({
        historyOffset: 0, messages: [{ role: "user", content: [{ type: "text", text: "Check the greenhouse" }] }],
      });
      await expect(gateway.history("local", "?limit=1&before=invalid")).rejects.toThrow("History returned 400");
    } finally {
      await gateway.close();
    }
  });

  it.each(["local", "alice"] as const)("streams and refreshes Main for %s", async (user) => {
    const gateway = await startDurableTestGateway({ multiUser: user === "alice" });
    try {
      const [sender, observer] = await Promise.all([gateway.socket(user), gateway.socket(user)]);
      observer.send({ type: "subscribe", agentId: "pilot", sessionKey: "web-seed" });
      sender.send({ type: "send", agentId: "pilot", sessionKey: "web-seed", message: "Check the greenhouse", clientSendId: "greenhouse-ws" });
      await vi.waitFor(() => expect(sender.events).toContainEqual({
        type: "done",
        meta: { sessionId: "durable-main", durationMs: expect.any(Number) },
      }));
      expect(sender.events.flatMap((event) => event.type === "text" ? [event.data] : []).join("")).toBe("The seedlings are ready.");
      await vi.waitFor(() => expect(observer.events).toContainEqual({
        type: "history_updated", agentId: "pilot", sessionId: "durable-main",
      }));
      expect(await gateway.history(user)).toMatchObject({
        messages: [{ role: "user", content: "Check the greenhouse" }, { role: "assistant", content: "The seedlings are ready." }],
      });
    } finally {
      await gateway.close();
    }
  });

  it.each(["local", "alice"] as const)("reuses %s's empty Main after failure between the two commits", async (user) => {
    const gateway = await startDurableTestGateway({ multiUser: user === "alice" });
    try {
      gateway.failBetweenCommits();
      const options = { clientSendId: "garden-recovery" };
      const failed = await gateway.send(user, "Check the greenhouse", options);
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "Fixture stopped between Main creation and admission." });
      expect(await gateway.history(user)).toEqual({ messages: [], view: "simple" });
      const main = await gateway.mainConversationId(user);
      expect(main).toEqual(expect.any(String));
      expect(gateway.callCount()).toBe(0);

      await gateway.restart();
      const retry = await gateway.send(user, "Check the greenhouse", options);
      expect(retry.status).toBe(200);
      expect(await gateway.mainConversationId(user)).toBe(main);
      const history = await gateway.history(user);
      expect(history.messages.map((row: { role: string; content: string }) => [row.role, row.content])).toEqual([
        ["user", "Check the greenhouse"], ["assistant", "The seedlings are ready."],
      ]);
    } finally {
      await gateway.close();
    }
  });

  it.each(["local", "alice"] as const)("deduplicates concurrent and restarted sends for %s by ID", async (user) => {
    const gateway = await startDurableTestGateway({ multiUser: user === "alice" });
    try {
      const send = async (clientSendId: string) => {
        const response = await gateway.send(user, "Check the greenhouse", { clientSendId });
        expect(response.status).toBe(200);
        return response.json();
      };
      expect(await gateway.mainConversationId(user)).toBeUndefined();
      const [original, duplicate] = await Promise.all([send("same-key"), send("same-key")]);
      expect(duplicate).toEqual(original);
      const main = await gateway.mainConversationId(user);
      expect(main).toEqual(expect.any(String));
      await gateway.restart();
      expect(await send("same-key")).toEqual(original);
      expect(await gateway.mainConversationId(user)).toBe(main);
      expect(gateway.callCount()).toBe(1);
      expect((await gateway.history(user)).messages).toMatchObject([
        { role: "user", content: "Check the greenhouse" }, { role: "assistant", content: "The seedlings are ready." },
      ]);

      gateway.script("The basil is ready.", "The tomatoes are ready.");
      await Promise.all([send("another-key"), send("third-key")]);
      const { messages } = await gateway.history(user);
      expect(messages.filter((row: { role: string }) => row.role === "user")).toMatchObject([
        { content: "Check the greenhouse" }, { content: "Check the greenhouse" }, { content: "Check the greenhouse" },
      ]);
      expect(await gateway.mainConversationId(user)).toBe(main);
    } finally {
      await gateway.close();
    }
  });

  it("scopes explicit Main selectors, live events and sends to the authenticated account", async () => {
    const gateway = await startDurableTestGateway({ multiUser: true });
    try {
      const aliceObserver = await gateway.subscribe("alice", { sessionKey: "web-alice" });
      const bobObserver = await gateway.subscribe("bob", { sessionKey: "web-alice", sessionId: "durable-main" });
      const alice = await gateway.send("alice", "Alice's seedlings", { sessionKey: "web-alice", clientSendId: "shared-key" }, "ws");
      await vi.waitFor(() => expect(alice.events).toContainEqual(expect.objectContaining({ type: "done" })));
      await vi.waitFor(() => expect(aliceObserver.events).toContainEqual(expect.objectContaining({ type: "history_updated" })));
      expect(await gateway.history("bob", "?sessionKey=web-alice&sessionId=durable-main")).toEqual({ messages: [], view: "simple" });
      expect(bobObserver.events).toEqual([]);

      gateway.script("Water the basil.");
      const bob = await gateway.send("bob", "Bob's basil", { sessionId: "durable-main", sessionKey: "web-alice", clientSendId: "shared-key" });
      expect(bob.status).toBe(200);
      await vi.waitFor(() => expect(bobObserver.events).toContainEqual(expect.objectContaining({ type: "history_updated" })));
      expect(bobObserver.events).not.toContainEqual(expect.objectContaining({ text: "The seedlings are ready." }));
      expect((await gateway.history("alice")).messages).toMatchObject([
        { role: "user", content: "Alice's seedlings" }, { role: "assistant", content: "The seedlings are ready." },
      ]);
      expect((await gateway.history("bob")).messages).toMatchObject([
        { role: "user", content: "Bob's basil" }, { role: "assistant", content: "Water the basil." },
      ]);
      expect(aliceObserver.events.filter(({ type }) => type === "history_updated")).toHaveLength(1);
    } finally {
      await gateway.close();
    }
  });

  it.each(["local", "alice"] as const)("holds %s's rejected draft and delivers the approved rewrite once", async (user) => {
    let release!: () => void;
    const verdict = new Promise<void>((resolve) => { release = resolve; });
    const review = vi.fn(async (draft: string) => {
      if (draft === "The first draft is private.") {
        await verdict;
        return { ok: false, rewriteHint: "State the result briefly." } as const;
      }
      return { ok: true } as const;
    });
    const gateway = await startDurableTestGateway({
      multiUser: user === "alice",
      reviewer: { begin() {}, end() {}, review },
    });
    try {
      gateway.script("The first draft is private.", ...(user === "alice" ? ["Water the basil."] : []), "The greenhouse is ready.");
      const sender = await gateway.send(user, "Check the greenhouse", { clientSendId: "review-1" }, "ws");
      await vi.waitFor(() => expect(review).toHaveBeenCalledWith("The first draft is private."));
      const observer = await gateway.subscribe(user);
      await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({ type: "active_turn", text: "" })));
      expect(sender.events).toEqual([]);
      expect(await gateway.history(user, "?view=full")).toMatchObject({
        isStreaming: true,
        activeTurn: { text: "" },
        messages: [{ role: "user", content: [{ type: "text", text: "Check the greenhouse" }] }],
      });

      if (user === "alice") {
        const unrelated = await gateway.send("bob", "Check the basil", { clientSendId: "while-reviewing" });
        expect(unrelated.status).toBe(200);
        expect(await unrelated.json()).toMatchObject({ payloads: [{ text: "Water the basil." }] });
        expect(sender.events).toEqual([]);
      }
      release();
      await vi.waitFor(() => expect(sender.events).toContainEqual(expect.objectContaining({ type: "done" })));
      expect(sender.events.filter(({ type }) => type === "text")).toEqual([{ type: "text", data: "The greenhouse is ready." }]);
      expect(review.mock.calls.map(([draft]) => draft)).toEqual([
        "The first draft is private.", ...(user === "alice" ? ["Water the basil."] : []), "The greenhouse is ready.",
      ]);
      const expected = [{ role: "user", content: "Check the greenhouse" }, { role: "assistant", content: "The greenhouse is ready." }];
      expect((await gateway.history(user)).messages).toMatchObject(expected);
      await gateway.restart();
      expect((await gateway.history(user)).messages).toMatchObject(expected);
      expect(JSON.stringify(observer.events)).not.toContain("The first draft is private.");
    } finally {
      release();
      await gateway.close();
    }
  });

  it.each(["local", "alice"] as const)("withholds both rejected drafts for %s, including after restart", async (user) => {
    const review = vi.fn(() => ({ ok: false, rewriteHint: "State the result briefly." }) as const);
    const gateway = await startDurableTestGateway({
      multiUser: user === "alice", reviewer: { begin() {}, end() {}, review },
    });
    try {
      gateway.script("First rejected answer.", "Second rejected answer.");
      const observer = await gateway.subscribe(user);
      const sender = await gateway.send(user, "Check the greenhouse", { clientSendId: "withheld" }, "ws");
      await vi.waitFor(() => expect(sender.events).toEqual([{ type: "error", message: "The reply was withheld by review." }]));
      await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({ type: "history_updated" })));
      expect(JSON.stringify(observer.events)).not.toMatch(/(First|Second) rejected answer/);
      const expected = [{ role: "user", content: "Check the greenhouse" }];
      expect((await gateway.history(user)).messages).toMatchObject(expected);
      await gateway.restart();
      expect((await gateway.history(user)).messages).toMatchObject(expected);

      const retry = await gateway.send(user, "Check the greenhouse", { clientSendId: "withheld" });
      expect(retry.status).toBe(500);
      expect(await retry.json()).toEqual({ error: "The reply was withheld by review." });
      expect(review.mock.calls).toEqual([["First rejected answer."], ["Second rejected answer."]]);
      expect(gateway.callCount()).toBe(2);
    } finally {
      await gateway.close();
    }
  });

  it("reports a missing model provider over WebSocket and HTTP", async () => {
    const gateway = await startDurableTestGateway();
    try {
      gateway.script({ errorMessage: "Provider is not configured: anthropic (Authorization: Bearer sk-faux-private)" });
      const options = { clientSendId: "missing-provider" };
      const sender = await gateway.send("local", "Check the greenhouse", options, "ws");
      const message = "The model provider is not configured for this agent.";
      await vi.waitFor(() => expect(sender.events).toHaveLength(1));
      expect(sender.events).toEqual([{ type: "error", message }]);

      const retry = await gateway.send("local", "Check the greenhouse", options);
      expect(retry.status).toBe(500);
      expect(await retry.json()).toEqual({ error: message });
      await sender.flush();
      expect(sender.events).toEqual([{ type: "error", message }]);
      expect(gateway.callCount()).toBe(1);
    } finally {
      await gateway.close();
    }
  });

  it("keeps a failed turn's notice in Main history across a gateway restart", async () => {
    const gateway = await startDurableTestGateway();
    try {
      gateway.script({ errorMessage: "Provider is not configured: anthropic (Authorization: Bearer sk-faux-private)" });
      const response = await gateway.send("local", "Check the greenhouse", { clientSendId: "failed-history" });
      expect(response.status).toBe(500);
      const text = "The model provider is not configured for this agent.";
      const meta = { stopReason: "error", failure: { kind: "provider_not_configured" } };
      const fullHistory = await gateway.history("local", "?view=full");
      expect(fullHistory.messages).toMatchObject([
        { role: "user", content: [{ type: "text", text: "Check the greenhouse" }] },
        { role: "assistant", content: [{ type: "text", text }], meta },
      ]);

      await gateway.restart();
      expect(await gateway.history("local", "?view=full")).toEqual(fullHistory);
      expect((await gateway.history("local")).messages).toMatchObject([
        { role: "user", content: "Check the greenhouse" },
        { role: "assistant", content: text, meta },
      ]);
    } finally {
      await gateway.close();
    }
  });

  it("records one model note and warning for a failed send, even when retried across a restart", async () => {
    const gateway = await startDurableTestGateway();
    const warn = vi.spyOn(console, "warn");
    try {
      gateway.script(
        { errorMessage: "Provider is not configured: anthropic (Authorization: Bearer sk-faux-private)" },
        "The seedlings are ready.",
      );
      const sendA = () => gateway.send("local", "Check the greenhouse", { clientSendId: "failed-note" });
      const expectedError = { error: "The model provider is not configured for this agent." };
      const expectFailedSend = async () => {
        const response = await sendA();
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual(expectedError);
      };
      const warnings = () => warn.mock.calls.flatMap(([line]) =>
        typeof line === "string" && line.startsWith("{") ? [JSON.parse(line)] : [])
        .filter((warning) => warning.agentId === "pilot");
      await expectFailedSend();
      expect(warnings()).toEqual([{
        level: "warn",
        msg: "Durable turn failed",
        agentId: "pilot",
        conversationId: Number(await gateway.mainConversationId("local")),
        submissionId: expect.any(Number),
        reason: "model_error",
        kind: "provider_not_configured",
      }]);
      await expectFailedSend();
      await gateway.restart();
      await expectFailedSend();
      expect(gateway.callCount()).toBe(1);

      const response = await gateway.send("local", "Try the greenhouse again", { clientSendId: "next-send" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ payloads: [{ text: "The seedlings are ready." }] });
      expect(gateway.callCount()).toBe(2);
      expect(gateway.requests[1]?.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
        "[from Local user via web]\nCheck the greenhouse",
        "[previous reply failed: model provider not configured]",
        "[from Local user via web]\nTry the greenhouse again",
      ]);
      expect(warnings()).toHaveLength(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("sk-faux-private");
    } finally {
      warn.mockRestore();
      await gateway.close();
    }
  });

  it.each(["local", "alice"] as const)("lands two distinct simultaneous first sends in %s's Main", async (user) => {
    const gateway = await startDurableTestGateway({ multiUser: user === "alice" });
    try {
      gateway.script("Basil checked.", "Mint checked.");
      const responses = await Promise.all([
        gateway.send(user, "Check the basil", { clientSendId: "check-basil" }),
        gateway.send(user, "Check the mint", { clientSendId: "check-mint" }),
      ]);
      expect(responses.map(({ status }) => status)).toEqual([200, 200]);
      for (const response of responses) await response.json();
      expect(await gateway.mainConversationId(user)).toEqual(expect.any(String));
      const { messages } = await gateway.history(user);
      expect(messages.filter((row: { role: string }) => row.role === "user").map((row: { content: string }) => row.content).sort())
        .toEqual(["Check the basil", "Check the mint"]);
    } finally {
      await gateway.close();
    }
  });

  it.each([
    { label: "flag off", extraYaml: "", sendId: "legacy-web" },
    { label: "send without a client ID", extraYaml: "durable: true", sendId: undefined },
    { label: "explicit older session", extraYaml: "durable: true", sendId: "older-web" },
  ])("preserves the legacy path for $label", async ({ label, extraYaml, sendId }) => {
    const gateway = await startDurableTestGateway({ extraYaml, legacyAnswer: "A legacy answer." });
    try {
      const target = label === "explicit older session" ? { sessionId: "legacy-garden" } : {};
      const response = await gateway.send("local", "Check the archive", { clientSendId: sendId, ...target });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({ payloads: [{ text: "A legacy answer." }] });
      expect(result.meta.sessionId).not.toBe("durable-main");
      expect((await gateway.history("local", "?sessionId=" + result.meta.sessionId)).messages)
        .toMatchObject([{ role: "user", content: "Check the archive" }, { role: "assistant", content: "A legacy answer." }]);
      expect(gateway.callCount()).toBe(0);
    } finally {
      await gateway.close();
    }
  });

  it.each([
    ["sandbox:\n  enabled: true", "Durable requires sandbox.enabled to be off"],
    ["sdk: openclaw", "openclaw SDK was removed, use pi"],
  ])("rejects incompatible durable configuration (%s)", async (config, warning) => {
    const warn = vi.spyOn(console, "warn");
    const gateway = await startDurableTestGateway({ extraYaml: "durable: true\n" + config });
    try {
      const response = await gateway.send("local", "Check the greenhouse", { clientSendId: "incompatible-config" });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Agent not found" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(warning));
    } finally {
      warn.mockRestore();
      await gateway.close();
    }
  });

  it("finishes the rejected draft's rewrite when another send arrives in the same Main", async () => {
    let release!: () => void;
    const verdict = new Promise<void>((resolve) => { release = resolve; });
    let firstDraftSeen = false;
    const factory = vi.fn(() => {
      let sawDraft = false;
      return {
        begin() {},
        async review(draft: string) {
          if (draft === "Unapproved greenhouse draft.") {
            sawDraft = true;
            firstDraftSeen = true;
            await verdict;
            return { ok: false, rewriteHint: "State the result briefly." } as const;
          }
          return draft === "The greenhouse is ready." && !sawDraft
            ? { ok: false, rewriteHint: "Review context was lost." } as const
            : { ok: true } as const;
        },
        end() {},
      };
    });
    const gateway = await startDurableTestGateway({ reviewer: factory });
    try {
      gateway.script("Unapproved greenhouse draft.", "The greenhouse is ready.", "The mint is ready.");
      const first = await gateway.send("local", "Check the greenhouse", { clientSendId: "greenhouse" }, "ws");
      await vi.waitFor(() => expect(firstDraftSeen).toBe(true));
      const second = await gateway.send("local", "Check the mint", { clientSendId: "mint" }, "ws");
      await second.flush();
      release();
      await vi.waitFor(() => expect(first.events).toContainEqual({ type: "text", data: "The greenhouse is ready." }));
      await vi.waitFor(() => expect(second.events).toContainEqual({ type: "text", data: "The mint is ready." }));
      expect(factory).toHaveBeenCalledTimes(2);
      expect((await gateway.history("local")).messages).toMatchObject([
        { role: "user", content: "Check the greenhouse" },
        { role: "assistant", content: "The greenhouse is ready." },
        { role: "user", content: "Check the mint" },
        { role: "assistant", content: "The mint is ready." },
      ]);
    } finally {
      release();
      await gateway.close();
    }
  });

  it("uses the configured model for the next turn in an existing Main after restart", async () => {
    const gateway = await startDurableTestGateway();
    try {
      const initial = await gateway.send("local", "Check the greenhouse", { clientSendId: "first" });
      expect(initial.status).toBe(200);
      await initial.json();

      await gateway.restart("fixture-alternate");
      gateway.script((model) => model === "fixture-alternate" ? "The mint is ready." : "The old model answered.");
      const next = await gateway.send("local", "Check the mint", { clientSendId: "second" });
      expect(next.status).toBe(200);
      expect(await next.json()).toMatchObject({ payloads: [{ text: "The mint is ready." }] });
      expect((await gateway.history("local")).messages).toMatchObject([
        { role: "user", content: "Check the greenhouse" },
        { role: "assistant", content: "The seedlings are ready." },
        { role: "user", content: "Check the mint" },
        { role: "assistant", content: "The mint is ready." },
      ]);
    } finally {
      await gateway.close();
    }
  });

  it("closes and reopens while an asynchronous reviewer is still waiting", async () => {
    let release!: () => void;
    const paused = new Promise<{ ok: true }>((resolve) => { release = () => resolve({ ok: true }); });
    const review = vi.fn(async (_draft: string) => ({ ok: true }) as const).mockImplementationOnce(() => paused);
    const gateway = await startDurableTestGateway({ reviewer: { begin() {}, end() {}, review } });
    try {
      gateway.script("The greenhouse is ready.", "The greenhouse is ready.");
      await gateway.send("local", "Check the greenhouse", { clientSendId: "restart-review" }, "ws");
      await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());
      const restart = gateway.restart();
      try {
        await expect(Promise.race([
          restart.then(() => "reopened"),
          new Promise<string>((resolve) => setTimeout(() => resolve("review still blocking shutdown"), 1200)),
        ])).resolves.toBe("reopened");
      } finally {
        release();
        await restart;
      }
      const retried = await gateway.send("local", "Check the greenhouse", { clientSendId: "restart-review" });
      expect(retried.status).toBe(200);
      expect(await retried.json()).toMatchObject({ payloads: [{ text: "The greenhouse is ready." }] });
      expect((await gateway.history("local")).messages).toMatchObject([
        { role: "user", content: "Check the greenhouse" },
        { role: "assistant", content: "The greenhouse is ready." },
      ]);
    } finally {
      release();
      await gateway.close();
    }
  });

  it("delivers text chunks before settlement and exposes the same partial to a reload", async () => {
    const gateway = await startDurableTestGateway({ tokensPerSecond: 75 });
    try {
      const answer = "The seedlings are ready. " + "The stems are sturdy. ".repeat(17).trim();
      gateway.script(answer);
      const sender = await gateway.send("local", "Check the greenhouse", { clientSendId: "paced" }, "ws");
      await vi.waitFor(() => expect(sender.events.some(({ type }) => type === "text")).toBe(true));
      expect(sender.events.some(({ type }) => type === "done")).toBe(false);
      const history = await gateway.history("local", "?view=full");
      expect(history).toMatchObject({ isStreaming: true, activeTurn: { text: expect.stringContaining("The") } });
      expect(history.messages).toHaveLength(1);
      await vi.waitFor(() => expect(sender.events.some(({ type }) => type === "done")).toBe(true), { timeout: 3500 });
      expect(sender.events.flatMap((event) => event.type === "text" ? [event.data] : []).join("")).toBe(answer);
    } finally {
      await gateway.close();
    }
  });
});
