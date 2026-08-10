import type { FileAttachment } from "./types.js";

/** One capability rule shared by all runtime adapters. */
export function modelSupportsImages(model: { input?: readonly string[] } | undefined): boolean {
  return model?.input?.includes("image") ?? false;
}

export type ImageDescription = Pick<FileAttachment, "path"> & { description: string };

/** Formats descriptions separately so later image references remain unambiguous. */
export function formatImageDescriptionBlocks(descriptions: ImageDescription[]): string {
  if (!descriptions.length) return "";
  return descriptions.map((image, index) => [
    `[Image ${index + 1} description — generated from, not the original image]`,
    `Container path: ${image.path}`,
    image.description,
  ].join("\n")).join("\n\n---\n\n");
}
