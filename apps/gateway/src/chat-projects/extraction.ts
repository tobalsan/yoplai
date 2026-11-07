import path from "node:path";
import { ExtractionError, extractTextDetails } from "../media/extract.js";
import { logWarn } from "../logging.js";
import type { ChatProjectFile, ChatProjectStore } from "./store.js";

export async function extractProjectFile(
  store: ChatProjectStore,
  projectId: string,
  file: ChatProjectFile
): Promise<ChatProjectFile> {
  let extracted: ChatProjectFile;
  try {
    const { text, note } = await extractTextDetails(path.join(store.filesDirectory(projectId), file.id), file.mimeType);
    extracted = { ...file, ...(text ? { text: text.slice(0, 250_000) } : {}), ...(note ? { extractionNote: note } : {}) };
    await store.updateFile(projectId, extracted);
  } catch (error) {
    const original = error instanceof ExtractionError && error.cause !== undefined ? error.cause : error;
    logWarn("Project file text extraction failed", {
      projectId, fileId: file.id, name: file.name, message: original instanceof Error ? original.message : String(original),
    });
    extracted = { ...file, extractionError: error instanceof ExtractionError ? error.message : "Text extraction failed" };
    await store.updateFile(projectId, extracted);
  }
  return extracted;
}
