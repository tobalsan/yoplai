import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "@yoplai/shared";
import {
  parseDashboardEdits,
  resolveDashboardDatabase,
  runDashboardEditWorker,
  type DashboardEdit,
  type DashboardEditField,
} from "./sql.js";

export const DASHBOARD_EDIT_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/** Who a page edit token speaks for. */
export type DashboardEditClaims = {
  dashboardId: string;
  userId: string;
  email: string | null;
  name: string | null;
  expiresAt: number;
};

/** An actor whose access to the dashboard was re-checked for this request. */
export type DashboardEditor = DashboardEditClaims & { canWrite: boolean };

export class DashboardEditError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 503, message: string) {
    super(message);
  }
}

const sign = (key: Buffer, payload: string) =>
  createHmac("sha256", key).update(payload).digest("base64url");

export function issueDashboardEditToken(
  key: Buffer,
  claims: Omit<DashboardEditClaims, "expiresAt">,
  now = Date.now()
): string {
  const payload = Buffer.from(
    JSON.stringify({ ...claims, expiresAt: now + DASHBOARD_EDIT_TOKEN_TTL_MS })
  ).toString("base64url");
  return `${payload}.${sign(key, payload)}`;
}

/** Returns the claims of a genuine, unexpired token, otherwise null. */
export function verifyDashboardEditToken(
  key: Buffer,
  token: unknown,
  now = Date.now()
): DashboardEditClaims | null {
  if (typeof token !== "string") return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(key, payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as DashboardEditClaims;
    if (typeof claims.expiresAt !== "number" || claims.expiresAt <= now)
      return null;
    return claims;
  } catch {
    return null;
  }
}

/** Sets one declared field of one row, after rights, guard and type checks. */
export async function editDashboardRow(
  agent: AgentConfig,
  html: string,
  editor: DashboardEditor,
  input: unknown
): Promise<{ value: unknown; at: string }> {
  const { edit, key, field, value } = (input ?? {}) as Record<string, unknown>;
  const declaration = findEdit(html, edit);
  if (typeof key !== "string" && !(typeof key === "number" && Number.isFinite(key)))
    throw new DashboardEditError(400, "key must be a string or a number");
  if (typeof field !== "string" || !Object.hasOwn(declaration.fields, field))
    throw new DashboardEditError(400, `Field ${String(field)} is not editable in ${declaration.name}`);
  const spec = declaration.fields[field];
  if (!editor.canWrite && !declaration.guard)
    throw new DashboardEditError(403, "You can only view this dashboard");
  const stored = encode(spec, field, value);
  const at = new Date().toISOString();
  const result = await run(agent, declaration, editor, at, {
    op: "edit",
    keyValue: key,
    field,
    value: stored,
    ...(editor.canWrite
      ? {}
      : {
          guard: {
            sql: declaration.guard!,
            bindings: guardBindings(declaration.guard!, {
              key,
              viewer_email: editor.email,
              viewer_name: editor.name,
            }),
          },
        }),
  });
  return { value: decode(spec, result.value), at };
}

/** Inserts a row into a `create: true` declaration's table. Writers only. */
export async function addDashboardRow(
  agent: AgentConfig,
  html: string,
  editor: DashboardEditor,
  input: unknown
): Promise<{ key: number; values: Record<string, unknown>; at: string }> {
  const { edit, values } = (input ?? {}) as Record<string, unknown>;
  const declaration = findEdit(html, edit);
  if (!editor.canWrite)
    throw new DashboardEditError(403, "Only the owner or a write share can add rows");
  if (!declaration.create)
    throw new DashboardEditError(400, `Edit ${declaration.name} does not allow adding rows (set "create": true)`);
  if (values !== undefined && (!values || typeof values !== "object" || Array.isArray(values)))
    throw new DashboardEditError(400, "values must be an object of field values");
  const stored: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values ?? {})) {
    if (!Object.hasOwn(declaration.fields, field))
      throw new DashboardEditError(400, `Field ${field} is not editable in ${declaration.name}`);
    stored[field] = encode(declaration.fields[field], field, value);
  }
  const at = new Date().toISOString();
  const fields = Object.keys(declaration.fields);
  const result = await run(agent, declaration, editor, at, { op: "add", values: stored, fields });
  return {
    key: result.key!,
    values: Object.fromEntries(
      fields.map((field) => [field, decode(declaration.fields[field], result.values?.[field])])
    ),
    at,
  };
}

