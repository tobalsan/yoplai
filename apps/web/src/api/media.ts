import type { FileAttachment, UploadResponse } from "./types";
import { API_BASE, apiFetch as fetch } from "./core";

/**
 * Upload a file to the server
 * Returns the file path that can be used in attachments
 */
async function uploadFile(file: File, agentId?: string): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_BASE}/media/upload${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(error.error || "Upload failed");
  }

  return res.json();
}

/**
 * Upload multiple files and return their paths as FileAttachments
 */
export async function uploadFiles(files: File[], agentId?: string): Promise<FileAttachment[]> {
  const results = await Promise.all(files.map((file) => uploadFile(file, agentId)));
  return results.map((r, index) => ({
    path: r.path,
    mimeType: r.mimeType,
    filename: files[index]?.name ?? r.filename,
    size: r.size,
  }));
}

type UploadedAttachment = {
  originalName: string;
  savedName: string;
  path: string;
  isImage: boolean;
};

export type UploadAttachmentsResult =
  | { ok: true; data: UploadedAttachment[] }
  | { ok: false; error: string };

export async function uploadAttachments(
  projectId: string,
  files: File[]
): Promise<UploadAttachmentsResult> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }

  const res = await fetch(`${API_BASE}/projects/${projectId}/attachments`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to upload attachments" }));
    return { ok: false, error: data.error ?? "Failed to upload attachments" };
  }

  const data = (await res.json()) as UploadedAttachment[];
  return { ok: true, data };
}
