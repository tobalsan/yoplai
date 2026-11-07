import {
  CreateScheduleRequestSchema,
  DeliverTargetSchema,
  ScheduleSchema,
  SchedulerExtensionConfigSchema,
  UpdateScheduleRequestSchema,
  type AgentConfig,
  type Extension,
  type ExtensionAgentTool,
  type ExtensionContext,
  type ScheduleAlert,
  type DeliveryOffer,
} from "@yoplai/shared";
import { z } from "zod";
import type { Context, Hono } from "hono";
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
import { computeNextRunAtMs, parseRunAtInput } from "./schedule.js";
import { resolveScriptLaunch } from "./script.js";
import { getAgentJobsPath, readLatestOutputFile } from "./store.js";

const scheduleInputSchema = z.object({
  cron: z.string().min(1).optional(),
  tz: z.string().min(1).optional(),
  startAt: z.string().optional(),
  runAt: z.string().min(1).optional(),
});

function parseToolSchedule(input: z.infer<typeof scheduleInputSchema>) {
  return ScheduleSchema.parse({
    ...input,
    runAt: input.runAt === undefined ? undefined : parseRunAtInput(input.runAt),
  });
}

const createJobToolSchema = z.object({
  name: z.string().min(1),
  credentialMode: z.enum(["owner", "team"]).optional(),
  cron: z.string().min(1).optional(),
  tz: z.string().min(1).optional(),
  startAt: z.string().optional(),
  runAt: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  sessionId: z.string().optional(),
  script: z.string().min(1).optional(),
  noAgent: z.boolean().optional(),
  quietOutput: z.boolean().optional(),
  deliver: z.array(DeliverTargetSchema).optional(),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
  timeoutMs: z.number().positive().optional(),
});

