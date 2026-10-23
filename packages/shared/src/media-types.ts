// The first MIME type for each extension is its canonical upload default.
export const EXTENSION_TO_MIME_TYPES: Record<string, readonly string[]> = {
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  svg: ["image/svg+xml"],
  pdf: ["application/pdf"],
  json: ["application/json", "text/plain"],
  txt: ["text/plain"],
  md: ["text/markdown", "text/plain"],
  markdown: ["text/markdown", "text/plain"],
  csv: ["text/csv", "text/plain", "application/vnd.ms-excel"],
  doc: ["application/msword"],
  docx: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ppt: ["application/vnd.ms-powerpoint"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
};
