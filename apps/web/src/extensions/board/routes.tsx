import { Suspense, lazy } from "solid-js";
import type { Component, JSX } from "solid-js";
import { LeftNavShell } from "../../components/LeftNavShell";

const LazyProjectsBoard = lazy(() =>
  import("../../components/ProjectsBoard").then((mod) => ({
    default: mod.ProjectsBoard,
  }))
);
const LazyBoardView = lazy(() =>
  import("../../components/BoardView").then((mod) => ({
    default: mod.BoardView,
  }))
);
const LazyAgentsView = lazy(() =>
  import("../../components/board/AgentsView").then((mod) => ({
    default: mod.AgentsView,
  }))
);

export function BoardRouteShell(): JSX.Element {
  return (
    <Suspense>
      <LazyProjectsBoard />
    </Suspense>
  );
}

export function BoardHomeRouteShell(): JSX.Element {
  return (
    <LeftNavShell>
      <Suspense>
        <LazyBoardView />
      </Suspense>
    </LeftNavShell>
  );
}

export function BoardAgentsRouteShell(): JSX.Element {
  return (
    <LeftNavShell>
      <Suspense>
        <LazyAgentsView />
      </Suspense>
    </LeftNavShell>
  );
}

export const webRouteExtension: {
  extensionId: string;
  home: Component;
  routes: { path: string; component: Component }[];
} = {
  extensionId: "board",
  home: BoardHomeRouteShell,
  routes: [
    { path: "/board", component: BoardRouteShell },
    { path: "/board/projects", component: BoardHomeRouteShell },
    { path: "/board/projects/:projectId", component: BoardHomeRouteShell },
    {
      path: "/board/projects/:projectId/slices/:sliceId",
      component: BoardHomeRouteShell,
    },
    { path: "/board/agents", component: BoardAgentsRouteShell },
  ],
};
