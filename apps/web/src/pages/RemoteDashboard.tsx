import { useLocation, useNavigate, useParams } from "@solidjs/router";
import { createMemo } from "solid-js";
import { FrameView } from "../components/chat/FrameView";
import type { DashboardFrame } from "../components/chat/appViews";
import { decodeRouteParam } from "../lib/path";
import { cleanDashboardQuery, remoteDashboardPath } from "../lib/remote-dashboard";

/**
 * The public route of a dashboard on a linked remote gateway:
 * `/remote-dashboards/:gateway/:id`. The route holds no handle and no token.
 * The trusted host below prepares a fresh view whenever the gateway, the
 * dashboard, or the query changes, so history steps never reuse a frame.
 */
export function RemoteDashboard() {
  const params = useParams<{ gateway: string; id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const gateway = () => decodeRouteParam(params.gateway);
  const target = createMemo<DashboardFrame>(() => ({
    kind: "dashboard",
    gateway: gateway(),
    id: decodeRouteParam(params.id),
    title: "Dashboard",
    query: cleanDashboardQuery(location.search),
  }));
  return (
    <main class="remote-dashboard-page">
      <FrameView
        target={target()}
        mode="panel"
        standalone
        onNavigate={(next) => navigate(remoteDashboardPath(gateway(), next.id, next.query))}
      />
      <style>{`
        .remote-dashboard-page { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; padding: 16px; box-sizing: border-box; }
        .remote-dashboard-page > .frame-view { flex: 1; }
        @media (max-width: 768px) { .remote-dashboard-page { padding: 8px; } }
      `}</style>
    </main>
  );
}
