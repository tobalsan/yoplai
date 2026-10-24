import {
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  createMemo,
  Show,
  Suspense,
} from "solid-js";
import { useLocation } from "@solidjs/router";
import { ScratchpadEditor } from "./ScratchpadEditor";
import { BoardLifecycleListPage } from "./board/BoardLifecycleListPage";
import { BoardProjectDetailPage } from "./board/BoardProjectDetailPage";

// ── Types ───────────────────────────────────────────────────────────

type CanvasPanel = "overview" | "projects";

interface CanvasState {
  panel: CanvasPanel;
}

type BoardProjectRoute = {
  projectId: string;
  sliceId: string | null;
  tab: string | undefined;
} | null;

const basePath = import.meta.env.BASE_URL?.replace(/\/+$/, "") ?? "";

function stripBase(pathname: string): string {
  if (basePath && pathname.startsWith(basePath)) {
    return pathname.slice(basePath.length) || "/";
  }
  return pathname;
}

function withBase(path: string): string {
  if (!basePath) return path;
  if (path.startsWith(basePath + "/") || path === basePath) return path;
  return `${basePath}${path.startsWith("/") ? "" : "/"}${path}`;
}

function parseBoardProjectRoute(
  pathname: string,
  search: string
): BoardProjectRoute {
  const match = stripBase(pathname).match(
    /^\/board\/projects\/([^/]+)(?:\/slices\/([^/]+))?$/
  );
  if (!match) return null;
  return {
    projectId: decodeURIComponent(match[1]),
    sliceId: match[2] ? decodeURIComponent(match[2]) : null,
    tab: new URLSearchParams(search).get("tab") ?? undefined,
  };
}

// ── BoardView ───────────────────────────────────────────────────────

export function BoardView() {
  const location = useLocation();
  const [canvas, setCanvas] = createSignal<CanvasState>({ panel: "overview" });
  createEffect(() => {
    if (location.pathname.startsWith("/board/projects")) {
      setCanvas({ panel: "projects" });
    }
  });

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div class="board">
      <div class="board-canvas">
        <div class="board-canvas-tabs">
          <button
            classList={{
              "board-canvas-tab": true,
              active: canvas().panel === "overview",
            }}
            onClick={() => {
              setCanvas({ panel: "overview" });
            }}
          >
            Scratchpad
          </button>
          <button
            classList={{
              "board-canvas-tab": true,
              active: canvas().panel === "projects",
            }}
            onClick={() => {
              setCanvas({ panel: "projects" });
            }}
          >
            Project lifecycle
          </button>
        </div>

        <div
          class="board-canvas-content"
          classList={{
            "board-canvas-content-projects": canvas().panel === "projects",
          }}
        >
          <Suspense fallback={<CanvasLoading />}>
            <CanvasPanelRenderer state={canvas()} />
          </Suspense>
        </div>
      </div>

      <style>{`
        .board {
          height: 100%;
          display: flex;
          width: 100%;
          min-height: 0;
          overflow: hidden;
        }

        .board-canvas {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
          background: var(--bg-surface);
        }

        .board-canvas-tabs {
          display: flex;
          border-bottom: 1px solid var(--border-default);
          padding: 0 16px;
          gap: 4px;
        }

        .board-canvas-tab {
          padding: 10px 16px;
          border: none;
          background: none;
          color: var(--text-secondary);
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          transition: color 0.15s, border-color 0.15s;
        }

        .board-canvas-tab:hover {
          color: var(--text-primary);
        }

        .board-canvas-tab.active {
          color: var(--text-accent, #6366f1);
          border-bottom-color: var(--text-accent, #6366f1);
        }

        .board-canvas-content {
          flex: 1;
          overflow-y: auto;
          padding: 24px;
          min-height: 0;
        }

        .board-canvas-content-projects {
          overflow: hidden;
          padding: 0;
        }

        @media (max-width: 768px) {
          .board {
            flex-direction: column;
          }
        }
      `}</style>
    </div>
  );
}

// ── Canvas panels ───────────────────────────────────────────────────

function CanvasPanelRenderer(props: { state: CanvasState }) {
  return (
    <>
      <div
        class="canvas-panel"
        style={{ display: props.state.panel === "overview" ? "block" : "none" }}
      >
        <OverviewPanel />
      </div>
      <div
        class="canvas-panel"
        style={{ display: props.state.panel === "projects" ? "block" : "none" }}
      >
        <ProjectsPanel />
      </div>
      <style>{`
        .canvas-panel {
          width: 100%;
          height: 100%;
          min-height: 0;
        }
      `}</style>
    </>
  );
}

function CanvasLoading() {
  return (
    <div class="canvas-loading" data-testid="canvas-loading">
      Loading…
      <style>{`
        .canvas-loading {
          padding: 24px;
          color: var(--text-secondary);
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}

function OverviewPanel() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div class="canvas-overview">
      <h1>{dateStr}</h1>
      <div class="canvas-overview-scratchpad">
        <ScratchpadEditor />
      </div>
      <style>{`
        .canvas-overview {
          width: 100%;
          display: flex;
          flex-direction: column;
          height: 100%;
        }
        .canvas-overview h1 {
          margin: 0 0 8px;
          font-size: 22px;
          color: var(--text-primary);
          flex-shrink: 0;
        }
        .canvas-overview-scratchpad {
          flex: 1;
          min-height: 0;
          margin-top: 16px;
        }
      `}</style>
    </div>
  );
}

function ProjectsPanel() {
  const [localRoute, setLocalRoute] = createSignal<BoardProjectRoute>(
    parseBoardProjectRoute(window.location.pathname, window.location.search)
  );
  const selectedProjectId = createMemo(
    () => localRoute()?.projectId ?? null
  );
  const selectedSliceId = createMemo(() => localRoute()?.sliceId ?? null);
  const selectedTab = createMemo(() => localRoute()?.tab);

  onMount(() => {
    const updateLocalRoute = () => {
      setLocalRoute(
        parseBoardProjectRoute(window.location.pathname, window.location.search)
      );
    };
    window.addEventListener("popstate", updateLocalRoute);
    onCleanup(() => window.removeEventListener("popstate", updateLocalRoute));
  });

  const setEmbeddedUrl = (to: string, options?: { replace?: boolean }) => {
    const url = new URL(to, window.location.origin);
    const target = `${withBase(url.pathname)}${url.search}`;
    if (options?.replace) {
      window.history.replaceState(null, "", target);
    } else {
      window.history.pushState(null, "", target);
    }
    setLocalRoute(parseBoardProjectRoute(url.pathname, url.search));
  };

  const openProject = (id: string) => {
    setEmbeddedUrl(`/board/projects/${encodeURIComponent(id)}`);
  };

  const closeProject = () => {
    window.history.pushState(null, "", withBase("/board/projects"));
    setLocalRoute(null);
  };

  return (
    <div class="canvas-projects-overview">
      <Show
        when={selectedProjectId()}
        fallback={
          <BoardLifecycleListPage
            onProjectClick={(project) => openProject(project.id)}
          />
        }
      >
        <BoardProjectDetailPage
          projectId={selectedProjectId()!}
          sliceId={selectedSliceId()}
          tab={selectedTab()}
          onBack={closeProject}
          onOpenProject={openProject}
          onNavigate={setEmbeddedUrl}
        />
      </Show>
      <style>{`
        .canvas-projects-overview {
          width: 100%;
          height: 100%;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
      `}</style>
    </div>
  );
}
