import { SendMessageRequestSchema } from "@yoplai/shared";
export { targetsDurableMain } from "@yoplai/shared";

export type WebSender = { id: string; name: string };

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

export function parseDurableWebSend(input: DurableWebRequest):
  | { ok: true; input: { message: string; clientSendId: string } }
  | { ok: true; stop: true }
  | { ok: false; error: string } {
  if (input.projectId !== undefined || input.turnId !== undefined) {
    return { ok: false, error: "Durable Main does not support project chats or desktop turn IDs." };
  }
  if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > 0)) {
    return { ok: false, error: "Durable Main does not support attachments." };
  }
  if (isDurableStopCommand(input.message)) return { ok: true, stop: true };
  const parsed = SendMessageRequestSchema.required({ clientSendId: true }).safeParse({
    message: input.message,
    clientSendId: input.clientSendId,
  });
  if (!parsed.success) return { ok: false, error: "Supply a message and a valid clientSendId." };
  return { ok: true, input: parsed.data };
}

export function durableWebSender(auth: { user: { name?: string }; session: { userId: string } } | null): WebSender {
  return auth ? { id: auth.session.userId, name: auth.user.name || "Web user" } : { id: "local", name: "Local user" };
}
