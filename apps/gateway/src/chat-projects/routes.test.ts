import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ dir: "" }));
vi.mock("../config/index.js", () => ({ get CONFIG_DIR() { return config.dir; } }));
vi.mock("../history/store.js", () => ({ appendSessionMeta: vi.fn() }));
vi.mock("../logging.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../logging.js")>(), logWarn: vi.fn() }));
import { logWarn } from "../logging.js";
import * as extraction from "../media/extract.js";
import { createChatProjectRoutes } from "./routes.js";
import { ChatProjectStore } from "./store.js";

beforeEach(async () => { vi.clearAllMocks(); config.dir = await fs.mkdtemp(path.join(os.tmpdir(), "project-files-api-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(config.dir, { recursive: true, force: true }); });

describe("chat project files API", () => {
  it("uploads, extracts, lists and deletes originals with user isolation", async () => {
    const store = new ChatProjectStore(config.dir, "alice");
    const project = await store.create("Research");
    const routes = createChatProjectRoutes({ getUserId: async (c) => c.req.header("x-user") ?? "alice", getAgentIds: () => [] });
    const body = new FormData();
    body.append("file", new File(["Useful project notes"], "notes.txt", { type: "text/plain" }));
    const upload = await routes.request(`/chat-projects/${project.id}/files`, { method: "POST", body });
    expect(upload.status).toBe(201);
    const file = await upload.json();
    expect((await store.listFiles(project.id))[0]?.text).toBe("Useful project notes");
    expect(await fs.readFile(path.join(store.filesDirectory(project.id), file.id), "utf8")).toBe("Useful project notes");
    const listed = await routes.request(`/chat-projects/${project.id}/files`);
    expect(await listed.json()).toMatchObject({ items: [{ name: "notes.txt", extracted: true }] });
    expect((await routes.request(`/chat-projects/${project.id}/files`, { headers: { "x-user": "bob" } })).status).toBe(404);
    const foreignUpload = new FormData();
    foreignUpload.append("file", new File(["Foreign"], "foreign.txt", { type: "text/plain" }));
    expect((await routes.request(`/chat-projects/${project.id}/files`, { method: "POST", body: foreignUpload, headers: { "x-user": "bob" } })).status).toBe(404);
    expect((await routes.request(`/chat-projects/${project.id}/files/${file.id}`, { method: "DELETE", headers: { "x-user": "bob" } })).status).toBe(404);
    expect(await store.listFiles(project.id)).toHaveLength(1);
    expect((await routes.request(`/chat-projects/${project.id}/files/${file.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await store.listFiles(project.id)).toEqual([]);
    expect(await fs.readdir(store.filesDirectory(project.id))).toEqual([]);
  });

  it("retains the original and warns when document extraction fails", async () => {
    const store = new ChatProjectStore(config.dir);
    const project = await store.create("Research");
    const routes = createChatProjectRoutes({ getUserId: async () => undefined, getAgentIds: () => [] });
    const body = new FormData();
    body.append("file", new File(["Invalid office document"], "broken.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    const upload = await routes.request(`/chat-projects/${project.id}/files`, { method: "POST", body });
    expect(upload.status).toBe(201);
    const file = await upload.json();
    expect((await store.listFiles(project.id))[0]?.extractionError).toBe("Text extraction failed");
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith("Project file text extraction failed", {
      projectId: project.id, fileId: file.id, name: "broken.docx", message: expect.any(String),
    });
    expect(await fs.readFile(path.join(store.filesDirectory(project.id), file.id), "utf8")).toBe("Invalid office document");
    const listed = await routes.request(`/chat-projects/${project.id}/files`);
    expect(await listed.json()).toMatchObject({ items: [{ extracted: false, extractionError: "Text extraction failed" }] });
  });

  it("rejects unsupported uploads without storing files", async () => {
    const store = new ChatProjectStore(config.dir);
    const project = await store.create("Research");
    const routes = createChatProjectRoutes({ getUserId: async () => undefined, getAgentIds: () => [] });
    const body = new FormData();
    body.append("file", new File(["code"], "script.exe", { type: "text/plain" }));
    expect((await routes.request(`/chat-projects/${project.id}/files`, { method: "POST", body })).status).toBe(400);
    expect(await store.listFiles(project.id)).toEqual([]);
  });

  it("stores the password-protected reason from a real encrypted PDF", async () => {
    const store = new ChatProjectStore(config.dir);
    const project = await store.create("Research");
    const routes = createChatProjectRoutes({ getUserId: async () => undefined, getAgentIds: () => [] });
    const body = new FormData();
    body.append("file", new File([await fs.readFile(new URL("../media/__fixtures__/encrypted.pdf", import.meta.url))], "encrypted.pdf", { type: "application/pdf" }));
    const upload = await routes.request(`/chat-projects/${project.id}/files`, { method: "POST", body });
    expect(upload.status).toBe(201);
    expect((await store.listFiles(project.id))[0]?.extractionError).toBe("PDF is password-protected");
    expect(await (await routes.request(`/chat-projects/${project.id}/files`)).json()).toMatchObject({
      items: [{ extracted: false, extractionError: "PDF is password-protected" }],
    });
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("stores an OCR cap reason and logs the original diagnostic once", async () => {
    vi.spyOn(extraction, "extractTextDetails").mockRejectedValueOnce(new extraction.ExtractionError(
      "Too many pages to OCR (45 scanned pages, max 30)", { cause: new Error("Empty OCR output from worker") },
    ));
    const store = new ChatProjectStore(config.dir);
    const project = await store.create("Research");
    const routes = createChatProjectRoutes({ getUserId: async () => undefined, getAgentIds: () => [] });
    const body = new FormData();
    body.append("file", new File(["scanned PDF"], "scan.pdf", { type: "application/pdf" }));
    const upload = await routes.request(`/chat-projects/${project.id}/files`, { method: "POST", body });
    expect(upload.status).toBe(201);
    const file = await upload.json();
    expect((await store.listFiles(project.id))[0]?.extractionError).toBe("Too many pages to OCR (45 scanned pages, max 30)");
    expect(await (await routes.request(`/chat-projects/${project.id}/files`)).json()).toMatchObject({
      items: [{ extracted: false, extractionError: "Too many pages to OCR (45 scanned pages, max 30)" }],
    });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith("Project file text extraction failed", {
      projectId: project.id, fileId: file.id, name: "scan.pdf", message: "Empty OCR output from worker",
    });
  });

  it("stores the output limit reason", async () => {
    vi.spyOn(extraction, "extractTextDetails").mockRejectedValueOnce(new extraction.ExtractionError("Text too long (over 250,000 characters)"));
    const store = new ChatProjectStore(config.dir);
    const project = await store.create("Research");
    const routes = createChatProjectRoutes({ getUserId: async () => undefined, getAgentIds: () => [] });
    const body = new FormData();
    body.append("file", new File(["long PDF"], "long.pdf", { type: "application/pdf" }));
    expect((await routes.request(`/chat-projects/${project.id}/files`, { method: "POST", body })).status).toBe(201);
    expect((await store.listFiles(project.id))[0]?.extractionError).toBe("Text too long (over 250,000 characters)");
    expect(await (await routes.request(`/chat-projects/${project.id}/files`)).json()).toMatchObject({
      items: [{ extracted: false, extractionError: "Text too long (over 250,000 characters)" }],
    });
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("stores readable partial text and exposes its neutral extraction note", async () => {
    vi.spyOn(extraction, "extractTextDetails").mockResolvedValueOnce({
      text: "Readable text layer\n\nOCR page text", note: "Partial text: 30 of 45 scanned pages read",
    });
    const store = new ChatProjectStore(config.dir);
    const project = await store.create("Research");
    const routes = createChatProjectRoutes({ getUserId: async () => undefined, getAgentIds: () => [] });
    const body = new FormData();
    body.append("file", new File(["mixed PDF"], "mixed.pdf", { type: "application/pdf" }));
    expect((await routes.request(`/chat-projects/${project.id}/files`, { method: "POST", body })).status).toBe(201);
    expect((await store.listFiles(project.id))[0]).toMatchObject({
      text: "Readable text layer\n\nOCR page text", extractionNote: "Partial text: 30 of 45 scanned pages read",
    });
    const listed = await (await routes.request(`/chat-projects/${project.id}/files`)).json();
    expect(listed).toMatchObject({ items: [{ extracted: true, extractionNote: "Partial text: 30 of 45 scanned pages read" }] });
    expect(listed.items[0].extractionError).toBeUndefined();
    expect(listed.items[0].text).toBeUndefined();
    expect(logWarn).not.toHaveBeenCalled();
  });
});


describe("chat project memory API", () => {
  it("lists and removes references without exposing paths, and edits notes in the owning user scope", async () => {
    const store = new ChatProjectStore(config.dir, "alice");
    const project = await store.create("Memory");
    const reference = await store.addReference(project.id, { title: "Wiki", description: "Useful source", path: "/private/wiki" });
    const routes = createChatProjectRoutes({ getUserId: async (c) => c.req.header("x-user") ?? "alice", getAgentIds: () => [] });
    const base = "/chat-projects/" + project.id;
    const listed = await routes.request(base + "/references");
    expect(await listed.json()).toEqual({ items: [{ id: reference.id, title: "Wiki", description: "Useful source", createdAt: reference.createdAt }] });
    for (const suffix of ["/references", "/notes"]) expect((await routes.request(base + suffix, { headers: { "x-user": "bob" } })).status).toBe(404);
    expect((await routes.request(base + "/references/" + reference.id, { method: "DELETE", headers: { "x-user": "bob" } })).status).toBe(404);
    const put = (text: unknown, user = "alice") => routes.request(base + "/notes", { method: "PUT", headers: { "content-type": "application/json", "x-user": user }, body: JSON.stringify({ text }) });
    expect((await put("Foreign", "bob")).status).toBe(404);
    expect((await put(123)).status).toBe(400);
    expect((await put("Editable notes")).status).toBe(200);
    expect(await (await routes.request(base + "/notes")).json()).toEqual({ text: "Editable notes" });
    expect((await put("")).status).toBe(200);
    expect(await store.getNotes(project.id)).toBe("");
    expect((await routes.request(base + "/references/" + reference.id, { method: "DELETE" })).status).toBe(200);
    expect((await routes.request(base + "/references/" + reference.id, { method: "DELETE" })).status).toBe(404);
    expect(await store.listReferences(project.id)).toEqual([]);
  });
});
