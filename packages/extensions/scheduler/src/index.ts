import {
  CreateScheduleRequestSchema,
  SchedulerExtensionConfigSchema,
  UpdateScheduleRequestSchema,
  type Extension,
  type ExtensionAgentTool,
  type ExtensionContext,
} from "@yoplai/shared";
import { z } from "zod";
import type { Hono } from "hono";
import {
  ScheduleAlreadyRunningError,
  SchedulerService,
  clearSchedulerContext,
  getScheduler,
  getSchedulerContext,
  hasSchedulerContext,
  setSchedulerContext,
  startScheduler,
  stopScheduler,
} from "./service.js";
import { computeNextRunAtMs } from "./schedule.js";
import { getAgentJobsPath, readLatestOutputFile } from "./store.js";

const scheduleInputSchema = z.object({
  cron: z.string().min(1),
  tz: z.string().min(1),
  startAt: z.string().optional(),
});

const createJobToolSchema = z.object({
  name: z.string().min(1),
  cron: z.string().min(1),
  tz: z.string().min(1),
  startAt: z.string().optional(),
  message: z.string().min(1),
  sessionId: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
});

const updateJobToolSchema = z.object({
  jobId: z.string().min(1),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  schedule: scheduleInputSchema.optional(),
  message: z.string().min(1).optional(),
  sessionId: z.string().nullable().optional(),
  timeoutMs: z.number().positive().optional(),
});

const jobIdToolSchema = z.object({ jobId: z.string().min(1) });

const latestOutputToolSchema = z.object({
  jobId: z.string().min(1),
  maxChars: z.number().int().positive().max(20_000).optional(),
});

