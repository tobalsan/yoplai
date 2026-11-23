import { Router, Route, useIsRouting, useLocation, type RouteSectionProps } from "@solidjs/router";
import {
  ErrorBoundary,
  Show,
  Suspense,
  createComputed,
  createEffect,
  createRenderEffect,
  createSignal,
  on,
  lazy,
  createMemo,
  createResource,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { fetchAgents } from "./api";
import { PageNavigationContext } from "./api/core";
import { ChatView } from "./components/ChatView";
import { OnboardingTour } from "./onboarding/OnboardingTour";
import { ConnectToolsPrompt } from "./components/ConnectToolsPrompt";
import { SessionSearch } from "./components/SessionSearch";
import { TurnNotifier } from "./components/TurnNotifier";
import { LeftNavShell } from "./components/LeftNavShell";
import { Button } from "./components/ui/Button";
import { PageToolbar } from "./components/PageToolbar";
import { NewAgent } from "./pages/NewAgent";
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
  reloadCapabilities,
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
import { releaseCatalogChanged } from "./api/release-catalog";
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
const LazyAgentManagementPage = lazy(() => import("./pages/admin/AgentManagement"));
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
    // A local write carries no gateway name, which a CustomEvent holds as null. It changes the extensions
    // the gateway loaded, so the app reads the capabilities again.
    const refreshCapabilities = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === null) void reloadCapabilities().catch(() => undefined);
    };
    window.addEventListener(releaseCatalogChanged, refreshCapabilities);
    onCleanup(() => window.removeEventListener(releaseCatalogChanged, refreshCapabilities));
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
        .agents-toolbar-title {
          margin: 0;
          font-size: 15px;
          font-weight: 600;
        }
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

function AppFrame(props: RouteSectionProps) {
  const location = useLocation();
  const isRouting = useIsRouting();
  const [pendingLocation, setPendingLocation] = createSignal<Pick<Location, "pathname" | "search">>();
  const [showProgress, setShowProgress] = createSignal(false);
  const pageUrl = () => location.pathname + location.search;
  let committedUrl = pageUrl();
  createRenderEffect(() => { committedUrl = pageUrl(); });
  const preparingPage = () => isRouting() && pageUrl() !== committedUrl;

  createComputed(on([() => location.pathname, () => location.search], ([pathname, search]) => {
    // Publish the router's accepted destination outside its transition so the sidebar can respond immediately.
    queueMicrotask(() => {
      if (isRouting()) setPendingLocation({ pathname, search });
    });
  }, { defer: true }));

  createEffect(() => {
    if (!isRouting()) {
      setPendingLocation(undefined);
      setShowProgress(false);
      return;
    }
    const timer = window.setTimeout(() => setShowProgress(true), 150);
    onCleanup(() => window.clearTimeout(timer));
  });

  return (
    <GuardedRoute>
      <LeftNavShell pendingLocation={pendingLocation}>
        <Show when={showProgress()}>
          <div class="navigation-progress" role="progressbar" aria-label="Loading page" />
        </Show>
        <ErrorBoundary fallback={(_, retry) => (
          <div class="page-loading">
            <p role="alert">Could not load this page.</p>
            <Button onClick={retry}>Try again</Button>
          </div>
        )}>
          <Suspense fallback={<p class="page-loading" role="status">Loading…</p>}>
            <PageNavigationContext.Provider value={preparingPage}>
              {props.children}
            </PageNavigationContext.Provider>
          </Suspense>
        </ErrorBoundary>
      </LeftNavShell>
    </GuardedRoute>
  );
}

function HomeRoute() {
  const home = capabilities.home;
  if (typeof home === "string") {
    const Home = getExtensionHome(home);
    if (Home) return <Home />;
  }
  const DefaultHome = getDefaultExtensionHome();
  return DefaultHome ? <DefaultHome /> : <MainAgentHome />;
}

function AgentsRoute() {
  return (
    <>
      <PageToolbar><h1 class="agents-toolbar-title">Agents</h1></PageToolbar>
      <AgentCatalog hideHeading />
    </>
  );
}

function TeamsRoute() {
  return <Show when={capabilities.multiUser} fallback={<AgentsRoute />}><Teams /></Show>;
}

function LoginRoute() {
  return (
    <Suspense fallback={<AppBootSplash />}>
      <LazyLoginPage />
    </Suspense>
  );
}

export default function App() {
  return (
    <Router root={Layout} base={import.meta.env.BASE_URL}>
      <Route path="/setup" component={() => <Suspense><LazyDesktopSetup /></Suspense>} />
      <Route path="/login" component={LoginRoute} />
      <Route path="/gateway-link" component={() => <GuardedRoute><GatewayLink /></GuardedRoute>} />
      <Route path="/" component={AppFrame}>
        <Route path="/" component={HomeRoute} />
        <Route path="/agents" component={AgentsRoute} />
        <Route path="/dashboards" component={Dashboards} />
        <Route path="/remote-dashboards/:gateway/:id" component={RemoteDashboard} />
        <Route path={["/skills", "/skills/:id"]} component={Skills} />
        <Route path="/teams" component={TeamsRoute} />
        <Route path="/agents/new" component={NewAgent} />
        <Route path="/agents/:agentId/edit" component={EditAgent} />
        <Route path="/agents/:agentId/schedules/:jobId/runs" component={ScheduleRuns} />
        <Route path="/agents/:agentId/schedules/:jobId/runs/:runId" component={ScheduleRunTrace} />
        <Route path="/agents/:agentId/mcp-servers/:serverName" component={McpServerDetails} />
        <Route
          path={["/agents/:agentId/extensions/:extensionId", "/agents/:agentId/extensions/:extensionId/config"]}
          component={() => <ExtensionDetails />}
        />
        <Route path="/p/:id" component={ChatProject} />
        <Route path="/shared/:token" component={SharedChat} />
        <Route path="/chat/:agentId/:view?" component={ChatView} />
        {renderExtensionRoutes()}
        <Route path="/admin/skills" component={LazyAdminSkillsPage} />
        <Route path="/admin/agent-management" component={LazyAgentManagementPage} />
        <Route path="/admin/quota" component={LazyAdminQuotaPage} />
        <Route path="/admin/users" component={LazyAdminUsersPage} />
        <Route path="/admin/extensions" component={LazyAdminExtensionsPage} />
        <Route path="/admin/mcp-servers" component={LazyAdminMcpServersPage} />
        <Route path="/archive" component={SessionArchive} />
        <Route path="/account/connections" component={AccountConnections} />
        <Route path="/account/gateway-links" component={GatewayLinks} />
        <Route path="/remote-gateways" component={RemoteGateways} />
      </Route>
    </Router>
  );
}
