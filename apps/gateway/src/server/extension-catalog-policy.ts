import { allowedCorsOrigins } from "./origins.js";

const prefix = "/api/admin/extension-catalog";

export function ownsExtensionCatalogPath(path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function allowsCatalogWriteOrigin(origin: string | null | undefined): boolean {
  return origin == null || allowedCorsOrigins().includes(origin);
}
