import { randomUUID } from "node:crypto";
import type {
  DeviceApprovalOutcome,
  WsDeviceApprovalRequest,
  WsDeviceApprovalResolved,
} from "@yoplai/shared";

/** The user has this long to answer an approval request. */
export const APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_APPROVAL_TEXT_CHARS = 2000;
/** The longest `device_bash` command that a card can show in full, so the user never approves a cut command. */
export const MAX_APPROVAL_COMMAND_CHARS = 20_000;

export type ApprovalEvent =
  | { kind: "request"; message: WsDeviceApprovalRequest; page: unknown }
  | { kind: "resolved"; message: WsDeviceApprovalResolved; page: unknown };

type PendingApproval = {
  message: WsDeviceApprovalRequest;
  /** Page socket of the turn. The page never sees it. */
  page: unknown;
  settle: (outcome: DeviceApprovalOutcome) => void;
};

/** Cuts each long text value, for example a file content, so the prompt stays small. The command of `device_bash` is never cut. */
export function truncateApprovalArguments(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_APPROVAL_TEXT_CHARS ? `${value.slice(0, MAX_APPROVAL_TEXT_CHARS)}… (cut)` : value;
  }
  if (Array.isArray(value)) return value.map(truncateApprovalArguments);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateApprovalArguments(item)]));
  }
  return value;
}

function truncateToolArguments(tool: string, value: unknown): unknown {
  const cut = truncateApprovalArguments(value);
  if (tool !== "device_bash" || !value || typeof value !== "object" || !("command" in value)) return cut;
  return { ...(cut as Record<string, unknown>), command: value.command };
}

export type ApprovalRequestInput = Omit<WsDeviceApprovalRequest, "type" | "approvalId"> & {
  signal: AbortSignal;
  timeoutMs?: number;
  /** Page socket of the turn. It always gets the request. */
  page: unknown;
};

/** Holds each device call that waits for the answer of the user. */
export class DeviceApprovals {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(event: ApprovalEvent) => void>();

  subscribe(listener: (event: ApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Each pending approval of one remote agent and one local chat. */
  pendingFor(agentId: string, chat: string): WsDeviceApprovalRequest[] {
    return [...this.pending.values()]
      .map((item) => item.message)
      .filter((message) => message.agentId === agentId && message.chat === chat);
  }

  /** Waits for an answer, a timeout, or an abort of the signal. */
  request(input: ApprovalRequestInput): Promise<DeviceApprovalOutcome> {
    const { signal, timeoutMs = APPROVAL_TIMEOUT_MS, page, ...fields } = input;
    if (signal.aborted) return Promise.resolve("cancelled");
    const message: WsDeviceApprovalRequest = {
      type: "device_approval_request",
      approvalId: randomUUID(),
      ...fields,
      arguments: truncateToolArguments(fields.tool, fields.arguments),
    };
    return new Promise<DeviceApprovalOutcome>((resolve) => {
      const settle = (outcome: DeviceApprovalOutcome) => {
        if (!this.pending.delete(message.approvalId)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.emit({
          kind: "resolved",
          message: {
            type: "device_approval_resolved",
            approvalId: message.approvalId,
            agentId: message.agentId,
            chat: message.chat,
            outcome,
          },
          page,
        });
        resolve(outcome);
      };
      const onAbort = () => settle("cancelled");
      const timer = setTimeout(() => settle("timeout"), timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(message.approvalId, { message, page, settle });
      this.emit({ kind: "request", message, page });
    });
  }

  /** Returns false when the approval is not pending, so a second answer has no effect. */
  answer(
    approvalId: string,
    approve: boolean,
    allow?: (request: WsDeviceApprovalRequest, page: unknown) => boolean
  ): boolean {
    const item = this.pending.get(approvalId);
    if (!item || (allow && !allow(item.message, item.page))) return false;
    item.settle(approve ? "approved" : "refused");
    return true;
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const approvals = new DeviceApprovals();

export function getDeviceApprovals(): DeviceApprovals {
  return approvals;
}
