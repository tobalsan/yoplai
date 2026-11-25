import { z } from "zod";

export const SessionHistoryArgsSchema = z.object({
  action: z.enum(["list", "search", "read"]),
  query: z.string().min(1).optional(),
  session: z.string().min(1).optional(),
  role: z.enum(["user", "assistant", "system"]).optional(),
  tool: z.string().min(1).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  from: z.number().int().min(0).optional(),
  to: z.number().int().min(0).optional(),
  around: z.number().int().min(0).optional(),
  n: z.number().int().min(0).max(50).optional(),
  full: z.number().int().min(0).optional(),
});

export function invalidInput(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "invalid_input" });
}

export function parseDate(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw invalidInput(`Invalid ${name} date: ${value}`);
  return time;
}

export function day(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
}
