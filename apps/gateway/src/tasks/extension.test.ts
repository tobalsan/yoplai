import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../config/index.js", () => ({ CONFIG_DIR: "/tmp/yoplai-task-tools" }));

afterEach(async () => {
  const { resetTaskStoreForTests } = await import("./store.js");
  resetTaskStoreForTests();
});

describe("task lifecycle tools", () => {
  it("keeps missing gateway session context untagged", async () => {
    const { taskLifecycleExtension } = await import("./extension.js");
    const tools = await taskLifecycleExtension.getAgentTools!({
      id: "agent",
    } as never);
    const error = await Promise.resolve(tools
      .find((tool) => tool.name === "task.complete")!
      .execute({}, {} as never))
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ message: "Task tools require a session" });
    expect(error).not.toHaveProperty("code");
  });

  it.each(["opener", null])("keeps shared-thread tasks in owner store %s across requesters", async (sessionOwnerId) => {
    const { taskLifecycleExtension } = await import("./extension.js");
    const { getTasks } = await import("./store.js");
    const tools = await taskLifecycleExtension.getAgentTools!({ id: "agent" } as never);
    const sessionId = `slack:C1:${randomUUID()}`;
    await tools.find((candidate) => candidate.name === "task.adopt")!.execute({ title: "Thread task" }, {
      sessionId, sessionOwnerId, userId: "requester",
    } as never);
    expect(await getTasks("agent", sessionId, sessionOwnerId ?? undefined)).toEqual([
      expect.objectContaining({ title: "Thread task" }),
    ]);
    expect(await getTasks("agent", sessionId, "requester")).toEqual([]);
    expect(await tools.find((candidate) => candidate.name === "task.get")!.execute({}, {
      sessionId, sessionOwnerId, userId: "other-requester",
    } as never)).toEqual([expect.objectContaining({ title: "Thread task" })]);
  });

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
      label: "Tests are passing",
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