const updateJobToolSchema = z.object({
  jobId: z.string().min(1),
  credentialMode: z.enum(["owner", "team"]).optional(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  schedule: scheduleInputSchema.optional(),
  message: z.string().min(1).nullable().optional(),
  sessionId: z.string().nullable().optional(),
  script: z.string().min(1).nullable().optional(),
  noAgent: z.boolean().optional(),
  quietOutput: z.boolean().optional(),
  deliver: z.array(DeliverTargetSchema).optional(),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
  timeoutMs: z.number().positive().optional(),
});

const jobIdToolSchema = z.object({ jobId: z.string().min(1) });

const latestOutputToolSchema = z.object({
  jobId: z.string().min(1),
  maxChars: z.number().int().positive().max(20_000).optional(),
});

function toolError(error: unknown) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

const SCRIPT_PATH_HINT =
  "Job scripts run on the gateway host, not in your container, and the script path is relative to the agent workspace root. " +
  "Inside a container, /workspace/files (the conversation folder) and /workspace/uploads are not under the workspace root, " +
  "so keep job scripts under the workspace root (e.g. data/).";

const SCRIPT_RUNTIME_GUIDANCE =
  "Scripts run on the gateway host, not in your container, with cwd = the agent workspace root: use relative paths " +
  "and never reference /workspace/... container paths inside the script. /workspace/files (the conversation folder) " +
  "and /workspace/uploads are not part of the workspace root. Non-.sh/.bash scripts need a shebang and chmod +x.";

/** Checks a job script now, so a bad path fails at save time, not at the first run. */
async function scriptValidationError(
  agent: AgentConfig,
  script: string
): Promise<string | undefined> {
  try {
    await resolveScriptLaunch(getSchedulerContext().resolveWorkspaceDir(agent), script);
    return undefined;
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}. ${SCRIPT_PATH_HINT}`;
  }
}

function requestUserId(c: Context): string | undefined {
  const context = c as Context<{
    Variables: { multiUserAuthContext?: { session: { userId: string } } };
  }>;
  return context.get("multiUserAuthContext")?.session.userId;
}

async function canAccessAgent(c: Context, agentId: string): Promise<boolean> {
  if (!getSchedulerContext().getConfig().extensions?.multiUser?.enabled) return true;
  const { getRequestAuthContext, hasAgentAccess } = await import("@yoplai/extension-multi-user");
  const auth = getRequestAuthContext(c);
  return !!auth && hasAgentAccess(auth, agentId);
}

async function canAccessJob(agentId: string, id: string, userId?: string): Promise<boolean> {
  const job = (await getScheduler().list(agentId)).find(
    (candidate) => candidate.id === id
  );
  return !!job && (!job.ownerUserId || job.ownerUserId === userId);
}

const credentialModeGuidance =
  'Mine (owner) is private to its owner and uses personal credentials with team fallback; Team (team) is visible and editable by everyone with agent access and uses team credentials only. ' +
  'Choose team for channel delivery, "for the team"/"everyone", or shared routines; choose owner for DM delivery, personal data ("my inbox", "my Drive"), or reminders. ' +
  'When unclear, ask: "Private to you, or shared with the team?" After creation say "Created as a private job" or "Shared with the team". Defaults to owner when signed in; never share by accident.';

export function buildDeliveryGuidance(offers: DeliveryOffer[]): string | undefined {
  const owner = offers.flatMap((offer) => offer.dm
    ? [`- DM to you on ${offer.label}: \`${JSON.stringify({ target: offer.target, user: offer.dm.user })}\``]
    : []);
  const team = offers.filter((offer) => offer.channel).map((offer) =>
    `- Team channel on ${offer.label}: target \`${offer.target}\`; ask the user which channel, never guess an id.`);
  if (!owner.length && !team.length) return undefined;
  return [
    'Before creating a job with no deliver, ask once "Do you want the results posted somewhere?" unless the user already named a destination or already declined. Do not ask again in this conversation after a decline; create without deliver.',
    "For update_job, apply the same single ask only when the job has no deliver and the change affects payload, schedule or credentialMode; not for name or enabled changes alone.",
    "Only ask when an option fits the job's credentialMode: owner (private) jobs may use DM options only; team jobs may use channel options only. Never change the credentialMode to make a destination fit.",
    owner.length ? `Owner (private) options:\n${owner.join("\n")}` : "Owner (private) options: none; do not ask, create without deliver.",
    team.length ? `Team options:\n${team.join("\n")}` : "Team options: none; do not ask, create without deliver.",
    "A delivery target receives every run's result, not only errors (a silent tick or empty script stdout delivers nothing; errors always deliver).",
    "Offer nothing outside this list. If no option fits the job's credentialMode, do not ask; proceed without deliver.",
  ].join("\n");
}

async function creatorDisplayName(userId: string): Promise<string | undefined> {
  try {
    const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
    return (getMultiUserRuntime()?.db.prepare("SELECT name FROM user WHERE id = ?").get(userId) as { name: string } | undefined)?.name;
  } catch {
    return undefined;
  }
}

/** Team jobs require agent management; private jobs stay with their owner. Userless/single-user callers are trusted. */
async function canManageJob(job: { ownerUserId?: string; agentId: string }, userId?: string): Promise<boolean> {
  if (job.ownerUserId || !userId) return true;
  try {
    const { getMultiUserRuntime, canManageAgent } = await import("@yoplai/extension-multi-user");
    const runtime = getMultiUserRuntime();
    if (!runtime) return true;
    const role = (runtime.db.prepare("SELECT role FROM user WHERE id = ?").get(userId) as { role?: string | null } | undefined)?.role;
    return canManageAgent({ user: { id: userId, role: role?.split(",").map((value) => value.trim()) }, session: { id: "scheduler", userId } }, job.agentId);
  } catch {
    return false;
  }
}

async function isSuperadmin(userId?: string): Promise<boolean> {
  if (!userId || !getSchedulerContext().getConfig().extensions?.multiUser?.enabled) return false;
  try {
    const { getMultiUserRuntime, getEligibleAccount } = await import("@yoplai/extension-multi-user");
    const runtime = getMultiUserRuntime();
    return !!runtime && getEligibleAccount(runtime.db, userId, { approvalBypass: "superadmin" })?.role === "superadmin";
  } catch {
    return false;
  }
}

