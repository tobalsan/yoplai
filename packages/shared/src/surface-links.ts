export type Surface = "threadit" | "mattermost";

export type SurfaceIdentity = { username: string; email?: string | null; isAgent: boolean };
export type SurfaceIdentityProvider = {
  surface: Surface;
  scope: string;
  lookup(externalId: string): Promise<SurfaceIdentity>;
};
export type SurfaceLinkIdentity = { surface: Surface; scope: string; externalId: string; username: string };
export type SurfaceLink = SurfaceLinkIdentity & { id: string; linkedAt: number };
export interface SurfaceLinkService {
  readonly baseUrl: string;
  issue(identity: SurfaceLinkIdentity): Promise<string>;
  inspect(token: string): SurfaceLinkIdentity;
  redeem(token: string, user: { id: string; email: string }): Promise<void>;
  resolve(surface: Surface, scope: string, externalId: string): string | undefined;
  list(userId: string): SurfaceLink[];
  unlink(userId: string, linkId: string): void;
}

export function normalizeSurfaceScope(scope: string): string {
  const url = new URL(scope.trim());
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/+$/, "");
}

let service: SurfaceLinkService | undefined;
export const getSurfaceLinkService = () => service;
export function registerSurfaceLinkService(next: SurfaceLinkService): () => void {
  service = next;
  return () => { if (service === next) service = undefined; };
}

const providers = new Map<string, SurfaceIdentityProvider[]>();
const providerKey = (surface: Surface, scope: string) => `${surface}:${normalizeSurfaceScope(scope)}`;
/** Providers outlive service startup order; stopping a transport removes only its registration. */
export function registerSurfaceIdentityProvider(provider: SurfaceIdentityProvider): () => void {
  const key = providerKey(provider.surface, provider.scope);
  const registrations = providers.get(key) ?? [];
  registrations.push(provider);
  providers.set(key, registrations);
  return () => {
    const index = registrations.indexOf(provider);
    if (index === -1) return;
    registrations.splice(index, 1);
    if (registrations.length === 0) providers.delete(key);
  };
}
export function getSurfaceIdentityProvider(surface: Surface, scope: string): SurfaceIdentityProvider | undefined {
  return providers.get(providerKey(surface, scope))?.at(-1);
}
