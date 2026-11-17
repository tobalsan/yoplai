import { z } from "zod";

/**
 * Contract between the remote embed renderer (`GET /d/:id/embed`) and the local
 * dashboard viewer relay. Each version number changes only with a break in the
 * contract. A reader that does not know a version refuses the page.
 */
export const DASHBOARD_EMBED_VERSION = 1;
/** Version of the remote security policy that the local viewer replaces with its own. */
export const DASHBOARD_EMBED_POLICY_VERSION = 1;
/** Asset version that the embed page expects from `/d-assets`. */
export const DASHBOARD_EMBED_ASSET_VERSION = "v3";

export const DASHBOARD_EMBED_HEADERS = {
  version: "X-Yoplai-Dashboard-Embed",
  assets: "X-Yoplai-Dashboard-Embed-Assets",
  policy: "X-Yoplai-Dashboard-Embed-Policy",
  meta: "X-Yoplai-Dashboard-Embed-Meta",
  reason: "X-Yoplai-Dashboard-Embed-Reason",
  theme: "X-Yoplai-Embed-Theme",
} as const;

export const DASHBOARD_ID_RE = /^[A-Za-z0-9_-]{32}$/;
/** Query names with this prefix belong to the viewer transport. The relay never forwards them. */
export const DASHBOARD_TRANSPORT_QUERY_PREFIX = "__yoplai_";
export const DASHBOARD_EMBED_META_MAX_BYTES = 2048;

const boundedText = z.string().min(1).max(128).regex(/^[^\s\p{Cc}]+$/u);

/** Checked facts for the trusted host. The page worker builds its Chat and annotation controls from them. */
export const DashboardEmbedMetaSchema = z
  .object({
    dashboardId: z.string().regex(DASHBOARD_ID_RE),
    /** The raw agent ID on the remote. The host adds the gateway suffix from its own state. */
    agentId: boundedText,
    canWrite: z.boolean(),
    canEdit: z.boolean(),
    /** Null when the viewer cannot chat with the agent. A null session means a new chat. */
    chat: z.object({ sessionId: boundedText.nullable() }).strict().nullable(),
    annotation: z.boolean(),
  })
  .strict()
  .refine((meta) => !meta.annotation || meta.chat !== null);
export type DashboardEmbedMeta = z.infer<typeof DashboardEmbedMetaSchema>;

export function encodeDashboardEmbedMeta(meta: DashboardEmbedMeta): string {
  return Buffer.from(JSON.stringify(DashboardEmbedMetaSchema.parse(meta))).toString("base64url");
}

/** Returns undefined for a missing, oversized, malformed, or inconsistent value. */
export function decodeDashboardEmbedMeta(value: string | null): DashboardEmbedMeta | undefined {
  if (!value || value.length > DASHBOARD_EMBED_META_MAX_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const parsed = DashboardEmbedMetaSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
