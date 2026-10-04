import type { Accessor } from "solid-js";
import { Show, createMemo, createSignal } from "solid-js";
import { A } from "@solidjs/router";
import { signOut, useSession } from "./client";

type SidebarAccountPanelProps = {
  collapsed: Accessor<boolean>;
};

type SessionUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

function initialsFor(name: string | null | undefined): string {
  const value = name?.trim();
  if (!value) return "?";
  const parts = value.split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

export default function SidebarAccountPanel(_props: SidebarAccountPanelProps) {
  const session = useSession();
  const [isSigningOut, setIsSigningOut] = createSignal(false);
  const user = createMemo(
    () => (session().data?.user ?? null) as SessionUser | null
  );

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await signOut();
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <Show when={user()}>
      {(currentUser) => (
        <>
          <div class="sidebar-account">
            <div class="sidebar-account-avatar" aria-hidden="true">
              <Show
                when={currentUser().image}
                fallback={<span>{initialsFor(currentUser().name)}</span>}
              >
                <img src={currentUser().image!} alt="" />
              </Show>
            </div>
            <div class="sidebar-account-body">
              <div class="sidebar-account-name">
                {currentUser().name ?? "Signed in"}
              </div>
              <div class="sidebar-account-email">{currentUser().email}</div>
              <A class="sidebar-account-settings" href="/account/connections">Account connections</A>
            </div>
            <button
              class="sidebar-account-logout"
              type="button"
              onClick={() => void handleSignOut()}
              disabled={isSigningOut()}
              aria-label="Log out"
              title="Log out"
            >
              <span class="sidebar-account-logout-full">
                {isSigningOut() ? "..." : "Logout"}
              </span>
              <span class="sidebar-account-logout-short">↗</span>
            </button>
          </div>
          <style>{`
            .sidebar-account {
              display: grid;
              grid-template-columns: auto minmax(0, 1fr) auto;
              align-items: center;
              gap: 10px;
              padding: 0 0 8px;
              margin-bottom: 6px;
            }

            .sidebar-account-avatar {
              width: 34px;
              height: 34px;
              border-radius: 999px;
              overflow: hidden;
              display: grid;
              place-items: center;
              background: color-mix(in srgb, var(--bg-raised) 85%, var(--bg-surface));
              color: var(--text-primary);
              font-size: 13px;
              font-weight: 700;
              flex-shrink: 0;
            }

            .sidebar-account-avatar img {
              width: 100%;
              height: 100%;
              object-fit: cover;
            }

            .sidebar-account-body {
              min-width: 0;
            }

            .sidebar-account-name,
            .sidebar-account-email {
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }

            .sidebar-account-name {
              color: var(--text-primary);
              font-size: 13px;
              font-weight: 600;
            }

            .sidebar-account-email {
              color: var(--text-secondary);
              font-size: 12px;
            }

            .sidebar-account-settings {
              display: inline-block;
              margin-top: 3px;
              color: var(--text-secondary);
              font-size: 11px;
              text-decoration: none;
            }

            .sidebar-account-settings:hover {
              color: var(--text-primary);
            }

            .sidebar-account-logout {
              border: none;
              background: transparent;
              color: var(--text-secondary);
              cursor: pointer;
              padding: 6px 8px;
              border-radius: 8px;
              transition: background 0.2s ease, color 0.2s ease;
              white-space: nowrap;
            }

            .sidebar-account-logout:hover:not(:disabled) {
              background: var(--bg-raised);
              color: var(--text-primary);
            }

            .sidebar-account-logout:disabled {
              cursor: default;
              opacity: 0.6;
            }

            .sidebar-account-logout-short {
              display: none;
            }

            .agent-sidebar.collapsed .sidebar-account {
              grid-template-columns: 1fr;
              justify-items: center;
              padding-bottom: 4px;
            }

            .agent-sidebar.collapsed .sidebar-account-body,
            .agent-sidebar.collapsed .sidebar-account-logout-full {
              display: none;
            }

            .agent-sidebar.collapsed .sidebar-account-logout-short {
              display: inline;
            }

            .agent-sidebar.collapsed:hover .sidebar-account {
              grid-template-columns: auto minmax(0, 1fr) auto;
              justify-items: stretch;
              padding-bottom: 8px;
            }

            .agent-sidebar.collapsed:hover .sidebar-account-body,
            .agent-sidebar.collapsed:hover .sidebar-account-logout-full {
              display: block;
            }

            .agent-sidebar.collapsed:hover .sidebar-account-logout-short {
              display: none;
            }
          `}</style>
        </>
      )}
    </Show>
  );
}
