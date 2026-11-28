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
        <SidebarAccountMenu
          avatar={<UserAvatar class="sidebar-account-avatar" name={currentUser().name} email={currentUser().email} image={currentUser().image} />}
          name={currentUser().name ?? "Signed in"}
          detail={currentUser().email}
          logout={
            <button type="button" class="account-menu-item" role="menuitem" onClick={() => void handleSignOut()} disabled={isSigningOut()}>
              <i class="fa-solid fa-right-from-bracket" aria-hidden="true" />
              {isSigningOut() ? "Logging out..." : "Logout"}
            </button>
          }
        >
          <For each={props.hideArchive ? accountLinks.filter((link) => link.path !== "/archive") : accountLinks}>{(link) => (
            <button type="button" class="account-menu-item" role="menuitem" onClick={() => navigate(link.path)}>
              <i class={`fa-solid ${link.icon}`} aria-hidden="true" />
              {link.label}
            </button>
          )}</For>
        </SidebarAccountMenu>
      )}
    </Show>
  );
}