function toolError(error: unknown) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function schedulerAgentTools(): ExtensionAgentTool[] {
  return [
    {
      name: "scheduler.list_jobs",
      description: "List this agent's scheduler cron jobs",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, { agent }) {
        try {
          return { ok: true, jobs: await getScheduler().list(agent.id) };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "scheduler.create_job",
      description:
        "Create an enabled scheduler cron job for this agent. Optional timeoutMs overrides the per-run timeout (default 30 minutes).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          cron: { type: "string" },
          tz: { type: "string" },
          startAt: { type: "string" },
          message: { type: "string" },
          sessionId: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["name", "cron", "tz", "message"],
      },
      async execute(args, { agent }) {
        try {
          const input = createJobToolSchema.parse(args);
          const parsed = CreateScheduleRequestSchema.parse({
            agentId: agent.id,
            name: input.name,
            schedule: {
              cron: input.cron,
              tz: input.tz,
              startAt: input.startAt,
            },
            payload: { message: input.message, sessionId: input.sessionId },
            timeoutMs: input.timeoutMs,
          });
          const { agentId, ...body } = parsed;
          return { ok: true, job: await getScheduler().add(agentId!, body) };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "scheduler.update_job",
      description:
        "Update this agent's scheduler cron job. Set timeoutMs to override the per-run timeout in milliseconds (default 30 minutes).",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          name: { type: "string" },
          enabled: { type: "boolean" },
          schedule: {
            type: "object",
            properties: {
              cron: { type: "string" },
              tz: { type: "string" },
              startAt: { type: "string" },
            },
            required: ["cron", "tz"],
          },
          message: { type: "string" },
          sessionId: { type: ["string", "null"] },
          timeoutMs: { type: "number" },
        },
        required: ["jobId"],
      },
      async execute(args, { agent }) {
        try {
          const input = updateJobToolSchema.parse(args);
          const [existing] = (await getScheduler().list(agent.id)).filter(
            (job) => job.id === input.jobId
          );
          if (!existing) return { ok: false, error: "Schedule not found" };
          const payload =
            input.message !== undefined || input.sessionId !== undefined
              ? {
                  message: input.message ?? existing.payload.message,
                  sessionId:
                    input.sessionId === null
                      ? undefined
                      : (input.sessionId ?? existing.payload.sessionId),
                }
              : undefined;
          const patch = UpdateScheduleRequestSchema.parse({
            name: input.name,
            enabled: input.enabled,
            schedule: input.schedule,
            payload,
            timeoutMs: input.timeoutMs,
          });
          return {
            ok: true,
            job: await getScheduler().update(agent.id, input.jobId, patch),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "scheduler.delete_job",
      description: "Delete this agent's scheduler cron job by id",
      parameters: {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
      },
      async execute(args, { agent }) {
        try {
          const input = jobIdToolSchema.parse(args);
          const result = await getScheduler().remove(agent.id, input.jobId);
          return result.removed
            ? { ok: true }
            : { ok: false, error: "Schedule not found" };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "scheduler.get_latest_output",
      description:
        "Get a bounded preview of one scheduler job's latest output. First call scheduler.list_jobs, then pass the selected job's id as jobId. If output is not found, that job has not produced stored output yet.",
      parameters: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            description: "Required. Job ID from scheduler.list_jobs (jobs[n].id).",
          },
          maxChars: {
            type: "number",
            minimum: 1,
            maximum: 20000,
            description: "Optional maximum preview length in characters. Defaults to 4000.",
          },
        },
        required: ["jobId"],
      },
      async execute(args, { agent }) {
        try {
          const parsed = latestOutputToolSchema.safeParse(args);
          if (!parsed.success) {
            const hasJobIdError = parsed.error.issues.some((issue) => issue.path[0] === "jobId");
            if (hasJobIdError) {
              return {
                ok: false,
                error:
                  "jobId is required. Call scheduler.list_jobs first, then pass the selected jobs[n].id as jobId.",
              };
            }
            return toolError(parsed.error);
          }
          const input = parsed.data;
          const ctx = getSchedulerContext();
          const latest = await readLatestOutputFile(
            ctx.resolveWorkspaceDir(agent),
            input.jobId
          );
          if (!latest) return { ok: false, error: "Output not found" };
          const maxChars = input.maxChars ?? 4000;
          return {
            ok: true,
            path: latest.path,
            content:
              latest.content.length > maxChars
                ? latest.content.slice(0, maxChars)
                : latest.content,
            truncated: latest.content.length > maxChars,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    },
  ];
}

const schedulerExtension: Extension = {
  id: "scheduler",
  displayName: "Scheduler",
  factory: true,
  description: "Cron-like scheduled agent execution",
  dependencies: [],
  configSchema: SchedulerExtensionConfigSchema,
  routePrefixes: ["/api/schedules"],
  validateConfig(raw) {
    const result = SchedulerExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success ? [] : result.error.issues.map((issue) => issue.message),
    };
  },
  getAgentTools(_agent, context) {
    if (context?.config.extensions?.scheduler?.enabled === false) return [];
    return schedulerAgentTools();
  },
  registerRoutes(app: Hono) {
    app.get("/schedules", async (c) => {
      const scheduler = getScheduler();
      const agentId = c.req.query("agent") ?? undefined;
      const jobs = await scheduler.list(agentId);
      return c.json(jobs);
    });

    app.post("/schedules", async (c) => {
      const body = await c.req.json();
      const parsed = CreateScheduleRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: parsed.error.message }, 400);
      }

      if (!parsed.data.agentId) {
        return c.json({ error: "agentId is required" }, 400);
      }
      const scheduler = getScheduler();
      const { agentId, ...input } = parsed.data;
      try {
        const job = await scheduler.add(agentId, input);
        return c.json(job, 201);
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : "Schedule create failed" },
          404
        );
      }
    });

    app.get("/schedules/:agentId/:id/tail", async (c) => {
      const agentId = c.req.param("agentId");
      const id = c.req.param("id");
      const ctx = getSchedulerContext();
      const agent = ctx.getAgent(agentId);
      if (!agent) return c.json({ error: "Agent not found" }, 404);
      const latest = await readLatestOutputFile(ctx.resolveWorkspaceDir(agent), id);
      if (!latest) return c.json({ error: "Output not found" }, 404);
      return c.json(latest);
    });

    app.post("/schedules/:agentId/:id/run", async (c) => {
      const agentId = c.req.param("agentId");
      const id = c.req.param("id");
      const scheduler = getScheduler();
      try {
        const result = await scheduler.runNow(agentId, id);
        if (result.status === "error") {
          return c.json({ error: result.error ?? "Schedule run failed", result }, 500);
        }
        return c.json(result, result.status === "skipped" ? 202 : 200);
      } catch (error) {
        if (error instanceof ScheduleAlreadyRunningError) {
          return c.json({ error: error.message }, 409);
        }
        return c.json({ error: "Schedule not found" }, 404);
      }
    });

    app.patch("/schedules/:agentId/:id", async (c) => {
      const agentId = c.req.param("agentId");
      const id = c.req.param("id");
      const body = await c.req.json();
      const parsed = UpdateScheduleRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: parsed.error.message }, 400);
      }

      const scheduler = getScheduler();
      try {
        const job = await scheduler.update(agentId, id, parsed.data);
        return c.json(job);
      } catch {
        return c.json({ error: "Schedule not found" }, 404);
      }
    });

    app.delete("/schedules/:agentId/:id", async (c) => {
      const agentId = c.req.param("agentId");
      const id = c.req.param("id");
      const scheduler = getScheduler();
      const result = await scheduler.remove(agentId, id);
      if (!result.removed) {
        return c.json({ error: "Schedule not found" }, 404);
      }
      return c.json({ ok: true });
    });
  },
  async start(ctx: ExtensionContext) {
    setSchedulerContext(ctx);
    await startScheduler();
  },
  async stop() {
    await stopScheduler();
    clearSchedulerContext();
  },
  capabilities() {
    return ["schedules"];
  },
};

export { schedulerExtension };

export {
  SchedulerService,
  getScheduler,
  startScheduler,
  stopScheduler,
  computeNextRunAtMs,
  getAgentJobsPath,
  hasSchedulerContext,
};
export { latestAssistantText, writeCronRunOutput } from "./output.js";

export { registerSchedulerCommands } from "./cli/index.js";
