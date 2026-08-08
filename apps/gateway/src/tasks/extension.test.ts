import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../config/index.js", () => ({ CONFIG_DIR: "/tmp/yoplai-task-tools" }));

afterEach(async () => {
  const { resetTaskStoreForTests } = await import("./store.js");
  resetTaskStoreForTests();
});

describe("task lifecycle tools", () => {
  it("pauses task A before adopting task B, then resumes A", async () => {
    const { taskLifecycleExtension } = await import("./extension.js");
    const tools = await taskLifecycleExtension.getAgentTools!({ id: "agent" } as never);
    const sessionId = `web:user:${randomUUID()}`;
    const tool = (name: string, args: Record<string, string> = {}) =>
      tools.find((candidate) => candidate.name === name)!.execute(args, {
        sessionId,
      } as never);

    await tool("task.adopt", { title: "Task A" });
    await tool("task.checkpoint", { checkpoint: "ready for review" });
    const paused = await tool("task.pause", { reason: "work B arrived" });
    await tool("task.adopt", { title: "Task B" });
    await tool("task.complete");
    const resumed = await tool("task.resume", { taskId: (paused as { id: string }).id });

    expect(resumed).toMatchObject({ title: "Task A", status: "active", checkpoint: "ready for review" });
    expect(await tool("task.get")).toEqual([
      expect.objectContaining({ title: "Task A", status: "active" }),
    ]);
  });

  it("emits a semantic progress event for a checkpoint", async () => {
    const { taskLifecycleExtension } = await import("./extension.js");
    const tools = await taskLifecycleExtension.getAgentTools!({ id: "agent" } as never);
    const progress = vi.fn();
    const context = { sessionId: `web:user:${randomUUID()}`, emitProgress: progress };
    const tool = (name: string, args: Record<string, string> = {}) =>
      tools.find((candidate) => candidate.name === name)!.execute(args, context as never);

    await tool("task.adopt", { title: "Task A" });
    const task = await tool("task.checkpoint", { checkpoint: "Tests are passing" });

    expect(progress).toHaveBeenCalledWith({
      label: "Progress updated.",
      taskId: (task as { id: string }).id,
    });
  });

  it("keeps one adopted task through checkpoint and completion", async () => {
    const { taskLifecycleExtension } = await import("./extension.js");
    const tools = await taskLifecycleExtension.getAgentTools!({ id: "agent" } as never);
    const progress = vi.fn();
    const context = { sessionId: `slack:C1:1:${randomUUID()}`, emitProgress: progress };
    const tool = (name: string, args: Record<string, string> = {}) =>
      tools.find((candidate) => candidate.name === name)!.execute(args, context as never);

    const adopted = await tool("task.adopt", { title: "Task A" }) as { id: string };
    const checkpointed = await tool("task.checkpoint", { checkpoint: "Running tests" }) as { id: string; status: string };
    const completed = await tool("task.complete") as { id: string; status: string };

    expect(checkpointed).toMatchObject({ id: adopted.id, status: "active" });
    expect(completed).toMatchObject({ id: adopted.id, status: "active" });
    expect(await tool("task.get")).toEqual([]);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ taskId: adopted.id }));
  });
});
