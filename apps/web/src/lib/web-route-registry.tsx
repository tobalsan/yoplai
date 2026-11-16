import { Route, useParams } from "@solidjs/router";
import { Show, type Component, type JSX } from "solid-js";
import { isExtensionEnabled } from "./capabilities";
import { decodeRouteParam } from "./path";
import { useAgentTarget } from "./agent-target";
import { useRequester } from "./requester";
import { LeftNavShell } from "../components/LeftNavShell";
import { ExtensionDetails } from "../pages/ExtensionDetails";

type ExtensionRoute = {
  path: string;
  component: Component;
};

// Agent-keyed config route: the bespoke-route tier of the config-surface
// contract (ALG-354). An extension self-registers a config page whose `path`
// carries the `:agentId` param — mirroring the `:projectId` param used by the
// project extension routes above — and the Edit-Agent hub redirects there when
// the extension is enabled for an agent. The gateway catalog reports the same
// route (resolved) as `configRoutePath`; this registry mounts the matching
// client `<Route>` so the redirect target actually renders.
type AgentConfigRoute = {
  path: string;
  component: Component;
};

type WebRouteExtension = {
  extensionId: string;
  home?: Component;
  defaultHome?: boolean;
  routes: ExtensionRoute[];
  // Optional bespoke, agent-keyed config surface (`:agentId` param). Escape
  // hatch for custom config UI; omitted by extensions that use the schema-
  // driven auto-form or are toggle-only.
  configRoute?: AgentConfigRoute;
};

type WebRouteModule = {
  webRouteExtension?: WebRouteExtension;
};

const routeModules = import.meta.glob<WebRouteModule>("../extensions/*/routes.tsx", {
  eager: true,
});

function getExtensions(): WebRouteExtension[] {
  return Object.values(routeModules)
    .map((mod) => mod.webRouteExtension)
    .filter((extension): extension is WebRouteExtension => Boolean(extension));
}

export function getExtensionHome(extensionId: string): Component | undefined {
  const extension = getExtensions().find((item) => item.extensionId === extensionId);
  if (!extension || !isExtensionEnabled(extension.extensionId)) return undefined;
  return extension.home;
}

export function getDefaultExtensionHome(): Component | undefined {
  const extension = getExtensions().find(
    (item) => item.defaultHome && item.home && isExtensionEnabled(item.extensionId)
  );
  return extension?.home;
}

/**
 * An agent config page belongs to the gateway of its agent. The route is always
 * mounted, because the local extension list says nothing about a remote agent.
 * The page checks the extension on the gateway that hosts the agent. Where that
 * gateway does not load the extension, the generic details page opens instead.
 */
function AgentConfigRoute(props: { extensionId: string; component: Component }) {
  const routeParams = useParams<{ agentId: string }>();
  const { target } = useAgentTarget(() => decodeRouteParam(routeParams.agentId));
  const gateway = () => { const current = target(); return current.state === "ready" ? current.gateway : undefined; };
  const requester = useRequester(gateway);
  const settled = () => target().state === "missing" || (target().state === "ready" && (gateway() === undefined || requester().ready));
  const Config = props.component;
  return (
    <Show when={settled()} fallback={<LeftNavShell><p role="status">Loading…</p></LeftNavShell>}>
      <Show when={target().state === "missing" || requester().isExtensionEnabled(props.extensionId)} fallback={<LeftNavShell><ExtensionDetails extensionId={props.extensionId} requester={requester} /></LeftNavShell>}>
        <Config />
      </Show>
    </Show>
  );
}

export function renderExtensionRoutes(
  wrap: (component: Component) => JSX.Element
): JSX.Element[] {
  return getExtensions().flatMap((extension) => {
    const routes = isExtensionEnabled(extension.extensionId)
      ? extension.routes.map((route) => (
          <Route path={route.path} component={() => wrap(route.component)} />
        ))
      : [];
    // Mount the bespoke agent-keyed config route too, so the hub's redirect
    // target renders. The route does not depend on the local extension list.
    if (extension.configRoute) {
      const configRoute = extension.configRoute;
      routes.push(
        <Route
          path={configRoute.path}
          component={() => wrap(() => <AgentConfigRoute extensionId={extension.extensionId} component={configRoute.component} />)}
        />
      );
    }
    return routes;
  });
}
