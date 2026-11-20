// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { streamMessage } from "./chat";

afterEach(() => vi.unstubAllGlobals());

it("sends the explicit turn ID and reports a duplicate without a chat error", () => {
  const wire = { send: vi.fn(), close: vi.fn(), onopen: () => {}, onclose: () => {}, onmessage: (_event: { data: string }) => {} };
  vi.stubGlobal("WebSocket", function () { return wire; });
  const onError = vi.fn();
  const onTurnExists = vi.fn();
  const turnId = "b82f489b-bbcf-4c30-92f4-0cf05d7d7d21";
  const stop = streamMessage("alpha", "Hello", "main", vi.fn(), vi.fn(), onError, { onTurnExists }, { turnId, sessionId: "first" });
  try {
    wire.onopen();
    expect(JSON.parse(wire.send.mock.calls[0][0])).toMatchObject({ type: "send", agentId: "alpha", turnId, sessionId: "first" });
    wire.onmessage({ data: JSON.stringify({ type: "turn_exists" }) });
    wire.onclose();
    expect(onTurnExists).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});
