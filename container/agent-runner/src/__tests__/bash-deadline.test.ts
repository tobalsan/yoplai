import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDeadlineBashTool } from "../bash-deadline.js";

const context = {} as ExtensionContext;
const execute = vi.hoisted(() => vi.fn());
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createBashToolDefinition: () => ({ name: "bash", execute }),
}));

afterEach(() => {
  vi.useRealTimers();
  execute.mockReset();
});

describe("native bash turn deadline", () => {
  it("clamps to remaining time and reports the native timeout with the reduction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const tool = createDeadlineBashTool("/workspace", 900_000);
    vi.setSystemTime(300_000);
    execute.mockRejectedValue(new Error("Command timed out after 599 seconds"));
    await expect(
      tool.execute(
        "id",
        { command: "sleep 900", timeout: 900 },
        undefined,
        undefined,
        context
      )
    ).rejects.toThrow("timeout reduced to 599s: turn time limit");
    expect(execute.mock.calls[0][1].timeout).toBe(599);
    expect(execute.mock.calls[0][4]).toBe(context);
  });

  it("preserves a 900s budget with ample runtime and missing timeout behavior", async () => {
    const tool = createDeadlineBashTool("/workspace", Date.now() + 1800_000);
    execute.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    await tool.execute(
      "id",
      { command: "sleep 900", timeout: 900 },
      undefined,
      undefined,
      context
    );
    expect(execute.mock.calls[0][1].timeout).toBe(900);
    await tool.execute(
      "other",
      { command: "sleep infinity" },
      undefined,
      undefined,
      context
    );
    expect(execute.mock.calls[1][1].timeout).toBeUndefined();
  });

  it("includes the reduction on successful output and does not renew the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const tool = createDeadlineBashTool("/workspace", 10_000);
    execute.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const result = await tool.execute(
      "id",
      { command: "true" },
      undefined,
      undefined,
      context
    );
    expect(result.content).toContainEqual({
      type: "text",
      text: "timeout reduced to 9s: turn time limit",
    });
    vi.setSystemTime(10_000);
    await expect(
      tool.execute(
        "other",
        { command: "true", timeout: 900 },
        undefined,
        undefined,
        context
      )
    ).rejects.toThrow("timeout reduced to 0s: turn time limit");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
