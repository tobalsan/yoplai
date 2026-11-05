import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { getUserHistoryDir } from "@yoplai/extension-multi-user/isolation";
import { CONFIG_DIR } from "../config/index.js";
import { ExtractionError, extractTextDetails } from "../media/extract.js";
import { logWarn } from "../logging.js";
import { MAX_UPLOAD_SIZE_BYTES, resolveUploadMimeType, UploadTypeError } from "../media/upload.js";
import { appendSessionMeta } from "../history/store.js";
import { isSafeSessionId, parseSessionFileName } from "../history/sessions.js";
import { draftProjectInstructions } from "../maintenance/project-instructions.js";
import { ChatProjectStore, isSafeChatProjectId } from "./store.js";

export function createChatProjectRoutes(deps: {
  getUserId: (c: Context) => Promise<string | undefined>;
  getAgentIds: () => string[];
}) {
  const routes = new Hono();
  routes.get("/chat-projects", async (c) => {
    const store = new ChatProjectStore(CONFIG_DIR, await deps.getUserId(c));
    return c.json({ items: await store.list() });
  });
  routes.post("/chat-projects", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!validName(body?.name)) return c.json({ error: "Invalid project name" }, 400);
    const store = new ChatProjectStore(CONFIG_DIR, await deps.getUserId(c));
    return c.json(await store.create(body.name), 201);
  });
  routes.post("/chat-projects/:id/instructions/draft", async (c) => {
    const id = c.req.param("id");
    if (!isSafeChatProjectId(id)) return c.json({ error: "Invalid project id" }, 400);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.purpose !== "string" || !body.purpose.trim()) return c.json({ error: "Invalid project purpose" }, 400);
    const store = new ChatProjectStore(CONFIG_DIR, await deps.getUserId(c));
    if (!await store.get(id)) return c.json({ error: "Project not found" }, 404);
    const instructions = await draftProjectInstructions(body.purpose, deps.getAgentIds()[0] ?? "", id);
    const project = await store.update(id, { instructions });
    return project ? c.json(project) : c.json({ error: "Project not found" }, 404);
  });
  routes.get("/chat-projects/:id", async (c) => {
    const id = c.req.param("id");
    if (!isSafeChatProjectId(id)) return c.json({ error: "Invalid project id" }, 400);
    const store = new ChatProjectStore(CONFIG_DIR, await deps.getUserId(c));
    const project = await store.get(id);
    return project ? c.json(project) : c.json({ error: "Project not found" }, 404);
  });
  routes.patch("/chat-projects/:id", async (c) => {
    const id = c.req.param("id");
    if (!isSafeChatProjectId(id)) return c.json({ error: "Invalid project id" }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || (body.name === undefined && body.instructions === undefined) ||
      (body.name !== undefined && !validName(body.name)) ||
      (body.instructions !== undefined && typeof body.instructions !== "string")) {
      return c.json({ error: "Invalid project update" }, 400);
    }
    const store = new ChatProjectStore(CONFIG_DIR, await deps.getUserId(c));
    const project = await store.update(id, { name: body.name, instructions: body.instructions });
    return project ? c.json(project) : c.json({ error: "Project not found" }, 404);
  });
  routes.get("/chat-projects/:id/files", async (c) => {
    const id = c.req.param("id");
    if (!isSafeChatProjectId(id)) return c.json({ error: "Invalid project id" }, 400);
    const store = new ChatProjectStore(CONFIG_DIR, await deps.getUserId(c));
    if (!await store.get(id)) return c.json({ error: "Project not found" }, 404);
    return c.json({ items: (await store.listFiles(id)).map(({ text, ...file }) => ({ ...file, extracted: Boolean(text) })) });
  });
  routes.post("/chat-projects/:id/files", async (c) => {
    const id = c.req.param("id");
    if (!isSafeChatProjectId(id)) return c.json({ error: "Invalid project id" }, 400);
    const store = new ChatProjectStore(CONFIG_DIR, await deps.getUserId(c));
    if (!await store.get(id)) return c.json({ error: "Project not found" }, 404);
    const body = await c.req.parseBody();
    const upload = body.file;
    if (!(upload instanceof File)) return c.json({ error: "File required" }, 400);
    if (upload.size > MAX_UPLOAD_SIZE_BYTES) return c.json({ error: "File exceeds the 25MB upload limit" }, 413);
    let mimeType: string;
    try { mimeType = resolveUploadMimeType(upload.type, upload.name); }
    catch (error) { if (error instanceof UploadTypeError) return c.json({ error: error.message }, 400); throw error; }
    const file = { id: crypto.randomUUID(), name: upload.name.split(/[\\/]/).pop()!.slice(0, 200), mimeType, size: upload.size, createdAt: Date.now() };
    await store.addFile(id, file, Buffer.from(await upload.arrayBuffer()));
    try {
      const { text, note } = await extractTextDetails(path.join(store.filesDirectory(id), file.id), mimeType);
      await store.updateFile(id, { ...file, ...(text ? { text: text.slice(0, 250_000) } : {}), ...(note ? { extractionNote: note } : {}) });
    } catch (error) {
      const original = error instanceof ExtractionError && error.cause !== undefined ? error.cause : error;
      logWarn("Project file text extraction failed", {
        projectId: id, fileId: file.id, name: file.name, message: original instanceof Error ? original.message : String(original),
      });
      await store.updateFile(id, { ...file, extractionError: error instanceof ExtractionError ? error.message : "Text extraction failed" });
    }
    return c.json(file, 201);
  });
  routes.delete("/chat-projects/:id/files/:fileId", async (c) => {
    const id = c.req.param("id");
    const fileId = c.req.param("fileId");
    if (!isSafeChatProjectId(id) || !isSafeChatProjectId(fileId)) return c.json({ error: "Invalid id" }, 400);
    const store = new ChatProjectStore(CONFIG_DIR, await deps.getUserId(c));
    if (!await store.get(id)) return c.json({ error: "Project not found" }, 404);
    return await store.deleteFile(id, fileId) ? c.json({ ok: true }) : c.json({ error: "File not found" }, 404);
  });
  routes.get("/chat-projects/:id/references", async (c) => {
    const id = c.req.param("id");
    if (!isSafeChatProjectId(id)) return c.json({ error: "Invalid project id" }, 400);
    const store = new ChatProjectStore(CONFIG_DIR, await deps.getUserId(c));
    if (!await store.get(id)) return c.json({ error: "Project not found" }, 404);
    return c.json({ items: (await store.listReferences(id)).map(({ id, title, description, createdAt }) => ({ id, title, description, createdAt })) });
  });
  routes.delete("/chat-projects/:id/references/:referenceId", async (c) => {
    const id = c.req.param("id");
    const referenceId = c.req.param("referenceId");
    if (!isSafeChatProjectId(id) || !isSafeChatProjectId(referenceId)) return c.json({ error: "Invalid id" }, 400);
    const store = new ChatProjectStore(CONFIG_DIR, await deps.getUserId(c));
    if (!await store.get(id)) return c.json({ error: "Project not found" }, 404);
    return await store.deleteReference(id, referenceId) ? c.json({ ok: true }) : c.json({ error: "Reference not found" }, 404);
  });
  routes.get("/chat-projects/:id/notes", async (c) => {
    const id = c.req.param("id");
    if (!isSafeChatProjectId(id)) return c.json({ error: "Invalid project id" }, 400);
    const store = new ChatProjectStore(CONFIG_DIR, await deps.getUserId(c));
    if (!await store.get(id)) return c.json({ error: "Project not found" }, 404);
    return c.json({ text: await store.getNotes(id) });
  });
  routes.put("/chat-projects/:id/notes", async (c) => {
    const id = c.req.param("id");
    if (!isSafeChatProjectId(id)) return c.json({ error: "Invalid project id" }, 400);
    const store = new ChatProjectStore(CONFIG_DIR, await deps.getUserId(c));
    if (!await store.get(id)) return c.json({ error: "Project not found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.text !== "string") return c.json({ error: "Note text must be a string" }, 400);
    await store.putNotes(id, body.text);
    return c.json({ text: body.text });
  });
  routes.delete("/chat-projects/:id", async (c) => {
    const id = c.req.param("id");
    if (!isSafeChatProjectId(id)) return c.json({ error: "Invalid project id" }, 400);
    const userId = await deps.getUserId(c);
    const store = new ChatProjectStore(CONFIG_DIR, userId);
    if (!await store.get(id)) return c.json({ error: "Project not found" }, 404);
    const dir = getUserHistoryDir(userId, CONFIG_DIR);
    const files = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const parsed = parseSessionFileName(file, deps.getAgentIds());
      if (parsed && !isSafeSessionId(parsed.sessionId)) continue;
      const raw = await fs.readFile(path.join(dir, file), "utf8");
      let projectId: unknown = null;
      for (const line of raw.split(/\r?\n/)) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "meta" && entry.key === "project") projectId = entry.value;
        } catch {
          // Ignore malformed history lines, as session summaries do.
        }
      }
      if (projectId !== id) continue;
      if (parsed) {
        await appendSessionMeta(parsed.agentId, parsed.sessionId, "project", null, userId);
      } else {
        // Removed agents still own histories that can reappear when restored.
        await fs.appendFile(path.join(dir, file), JSON.stringify({ type: "meta", key: "project", value: null, timestamp: Date.now() }) + "\n", "utf8");
      }
    }
    await store.delete(id);
    return c.json({ ok: true });
  });
  return routes;
}

function validName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0 && name.trim().length <= 200;
}