async function canReadJob(agentId: string, id: string, userId?: string): Promise<boolean> {
  if (await canAccessJob(agentId, id, userId)) return true;
  return await isSuperadmin(userId) && (await getScheduler().list(agentId)).some((job) => job.id === id);
}

function schedulerAgentTools(): ExtensionAgentTool[] {
  return [
    {
      name: "scheduler.list_jobs",
      description: "List this agent's scheduled jobs",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(_args, { agent, userId }) {
        try {
          const jobs = (await getScheduler().list(agent.id)).filter(
            (job) => !job.ownerUserId || job.ownerUserId === userId
          );
          return { ok: true, jobs };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "scheduler.create_job",
      description:
        "Create an enabled scheduled job for this agent. Set cron + tz for recurrence, or runAt for one shot (ISO 8601 or 'in 30m'/'in 2h'); exactly one of cron and runAt is required. Choose one of three payload shapes: " +
        "(1) message only — an agent job; the LLM runs every tick, use when the tick needs reasoning. " +
        "(2) script + noAgent: true — script-only; the scheduler runs the script as a subprocess and " +
        "success/failure is decided by its exit code alone, never by an LLM self-report — no model tokens, " +
        "no agent loop. Use for deterministic recurring work like token rotation, watchdogs, or health " +
        "checks. (3) script + message (without noAgent) — gated; the script runs first as a cheap check " +
        "and only wakes the agent (with message) when its final stdout line is JSON with " +
        '{"wakeAgent": true}. Use for file-change gates, threshold alerts, or new-rows pollers that ' +
        "should stay silent most ticks. Set quietOutput: true on high-frequency script jobs to skip " +
        "writing an output file for uneventful runs (errors and woke-agent runs always write one). " +
        SCRIPT_RUNTIME_GUIDANCE + " " +
        "Scripts can POST {tool,args,agentId,agentToken,sessionId,runId} to YOPLAI_TOOL_URL/internal/tools using " +
        "YOPLAI_TOOL_TOKEN, YOPLAI_AGENT_ID, YOPLAI_SESSION_ID and YOPLAI_RUN_ID from env. " +
        "Optional deliver pushes each run's result to comm-channel targets: this happens at the RUNTIME " +
        "level after the run resolves, not as an LLM action — do NOT call a *.send_message tool yourself " +
        "to report cron results, that would duplicate delivery and the agent is not trusted to self-report " +
        "success/failure. Optional timeoutMs overrides the per-run timeout (default 30 minutes). " + credentialModeGuidance,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          credentialMode: {
            type: "string",
            enum: ["owner", "team"],
            description: credentialModeGuidance,
          },
          cron: { type: "string" },
          tz: { type: "string" },
          startAt: { type: "string" },
          runAt: { type: "string" },
          message: {
            type: "string",
            description:
              "Prompt for an agent job, or the wake prompt for a gated job. Omit for a script-only job (noAgent: true).",
          },
          sessionId: { type: "string" },
          script: {
            type: "string",
            description:
              "Relative path (from the agent workspace root) to an existing script to run. Required for script-only and gated jobs. " +
              SCRIPT_RUNTIME_GUIDANCE,
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
                  description:
                    "Delivery sink id from the offered list in the system prompt.",
                },
                channel: { type: "string" },
                user: { type: "string" },
              },
              required: ["target"],
            },
            description:
              "Destinations receive every run's result, not only errors: agent job or woke " +
              "gated run delivers the response, script-only delivers trimmed stdout (nothing when empty), " +
              "a silent tick delivers nothing, and any error always delivers an alert. Each entry needs " +
              "target and exactly one of channel or user.",
          },
          model: {
            type: "object",
            properties: { provider: { type: "string" }, model: { type: "string" } },
            required: ["provider", "model"],
            description:
              "Per-job model override, e.g. {provider: \"anthropic\", model: \"claude-opus-5-5\"}. " +
              "Omit to use the agent's default model.",
          },
          timeoutMs: { type: "number" },
        },
        required: ["name"],
      },
      async execute(args, { agent, userId }) {
        try {
          const input = createJobToolSchema.parse(args);
          // Checked before the request schema so its relative-path rule also
          // gets the host/workspace hint.
          if (input.script !== undefined) {
            const scriptError = await scriptValidationError(agent, input.script);
            if (scriptError) return { ok: false, error: scriptError };
          }
          const parsed = CreateScheduleRequestSchema.parse({
            agentId: agent.id,
            name: input.name,
            credentialMode: input.credentialMode,
            schedule: parseToolSchedule({
              cron: input.cron,
              tz: input.tz,
              startAt: input.startAt,
              runAt: input.runAt,
            }),
            payload: {
              message: input.message,
              sessionId: input.sessionId,
              script: input.script,
              noAgent: input.noAgent,
              quietOutput: input.quietOutput,
            },
            deliver: input.deliver,
            model: input.model,
            timeoutMs: input.timeoutMs,
          });
          const { agentId, ...body } = parsed;
          return { ok: true, job: await getScheduler().add(agentId!, body, userId) };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "scheduler.update_job",
      description:
        "Update this agent's scheduled job. A replacement schedule requires cron + tz or runAt (ISO 8601 or relative); exactly one of cron and runAt. Only the fields you provide change; omit a field to " +
        "leave it unchanged, or pass null for message/script/sessionId to clear it (needed when moving " +
        "a job between payload shapes). Payload fields (message, script, noAgent, quietOutput) follow the same " +
        "mode rules as scheduler.create_job: message only = agent job; script + noAgent: true = " +
        "script-only (exit code decides success, the agent is never called); script + message = gated " +
        '(wakes the agent only when the script\'s final stdout line is JSON with {"wakeAgent": true}); ' +
        "quietOutput: true skips the output file for uneventful script ticks. " +
        SCRIPT_RUNTIME_GUIDANCE + " " +
        "Scripts can POST {tool,args,agentId,agentToken,sessionId,runId} to YOPLAI_TOOL_URL/internal/tools using " +
        "YOPLAI_TOOL_TOKEN, YOPLAI_AGENT_ID, YOPLAI_SESSION_ID and YOPLAI_RUN_ID from env. deliver replaces the job's " +
        "whole delivery list when provided (pass [] to clear it, omit to leave it unchanged); results are " +
        "pushed by the RUNTIME after each run, so do NOT call a *.send_message tool yourself to report " +
        "cron results. Set timeoutMs to override the per-run timeout in milliseconds (default 30 minutes). " + credentialModeGuidance,
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          credentialMode: { type: "string", enum: ["owner", "team"], description: credentialModeGuidance },
          name: { type: "string" },
          enabled: { type: "boolean" },
          schedule: {
            type: "object",
            properties: {
              cron: { type: "string" },
              tz: { type: "string" },
              startAt: { type: "string" },
              runAt: { type: "string" },
            },
          },
          message: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "Prompt for an agent job, or the wake prompt for a gated job. Pass null to drop it, e.g. when switching the job to script-only (noAgent: true).",
          },
          sessionId: { anyOf: [{ type: "string" }, { type: "null" }] },
          script: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "Relative path (from the agent workspace root) to an existing script to run. Required for script-only and gated jobs; pass null to drop it and go back to a plain agent job. " +
              SCRIPT_RUNTIME_GUIDANCE,
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
                  description:
                    "Delivery sink id from the offered list in the system prompt.",
                },
                channel: { type: "string" },
                user: { type: "string" },
              },
              required: ["target"],
            },
            description:
              "Replaces the job's whole delivery list. Pass an empty array to clear all delivery targets; " +
              "omit this field to leave the current list unchanged. Targets receive every run's result, not only errors " +
              "(a silent tick or empty script stdout delivers nothing; errors always deliver). Each entry needs target and exactly " +
              "one of channel or user.",
          },
          model: {
            type: "object",
            properties: { provider: { type: "string" }, model: { type: "string" } },
            required: ["provider", "model"],
            description:
              "Per-job model override, e.g. {provider: \"anthropic\", model: \"claude-opus-5-5\"}. " +
              "Omit to use the agent's default model.",
          },
          timeoutMs: { type: "number" },
        },
        required: ["jobId"],
      },
      async execute(args, { agent, userId }) {
        try {
          const input = updateJobToolSchema.parse(args);
          const [existing] = (await getScheduler().list(agent.id)).filter(
            (job) => job.id === input.jobId
          );
          if (!existing) return { ok: false, error: "Schedule not found" };
          if (!(await canAccessJob(agent.id, input.jobId, userId))) return { ok: false, error: "Schedule owner access required" };
          if (input.enabled !== undefined && input.enabled !== existing.enabled && !(await canManageJob(existing, userId))) {
            return { ok: false, error: "Only admins can pause or resume Team jobs" };
          }
          // Only a newly supplied script is checked: renaming or pausing a job
          // must keep working even if its current script has gone missing.
          if (typeof input.script === "string") {
            const scriptError = await scriptValidationError(agent, input.script);
            if (scriptError) return { ok: false, error: scriptError };
          }
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
                  quietOutput:
                    input.quietOutput ?? existing.payload.quietOutput,
                }
              : undefined;
          const patch = UpdateScheduleRequestSchema.parse({
            name: input.name,
            credentialMode: input.credentialMode,
            enabled: input.enabled,
            schedule: input.schedule
              ? parseToolSchedule(input.schedule)
              : undefined,
            payload,
            deliver: input.deliver,
            model: input.model,
            timeoutMs: input.timeoutMs,
          });
          return {
            ok: true,
            job: await getScheduler().update(agent.id, input.jobId, patch, userId),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "scheduler.delete_job",
      description: "Delete this agent's scheduled job by id",
      parameters: {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
      },
      async execute(args, { agent, userId }) {
        try {
          const input = jobIdToolSchema.parse(args);
          if (!(await canAccessJob(agent.id, input.jobId, userId))) return { ok: false, error: "Schedule owner access required" };
          const job = (await getScheduler().list(agent.id)).find((candidate) => candidate.id === input.jobId);
          if (job && !(await canManageJob(job, userId))) return { ok: false, error: "Only admins can delete Team jobs" };
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
      name: "scheduler.run_job",
      description:
        "Trigger one of this agent's scheduler jobs immediately, outside its cron schedule. Runs in the background; use scheduler.get_latest_output later to read the result.",
      parameters: {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
      },
      async execute(args, { agent, userId }) {
        try {
          const input = jobIdToolSchema.parse(args);
          if (!(await canAccessJob(agent.id, input.jobId, userId))) return { ok: false, error: "Schedule owner access required" };
          const result = await getScheduler().runNowDetached(
            agent.id,
            input.jobId
          );
          return {
            ok: true,
            status: result.status,
            sessionId: result.sessionId,
            firedAt: result.firedAt,
          };
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
            description:
              "Required. Job ID from scheduler.list_jobs (jobs[n].id).",
          },
          maxChars: {
            type: "number",
            minimum: 1,
            maximum: 20000,
            description:
              "Optional maximum preview length in characters. Defaults to 4000.",
          },
        },
        required: ["jobId"],
      },
      async execute(args, { agent, userId }) {
        try {
          const parsed = latestOutputToolSchema.safeParse(args);
          if (!parsed.success) {
            const hasJobIdError = parsed.error.issues.some(
              (issue) => issue.path[0] === "jobId"
            );
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
          if (!(await canAccessJob(agent.id, input.jobId, userId))) return { ok: false, error: "Schedule owner access required" };
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
  routePrefixes: ["/api/schedules", "/api/schedule-alerts"],
  validateConfig(raw) {
    const result = SchedulerExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success
        ? []
        : result.error.issues.map((issue) => issue.message),
    };
  },
  getAgentTools(_agent, context) {
    if (context?.config.extensions?.scheduler?.enabled === false) return [];
    return schedulerAgentTools();
  },
  async getSystemPromptContributions(agent, context) {
    if (context?.config.extensions?.scheduler?.enabled === false) return undefined;
    const prompt = "Scheduled jobs: " + credentialModeGuidance;
    if (!context || !hasSchedulerContext()) return prompt;
    const offers = await getSchedulerContext().getDeliveryOffers?.(agent, { userId: context.userId }) ?? [];
    const guidance = buildDeliveryGuidance(offers);
    return guidance ? `${prompt}\n\n${guidance}` : prompt;
  },
  registerRoutes(app: Hono) {
    app.get("/schedule-alerts", async (c) => {
      const userId = requestUserId(c);
      const multiUser = getSchedulerContext().getConfig().extensions?.multiUser?.enabled;
      const alerts: ScheduleAlert[] = [];
      for (const job of await getScheduler().list()) {
        if (job.enabled !== false || !job.pausedReason) continue;
        if (!(await canAccessAgent(c, job.agentId))) continue;
        if (multiUser && job.ownerUserId && job.ownerUserId !== userId) continue;
        if (multiUser && !(await canManageJob(job, userId))) continue;
        alerts.push({
          agentId: job.agentId,
          jobId: job.id,
          jobName: job.name,
          mode: job.credentialMode ?? "team",
          pausedReason: job.pausedReason,
        });
      }
      return c.json(alerts);
    });
    app.use("/schedules/:agentId/*", async (c, next) => {
      if (!(await canAccessAgent(c, c.req.param("agentId")))) return c.json({ error: "Agent access required" }, 403);
      await next();
    });
    app.get("/schedules", async (c) => {
      const scheduler = getScheduler();
      const agentId = c.req.query("agent") ?? undefined;
      if (agentId && !(await canAccessAgent(c, agentId))) return c.json({ error: "Agent access required" }, 403);
      const userId = requestUserId(c);
      const superadmin = await isSuperadmin(userId);
      const ownedJobs = (await scheduler.list(agentId)).filter((job) => superadmin || !job.ownerUserId || job.ownerUserId === userId);
      const jobs = (await Promise.all(ownedJobs.map(async (job) =>
        await canAccessAgent(c, job.agentId) ? job : undefined
      ))).filter((job) => job !== undefined);
      return c.json(await Promise.all(jobs.map(async (job) => {
        if (superadmin && job.ownerUserId && job.ownerUserId !== userId) {
          return { ...job, ownerDisplayName: await creatorDisplayName(job.ownerUserId) };
        }
        if (job.ownerUserId || !job.createdByUserId) return job;
        return { ...job, createdByDisplayName: await creatorDisplayName(job.createdByUserId) };
      })));
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
      if (!(await canAccessAgent(c, parsed.data.agentId))) return c.json({ error: "Agent access required" }, 403);
      const scheduler = getScheduler();
      const { agentId, ...input } = parsed.data;
      try {
        const job = await scheduler.add(agentId, input, requestUserId(c));
        return c.json(job, 201);
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error ? error.message : "Schedule create failed",
          },
          404
        );
      }
    });

    app.get("/schedules/:agentId/:id/runs", async (c) => {
      if (!getSchedulerContext().getConfig().enableCronMonitoring) {
        return c.json({ error: "Not found" }, 404);
      }
      const agentId = c.req.param("agentId");
      const id = c.req.param("id");
      if (!(await canReadJob(agentId, id, requestUserId(c)))) {
        return c.json({ error: "Schedule owner access required" }, 403);
      }
      return c.json({ runs: await getScheduler().listRuns(agentId, id) });
    });

    app.get("/schedules/:agentId/:id/runs/:runId/trace", async (c) => {
      if (!getSchedulerContext().getConfig().enableCronMonitoring) {
        return c.json({ error: "Not found" }, 404);
      }
      const agentId = c.req.param("agentId");
      const id = c.req.param("id");
      if (!(await canReadJob(agentId, id, requestUserId(c)))) {
        return c.json({ error: "Schedule owner access required" }, 403);
      }
      const trace = await getScheduler().getRunTrace(agentId, id, c.req.param("runId"));
      if (!trace) return c.json({ error: "Run not found" }, 404);
      if (trace.run.sessionId && !getSchedulerContext().getFullSessionHistory) {
        return c.json({ error: "Full history unavailable" }, 503);
      }
      return c.json(trace);
    });

    app.get("/schedules/:agentId/:id/tail", async (c) => {
      const agentId = c.req.param("agentId");
      const id = c.req.param("id");
      if (!(await canReadJob(agentId, id, requestUserId(c)))) return c.json({ error: "Schedule owner access required" }, 403);
      const ctx = getSchedulerContext();
      const agent = ctx.getAgent(agentId);
      if (!agent) return c.json({ error: "Agent not found" }, 404);
      const latest = await readLatestOutputFile(
        ctx.resolveWorkspaceDir(agent),
        id
      );
      if (!latest) return c.json({ error: "Output not found" }, 404);
      return c.json(latest);
    });

    app.post("/schedules/:agentId/:id/run", async (c) => {
      const agentId = c.req.param("agentId");
      const id = c.req.param("id");
      const scheduler = getScheduler();
      if (!(await canAccessJob(agentId, id, requestUserId(c)))) return c.json({ error: "Schedule owner access required" }, 403);
      try {
        const result = await scheduler.runNowDetached(agentId, id);
        return c.json(result, 202);
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
      if (!(await canAccessJob(agentId, id, requestUserId(c)))) return c.json({ error: "Schedule owner access required" }, 403);
      try {
        const previous = (await scheduler.list(agentId)).find((candidate) => candidate.id === id);
        const previousMode = previous?.credentialMode ?? "team";
        const previousOwnerUserId = previous?.ownerUserId;
        if (previous && parsed.data.enabled !== undefined && parsed.data.enabled !== previous.enabled && !(await canManageJob(previous, requestUserId(c)))) {
          return c.json({ error: "team_requires_admin" }, 403);
        }
        const job = await scheduler.update(agentId, id, parsed.data, requestUserId(c));
        if (previous && previousMode !== (job.credentialMode ?? "team")) {
          const auth = (c as unknown as Context<{ Variables: { multiUserAuthContext?: {
            session: { userId: string }; user?: { email?: string }; impersonator?: { id: string };
          } } }>).get("multiUserAuthContext");
          getSchedulerContext().audit?.record({
            actorUserId: auth?.session.userId, actorEmail: auth?.user?.email, impersonatorUserId: auth?.impersonator?.id,
            action: "schedule.credential_mode", agentId, targetType: "schedule", targetId: id,
            changes: [
              { field: "credentialMode", before: previousMode, after: job.credentialMode ?? "team" },
              { field: "ownerUserId", before: previousOwnerUserId, after: job.ownerUserId },
            ],
          });
        }
        return c.json(job);
      } catch {
        return c.json({ error: "Schedule not found" }, 404);
      }
    });

    app.delete("/schedules/:agentId/:id", async (c) => {
      const agentId = c.req.param("agentId");
      const id = c.req.param("id");
      const scheduler = getScheduler();
      if (!(await canAccessJob(agentId, id, requestUserId(c)))) return c.json({ error: "Schedule owner access required" }, 403);
      const job = (await scheduler.list(agentId)).find((candidate) => candidate.id === id);
      if (job && !(await canManageJob(job, requestUserId(c)))) return c.json({ error: "team_requires_admin" }, 403);
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
