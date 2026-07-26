import { Command } from "commander";
import { createInterface } from "node:readline";
import type {
  CreateScheduleRequest,
  ScheduleJob,
  UpdateScheduleRequest,
} from "@yoplai/shared";
import { SchedulerApiClient, SchedulerApiError } from "./client.js";
import {
  buildScheduleFromOpts,
  defaultJobName,
  renderJobsTable,
  type JobWithState,
  type ScheduleInputOpts,
} from "./schedule-input.js";

type AddOpts = ScheduleInputOpts & {
  message: string;
  name?: string;
  session?: string;
  provider?: string;
  model?: string;
  disabled?: boolean;
  json?: boolean;
};

type UpdateOpts = ScheduleInputOpts & {
  name?: string;
  enable?: boolean;
  disable?: boolean;
  message?: string;
  session?: string;
  provider?: string;
  model?: string;
  json?: boolean;
};

type DeleteOpts = {
  yes?: boolean;
  json?: boolean;
};

type ListOpts = { agent?: string; json?: boolean };
type RunOpts = { json?: boolean };
type TailOpts = { lines?: string };

function fail(err: unknown): never {
  if (err instanceof Error) console.error(err.message);
  else console.error("Request failed");
  process.exit(1);
}

function failedRunOutputPath(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("data" in err)) {
    return undefined;
  }
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || !("result" in data)) {
    return undefined;
  }
  const result = (data as { result?: unknown }).result;
  if (typeof result !== "object" || result === null || !("outputPath" in result)) {
    return undefined;
  }
  const outputPath = (result as { outputPath?: unknown }).outputPath;
  return typeof outputPath === "string" ? outputPath : undefined;
}

function getClient(): SchedulerApiClient {
  return new SchedulerApiClient();
}

function printJobs(jobs: JobWithState[], json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }
  console.log(renderJobsTable(jobs));
}

function buildModelOverride(opts: { provider?: string; model?: string }) {
  const provider = opts.provider?.trim();
  const model = opts.model?.trim();
  if (!provider && !model) return undefined;
  if (!provider || !model) {
    throw new Error("Both --provider and --model are required for model override.");
  }
  return { provider, model };
}

async function confirmDelete(agentId: string, id: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) =>
    rl.question(`Delete schedule ${agentId}/${id}? [y/N] `, resolve)
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export function buildCreateBody(
  agentId: string,
  opts: AddOpts
): CreateScheduleRequest {
  const schedule = buildScheduleFromOpts(opts);
  const name = opts.name?.trim() || defaultJobName(agentId, schedule);
  const payload: CreateScheduleRequest["payload"] = { message: opts.message };
  if (opts.session) payload.sessionId = opts.session;
  const model = buildModelOverride(opts);
  return { name, agentId, schedule, ...(model ? { model } : {}), payload };
}

export function buildUpdateBody(opts: UpdateOpts): UpdateScheduleRequest {
  const body: UpdateScheduleRequest = {};
  if (opts.enable && opts.disable) {
    throw new Error("Use either --enable or --disable, not both.");
  }
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.enable) body.enabled = true;
  if (opts.disable) body.enabled = false;

  const hasScheduleOpt = Boolean(opts.cron) || Boolean(opts.tz) || Boolean(opts.startAt);
  if (hasScheduleOpt) body.schedule = buildScheduleFromOpts(opts);

  const model = buildModelOverride(opts);
  if (model) body.model = model;

  if (opts.message !== undefined || opts.session !== undefined) {
    if (opts.message === undefined) {
      throw new Error("--session also requires -m <message> (server replaces payload).");
    }
    const payload: NonNullable<UpdateScheduleRequest["payload"]> = {
      message: opts.message,
    };
    if (opts.session) payload.sessionId = opts.session;
    body.payload = payload;
  }

  if (Object.keys(body).length === 0) {
    throw new Error("Nothing to update. Pass --name/--enable/--disable/--cron/-m/--model.");
  }
  return body;
}

