import type { Accessor } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { signOut, useSession } from "./client";
import { UserAvatar } from "../components/UserAvatar";
import { SidebarAccountMenu } from "../components/SidebarAccountMenu";

type SidebarAccountPanelProps = {
  collapsed: Accessor<boolean>;
  hideArchive?: boolean;
};

type SessionUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

const accountLinks = [
  { label: "Pairings", icon: "fa-user-group", path: "/account/connections" },
  { label: "Linked devices", icon: "fa-laptop", path: "/account/gateway-links" },
  { label: "Archive", icon: "fa-box-archive", path: "/archive" },
  { label: "Account settings", icon: "fa-gear", path: "/account/settings" },
];

export default function SidebarAccountPanel(props: SidebarAccountPanelProps) {
  const session = useSession();
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = createSignal(false);
  const user = createMemo(() => (session().data?.user ?? null) as SessionUser | null);

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
          <SidebarAccountMenu
            class="sidebar-account sidebar-account--menu"
            triggerClass="sidebar-account-toggle"
            trigger={
              <>
                <UserAvatar class="sidebar-account-avatar" name={currentUser().name} email={currentUser().email} image={currentUser().image} />
                <div class="sidebar-account-body">
                  <div class="sidebar-account-name">{currentUser().name ?? "Signed in"}</div>
                  <div class="sidebar-account-email">{currentUser().email}</div>
                </div>
                <i class="fa-solid fa-chevron-up" aria-hidden="true" />
              </>
            }
          >
            <For each={props.hideArchive ? accountLinks.filter((link) => link.path !== "/archive") : accountLinks}>{(link) => (
              <button type="button" class="account-menu-item" role="menuitem" onClick={() => navigate(link.path)}>
                <i class={`fa-solid ${link.icon}`} aria-hidden="true" />
                {link.label}
              </button>
            )}</For>
            <hr class="account-menu-separator" />
            <button type="button" class="account-menu-item" role="menuitem" onClick={() => void handleSignOut()} disabled={isSigningOut()}>
              <i class="fa-solid fa-right-from-bracket" aria-hidden="true" />
              {isSigningOut() ? "Logging out..." : "Logout"}
            </button>
          </SidebarAccountMenu>
          <style>{`
            .sidebar-account {
              display: grid;
              grid-template-columns: auto minmax(0, 1fr) auto;
              align-items: center;
              gap: 10px;
              padding: 0 0 8px;
              margin-bottom: 6px;
            }

            .sidebar-account-toggle {
              display: grid;
              grid-template-columns: auto minmax(0, 1fr) auto;
              align-items: center;
              gap: 10px;
              width: 100%;
              padding: 0;
              border: none;
              background: transparent;
              cursor: pointer;
              text-align: left;
              transition: opacity 0.2s ease;
            }

            .sidebar-account-toggle:hover {
              opacity: 0.8;
            }

            .sidebar-account-toggle i {
              color: var(--text-secondary);
              font-size: 12px;
            }

            .sidebar-account-toggle[aria-expanded="true"] > i {
              transform: rotate(180deg);
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

            .agent-sidebar.collapsed .sidebar-account--menu .sidebar-account-toggle {
              grid-template-columns: 1fr;
              justify-items: center;
            }

            .agent-sidebar.collapsed .sidebar-account--menu .sidebar-account-body,
            .agent-sidebar.collapsed .sidebar-account--menu i {
              display: none;
            }

            .agent-sidebar.collapsed:hover .sidebar-account--menu .sidebar-account-toggle {
              grid-template-columns: auto minmax(0, 1fr) auto;
              justify-items: stretch;
            }

            .agent-sidebar.collapsed:hover .sidebar-account--menu .sidebar-account-body,
            .agent-sidebar.collapsed:hover .sidebar-account--menu i {
              display: block;
            }
          `}</style>
        </>
      )}
    </Show>
  );
}
