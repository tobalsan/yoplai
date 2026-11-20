import { useNavigate, useParams } from "@solidjs/router";
import { Suspense, createEffect, createMemo, lazy } from "solid-js";
import type { Component, JSX } from "solid-js";
import { LeftNavShell } from "../../components/LeftNavShell";

const LazyAreasOverview = lazy(() =>
  import("../../components/AreasOverview").then((mod) => ({
    default: mod.AreasOverview,
  }))
);
const LazyProjectsBoard = lazy(() =>
  import("../../components/ProjectsBoard").then((mod) => ({
    default: mod.ProjectsBoard,
  }))
);
const LazyProjectsDetailRouteAdapter = lazy(() =>
  import("../../components/project/ProjectsDetailRouteAdapter").then((mod) => ({
    default: mod.ProjectsDetailRouteAdapter,
  }))
);
const LazyProjectsArchivePage = lazy(() =>
  import("../../components/project/ProjectsArchivePage").then((mod) => ({
    default: mod.ProjectsArchivePage,
  }))
);
const LazySliceDetailPage = lazy(() =>
  import("../../components/SliceDetailPage").then((mod) => ({
    default: mod.SliceDetailPage,
  }))
);

export function AreasOverviewRouteShell(): JSX.Element {
  return (
    <LeftNavShell>
      <Suspense>
        <LazyAreasOverview />
      </Suspense>
    </LeftNavShell>
  );
}

export function ProjectsRouteShell(): JSX.Element {
  return (
    <Suspense>
      <LazyProjectsBoard />
    </Suspense>
  );
}

export function ProjectsDetailRouteShell(): JSX.Element {
  return (
    <LeftNavShell>
      <Suspense>
        <LazyProjectsDetailRouteAdapter />
      </Suspense>
    </LeftNavShell>
  );
}

export function ProjectsArchiveRouteShell(): JSX.Element {
  return (
    <LeftNavShell>
      <Suspense>
        <LazyProjectsArchivePage />
      </Suspense>
    </LeftNavShell>
  );
}

export function SliceDetailRouteShell(): JSX.Element {
  return (
    <LeftNavShell>
      <Suspense>
        <LazySliceDetailPage />
      </Suspense>
    </LeftNavShell>
  );
}

function FlatSliceRedirect(): JSX.Element {
  const params = useParams<{ sliceId: string }>();
  const navigate = useNavigate();
  const sliceId = () => params.sliceId ?? "";
  const projectId = createMemo(() => {
    const match = sliceId().match(/^(PRO-\d+)-S\d+$/);
    return match ? match[1] : "";
  });
  createEffect(() => {
    const pid = projectId();
    const sid = sliceId();
    if (pid && sid) {
      navigate(
        `/projects/${encodeURIComponent(pid)}/slices/${encodeURIComponent(sid)}`,
        { replace: true }
      );
    }
  });
  return <div class="app" />;
}

export const webRouteExtension: {
  extensionId: string;
  home: Component;
  defaultHome: boolean;
  routes: { path: string; component: Component }[];
} = {
  extensionId: "projects",
  home: AreasOverviewRouteShell,
  defaultHome: true,
  routes: [
    { path: "/projects", component: ProjectsRouteShell },
    { path: "/projects/archive", component: ProjectsArchiveRouteShell },
    { path: "/projects/:projectId", component: ProjectsDetailRouteShell },
    {
      path: "/projects/:projectId/slices/:sliceId",
      component: ProjectsDetailRouteShell,
    },
    { path: "/slices/:sliceId", component: FlatSliceRedirect },
  ],
};
