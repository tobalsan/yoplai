import { Router, Route, useLocation } from "@solidjs/router";
import {
  Show,
  Suspense,
  createEffect,
  lazy,
  createMemo,
  createResource,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { fetchAgents } from "./api";
import { ChatView } from "./components/ChatView";
import { OnboardingTour } from "./onboarding/OnboardingTour";
import { ConnectToolsPrompt } from "./components/ConnectToolsPrompt";
import { SessionSearch } from "./components/SessionSearch";
import { TurnNotifier } from "./components/TurnNotifier";
import { LeftNavShell } from "./components/LeftNavShell";
import { AgentCatalog } from "./pages/AgentCatalog";
import { MainAgentHome } from "./pages/MainAgentHome";
import { EditAgent } from "./pages/EditAgent";
import { ScheduleRuns } from "./pages/ScheduleRuns";
import { ScheduleRunTrace } from "./pages/ScheduleRunTrace";
import { ExtensionDetails } from "./pages/ExtensionDetails";
import { McpServerDetails } from "./pages/McpServerDetails";
import { ChatProject } from "./pages/ChatProject";
import { SharedChat } from "./pages/SharedChat";
import { Teams } from "./pages/Teams";
import { Dashboards } from "./pages/Dashboards";
import { RemoteDashboard } from "./pages/RemoteDashboard";
import { Skills } from "./pages/Skills";
import { AccountConnections } from "./pages/AccountConnections";
import { GatewayLink } from "./pages/GatewayLink";
import { GatewayLinks } from "./pages/GatewayLinks";
import { RemoteGateways } from "./pages/RemoteGateways";
import { SessionArchive } from "./pages/SessionArchive";
import { ImpersonationBanner } from "./components/ImpersonationBanner";
import {
  capabilitiesReady,
  capabilities,
  loadCapabilities,
} from "./lib/capabilities";
import {
  toggleSidebarCollapsed,
  toggleZenMode,
  zenMode,
} from "./lib/layout";
import {
  getDefaultExtensionHome,
  getExtensionHome,
  renderExtensionRoutes,
} from "./lib/web-route-registry";
import { documentTitle } from "./lib/document-title";
import { stripBase } from "./lib/path";
import { ToastHost } from "./lib/toast";
import { isDesktopWindow } from "./lib/desktop-window";
import { SetupGate } from "./desktop-setup/SetupGate";
import { useScheduleAlerts } from "./lib/schedule-alerts";

const LazyAuthGuard = lazy(() => import("./auth/AuthGuard"));
const LazyDesktopSetup = lazy(() => import("./desktop-setup/Wizard"));
const LazyLoginPage = lazy(() => import("./pages/Login"));
const LazyAdminUsersPage = lazy(() => import("./pages/admin/Users"));
const LazyAdminExtensionsPage = lazy(() => import("./pages/admin/Extensions"));
const LazyAdminMcpServersPage = lazy(() => import("./pages/admin/McpServers"));
const LazyAdminQuotaPage = lazy(() => import("./pages/admin/Quota"));
const LazyAdminSkillsPage = lazy(() => import("./pages/admin/Skills"));

function Layout(props: { children?: JSX.Element }) {
  const location = useLocation();
  const desktopWindow = isDesktopWindow();
  const isLoginPage = createMemo(() =>
    stripBase(location.pathname).startsWith("/login")
  );
  const chatAgentId = createMemo(() => {
    const match = stripBase(location.pathname).match(/^\/chat\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  });
  const [chatAgents] = createResource(
    () =>
      chatAgentId() &&
      capabilitiesReady() &&
      (!capabilities.multiUser || Boolean(capabilities.user))
        ? chatAgentId()
        : null,
    () => fetchAgents()
  );
  const chatAgentName = createMemo(
    () => chatAgents()?.find((agent) => agent.id === chatAgentId())?.name
  );
  // The gateway of the chat agent comes from the resolved agent list, never from its ID suffix.
  const chatGateway = createMemo(() => chatAgents()?.find((agent) => agent.id === chatAgentId())?.gateway);
  useScheduleAlerts(() => !isLoginPage(), chatAgentId, chatGateway);

  onMount(() => {
    void loadCapabilities().catch(() => undefined);
  });

  createEffect(() => {
    const devPrefix =
      import.meta.env.VITE_YOPLAI_DEV === "true" ||
      import.meta.env.VITE_AIHUB_DEV === "true"
        ? `[DEV :${import.meta.env.VITE_YOPLAI_UI_PORT ?? import.meta.env.VITE_AIHUB_UI_PORT ?? "?"}] `
        : undefined;
    document.title = documentTitle({
      pathname: location.pathname,
      brandingName: capabilities.branding?.name,
      agentName: chatAgentName(),
      devPrefix,
    });
  });

  createEffect(() => {
    if (isLoginPage()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "b" && !event.shiftKey) {
        event.preventDefault();
        toggleSidebarCollapsed();
        return;
      }
      if (key === "z" && event.shiftKey) {
        event.preventDefault();
        toggleZenMode();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <>
      <Show when={capabilitiesReady()} fallback={<AppBootSplash />}>
        <div class="app" classList={{ "zen-mode": zenMode(), "desktop-window": desktopWindow,
          "desktop-wizard": desktopWindow && stripBase(location.pathname) === "/setup" }}>
          <ImpersonationBanner />
          <SetupGate>{props.children}</SetupGate>
          <OnboardingTour />
          <ConnectToolsPrompt />
          <SessionSearch />
          <TurnNotifier enabled={!isLoginPage()} />
        </div>
        <ToastHost />
      </Show>
      <style>{`
        .app {
          height: 100%;
          display: flex;
          flex-direction: column;
          width: 100%;
        }

        .desktop-window {
          --desktop-buttons-width: 88px;
          --desktop-buttons-height: 40px;
        }
        /* Electron reads only a literal app-region value, not var(). */
        body:is(.driver-active, :has([role="dialog"], [role="alertdialog"], dialog[open], .chat-side-panel-overlay, .session-menu)) .desktop-window *,
        body:is(.driver-active, :has([role="dialog"], [role="alertdialog"], dialog[open], .chat-side-panel-overlay, .session-menu)) .desktop-window::before,
        body:is(.driver-active, :has([role="dialog"], [role="alertdialog"], dialog[open], .chat-side-panel-overlay, .session-menu)) .desktop-window *::before {
          -webkit-app-region: no-drag !important;
        }
        .desktop-window:not(.desktop-wizard, :has(.left-nav-shell))::before {
          content: "";
          flex: 0 0 8px;
          margin-inline-start: var(--desktop-buttons-width);
          -webkit-app-region: drag;
        }
        .desktop-window :is(button, a, input, select, textarea, label, [role="menu"], [role="button"], [contenteditable]) {
          -webkit-app-region: no-drag;
        }
        .desktop-window .mobile-sidebar-toggle { margin-top: var(--desktop-buttons-height); }
        .app.zen-mode {
          background: var(--bg-base);
        }
      `}</style>
    </>
  );
}

function AppBootSplash() {
  return <div class="app" />;
}

function GuardedRoute(props: { children?: JSX.Element }) {
  return (
    <Show when={capabilities.multiUser} fallback={props.children}>
      <Suspense fallback={<AppBootSplash />}>
        <LazyAuthGuard>{props.children}</LazyAuthGuard>
      </Suspense>
    </Show>
  );
}

function HomeRoute() {
  const home = capabilities.home;
  if (typeof home === "string") {
    const Home = getExtensionHome(home);
    if (Home) return <Home />;
  }
  const defaultHome = getDefaultExtensionHome();
  if (defaultHome) {
    const DefaultHome = defaultHome;
    return <DefaultHome />;
  }
  return <LeftNavShell><MainAgentHome /></LeftNavShell>;
}

function AgentsRouteShell() {
  return (
    <LeftNavShell>
      <AgentCatalog />
    </LeftNavShell>
  );
}

function TeamsRouteShell() {
  return (
    <LeftNavShell>
      <Show when={capabilities.forkedAgents} fallback={<AgentCatalog />}>
        <Teams />
      </Show>
    </LeftNavShell>
  );
}

function EditAgentRouteShell() {
  return (
    <LeftNavShell>
      <EditAgent />
    </LeftNavShell>
  );
}

function ExtensionDetailsRouteShell() {
  return (
    <LeftNavShell>
      <ExtensionDetails />
    </LeftNavShell>
  );
}
function McpServerDetailsRouteShell() {
  return (
    <LeftNavShell>
      <McpServerDetails />
    </LeftNavShell>
  );
}
function ChatRouteShell() {
  return (
    <LeftNavShell>
      <ChatView />
    </LeftNavShell>
  );
}

function LoginRoute() {
  return (
    <Suspense fallback={<AppBootSplash />}>
      <LazyLoginPage />
    </Suspense>
  );
}

function AdminUsersRouteShell() {
  return (
    <LeftNavShell>
      <Suspense>
        <LazyAdminUsersPage />
      </Suspense>
    </LeftNavShell>
  );
}

function AdminMcpServersRouteShell() {
  return (
    <LeftNavShell>
      <Suspense>
        <LazyAdminMcpServersPage />
      </Suspense>
    </LeftNavShell>
  );
}

function AdminExtensionsRouteShell() {
  return (
    <LeftNavShell>
      <Suspense>
        <LazyAdminExtensionsPage />
      </Suspense>
    </LeftNavShell>
  );
}

export default function App() {
  const base = import.meta.env.BASE_URL;
  return (
    <Router root={Layout} base={base}>
      <Route path="/setup" component={() => <Suspense><LazyDesktopSetup /></Suspense>} />
      <Route path="/login" component={LoginRoute} />
      <Route
        path="/"
        component={() => (
          <GuardedRoute>
            <HomeRoute />
          </GuardedRoute>
        )}
      />
      <Route
        path="/agents"
        component={() => (
          <GuardedRoute>
            <AgentsRouteShell />
          </GuardedRoute>
        )}
      />
      <Route
        path="/dashboards"
        component={() => <GuardedRoute><LeftNavShell><Dashboards /></LeftNavShell></GuardedRoute>}
      />
      <Route
        path="/remote-dashboards/:gateway/:id"
        component={() => <GuardedRoute><LeftNavShell><RemoteDashboard /></LeftNavShell></GuardedRoute>}
      />
      <Route path={["/skills", "/skills/:id"]} component={() => <GuardedRoute><LeftNavShell><Skills /></LeftNavShell></GuardedRoute>} />
      <Route path="/admin/skills" component={() => <GuardedRoute><LeftNavShell><Suspense><LazyAdminSkillsPage /></Suspense></LeftNavShell></GuardedRoute>} />
      <Route path="/admin/quota" component={() => <GuardedRoute><LeftNavShell><Suspense><LazyAdminQuotaPage /></Suspense></LeftNavShell></GuardedRoute>} />
      <Route
        path="/teams"
        component={() => (
          <GuardedRoute>
            <TeamsRouteShell />
          </GuardedRoute>
        )}
      />
      <Route
        path="/agents/:agentId/edit"
        component={() => (
          <GuardedRoute>
            <EditAgentRouteShell />
          </GuardedRoute>
        )}
      />
      <Route
        path="/agents/:agentId/schedules/:jobId/runs"
        component={() => (
          <GuardedRoute>
            <LeftNavShell><ScheduleRuns /></LeftNavShell>
          </GuardedRoute>
        )}
      />
      <Route
        path="/agents/:agentId/schedules/:jobId/runs/:runId"
        component={() => (
          <GuardedRoute>
            <LeftNavShell><ScheduleRunTrace /></LeftNavShell>
          </GuardedRoute>
        )}
      />
      <Route
        path="/agents/:agentId/mcp-servers/:serverName"
        component={() => (
          <GuardedRoute>
            <McpServerDetailsRouteShell />
          </GuardedRoute>
        )}
      />
      <Route
        path={["/agents/:agentId/extensions/:extensionId", "/agents/:agentId/extensions/:extensionId/config"]}
        component={() => (
          <GuardedRoute>
            <ExtensionDetailsRouteShell />
          </GuardedRoute>
        )}
      />
      <Route path="/p/:id" component={() => <GuardedRoute><LeftNavShell><ChatProject /></LeftNavShell></GuardedRoute>} />
      <Route path="/shared/:token" component={() => <GuardedRoute><LeftNavShell><SharedChat /></LeftNavShell></GuardedRoute>} />
      <Route
        path="/chat/:agentId/:view?"
        component={() => (
          <GuardedRoute>
            <ChatRouteShell />
          </GuardedRoute>
        )}
      />
      {renderExtensionRoutes((Component) => (
        <GuardedRoute>
          <Component />
        </GuardedRoute>
      ))}
      <Route
        path="/admin/users"
        component={() => (
          <GuardedRoute>
            <AdminUsersRouteShell />
          </GuardedRoute>
        )}
      />
      <Route
        path="/admin/extensions"
        component={() => (
          <GuardedRoute>
            <AdminExtensionsRouteShell />
          </GuardedRoute>
        )}
      />
      <Route
        path="/admin/mcp-servers"
        component={() => (
          <GuardedRoute>
            <AdminMcpServersRouteShell />
          </GuardedRoute>
        )}
      />
      <Route
        path="/archive"
        component={() => (
          <GuardedRoute>
            <SessionArchive />
          </GuardedRoute>
        )}
      />
      <Route
        path="/account/connections"
        component={() => (
          <GuardedRoute>
            <AccountConnections />
          </GuardedRoute>
        )}
      />
      <Route
        path="/account/gateway-links"
        component={() => (
          <GuardedRoute>
            <GatewayLinks />
          </GuardedRoute>
        )}
      />
      <Route
        path="/remote-gateways"
        component={() => (
          <GuardedRoute>
            <RemoteGateways />
          </GuardedRoute>
        )}
      />
      <Route
        path="/gateway-link"
        component={() => (
          <GuardedRoute>
            <GatewayLink />
          </GuardedRoute>
        )}
      />
    </Router>
  );
}
