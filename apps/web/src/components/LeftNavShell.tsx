import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { AgentSidebar } from "./AgentSidebar";
import {
  sidebarCollapsed,
  setSidebarCollapsedPersistent,
  toggleSidebarCollapsed,
  zenMode,
} from "../lib/layout";

export function LeftNavShell(props: { children?: JSX.Element; toolbar?: JSX.Element }) {
  const [isMobile, setIsMobile] = createSignal(false);

  onMount(() => {
    const media = window.matchMedia("(max-width: 768px)");
    const update = (matches: boolean) => {
      setIsMobile(matches);
      if (matches) setSidebarCollapsedPersistent(true);
    };
    const handler = (event: MediaQueryListEvent) => update(event.matches);
    update(media.matches);
    if (media.addEventListener) {
      media.addEventListener("change", handler);
      onCleanup(() => media.removeEventListener("change", handler));
    } else if (media.addListener) {
      media.addListener(handler);
      onCleanup(() => media.removeListener(handler));
    }
  });

  const sidebarVisible = () => !zenMode() && (!isMobile() || !sidebarCollapsed());

  return (
    <div class="left-nav-shell">
      <header class="shell-toolbar">
        <Show when={!zenMode()}>
          <button
            class="sidebar-toggle"
            type="button"
            onClick={toggleSidebarCollapsed}
            aria-label="Toggle sidebar"
            aria-expanded={!sidebarCollapsed()}
            title={sidebarCollapsed() ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <path d="M9 4v16" />
            </svg>
          </button>
        </Show>
        <div class="shell-toolbar-content">{props.toolbar}</div>
        <Show when={import.meta.env.VITE_YOPLAI_DEV === "true" || import.meta.env.VITE_AIHUB_DEV === "true"}>
          <span class="shell-dev-badge">DEV</span>
        </Show>
      </header>
      <div class="left-nav-content">
        <Show when={sidebarVisible()}>
          <AgentSidebar collapsed={sidebarCollapsed} />
        </Show>
        <Show when={isMobile() && sidebarVisible()}>
          <div class="sidebar-scrim" onClick={toggleSidebarCollapsed} />
        </Show>
        <div class="left-nav-main">{props.children}</div>
      </div>
      <style>{`
        .left-nav-shell {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          width: 100%;
          overscroll-behavior: contain;
        }
        .shell-toolbar {
          position: relative;
          z-index: 45;
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 48px;
          flex: none;
          padding: 0 10px 0 5px;
          background: var(--bg-base);
          border-bottom: 1px solid var(--border-default);
        }
        .desktop-window .shell-toolbar {
          padding-inline-start: var(--desktop-buttons-width);
          -webkit-app-region: drag;
        }
        .sidebar-toggle {
          width: 40px;
          height: 40px;
          flex: none;
          display: grid;
          place-items: center;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
        }
        .sidebar-toggle:hover,
        .sidebar-toggle:active {
          background: var(--bg-raised);
          color: var(--text-primary);
        }
        .sidebar-toggle:focus-visible {
          outline: 2px solid var(--text-secondary);
          outline-offset: -2px;
        }
        .shell-toolbar-content {
          flex: 1;
          min-width: 0;
          container: shell-toolbar / inline-size;
        }
        .shell-dev-badge {
          flex: none;
          padding: 2px 5px;
          border-radius: 4px;
          background: color-mix(in srgb, #f59e0b 22%, var(--bg-base));
          color: var(--text-primary);
          font-size: 10px;
          font-weight: 700;
        }
        .left-nav-content {
          display: flex;
          position: relative;
          flex: 1;
          min-height: 0;
        }
        .left-nav-main {
          flex: 1;
          min-width: 0;
          min-height: 0;
          overflow-x: hidden;
          overflow-y: auto;
        }
        .sidebar-scrim {
          position: absolute;
          inset: 0;
          z-index: 39;
          background: var(--shadow-md);
        }
        @media (max-width: 768px) {
          .shell-toolbar { gap: 4px; }
        }
        @media (max-width: 480px) {
          .shell-dev-badge { display: none; }
        }
      `}</style>
    </div>
  );
}