export function registerSchedulerCommands(program: Command): Command {
  program
    .command("list")
    .description("List schedules")
    .option("--agent <id>", "Filter by agent id")
    .option("-j, --json", "JSON output")
    .action(async (opts: ListOpts) => {
      try {
        const jobs = await getClient().listSchedules(opts.agent);
        printJobs(jobs as JobWithState[], opts.json);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("add")
    .alias("create")
    .description("Create a schedule")
    .argument("<agent-id>", "Agent id to invoke")
    .requiredOption("-m, --message <text>", "Message to send on each fire")
    .requiredOption("--cron <expr>", "Cron expression, e.g. '0 8 * * *'")
    .requiredOption("--tz <iana>", "IANA timezone")
    .option("--name <name>", "Schedule name (default: <agent>-<cron>)")
    .option("--start-at <iso>", "ISO 8601 anchor")
    .option("--session <id>", "Session id override")
    .option("--provider <provider>", "Model provider override")
    .option("--model <model>", "Model name override")
    .option("--disabled", "Create disabled")
    .option("-j, --json", "JSON output")
    .action(async (agentId: string, opts: AddOpts) => {
      try {
        const body = buildCreateBody(agentId, opts);
        const client = getClient();
        let job = (await client.createSchedule(body)) as JobWithState;
        if (opts.disabled) {
          job = (await client.updateSchedule(agentId, job.id, {
            enabled: false,
          })) as JobWithState;
        }
        printJobs([job], opts.json);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("update")
    .description("Update a schedule")
    .argument("<agent-id>", "Agent id")
    .argument("<job-id>", "Schedule id")
    .option("--name <name>", "Rename")
    .option("--enable", "Enable the schedule")
    .option("--disable", "Disable the schedule")
    .option("--cron <expr>", "Cron expression")
    .option("--tz <iana>", "IANA timezone")
    .option("--start-at <iso>", "Anchor")
    .option("-m, --message <text>", "Replace payload message")
    .option("--session <id>", "Replace payload session id (requires -m)")
    .option("--provider <provider>", "Model provider override (requires --model)")
    .option("--model <model>", "Model name override (requires --provider)")
    .option("-j, --json", "JSON output")
    .action(async (agentId: string, id: string, opts: UpdateOpts) => {
      try {
        const body = buildUpdateBody(opts);
        const job = (await getClient().updateSchedule(agentId, id, body)) as JobWithState;
        printJobs([job], opts.json);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("rm")
    .alias("delete")
    .description("Delete a schedule")
    .argument("<agent-id>", "Agent id")
    .argument("<job-id>", "Schedule id")
    .option("-y, --yes", "Skip confirmation")
    .option("-j, --json", "JSON output")
    .action(async (agentId: string, id: string, opts: DeleteOpts) => {
      try {
        if (!opts.yes) {
          const ok = await confirmDelete(agentId, id);
          if (!ok) {
            console.error("Aborted.");
            process.exit(1);
          }
        }
        const result = await getClient().deleteSchedule(agentId, id);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Deleted schedule ${agentId}/${id}`);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("run")
    .description("Run a schedule immediately")
    .argument("<agent-id>", "Agent id")
    .argument("<job-id>", "Schedule id")
    .option("-j, --json", "JSON output")
    .action(async (agentId: string, id: string, opts: RunOpts) => {
      try {
        const result = await getClient().runSchedule(agentId, id);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Ran schedule ${agentId}/${id}: ${result.status}`);
        if (result.outputPath) console.log(`Output: ${result.outputPath}`);
      } catch (err) {
        if (err instanceof SchedulerApiError || failedRunOutputPath(err)) {
          const outputPath = failedRunOutputPath(err);
          console.error(err instanceof Error ? err.message : "Request failed");
          if (outputPath) console.error(`Output: ${outputPath}`);
          process.exit(1);
        }
        fail(err);
      }
    });

  program
    .command("tail")
    .description("Print latest schedule output")
    .argument("<agent-id>", "Agent id")
    .argument("<job-id>", "Schedule id")
    .option("-n, --lines <n>", "Line count", "80")
    .action(async (agentId: string, id: string, opts: TailOpts) => {
      try {
        const jobs = await getClient().listSchedules(agentId);
        const job = jobs.find((candidate) => candidate.id === id);
        if (!job) throw new Error(`Schedule not found: ${agentId}/${id}`);
        const output = await getClient().request<{ content?: string }>(
          `/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}/tail`
        );
        const content = output.content ?? "";
        const count = Number.parseInt(opts.lines ?? "80", 10);
        console.log(content.split(/\r?\n/).slice(-count).join("\n"));
      } catch (err) {
        fail(err);
      }
    });

  return program;
}

export type { ScheduleJob };
