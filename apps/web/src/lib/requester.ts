import { createMemo, createResource, useContext, type Accessor } from "solid-js";
import { PageNavigationContext } from "../api/core";
import { useSession } from "../auth/client";
import { capabilities, capabilitiesFailed, capabilitiesReady, loadCapabilities } from "./capabilities";
import { fetchGatewayCapabilities, type GatewayName } from "../api/gateway";
import { hasStaffRole, isSuperadmin, type SessionRole } from "./roles";

/**
 * Who asks, from the point of view of the gateway that serves the page.
 * A local page uses the local session and capabilities. A remote page uses
 * the capabilities of the remote and the identity of the linked bearer owner.
 * A read that failed, local or remote, is `unknown`, and it grants no rights.
 */
export type Requester = {
  gateway: GatewayName;
  ready: boolean;
  unknown: boolean;
  multiUser: boolean;
  enableCronMonitoring: boolean;
  user?: { id: string; name?: string | null; email?: string | null; image?: string | null; role?: SessionRole };
  isExtensionEnabled: (id: string) => boolean;
  /** Reads the capabilities of the gateway again. */
  retry: () => void;
  isStaff: boolean;
  isSuperadmin: boolean;
};

export function useRequester(gateway: Accessor<GatewayName>): Accessor<Requester> {
  const session = useSession();
  const insideAppFrame = useContext(PageNavigationContext) !== undefined;
  const [remote, { refetch }] = createResource(
    () => gateway() ?? null,
    async (name) => {
      try { return { gateway: name, caps: await fetchGatewayCapabilities(name) }; }
      catch { return { gateway: name, caps: undefined }; }
    }
  );
  return createMemo<Requester>(() => {
    const name = gateway();
    if (name === undefined) {
      // A single-user app page has no auth service to wait for.
      const localSession = insideAppFrame && !capabilities.multiUser ? undefined : session();
      const user = localSession?.data?.user as Requester["user"];
      const role = (user as { role?: SessionRole } | undefined)?.role;
      return {
        gateway: undefined,
        ready: !localSession?.isPending && capabilitiesReady(),
        unknown: capabilitiesFailed(),
        multiUser: capabilities.multiUser,
        enableCronMonitoring: capabilities.enableCronMonitoring === true,
        user,
        isExtensionEnabled: (id) => capabilities.extensions[id] === true,
        retry: () => void loadCapabilities().catch(() => undefined),
        isStaff: hasStaffRole(role),
        isSuperadmin: isSuperadmin(role),
      };
    }
    const result = remote.state === "ready" || remote.state === "refreshing" ? remote() : undefined;
    const caps = result?.gateway === name ? result.caps : undefined;
    const loaded = result?.gateway === name;
    const role = caps?.user?.role;
    return {
      gateway: name,
      ready: loaded,
      unknown: loaded && !caps,
      multiUser: caps?.multiUser === true,
      enableCronMonitoring: caps?.enableCronMonitoring === true,
      user: caps?.user,
      isExtensionEnabled: (id) => caps?.extensions[id] === true,
      retry: () => void refetch(),
      isStaff: hasStaffRole(role),
      isSuperadmin: isSuperadmin(role),
    };
  });
}
