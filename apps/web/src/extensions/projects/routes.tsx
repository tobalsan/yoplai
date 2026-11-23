import { useNavigate, useParams } from "@solidjs/router";
import { createEffect, createMemo, lazy } from "solid-js";
import type { Component, JSX } from "solid-js";

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

export const SliceDetailRouteShell = LazySliceDetailPage;

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
  home: LazyAreasOverview,
  defaultHome: true,
  routes: [
    { path: "/projects", component: LazyProjectsBoard },
    { path: "/projects/archive", component: LazyProjectsArchivePage },
    { path: "/projects/:projectId", component: LazyProjectsDetailRouteAdapter },
    {
      path: "/projects/:projectId/slices/:sliceId",
      component: LazyProjectsDetailRouteAdapter,
    },
    { path: "/slices/:sliceId", component: FlatSliceRedirect },
  ],
};
