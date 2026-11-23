import { lazy } from "solid-js";
import type { Component } from "solid-js";

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

export const webRouteExtension: {
  extensionId: string;
  home: Component;
  routes: { path: string; component: Component }[];
} = {
  extensionId: "board",
  home: LazyBoardView,
  routes: [
    { path: "/board", component: LazyProjectsBoard },
    { path: "/board/projects", component: LazyBoardView },
    { path: "/board/projects/:projectId", component: LazyBoardView },
    {
      path: "/board/projects/:projectId/slices/:sliceId",
      component: LazyBoardView,
    },
    { path: "/board/agents", component: LazyAgentsView },
  ],
};
