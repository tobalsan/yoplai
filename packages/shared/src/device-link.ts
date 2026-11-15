import { z } from "zod";

/** Version of the device link protocol. Each side closes the link on a version that it does not know. */
export const DEVICE_PROTOCOL_VERSION = 1;

/** Close codes of the device link. */
export const DEVICE_CLOSE_UNSUPPORTED_VERSION = 4001;
export const DEVICE_CLOSE_INVALID_MESSAGE = 4002;
export const DEVICE_CLOSE_REPLACED = 4003;

export const DEVICE_TOOL_NAMES = ["device_read", "device_write", "device_edit", "device_bash"] as const;
export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number];

/** Each device call that finds no device starts its error text with this. The scheduler looks for it. */
export const DEVICE_OFFLINE_CALL_TEXT = "The device of the user is not connected. The call did not run.";

/** `background` means that no human is present to answer a prompt. */
export const DeviceRunKindSchema = z.enum(["chat", "background"]);
export type DeviceRunKind = z.infer<typeof DeviceRunKindSchema>;

/** The relay sends `deviceName`. The remote gateway answers without it. */
const DeviceHelloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number(),
  deviceName: z.string().optional(),
});

const DeviceCallSchema = z.object({
  type: z.literal("call"),
  callId: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
  agentId: z.string(),
  sessionId: z.string(),
  toolCallId: z.string(),
  runKind: DeviceRunKindSchema,
});

const DeviceResultSchema = z.object({
  type: z.literal("result"),
  callId: z.string(),
  ok: z.boolean(),
  content: z.array(z.unknown()).optional(),
  details: z.unknown().optional(),
  error: z.string().optional(),
});

const DeviceCancelSchema = z.object({
  type: z.literal("cancel"),
  callId: z.string(),
});

export const DeviceLinkMessageSchema = z.discriminatedUnion("type", [
  DeviceHelloSchema,
  DeviceCallSchema,
  DeviceResultSchema,
  DeviceCancelSchema,
]);

export type DeviceHello = z.infer<typeof DeviceHelloSchema>;
export type DeviceCall = z.infer<typeof DeviceCallSchema>;
export type DeviceResult = z.infer<typeof DeviceResultSchema>;
export type DeviceCancel = z.infer<typeof DeviceCancelSchema>;
export type DeviceLinkMessage = z.infer<typeof DeviceLinkMessageSchema>;

/** Returns null when the text is not a valid device link message. */
export function parseDeviceLinkMessage(text: string): DeviceLinkMessage | null {
  try {
    const parsed = DeviceLinkMessageSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Page asks the local gateway for a decision on a device call. */
export type WsDeviceApprovalRequest = {
  type: "device_approval_request";
  approvalId: string;
  gateway: string;
  /** Remote agent ID with the gateway suffix. */
  agentId: string;
  sessionId: string;
  toolCallId: string;
  tool: string;
  /** Long text values are cut to 2,000 characters. */
  arguments: unknown;
};

export type DeviceApprovalOutcome = "approved" | "refused" | "timeout" | "cancelled";

export type WsDeviceApprovalResolved = {
  type: "device_approval_resolved";
  approvalId: string;
  agentId: string;
  sessionId: string;
  outcome: DeviceApprovalOutcome;
};

export type WsDeviceApprovalAnswer = {
  type: "device_approval_answer";
  approvalId: string;
  approve: boolean;
};
