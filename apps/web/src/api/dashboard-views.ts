import { API_BASE, apiFetch } from "./core";

const NAMESPACE = `${API_BASE}/relay/dashboard-views`;

/** Checked facts of one prepared view. The raw agent ID has no gateway suffix. */
export type DashboardViewMeta = {
  dashboardId: string;
  agentId: string;
  canWrite: boolean;
  canEdit: boolean;
  chat: { sessionId: string | null } | null;
  annotation: boolean;
};

export type PreparedDashboardView = {
  handle: string;
  instance: string;
  shellUrl: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  gateway: string;
  dashboardId: string;
};

export type ReadDashboardView = {
  state: "ready" | "delivered";
  expiresAt: number;
  gateway: string;
  dashboardId: string;
  meta: DashboardViewMeta;
};

/** A typed refusal of the local gateway. It never holds remote HTML, a bearer, or a handle. */
export class DashboardViewError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  readonly ownerName?: string;
  constructor(status: number, code: string, extra: { reason?: string; ownerName?: string } = {}) {
    super(code);
    this.name = "DashboardViewError";
    this.status = status;
    this.code = code;
    this.reason = extra.reason;
    this.ownerName = extra.ownerName;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const HANDLE = /^[A-Za-z0-9_-]{43}$/;
const META_KEYS = ["agentId", "annotation", "canEdit", "canWrite", "chat", "dashboardId"];

async function post(path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<{ response: Response; data: unknown }> {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = undefined;
  }
  return { response, data };
}

function refusal(status: number, data: unknown): DashboardViewError {
  const body = isRecord(data) ? data : {};
  return new DashboardViewError(status, typeof body.error === "string" ? body.error : "unknown", {
    reason: typeof body.reason === "string" ? body.reason : undefined,
    ownerName: typeof body.ownerName === "string" ? body.ownerName.slice(0, 200) : undefined,
  });
}

function parseMeta(value: unknown): DashboardViewMeta | undefined {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== META_KEYS.join(",")) return undefined;
  const { agentId, annotation, canEdit, canWrite, chat, dashboardId } = value;
  if (typeof agentId !== "string" || !agentId || typeof dashboardId !== "string") return undefined;
  if (typeof annotation !== "boolean" || typeof canEdit !== "boolean" || typeof canWrite !== "boolean") return undefined;
  if (chat !== null) {
    if (!isRecord(chat) || Object.keys(chat).join(",") !== "sessionId") return undefined;
    if (chat.sessionId !== null && (typeof chat.sessionId !== "string" || !chat.sessionId)) return undefined;
  }
  if (annotation && chat === null) return undefined;
  return { agentId, annotation, canEdit, canWrite, dashboardId, chat: chat === null ? null : { sessionId: chat.sessionId as string | null } };
}

/** One checked remote read. The gateway stores one immutable snapshot of the dashboard. */
export async function prepareDashboardView(
  request: { gateway: string; dashboardId: string; query?: string; theme: "light" | "dark" },
  signal: AbortSignal
): Promise<PreparedDashboardView> {
  const { response, data } = await post(NAMESPACE, {
    gateway: request.gateway,
    dashboardId: request.dashboardId,
    ...(request.query ? { query: request.query } : {}),
    theme: request.theme,
  }, signal);
  if (!response.ok) throw refusal(response.status, data);
  const expiresAt = isRecord(data) && typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
  if (
    response.status !== 201 || !isRecord(data) ||
    typeof data.handle !== "string" || !HANDLE.test(data.handle) ||
    typeof data.instance !== "string" || !data.instance ||
    data.shellUrl !== `${NAMESPACE}/${data.handle}/shell` ||
    data.gateway !== request.gateway || data.dashboardId !== request.dashboardId ||
    !Number.isFinite(expiresAt)
  ) throw new DashboardViewError(502, "invalid_response");
  return { handle: data.handle, instance: data.instance, shellUrl: data.shellUrl, expiresAt, gateway: data.gateway, dashboardId: data.dashboardId };
}

/** The handle travels in the body, never in a URL. */
export async function readDashboardView(handle: string, signal: AbortSignal): Promise<ReadDashboardView> {
  const { response, data } = await post(`${NAMESPACE}/read`, { handle }, signal);
  if (!response.ok) throw refusal(response.status, data);
  const expiresAt = isRecord(data) && typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
  const meta = isRecord(data) ? parseMeta(data.meta) : undefined;
  if (
    !isRecord(data) || (data.state !== "ready" && data.state !== "delivered") ||
    typeof data.gateway !== "string" || typeof data.dashboardId !== "string" ||
    !Number.isFinite(expiresAt) || !meta
  ) throw new DashboardViewError(502, "invalid_response");
  return { state: data.state, expiresAt, gateway: data.gateway, dashboardId: data.dashboardId, meta };
}
