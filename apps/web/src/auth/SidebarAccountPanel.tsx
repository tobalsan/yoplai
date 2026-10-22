import type { Accessor } from "solid-js";
import { Show, createMemo, createSignal, onCleanup, createEffect, on } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { signOut, useSession } from "./client";
import { UserAvatar } from "../components/UserAvatar";

type SidebarAccountPanelProps = {
  collapsed: Accessor<boolean>;
};

type SessionUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

export default function SidebarAccountPanel(_props: SidebarAccountPanelProps) {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [isSigningOut, setIsSigningOut] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  let menuRef: HTMLDivElement | undefined;
  let buttonRef: HTMLButtonElement | undefined;
  const user = createMemo(
    () => (session().data?.user ?? null) as SessionUser | null
  );

  async function handleSignOut() {
    setIsSigningOut(true);
    setMenuOpen(false);
    try {
      await signOut();
    } finally {
      window.location.assign("/login");
    }
  }

  function handleClickOutside(event: MouseEvent) {
    if (
      menuRef &&
      buttonRef &&
      !menuRef.contains(event.target as Node) &&
      !buttonRef.contains(event.target as Node)
    ) {
      setMenuOpen(false);
    }
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key === "Escape") {
      setMenuOpen(false);
      buttonRef?.focus();
    }
  }

  createEffect(() => {
    if (menuOpen()) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
      onCleanup(() => {
        document.removeEventListener("mousedown", handleClickOutside);
        document.removeEventListener("keydown", handleEscape);
      });
    }
  });

  // Close menu on route change
  createEffect(on(() => location.pathname, () => setMenuOpen(false)));

  return (
    <Show when={user()}>
      {(currentUser) => (
        <>
          <div class="sidebar-account sidebar-account--menu">
              <button
                ref={buttonRef}
                class="sidebar-account-toggle"
                type="button"
                onClick={() => setMenuOpen(!menuOpen())}
                aria-haspopup="menu"
                aria-expanded={menuOpen()}
                aria-label="Account menu"
              >
                <UserAvatar class="sidebar-account-avatar" name={currentUser().name} email={currentUser().email} image={currentUser().image} />
                <div class="sidebar-account-body">
                  <div class="sidebar-account-name">
                    {currentUser().name ?? "Signed in"}
                  </div>
                  <div class="sidebar-account-email">{currentUser().email}</div>
                </div>
                <i
                  class={`fa-solid ${menuOpen() ? "fa-chevron-down" : "fa-chevron-up"}`}
                  aria-hidden="true"
                />
              </button>
              <Show when={menuOpen()}>
                <div ref={menuRef} class="account-menu" role="menu">
                  <button
                    type="button"
                    class="account-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate("/account/connections");
                    }}
                  >
                    <i class="fa-solid fa-plug" aria-hidden="true" />
                    Account connections
                  </button>
                  <button
                    type="button"
                    class="account-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate("/archive");
                    }}
                  >
                    <i class="fa-solid fa-box-archive" aria-hidden="true" />
                    Archive
                  </button>
                  <hr class="account-menu-separator" />
                  <button
                    type="button"
                    class="account-menu-item"
                    role="menuitem"
                    onClick={() => void handleSignOut()}
                    disabled={isSigningOut()}
                  >
                    <i class="fa-solid fa-right-from-bracket" aria-hidden="true" />
                    {isSigningOut() ? "Logging out..." : "Logout"}
                  </button>
                </div>
              </Show>
          </div>
          <style>{`
            .sidebar-account {
              position: relative;
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

            .account-menu {
              position: absolute;
              bottom: calc(100% + 4px);
              left: 0;
              right: 0;
              background: var(--bg-raised);
              border: 1px solid var(--border-default);
              border-radius: 8px;
              padding: 4px 0;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
              z-index: 100;
            }

            .account-menu-item {
              display: flex;
              align-items: center;
              gap: 10px;
              width: 100%;
              padding: 8px 12px;
              border: none;
              background: transparent;
              color: var(--text-primary);
              font-size: 13px;
              font-family: inherit;
              text-align: left;
              cursor: pointer;
              transition: background 0.15s ease;
            }

            .account-menu-item:hover:not(:disabled) {
              background: var(--bg-surface);
            }

            .account-menu-item:disabled {
              opacity: 0.6;
              cursor: default;
            }

            .account-menu-item i {
              width: 16px;
              text-align: center;
              color: var(--text-secondary);
            }

            .account-menu-separator {
              margin: 4px 0;
              border: none;
              border-top: 1px solid var(--border-default);
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
