import type {
  CreateScheduleRequest,
  ScheduleJob,
  UpdateScheduleRequest,
} from "@yoplai/shared";
import type { SchedulerRunResult } from "../service.js";
import { resolveConfig } from "./config.js";

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

type RequestOptions = {
  method?: HttpMethod;
  body?: unknown;
};

export class SchedulerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: unknown
  ) {
    super(message);
    this.name = "SchedulerApiError";
  }
}

export class SchedulerApiClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(config = resolveConfig()) {
    this.baseUrl = config.apiUrl;
    this.token = config.token;
  }

  async request<T = unknown>(
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = new URL(`/api${path}`, this.baseUrl).toString();
    const headers: Record<string, string> = {};

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await res.text();
    const data = text ? safeJson(text) : {};
    if (!res.ok) {
      const error =
        typeof data === "object" &&
        data !== null &&
        "error" in data &&
        typeof (data as { error: unknown }).error === "string"
          ? (data as { error: string }).error
          : `Request failed (${res.status})`;
      throw new SchedulerApiError(error, res.status, data);
    }
    return data as T;
  }

  listSchedules(agentId?: string): Promise<ScheduleJob[]> {
    const query = agentId ? `?agent=${encodeURIComponent(agentId)}` : "";
    return this.request<ScheduleJob[]>(`/schedules${query}`);
  }

  createSchedule(body: CreateScheduleRequest): Promise<ScheduleJob> {
    return this.request<ScheduleJob>("/schedules", {
      method: "POST",
      body,
    });
  }

  updateSchedule(
    agentId: string,
    id: string,
    body: UpdateScheduleRequest
  ): Promise<ScheduleJob> {
    return this.request<ScheduleJob>(
      `/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body,
      }
    );
  }

  deleteSchedule(agentId: string, id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      `/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
      }
    );
  }

  runSchedule(agentId: string, id: string): Promise<SchedulerRunResult> {
    return this.request<SchedulerRunResult>(
      `/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}/run`,
      {
        method: "POST",
      }
    );
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
