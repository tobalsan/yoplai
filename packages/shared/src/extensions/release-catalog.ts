import { extensionDigestSchema, extensionIdSchema } from "./install-record.js";
import { z } from "zod";

export const extensionCategories = [
  "communication", "productivity", "sales", "support", "data", "search", "finance", "developer",
] as const;
export const maxExtensionBundleBytes = 50_000_000;
export const extensionVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/);
export const releaseCatalogEntrySchema = z.object({
  id: extensionIdSchema,
  name: z.string().min(1),
  tagline: z.string(),
  description: z.string(),
  category: z.enum(extensionCategories),
  version: extensionVersionSchema,
  minYoplai: extensionVersionSchema,
  url: z.string().url(),
  size: z.number().int().positive().max(maxExtensionBundleBytes),
  sha256: extensionDigestSchema.transform((value) => value.toLowerCase()),
  iconUrl: z.string().url().optional(),
  docsUrl: z.string().url().optional(),
});

export type ReleaseCatalogEntry = z.infer<typeof releaseCatalogEntrySchema>;
export type ReleaseCatalogRow = Partial<Omit<ReleaseCatalogEntry, "id">> & {
  id: string;
  state: "available" | "installed" | "update" | "manual" | "incompatible";
  installedVersion?: string;
  iconDataUri?: string;
  usedByAgents: number;
};

export type ReleaseCatalogView = {
  source: string;
  fetchedAt: string | null;
  stale: boolean;
  error?: string;
  entries: ReleaseCatalogRow[];
};
