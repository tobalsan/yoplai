import { createSignal } from "solid-js";
import {
  createPendingFile,
  isSupportedFile,
  MAX_UPLOAD_SIZE_BYTES,
  revokePendingFile,
  type PendingFile,
} from "./attachments";

export type { PendingFile };

export function createChatAttachmentRuntime() {
  const [pendingFiles, setPendingFiles] = createSignal<PendingFile[]>([]);
  const [uploadingFiles, setUploadingFiles] = createSignal(false);
  const [uploadError, setUploadError] = createSignal("");

  const clearFiles = () => {
    setPendingFiles((prev) => {
      prev.forEach(revokePendingFile);
      return [];
    });
  };

  const attachFiles = (files: FileList | File[]) => {
    setUploadError("");
    const next: PendingFile[] = [];
    for (const file of Array.from(files)) {
      if (!isSupportedFile(file)) {
        setUploadError(`Unsupported file type: ${file.name}`);
        continue;
      }
      if (file.size > MAX_UPLOAD_SIZE_BYTES) {
        setUploadError(`File exceeds 25 MB: ${file.name}`);
        continue;
      }
      next.push(createPendingFile(file));
    }
    if (next.length > 0) setPendingFiles((prev) => [...prev, ...next]);
  };

  const removeFile = (id: string) => {
    setPendingFiles((prev) => {
      const removed = prev.find((item) => item.id === id);
      if (removed) revokePendingFile(removed);
      return prev.filter((item) => item.id !== id);
    });
  };

  return {
    pendingFiles,
    uploadingFiles,
    uploadError,
    setUploadingFiles,
    setUploadError,
    attachFiles,
    clearFiles,
    removeFile,
  };
}
