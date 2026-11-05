import fs from "node:fs/promises";
import type { AgentContext } from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";
import { resolveSessionProject } from "../history/store.js";
import { ChatProjectStore, isSafeChatProjectId } from "./store.js";

export const PROJECT_FILES_CONTEXT_BUDGET = 12_000;
export const PROJECT_FILE_INLINE_LIMIT = 4_000;
export const PROJECT_NOTES_CONTEXT_LIMIT = 4_000;
export const PROJECT_REFERENCES_CONTEXT_LIMIT = 4_000;

export class ProjectContextResolver {
  async resolve(params: {
    agentId: string;
    sessionId: string;
    userId?: string;
    projectId?: string;
    sessionHistory?: boolean;
    context?: AgentContext;
  }): Promise<AgentContext | undefined> {
    const context = params.context ? { ...params.context } : undefined;
    if (context) delete context.project;
    const store = new ChatProjectStore(CONFIG_DIR, params.userId);
    const id = await resolveSessionProject(
      params.agentId, params.sessionId, params.userId, params.projectId,
      async (initialId) => {
        if (!isSafeChatProjectId(initialId) || !await store.get(initialId)) {
          throw new Error("Project not found");
        }
      }
    );
    if (!id || !isSafeChatProjectId(id)) return context;
    const project = await store.get(id);
    if (!project) return context;
    const filesPath = store.filesDirectory(id);
    await fs.mkdir(filesPath, { recursive: true });
    let files = "";
    const note = "\nAdditional files omitted from context; inspect the project files directory.";
    for (const file of await store.listFiles(id)) {
      const entry = [file.name + " (" + file.id + ", " + file.size + " bytes)",
        file.text && file.text.length <= PROJECT_FILE_INLINE_LIMIT ? file.text : "",
        file.extractionError ?? "", file.extractionNote ?? ""].filter(Boolean).join("\n");
      if (Buffer.byteLength(files + "\n" + entry + note, "utf8") > PROJECT_FILES_CONTEXT_BUDGET) {
        files += note;
        break;
      }
      files += (files ? "\n" : "") + entry;
    }
    let references = "";
    for (const reference of await store.listReferences(id)) {
      const entry = "- " + reference.title + ": " + reference.description + " (path: " + reference.path + ")";
      if (references.length + entry.length + 1 > PROJECT_REFERENCES_CONTEXT_LIMIT) break;
      references += (references ? "\n" : "") + entry;
    }
    const allNotes = await store.getNotes(id);
    let notes = allNotes.slice(-PROJECT_NOTES_CONTEXT_LIMIT);
    if (notes.length < allNotes.length && notes.charCodeAt(0) >= 0xdc00 && notes.charCodeAt(0) <= 0xdfff) notes = notes.slice(1);
    return { ...(context ?? { kind: "web" }), project: { id, instructions: project.instructions ?? "", filesPath, files, references, notes, ...(params.sessionHistory ? { sessionHistory: true } : {}) } };
  }
}
