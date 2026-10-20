import fs from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { MAX_UPLOAD_SIZE_BYTES } from "../media/upload.js";
import { inspectSkillDirectory, type SkillStore } from "./store.js";
import type { SkillAccessPolicy } from "./access.js";
import { SKILL_IMPORT_TOKEN_PREFIX, type ImportTokenStore } from "./import-tokens.js";
import { resolveRunSkills } from "./resolver.js";
import { SkillError, type SkillActor, type SkillDirectory, type SkillInput, type SkillRow } from "./types.js";

type SkillRoutesDeps = {
  getContext(): Promise<{ store: SkillStore; policy: SkillAccessPolicy; multiUser: boolean }>;
  tokens: ImportTokenStore;
  getActor(c: Context): Promise<SkillActor | undefined>;
  getAgents(c: Context): Promise<{ id: string; name: string; directory: string }[]>;
  getOwnerName(id: string): Promise<string>;
  getRecipients(): Promise<{ id: string; name: string; email: string }[]>;
  publicBaseUrl(): string;
  audit?(c: Context, action: string, targetId: string, changes: { field: string; before?: unknown; after?: unknown }[]): Promise<void>;
};

const sharesSchema = z.object({ shares: z.array(z.union([
  z.object({ kind: z.literal("user"), id: z.string().min(1), mode: z.enum(["read", "write"]) }).strict(),
  z.object({ kind: z.literal("all"), mode: z.literal("read") }).strict(),
])) }).strict();

async function jsonBody(c: Context): Promise<unknown> {
  return (await boundedBody(c)).json().catch(() => { throw new SkillError("invalid_json"); });
}

