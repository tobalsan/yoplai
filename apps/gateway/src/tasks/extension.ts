import { z } from "zod";
import type { Extension, ExtensionAgentTool } from "@yoplai/shared";
import { adoptTask, completeTask, getTasks, updateTask } from "./store.js";

const empty = z.object({});
const schema = (shape: z.ZodRawShape) => z.object(shape);
type TaskArgs = Record<string, string | undefined>;
function tool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  parser: z.ZodTypeAny,
  execute: (
    args: TaskArgs,
    sessionId: string,
    userId?: string
  ) => Promise<unknown>
): ExtensionAgentTool {
  return {
    name,
    description,
    parameters,
    execute: async (raw, context) => {
      if (!context.sessionId) throw new Error("Task tools require a session");
      return execute(
        parser.parse(raw) as TaskArgs,
        context.sessionId,
        context.userId
      );
    },
  };
}
export const taskLifecycleExtension: Extension = {
  id: "taskLifecycle",
  displayName: "Task lifecycle",
  description: "Durable agent task lifecycle tools.",
  dependencies: [],
  factory: true,
  routePrefixes: [],
  configSchema: empty,
  validateConfig: () => ({ valid: true, errors: [] }),
  registerRoutes: () => {},
  start: async () => {},
  stop: async () => {},
  capabilities: () => [],
  getSystemPromptContributions: () =>
    "Use task.adopt when starting substantive work. Before switching to unrelated work, checkpoint and pause the current task; resume it when continuing. Complete tasks only after their work is done. Do not mention this bookkeeping to the user unless they need to choose priorities.",
  getAgentTools(agent) {
    const id = agent.id;
    return [
      tool(
        "task.adopt",
        "Adopt a task for the current session.",
        {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
        schema({ title: z.string().min(1) }),
        (a, session, user) => adoptTask(id, session, a.title!, user)
      ),
      tool(
        "task.get",
        "Inspect active and paused tasks for the current session.",
        { type: "object", properties: {} },
        empty,
        (_a, session, user) => getTasks(id, session, user)
      ),
      tool(
        "task.checkpoint",
        "Record resumable progress for the current task.",
        {
          type: "object",
          properties: { checkpoint: { type: "string" } },
          required: ["checkpoint"],
        },
        schema({ checkpoint: z.string().min(1) }),
        (a, session, user) =>
          updateTask(id, session, user, { checkpoint: a.checkpoint })
      ),
      tool(
        "task.pause",
        "Pause the current task with a reason.",
        {
          type: "object",
          properties: {
            reason: { type: "string" },
            checkpoint: { type: "string" },
          },
          required: ["reason"],
        },
        schema({
          reason: z.string().min(1),
          checkpoint: z.string().min(1).optional(),
        }),
        (a, session, user) => {
          const update = {
            status: "paused" as const,
            pauseReason: a.reason,
            ...(a.checkpoint === undefined ? {} : { checkpoint: a.checkpoint }),
          };
          return updateTask(id, session, user, update);
        }
      ),
      tool(
        "task.resume",
        "Resume the current paused task.",
        { type: "object", properties: { taskId: { type: "string" } } },
        schema({ taskId: z.string().min(1).optional() }),
        (a, session, user) =>
          updateTask(id, session, user, {
            status: "active",
            pauseReason: undefined,
          }, a.taskId)
      ),
      tool(
        "task.complete",
        "Complete and remove the current task.",
        { type: "object", properties: { taskId: { type: "string" } } },
        schema({ taskId: z.string().min(1).optional() }),
        (a, session, user) => completeTask(id, session, user, a.taskId)
      ),
    ];
  },
};
