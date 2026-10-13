import { afterEach, describe, expect, it } from "vitest";
import {
  abortContainerRun,
  getContainerTokenContext,
  registerContainerToken,
  removeContainerToken,
  validateContainerToken,
} from "./tokens.js";

const register = (token: string, runId: string) => {
  registerContainerToken(token, {
    agentId: "agent",
    sessionId: "session",
    runId,
    containerName: "container",
    roots: { workspace: "/workspace", data: "/data", uploads: "/uploads" },
  });
  return getContainerTokenContext(token)!.abortController.signal;
};

afterEach(() => {
  removeContainerToken("one");
  removeContainerToken("two");
});

describe("container run cancellation", () => {
  it("aborts in-flight work before removing the token", () => {
    const signal = register("one", "run-one");
    let validOnAbort = false;
    signal.addEventListener("abort", () => {
      validOnAbort = validateContainerToken("one", "agent");
    });
    removeContainerToken("one");
    expect(signal.aborted).toBe(true);
    expect(validOnAbort).toBe(true);
    expect(getContainerTokenContext("one")).toBeUndefined();
  });

  it.each(["one", "run-one"])("cancels by %s without cancelling another run", (id) => {
    const one = register("one", "run-one");
    const two = register("two", "run-two");
    abortContainerRun(id);
    abortContainerRun(id);
    expect(one.aborted).toBe(true);
    expect(two.aborted).toBe(false);
  });
});
