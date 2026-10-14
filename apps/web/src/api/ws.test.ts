import { describe, expect, it, vi } from "vitest";
import { dispatchWsEvent } from "./ws";

describe("terminal failure dispatch", () => {
  it("dispatches safe user text rather than raw provider errors", () => {
    const onError = vi.fn();
    dispatchWsEvent({ type: "error", message: "provider secret request-id", kind: "rate_limit", userMessage: "Safe notice" }, { onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("Safe notice");
  });

  it("uses a safe fixed message for legacy error events", () => {
    const onError = vi.fn();
    dispatchWsEvent({ type: "error", message: "provider secret request-id" }, { onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("Something went wrong, please try again.");
  });
});
