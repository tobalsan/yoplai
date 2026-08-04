import {
  CreateScheduleRequestSchema,
  DeliverTargetSchema,
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
  message: z.string().min(1).optional(),
  sessionId: z.string().optional(),
  script: z.string().min(1).optional(),
  noAgent: z.boolean().optional(),
  quietOutput: z.boolean().optional(),
  deliver: z.array(DeliverTargetSchema).optional(),
  timeoutMs: z.number().positive().optional(),
});

const updateJobToolSchema = z.object({
  jobId: z.string().min(1),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  schedule: scheduleInputSchema.optional(),
  message: z.string().min(1).nullable().optional(),
  sessionId: z.string().nullable().optional(),
  script: z.string().min(1).nullable().optional(),
  noAgent: z.boolean().optional(),
  quietOutput: z.boolean().optional(),
  deliver: z.array(DeliverTargetSchema).optional(),
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
        "Create an enabled scheduler cron job for this agent. Choose one of three payload shapes: " +
        "(1) message only — an agent job; the LLM runs every tick, use when the tick needs reasoning. " +
        "(2) script + noAgent: true — script-only; the scheduler runs the script as a subprocess and " +
        "success/failure is decided by its exit code alone, never by an LLM self-report — no tokens, " +
        "no agent loop. Use for deterministic recurring work like token rotation, watchdogs, or health " +
        "checks. (3) script + message (without noAgent) — gated; the script runs first as a cheap check " +
        "and only wakes the agent (with message) when its final stdout line is JSON with " +
        '{"wakeAgent": true}. Use for file-change gates, threshold alerts, or new-rows pollers that ' +
        "should stay silent most ticks. Set quietOutput: true on high-frequency script jobs to skip " +
        "writing an output file for uneventful runs (errors and woke-agent runs always write one). " +
        "Optional deliver pushes each run's result to comm-channel targets: this happens at the RUNTIME " +
        "level after the run resolves, not as an LLM action — do NOT call a *.send_message tool yourself " +
        "to report cron results, that would duplicate delivery and the agent is not trusted to self-report " +
        "success/failure. Optional timeoutMs overrides the per-run timeout (default 30 minutes).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          cron: { type: "string" },
          tz: { type: "string" },
          startAt: { type: "string" },
          message: {
            type: "string",
            description:
              "Prompt for an agent job, or the wake prompt for a gated job. Omit for a script-only job (noAgent: true).",
          },
          sessionId: { type: "string" },
          script: {
            type: "string",
            description:
              "Relative path (from the agent workspace root) to a script to run. Required for script-only and gated jobs.",
          },
          noAgent: {
            type: "boolean",
            description:
              "Script-only mode: run the script and skip the agent entirely; success/failure is decided by the script's exit code. Requires script; rejects message.",
          },
          quietOutput: {
            type: "boolean",
            description:
              "Skip writing an output file for uneventful runs (exit 0 with empty stdout on script-only jobs, or a silent tick on gated jobs). Errors and woke-agent runs always write a file. Requires script.",
          },
          deliver: {
            type: "array",
            items: {
              type: "object",
              properties: {
                target: {
                  type: "string",
                  description: "Delivery sink id, e.g. \"slack\", \"telegram\", \"discord\".",
                },
                channel: { type: "string" },
                user: { type: "string" },
              },
              required: ["target"],
            },
            description:
              "Destinations the runtime pushes this job's result to after each run: agent job or woke " +
              "gated run delivers the response, script-only delivers trimmed stdout (nothing when empty), " +
              "a silent tick delivers nothing, and any error always delivers an alert. Each entry needs " +
              "target and exactly one of channel or user.",
          },
          timeoutMs: { type: "number" },
        },
        required: ["name", "cron", "tz"],
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
            payload: {
              message: input.message,
              sessionId: input.sessionId,
              script: input.script,
              noAgent: input.noAgent,
              quietOutput: input.quietOutput,
            },
            deliver: input.deliver,
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
        "Update this agent's scheduler cron job. Only the fields you provide change; omit a field to " +
        "leave it unchanged, or pass null for message/script/sessionId to clear it (needed when moving " +
        "a job between payload shapes). Payload fields (message, script, noAgent, quietOutput) follow the same " +
        "mode rules as scheduler.create_job: message only = agent job; script + noAgent: true = " +
        "script-only (exit code decides success, the agent is never called); script + message = gated " +
        '(wakes the agent only when the script\'s final stdout line is JSON with {"wakeAgent": true}); ' +
        "quietOutput: true skips the output file for uneventful script ticks. deliver replaces the job's " +
        "whole delivery list when provided (pass [] to clear it, omit to leave it unchanged); results are " +
        "pushed by the RUNTIME after each run, so do NOT call a *.send_message tool yourself to report " +
        "cron results. Set timeoutMs to override the per-run timeout in milliseconds (default 30 minutes).",
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
          message: {
            type: ["string", "null"],
            description:
              "Prompt for an agent job, or the wake prompt for a gated job. Pass null to drop it, e.g. when switching the job to script-only (noAgent: true).",
          },
          sessionId: { type: ["string", "null"] },
          script: {
            type: ["string", "null"],
            description:
              "Relative path (from the agent workspace root) to a script to run. Required for script-only and gated jobs; pass null to drop it and go back to a plain agent job.",
          },
          noAgent: {
            type: "boolean",
            description:
              "Script-only mode: run the script and skip the agent entirely; success/failure is decided by the script's exit code. Requires script; rejects message.",
          },
          quietOutput: {
            type: "boolean",
            description:
              "Skip writing an output file for uneventful runs (exit 0 with empty stdout on script-only jobs, or a silent tick on gated jobs). Errors and woke-agent runs always write a file. Requires script.",
          },
          deliver: {
            type: "array",
            items: {
              type: "object",
              properties: {
                target: {
                  type: "string",
                  description: "Delivery sink id, e.g. \"slack\", \"telegram\", \"discord\".",
                },
                channel: { type: "string" },
                user: { type: "string" },
              },
              required: ["target"],
            },
            description:
              "Replaces the job's whole delivery list. Pass an empty array to clear all delivery targets; " +
              "omit this field to leave the current list unchanged. Each entry needs target and exactly " +
              "one of channel or user.",
          },
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
            input.message !== undefined ||
            input.sessionId !== undefined ||
            input.script !== undefined ||
            input.noAgent !== undefined ||
            input.quietOutput !== undefined
              ? {
                  // null clears a field, so a job can be moved between the
                  // three payload shapes (e.g. agent job -> script-only needs
                  // message dropped) without deleting and re-creating it.
                  message:
                    input.message === null
                      ? undefined
                      : (input.message ?? existing.payload.message),
                  sessionId:
                    input.sessionId === null
                      ? undefined
                      : (input.sessionId ?? existing.payload.sessionId),
                  script:
                    input.script === null
                      ? undefined
                      : (input.script ?? existing.payload.script),
                  noAgent: input.noAgent ?? existing.payload.noAgent,
                  quietOutput: input.quietOutput ?? existing.payload.quietOutput,
                }
              : undefined;
          const patch = UpdateScheduleRequestSchema.parse({
            name: input.name,
            enabled: input.enabled,
            schedule: input.schedule,
            payload,
            deliver: input.deliver,
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
