import { createMemo, createResource, type Accessor } from "solid-js";
import { useSession } from "../auth/client";
import { capabilities } from "./capabilities";
import { fetchGatewayCapabilities, type GatewayName } from "../api/gateway";
import { hasStaffRole, isSuperadmin, type SessionRole } from "./roles";

/**
 * Who asks, from the point of view of the gateway that serves the page.
 * A local page uses the local session and capabilities. A remote page uses
 * the capabilities of the remote and the identity of the linked bearer owner.
 * A remote read that failed is `unknown`, and it grants no rights.
 */
export type Requester = {
  gateway: GatewayName;
  ready: boolean;
  unknown: boolean;
  multiUser: boolean;
  forkedAgents: boolean;
  enableCronMonitoring: boolean;
  user?: { id: string; name?: string | null; email?: string | null; image?: string | null; role?: SessionRole };
  isExtensionEnabled: (id: string) => boolean;
  isStaff: boolean;
  isSuperadmin: boolean;
};

export function useRequester(gateway: Accessor<GatewayName>): Accessor<Requester> {
  const session = useSession();
  const [remote] = createResource(
    () => gateway() ?? null,
    async (name) => {
      try { return { gateway: name, caps: await fetchGatewayCapabilities(name) }; }
      catch { return { gateway: name, caps: undefined }; }
    }
  );
  return createMemo<Requester>(() => {
    const name = gateway();
    if (name === undefined) {
      const user = session().data?.user as Requester["user"];
      const role = (user as { role?: SessionRole } | undefined)?.role;
      return {
        gateway: undefined,
        ready: !session().isPending,
        unknown: false,
        multiUser: capabilities.multiUser,
        forkedAgents: capabilities.forkedAgents === true,
        enableCronMonitoring: capabilities.enableCronMonitoring === true,
        user,
        isExtensionEnabled: (id) => capabilities.extensions[id] === true,
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
      forkedAgents: caps?.forkedAgents === true,
      enableCronMonitoring: caps?.enableCronMonitoring === true,
      user: caps?.user,
      isExtensionEnabled: (id) => caps?.extensions[id] === true,
      isStaff: hasStaffRole(role),
      isSuperadmin: isSuperadmin(role),
    };
  });
}
