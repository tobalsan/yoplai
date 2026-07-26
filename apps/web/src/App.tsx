import { Router, Route, useLocation } from "@solidjs/router";
import {
  Show,
  Suspense,
  createEffect,
  lazy,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { fetchAgents, getSessionKey, subscribeToSession } from "./api";
import type { Agent } from "./api/types";
import { ChatView } from "./components/ChatView";
import { QuickChatFAB } from "./components/QuickChatFAB";
import { QuickChatOverlay } from "./components/QuickChatOverlay";
import { LeftNavShell } from "./components/LeftNavShell";
import { AgentCatalog } from "./pages/AgentCatalog";
import { EditAgent } from "./pages/EditAgent";
import { ExtensionConfigForm } from "./pages/ExtensionConfigForm";
import { ExtensionDetails } from "./pages/ExtensionDetails";
import { Teams } from "./pages/Teams";
import {
  ImpersonationBanner,
  impersonationStatus,
} from "./components/ImpersonationBanner";
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

const LazyAuthGuard = lazy(() => import("./auth/AuthGuard"));
const LazyLoginPage = lazy(() => import("./pages/Login"));
const LazyAdminUsersPage = lazy(() => import("./pages/admin/Users"));

const basePath = import.meta.env.BASE_URL?.replace(/\/+$/, "") ?? "";

function stripBase(pathname: string): string {
  if (basePath && pathname.startsWith(basePath)) {
    return pathname.slice(basePath.length) || "/";
  }
  return pathname;
}

const QUICK_CHAT_LAST_AGENT_KEY = "yoplai:quick-chat-last-agent";
const LEGACY_QUICK_CHAT_LAST_AGENT_KEY = "aihub:quick-chat-last-agent";

function readQuickChatAgentId(): string | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(QUICK_CHAT_LAST_AGENT_KEY);
  if (stored) return stored;
  const legacy = localStorage.getItem(LEGACY_QUICK_CHAT_LAST_AGENT_KEY);
  if (legacy) {
    localStorage.setItem(QUICK_CHAT_LAST_AGENT_KEY, legacy);
    return legacy;
  }
  return null;
}

function pickDefaultQuickAgentId(agents: Agent[]): string | null {
  if (agents.length === 0) return null;
  const lead =
    agents.find(
      (agent) =>
        agent.id.toLowerCase().includes("lead") ||
        agent.name.toLowerCase().includes("lead")
    ) ?? agents[0];
  return lead.id;
}

