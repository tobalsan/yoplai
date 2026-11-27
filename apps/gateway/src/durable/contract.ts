import { FileAttachmentSchema, SendMessageRequestSchema, type FileAttachment } from "@yoplai/shared";
export { targetsDurableMain } from "@yoplai/shared";

export type WebSender = { id: string; name: string };
export type DurableWebInput = { message: string; clientSendId: string; attachments?: FileAttachment[] };

const WebAttachmentsSchema = FileAttachmentSchema.array().optional();

export type DurableWebRequest = {
  clientSendId?: unknown;
  message?: unknown;
  projectId?: unknown;
  turnId?: unknown;
  attachments?: unknown;
};

export function isDurableStopCommand(message: unknown): boolean {
  return typeof message === "string" && /^\/(stop|abort)$/.test(message.trim());
}

export function parseDurableWebSend(input: DurableWebRequest, options?: { allowAttachments?: boolean }):
  | { ok: true; input: DurableWebInput }
  | { ok: true; stop: true }
  | { ok: false; error: string } {
  if (input.projectId !== undefined || input.turnId !== undefined) {
    return { ok: false, error: "Durable Main does not support project chats or desktop turn IDs." };
  }
  if (options?.allowAttachments === false && input.attachments !== undefined &&
    (!Array.isArray(input.attachments) || input.attachments.length > 0)) {
    return { ok: false, error: "Durable Main does not support attachments." };
  }
  const attachments = WebAttachmentsSchema.safeParse(input.attachments);
  if (!attachments.success) return { ok: false, error: "Attachments must be an array of files with a path and MIME type." };
  if (isDurableStopCommand(input.message)) return { ok: true, stop: true };
  const parsed = SendMessageRequestSchema.required({ clientSendId: true }).safeParse({
    message: input.message,
    clientSendId: input.clientSendId,
  });
  if (!parsed.success) return { ok: false, error: "Supply a message and a valid clientSendId." };
  return { ok: true, input: { ...parsed.data, attachments: attachments.data } };
}

export function durableWebSender(auth: { user: { name?: string }; session: { userId: string } } | null): WebSender {
  return auth ? { id: auth.session.userId, name: auth.user.name || "Web user" } : { id: "local", name: "Local user" };
}

export class DurableAttachmentError extends Error {
  constructor() {
    super("Attachment is missing or outside the inbound media directory.");
  }
}

export class ThreadError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}
