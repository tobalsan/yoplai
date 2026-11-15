import { createHash, randomBytes } from "node:crypto";
import type { DashboardEmbedMeta } from "../canvas/embed-contract.js";
import { getLinkedGateways } from "./state.js";
import type { RemoteGateway } from "./store.js";

export const DASHBOARD_VIEW_GRANT_TTL_MS = 30 * 60 * 1000;
export const DASHBOARD_VIEW_GRANT_LIMIT = 128;

/** What the latest view through a grant returned. The trusted host reads it. The frame cannot. */
export type DashboardViewOutcome =
  | { ok: true; meta: DashboardEmbedMeta }
  | { ok: false; error: string; status: number };
export type DashboardViewRecord = { seq: number; dashboardId: string } & DashboardViewOutcome;

type Grant = {
  gateway: string;
  /** Hash of the link that issued the grant. Unlink and relink change it. */
  link: string;
  origin: string;
  expiresAt: number;
  views: number;
  view?: DashboardViewRecord;
};

const grants = new Map<string, Grant>();

function linkFingerprint(gateway: RemoteGateway): string {
  return createHash("sha256").update(JSON.stringify([gateway.name, gateway.url, gateway.token ?? null])).digest("hex");
}

/** Drops expired grants and grants whose link no longer exists or changed. */
function sweep(now: number): void {
  const links = new Map(getLinkedGateways().map((gateway) => [gateway.name, linkFingerprint(gateway)]));
  for (const [id, grant] of grants) {
    if (grant.expiresAt <= now || links.get(grant.gateway) !== grant.link) grants.delete(id);
  }
}

export function createDashboardViewGrant(
  gateway: RemoteGateway,
  origin: string,
  now = Date.now()
): { grant: string; expiresAt: number } | undefined {
  sweep(now);
  if (grants.size >= DASHBOARD_VIEW_GRANT_LIMIT) return undefined;
  const grant = randomBytes(32).toString("base64url");
  const expiresAt = now + DASHBOARD_VIEW_GRANT_TTL_MS;
  grants.set(grant, { gateway: gateway.name, link: linkFingerprint(gateway), origin, expiresAt, views: 0 });
  return { grant, expiresAt };
}

export type ResolvedDashboardViewGrant = { gateway: RemoteGateway; origin: string; expiresAt: number; view?: DashboardViewRecord };

/** Returns the linked gateway, or undefined when the grant is unknown, expired, or its link changed. */
export function resolveDashboardViewGrant(grant: string, now = Date.now()): ResolvedDashboardViewGrant | undefined {
  const entry = grants.get(grant);
  if (!entry) return undefined;
  const gateway = getLinkedGateways().find((item) => item.name === entry.gateway);
  if (entry.expiresAt <= now || !gateway || linkFingerprint(gateway) !== entry.link) {
    grants.delete(grant);
    return undefined;
  }
  return { gateway, origin: entry.origin, expiresAt: entry.expiresAt, view: entry.view };
}

export function recordDashboardView(grant: string, dashboardId: string, outcome: DashboardViewOutcome): void {
  const entry = grants.get(grant);
  if (!entry) return;
  entry.views += 1;
  entry.view = { seq: entry.views, dashboardId, ...outcome };
}

export function resetDashboardViewGrantsForTests(): void {
  grants.clear();
}