function findEdit(html: string, name: unknown): DashboardEdit {
  let edits: DashboardEdit[];
  try {
    edits = parseDashboardEdits(html);
  } catch (error) {
    throw new DashboardEditError(400, (error as Error).message);
  }
  const declaration = edits.find((edit) => edit.name === name);
  if (!declaration)
    throw new DashboardEditError(400, `This page declares no edit named ${String(name)}`);
  return declaration;
}

async function run(
  agent: AgentConfig,
  declaration: DashboardEdit,
  editor: DashboardEditor,
  at: string,
  operation:
    | { op: "edit"; keyValue: string | number; field: string; value: unknown; guard?: { sql: string; bindings: Record<string, string | number | null> } }
    | { op: "add"; values: Record<string, unknown>; fields: string[] }
) {
  let location: { root: string; database: string };
  try {
    location = await resolveDashboardDatabase(agent, declaration.database);
  } catch (error) {
    throw new DashboardEditError(400, (error as Error).message);
  }
  let response;
  try {
    const rootStat = await fs.stat(location.root);
    response = await runDashboardEditWorker({
      root: location.root,
      rootDev: rootStat.dev,
      rootIno: rootStat.ino,
      database: path.relative(location.root, location.database),
      table: declaration.table,
      key: declaration.key,
      ...(declaration.updatedAt ? { updatedAt: declaration.updatedAt } : {}),
      at,
      audit: {
        dashboardId: editor.dashboardId,
        userId: editor.userId,
        email: editor.email,
        name: editor.name,
        edit: declaration.name,
      },
      ...operation,
    });
  } catch (error) {
    throw new DashboardEditError(503, (error as Error).message);
  }
  if (!response.ok) throw new DashboardEditError(response.status, response.error);
  return response;
}

function guardBindings(
  sql: string,
  values: Record<string, string | number | null>
): Record<string, string | number | null> {
  const bindings: Record<string, string | number | null> = {};
  for (const match of sql.matchAll(/[:@$]([A-Za-z_]\w*)/g)) bindings[match[1]] = null;
  for (const [name, value] of Object.entries(values)) {
    if (Object.hasOwn(bindings, name)) bindings[name] = value;
  }
  return bindings;
}

/** Validates a page value and returns what is stored in SQLite. */
function encode(spec: DashboardEditField, field: string, value: unknown): unknown {
  const invalid = (expected: string) =>
    new DashboardEditError(400, `${field} must be ${expected}`);
  // Clearing a nullable text field means "not user-set" again.
  if (value === "" && spec.type === "text" && spec.nullable) return null;
  if (value === null) {
    if (spec.nullable) return null;
    throw invalid("set (it cannot be empty)");
  }
  switch (spec.type) {
    case "bool":
      if (typeof value !== "boolean") throw invalid("true or false");
      return value ? 1 : 0;
    case "int":
      if (!Number.isSafeInteger(value)) throw invalid("a whole number");
      if (spec.min !== undefined && (value as number) < spec.min) throw invalid(`at least ${spec.min}`);
      if (spec.max !== undefined && (value as number) > spec.max) throw invalid(`at most ${spec.max}`);
      return value;
    case "text":
      if (typeof value !== "string") throw invalid("text");
      if ([...value].length > spec.max) throw invalid(`at most ${spec.max} characters`);
      return value;
    case "enum":
      if (typeof value !== "string" || !spec.values.includes(value))
        throw invalid(`one of ${spec.values.join(", ")}`);
      return value;
  }
}

function decode(spec: DashboardEditField, value: unknown): unknown {
  if (spec.type === "bool" && value !== null && value !== undefined) return Boolean(value);
  return value ?? null;
}