// Enforce the request bound before multipart/JSON parsers buffer the body.
async function boundedBody(c: Context): Promise<Request> {
  const length = c.req.header("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_UPLOAD_SIZE_BYTES)) throw new SkillError("body_too_large", 413);
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_UPLOAD_SIZE_BYTES) {
          await reader.cancel();
          throw new SkillError("body_too_large", 413);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  return new Request(c.req.url, { method: "POST", headers: c.req.raw.headers, body: Buffer.concat(chunks) });
}

async function multipart(c: Context): Promise<SkillInput> {
  const request = await boundedBody(c);
  const form = await request.formData().catch(() => { throw new SkillError("invalid_multipart"); });
  const zip = form.get("file");
  const entries = form.getAll("files");
  if (zip instanceof File && entries.length === 0) return { zip: Buffer.from(await zip.arrayBuffer()) };
  if (zip !== null || !entries.length || !entries.every((entry) => entry instanceof File)) throw new SkillError("skill_files_required");
  return { files: await Promise.all((entries as File[]).map(async (file) => ({ path: file.name, content: Buffer.from(await file.arrayBuffer()).toString("base64"), encoding: "base64" as const }))) };
}

// Find paths that point outside the skill folder: absolute paths, ~/ and $HOME/ paths, and ../ paths that leave the folder.
// The check skips URLs, shebang lines and /dev/ paths.
const PATH_PATTERN = /(?<![\w:/.$>}!-])((?:~|\$HOME|\.\.)(?:\/[^\s`"'()<>[\]{},;*]+)+|\/(?:[\w.@-]+\/)+[\w.@-]*)/g;
async function outsidePaths(directory: string): Promise<string[]> {
  const found = new Set<string>();
  for (const file of (await inspectSkillDirectory(directory)).files) {
    if (file.size > 1024 * 1024) continue;
    const data = await fs.readFile(path.join(directory, file.path));
    if (data.includes(0)) continue;
    for (const match of data.toString("utf8").matchAll(PATH_PATTERN)) {
      const value = match[1].replace(/[.:]+$/, "");
      if (value.startsWith("/dev/")) continue;
      if (value.startsWith("..") && path.resolve(directory, path.dirname(file.path), value).startsWith(directory + path.sep)) continue;
      found.add(value);
    }
  }
  return [...found].sort();
}

export function createSkillRoutes(deps: SkillRoutesDeps): Hono {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    if (/^Bearer /i.test(c.req.header("authorization") ?? "") && (c.req.header("authorization") ?? "").slice(7).startsWith(SKILL_IMPORT_TOKEN_PREFIX) && !(c.req.method === "POST" && c.req.path === "/skills/import")) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  routes.onError((error, c) => {
    if (error instanceof SkillError) return c.json({ error: error.code, ...error.details }, error.status as ContentfulStatusCode);
    console.warn("[skills] Request failed");
    return c.json({ error: "skills_unavailable" }, 500);
  });
  const context = async (c: Context) => {
    const actor = await deps.getActor(c);
    if (!actor) throw new SkillError("unauthorized", 401);
    return { ...await deps.getContext(), actor };
  };
  const userRow = async (c: Context, write = false) => {
    const ctx = await context(c);
    const skill = await ctx.store.get(c.req.param("id")!);
    if (!skill || !(write ? await ctx.policy.canWrite(skill, ctx.actor) : await ctx.policy.canRead(skill, ctx.actor))) throw new SkillError("not_found", 404);
    return { ...ctx, skill };
  };
  const superadminRow = async (c: Context) => {
    const ctx = await context(c);
    if (ctx.actor.role !== "superadmin") throw new SkillError("forbidden", 403);
    const skill = await ctx.store.get(c.req.param("id")!);
    if (!skill) throw new SkillError("not_found", 404);
    return { ...ctx, skill };
  };
  const present = async (store: SkillStore, policy: SkillAccessPolicy, actor: SkillActor, skill: SkillRow) => ({
    ...skill, kind: "user", ownerName: await deps.getOwnerName(skill.ownerId),
    enabled: (await store.getState(actor.userId)).enabled.includes(skill.id),
    locked: false, shadowed: false, ...await policy.permissions(skill, actor),
    mode: skill.ownerId === actor.userId ? "write" : skill.shares.find((share) => share.kind === "user" && share.id === actor.userId)?.mode ?? "read",
  });
  const agentSkills = async (c: Context) => {
    const { loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent");
    const skills: (SkillDirectory & { agentId: string; agentName: string; skillFile: string })[] = [];
    for (const agent of await deps.getAgents(c)) {
      for (const skill of loadSkillsFromDir({ dir: agent.directory, source: "workspace" }).skills) {
        const relative = path.relative(agent.directory, path.basename(skill.filePath) === "SKILL.md" ? skill.baseDir : skill.filePath).split(path.sep).join("/");
        skills.push({ id: `agent:${agent.id}:${relative}`, name: skill.name, description: skill.description, directory: skill.baseDir, skillFile: skill.filePath, agentId: agent.id, agentName: agent.name });
      }
    }
    return skills;
  };
  const directoryRow = (skill: SkillDirectory & { agentId?: string; agentName?: string }) => {
    const kind = skill.id.split(":")[0];
    return { id: skill.id, name: skill.name, description: skill.description, kind, agentId: skill.agentId, agentName: skill.agentName, agents: skill.agents,
      ownerName: "", enabled: true, locked: true, shadowed: false,
      canRead: true, canWrite: false, canManage: false, shares: [], mode: "read" };
  };
  const findDirectory = async (c: Context, store: SkillStore, id: string) => [...await store.builtins(), ...await store.defaults(), ...await agentSkills(c)].find((skill) => skill.id === id);
  routes.get("/skills", async (c) => {
    const { store, policy, actor, multiUser } = await context(c);
    const visible = await policy.filterVisible(await store.list(), actor);
    const mine = await Promise.all(visible.filter((skill) => skill.ownerId === actor.userId).map((skill) => present(store, policy, actor, skill)));
    const sharedWithMe = await Promise.all(visible.filter((skill) => skill.ownerId !== actor.userId && skill.shares.some((share) => share.kind === "all" || share.id === actor.userId)).map((skill) => present(store, policy, actor, skill)));
    const hidden = new Set(multiUser ? await store.systemAgentSkills() : []);
    const { diagnostics } = await resolveRunSkills(store, { agentId: "", userId: actor.userId, multiUser, policy, ignoreAgentRestrictions: true });
    const shadowed = new Set(diagnostics.map((diagnostic) => diagnostic.id));
    for (const skill of [...mine, ...sharedWithMe]) skill.shadowed = shadowed.has(skill.id);
    return c.json({
      mine, sharedWithMe: multiUser ? sharedWithMe : [],
      agent: (await agentSkills(c)).filter((skill) => !hidden.has(skill.id)).map(directoryRow),
    });
  });
  routes.post("/skills", async (c) => {
    const { store, actor } = await context(c);
    const { skill } = await store.create(actor.userId, await multipart(c));
    return c.json({ id: skill.id, name: skill.name }, 201);
  });
  routes.post("/skills/import-token", async (c) => {
    const { actor } = await context(c);
    const token = await deps.tokens.create(actor.userId);
    const url = new URL("/api/skills/import", deps.publicBaseUrl()).toString();
    const example = JSON.stringify({ name: "meeting-notes", files: [{ path: "SKILL.md", content: "---\nname: meeting-notes\ndescription: Summarize meeting notes.\n---\nSummarize decisions and next actions." }] }, null, 2);
    const prompt = `Help me transfer my skills to Yoplai. Send only skill files, never conversation history, account data, credentials or other data.\n\nSend each skill in turn as an HTTPS POST to ${url} (local installations may use HTTP). Set Authorization: Bearer ${token.token} and Content-Type: application/json. The token expires in 24 hours and grants skill writes for my Yoplai account only.\n\nRequest shape: {"name":"canonical-skill-name","files":[{"path":"SKILL.md","content":"file text","encoding":"utf8"}]}. Include SKILL.md at the root, with required name and description in YAML front matter. The request name must match the front matter name. For binary files use encoding "base64". Keep paths relative to the skill root.\n\nWorked example:\n${example}\n\nSend each skill separately and report each HTTP result. A matching skill I own is replaced, keeping its sharing. Imported skills appear in Mine, off until I review and enable them. Do not send this token anywhere else.`;
    await deps.audit?.(c, "skill.import_token_create", token.id, [{ field: "created", after: true }]);
    return c.json({ ...token, prompt }, 201);
  });
  routes.get("/skills/import-token", async (c) => {
    const { actor } = await context(c);
    return c.json({ tokens: await deps.tokens.list(actor.userId) });
  });
  routes.delete("/skills/import-token/:tokenId", async (c) => {
    const { actor } = await context(c);
    const id = c.req.param("tokenId");
    if (!await deps.tokens.revoke(actor.userId, id)) throw new SkillError("not_found", 404);
    await deps.audit?.(c, "skill.import_token_revoke", id, [{ field: "revoked", after: true }]);
    return c.json({ ok: true });
  });
  routes.post("/skills/import", async (c) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    const ownerId = match ? await deps.tokens.authenticate(match[1]) : null;
    if (!ownerId) throw new SkillError("unauthorized", 401);
    const { store, multiUser } = await deps.getContext();
    if (multiUser && !(await deps.getRecipients()).some((user) => user.id === ownerId)) throw new SkillError("forbidden", 403);
    let input: SkillInput;
    if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) input = await multipart(c);
    else {
      const result = z.object({ name: z.string(), files: z.array(z.object({ path: z.string(), content: z.string(), encoding: z.enum(["utf8", "base64"]).optional() }).strict()) }).strict().safeParse(await jsonBody(c));
      if (!result.success) throw new SkillError("invalid_skill");
      input = result.data;
    }
    const { skill, replaced } = await store.create(ownerId, input, { replaceOwn: true });
    return c.json({ id: skill.id, name: skill.name, replaced }, replaced ? 200 : 201);
  });
  routes.get("/skills/recipients", async (c) => {
    await context(c);
    return c.json({ users: await deps.getRecipients() });
  });
  routes.get("/skills/:id", async (c) => {
    const ctx = await context(c);
    const id = c.req.param("id");
    if (ctx.multiUser && ctx.actor.role !== "superadmin" && (await ctx.store.systemAgentSkills()).includes(id)) throw new SkillError("not_found", 404);
    const directory = await findDirectory(c, ctx.store, id);
    if (directory) {
      const skillFile = "skillFile" in directory && typeof directory.skillFile === "string" ? directory.skillFile : undefined;
      const content = skillFile && path.basename(skillFile) !== "SKILL.md"
        ? { skillMd: await fs.readFile(skillFile, "utf8"), files: [{ path: path.basename(skillFile), size: (await fs.stat(skillFile)).size }] }
        : await inspectSkillDirectory(directory.directory);
      return c.json({ ...directoryRow(directory), ...content });
    }
    const { store, policy, actor, skill } = await userRow(c);
    return c.json({ ...await present(store, policy, actor, skill), ...await store.detail(skill.id) });
  });
  routes.put("/skills/:id/content", async (c) => {
    const { store, skill } = await userRow(c, true);
    const updated = await store.replace(skill.id, await multipart(c));
    return c.json({ id: updated.id, name: updated.name });
  });
  routes.put("/skills/:id/enabled", async (c) => {
    if (/^(builtin|default|agent):/.test(c.req.param("id"))) throw new SkillError("skill_locked");
    const { store, actor, skill } = await userRow(c);
    const result = z.object({ enabled: z.boolean() }).strict().safeParse(await jsonBody(c));
    if (!result.success) throw new SkillError("invalid_enabled");
    await store.setEnabled(actor.userId, skill.id, result.data.enabled);
    return c.json({ ok: true });
  });
  routes.put("/skills/:id/shares", async (c) => {
    const { store, policy, actor, skill } = await userRow(c);
    if (!await policy.canManage(skill, actor)) throw new SkillError("forbidden", 403);
    const parsed = sharesSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new SkillError("invalid_shares");
    const shares = parsed.data.shares;
    const recipients = new Set((await deps.getRecipients()).map((user) => user.id));
    const seen = new Set<string>();
    for (const share of shares) {
      const key = share.kind === "all" ? "all" : `user:${share.id}`;
      if (seen.has(key)) throw new SkillError("duplicate_share");
      seen.add(key);
      if (share.kind === "user" && !recipients.has(share.id)) throw new SkillError("ineligible_recipient");
    }
    await store.shares(skill.id, shares);
    await deps.audit?.(c, "skill.shares", skill.id, [{ field: "shares", before: skill.shares, after: shares }]);
    return c.json({ ok: true });
  });
  routes.get("/admin/skills", async (c) => {
    const { store, policy, actor, multiUser } = await context(c);
    if (actor.role !== "superadmin") throw new SkillError("forbidden", 403);
    const reserved = [...await store.builtins(), ...await store.defaults()];
    const active = new Set((await deps.getRecipients()).map((user) => user.id));
    const skills = await Promise.all((await store.list()).map(async (skill) => ({
      ...await present(store, policy, actor, skill), ownerActive: !multiUser || active.has(skill.ownerId), enabledCount: await store.enableCount(skill.id),
      collisions: reserved.filter((other) => other.name === skill.name).map((other) => other.id),
    })));
    const ids = await store.systemAgentSkills();
    const agent = (await agentSkills(c)).map((row) => ({ ...directoryRow(row), system: ids.includes(row.id) }));
    return c.json({ skills, agent, system: reserved.map(directoryRow) });
  });
  routes.put("/skills/:id/system", async (c) => {
    const { store, actor } = await context(c);
    if (actor.role !== "superadmin") throw new SkillError("forbidden", 403);
    const id = c.req.param("id")!;
    if (!(await agentSkills(c)).some((skill) => skill.id === id)) throw new SkillError("not_found", 404);
    const result = z.object({ system: z.boolean() }).strict().safeParse(await jsonBody(c));
    if (!result.success) throw new SkillError("invalid_system_state");
    const before = (await store.systemAgentSkills()).includes(id);
    await store.setSystemAgentSkill(id, result.data.system);
    await deps.audit?.(c, "skill.system", id, [{ field: "system", before, after: result.data.system }]);
    return c.json({ ok: true });
  });
  const agentSource = async (c: Context) => {
    const ctx = await context(c);
    if (ctx.actor.role !== "superadmin") throw new SkillError("forbidden", 403);
    const source = (await agentSkills(c)).find((skill) => skill.id === c.req.param("id"));
    if (!source) throw new SkillError("not_found", 404);
    if (path.basename(source.skillFile) !== "SKILL.md") throw new SkillError("unsupported_skill");
    return { ...ctx, source };
  };
  routes.get("/skills/:id/default", async (c) => {
    const { source } = await agentSource(c);
    return c.json({ outsidePaths: await outsidePaths(source.directory) });
  });
  routes.post("/skills/:id/default", async (c) => {
    const { store, source } = await agentSource(c);
    const id = source.id;
    const { name } = await store.addDefault(source.directory);
    await store.setSystemAgentSkill(id, false);
    await deps.audit?.(c, "skill.make_default", source.agentId, [{ field: "default", after: `default:${name}` }]);
    return c.json({ id: `default:${name}`, name });
  });
  routes.put("/skills/:id/owner", async (c) => {
    const { store, skill } = await superadminRow(c);
    const result = z.object({ ownerId: z.string().min(1) }).strict().safeParse(await jsonBody(c));
    if (!result.success) throw new SkillError("invalid_owner");
    if (!(await deps.getRecipients()).some((user) => user.id === result.data.ownerId)) throw new SkillError("ineligible_recipient");
    await store.transfer(skill.id, result.data.ownerId);
    await deps.audit?.(c, "skill.owner", skill.id, [{ field: "ownerId", before: skill.ownerId, after: result.data.ownerId }]);
    return c.json({ ok: true });
  });
  routes.put("/skills/:id/admin", async (c) => {
    const { store, skill } = await superadminRow(c);
    const result = z.object({ disabledByAdmin: z.boolean() }).strict().safeParse(await jsonBody(c));
    if (!result.success) throw new SkillError("invalid_admin_state");
    if (result.data.disabledByAdmin && !skill.shares.some((share) => share.kind === "all")) throw new SkillError("platform_share_required");
    if (!result.data.disabledByAdmin && !skill.disabledByAdmin) throw new SkillError("not_admin_disabled");
    await store.setAdminDisabled(skill.id, result.data.disabledByAdmin);
    await deps.audit?.(c, "skill.admin", skill.id, [{ field: "disabledByAdmin", before: skill.disabledByAdmin, after: result.data.disabledByAdmin }]);
    return c.json({ ok: true });
  });
  routes.get("/skills/:id/versions", async (c) => {
    const { store, skill } = await userRow(c, true);
    return c.json({ versions: await store.versions(skill.id) });
  });
  routes.post("/skills/:id/versions/:versionId/restore", async (c) => {
    const { store, skill } = await userRow(c, true);
    const updated = await store.restore(skill.id, c.req.param("versionId"));
    return c.json({ id: updated.id, name: updated.name });
  });
  routes.delete("/skills/:id", async (c) => {
    const admin = (await context(c)).actor.role === "superadmin";
    const { store, policy, actor, skill } = admin ? await superadminRow(c) : await userRow(c);
    if (!await policy.canManage(skill, actor) && !(actor.role === "superadmin" && skill.shares.some((share) => share.kind === "all"))) throw new SkillError("forbidden", 403);
    await store.delete(skill.id);
    await deps.audit?.(c, "skill.delete", skill.id, [{ field: "deleted", before: false, after: true }]);
    return c.json({ ok: true });
  });
  return routes;
}