function Layout(props: { children?: JSX.Element }) {
  const location = useLocation();
  const isLoginPage = createMemo(() =>
    stripBase(location.pathname).startsWith("/login")
  );
  const canLoadQuickChatAgents = createMemo(
    () =>
      capabilitiesReady() &&
      capabilities.agentFab === true &&
      !isLoginPage() &&
      (!capabilities.multiUser || Boolean(capabilities.user))
  );
  const [quickChatOpen, setQuickChatOpen] = createSignal(false);
  const [quickChatHasUnread, setQuickChatHasUnread] = createSignal(false);
  const [quickChatMobile, setQuickChatMobile] = createSignal(false);
  const [quickChatAgentId, setQuickChatAgentId] = createSignal<string | null>(
    readQuickChatAgentId()
  );
  const [agents] = createResource(canLoadQuickChatAgents, async (enabled) =>
    enabled ? fetchAgents() : []
  );
  const quickChatAgents = createMemo(() => agents() ?? []);
  const selectedQuickChatAgent = createMemo(
    () =>
      quickChatAgents().find((agent) => agent.id === quickChatAgentId()) ?? null
  );
  const quickChatFabLabel = createMemo(
    () => selectedQuickChatAgent()?.name ?? "Lead agent"
  );

  // Set document title based on dev mode
  onMount(() => {
    if (import.meta.env.VITE_YOPLAI_DEV === "true" || import.meta.env.VITE_AIHUB_DEV === "true") {
      const port = import.meta.env.VITE_YOPLAI_UI_PORT ?? import.meta.env.VITE_AIHUB_UI_PORT ?? "?";
      document.title = `[DEV :${port}] Yoplai`;
    }
    void loadCapabilities().catch(() => undefined);
  });

  onMount(() => {
    const media = window.matchMedia("(max-width: 768px)");
    const update = (matches: boolean) => setQuickChatMobile(matches);
    update(media.matches);
    const handler = (event: MediaQueryListEvent) => update(event.matches);
    if (media.addEventListener) {
      media.addEventListener("change", handler);
      onCleanup(() => media.removeEventListener("change", handler));
    } else {
      media.addListener(handler);
      onCleanup(() => media.removeListener(handler));
    }
  });

  createEffect(() => {
    const list = quickChatAgents();
    if (list.length === 0) return;
    const current = quickChatAgentId();
    if (current && list.some((agent) => agent.id === current)) return;
    const next = pickDefaultQuickAgentId(list);
    setQuickChatAgentId(next);
  });

  createEffect(() => {
    const agentId = quickChatAgentId();
    if (typeof window === "undefined") return;
    if (agentId) {
      localStorage.setItem(QUICK_CHAT_LAST_AGENT_KEY, agentId);
    } else {
      localStorage.removeItem(QUICK_CHAT_LAST_AGENT_KEY);
    }
  });

  createEffect(() => {
    if (!quickChatOpen()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setQuickChatOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  const isOnChatPage = createMemo(() => {
    const p = stripBase(location.pathname);
    return p.startsWith("/chat/") || p.startsWith("/agents");
  });

  createEffect(() => {
    if (quickChatOpen()) setQuickChatHasUnread(false);
  });

  createEffect(() => {
    if (isOnChatPage() && quickChatOpen()) setQuickChatOpen(false);
  });

  createEffect(() => {
    const agentId = quickChatAgentId();
    if (!agentId) return;
    const cleanup = subscribeToSession(agentId, getSessionKey(agentId), {
      onHistoryUpdated: () => {
        if (!quickChatOpen()) {
          setQuickChatHasUnread(true);
        }
      },
    });
    onCleanup(cleanup);
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
        <div class="app" classList={{ "zen-mode": zenMode() }}>
          <ImpersonationBanner />
          {props.children}
        </div>
      </Show>
      <Show
        when={
          canLoadQuickChatAgents() &&
          !isOnChatPage() &&
          !impersonationStatus()?.active
        }
      >
        <QuickChatOverlay
          open={quickChatOpen()}
          mobile={quickChatMobile()}
          agents={quickChatAgents()}
          selectedAgentId={quickChatAgentId()}
          onSelectAgent={(agentId) => {
            setQuickChatAgentId(agentId);
            setQuickChatHasUnread(false);
          }}
          onMinimize={() => setQuickChatOpen(false)}
          onClose={() => setQuickChatOpen(false)}
        />
        <QuickChatFAB
          open={quickChatOpen}
          hasUnread={quickChatHasUnread}
          agentLabel={quickChatFabLabel}
          onToggle={() => {
            setQuickChatOpen((prev) => {
              const next = !prev;
              if (next) setQuickChatHasUnread(false);
              return next;
            });
          }}
        />
      </Show>
      <style>{`
        .app {
          height: 100%;
          display: flex;
          flex-direction: column;
          width: 100%;
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
  return <AgentsRouteShell />;
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

function ExtensionConfigRouteShell() {
  return (
    <LeftNavShell>
      <ExtensionConfigForm />
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

export default function App() {
  const base = import.meta.env.BASE_URL;
  return (
    <Router root={Layout} base={base}>
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
        path="/agents/:agentId/extensions/:extensionId/config"
        component={() => (
          <GuardedRoute>
            <ExtensionConfigRouteShell />
          </GuardedRoute>
        )}
      />
      <Route
        path="/agents/:agentId/extensions/:extensionId"
        component={() => (
          <GuardedRoute>
            <ExtensionDetailsRouteShell />
          </GuardedRoute>
        )}
      />
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
    </Router>
  );
}
