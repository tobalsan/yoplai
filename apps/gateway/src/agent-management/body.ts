import type { Context } from "hono";
import { AgentManagementError, readAvatarUpload } from "./files.js";

export async function readManagementBody(c: Context) {
  if (!c.req.header("Content-Type")?.toLowerCase().startsWith("multipart/form-data;")) {
    return { json: await c.req.json().catch(() => undefined) };
  }
  const parts = await c.req.formData().catch(() => undefined);
  const fields = parts?.get("fields");
  const file = parts?.get("image");
  if (typeof fields !== "string" || typeof file === "string") {
    throw new AgentManagementError("invalid_request", 400, "Check the agent fields.");
  }
  let json: unknown;
  try { json = JSON.parse(fields); } catch { json = undefined; }
  return { json, upload: file ? await readAvatarUpload(file) : undefined };
}
