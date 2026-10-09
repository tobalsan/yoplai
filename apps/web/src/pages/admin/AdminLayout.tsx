import { For, Show, type JSX } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { capabilities } from "../../lib/capabilities";
import { stripBase } from "../../lib/path";

const isSuperadmin = (role: string | string[] | null | undefined) =>
  Array.isArray(role) ? role.includes("superadmin") : role === "superadmin";

/** Admin sections, one tab each; users exist only in multi-user mode, Top extensions and MCP servers are superadmin-only. */
function adminTabs() {
  return [
    { href: "/admin/users", label: "User management", visible: !!capabilities.multiUser },
    {
      href: "/admin/extensions",
      label: "Top extensions",
      visible: !capabilities.multiUser || isSuperadmin(capabilities.user?.role),
    },
    {
      href: "/admin/mcp-servers",
      label: "MCP servers",
      visible: !capabilities.multiUser || isSuperadmin(capabilities.user?.role),
    },
  ].filter((tab) => tab.visible);
}

export default function AdminLayout(props: {
  title: string;
  description: string;
  children?: JSX.Element;
}) {
  const location = useLocation();
  return (
    <>
      <section class="admin-page">
        <header class="admin-page-header">
          <div>
            <p class="admin-page-eyebrow">Admin</p>
            <h1>{props.title}</h1>
            <p>{props.description}</p>
          </div>
        </header>
        <Show when={adminTabs().length > 1}>
          <nav class="admin-tabs" aria-label="Admin sections">
            <For each={adminTabs()}>
              {(tab) => (
                <A
                  href={tab.href}
                  class="admin-tab"
                  classList={{ active: stripBase(location.pathname).startsWith(tab.href) }}
                  aria-current={stripBase(location.pathname).startsWith(tab.href) ? "page" : undefined}
                >
                  {tab.label}
                </A>
              )}
            </For>
          </nav>
        </Show>
        <div class="admin-page-body">{props.children}</div>
      </section>
      <style>{`
        .admin-page {
          height: 100%;
          overflow: auto;
          padding: 28px;
          background:
            radial-gradient(circle at top right, color-mix(in srgb, var(--accent, #60a5fa) 10%, transparent), transparent 24%),
            var(--bg-primary);
        }

        .admin-page-header {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 24px;
        }

        .admin-page-eyebrow {
          margin: 0 0 8px;
          color: var(--text-secondary);
          font-size: 0.78rem;
          text-transform: uppercase;
          letter-spacing: 0.12em;
        }

        .admin-page-header h1 {
          margin: 0;
          color: var(--text-primary);
          font-size: clamp(1.6rem, 4vw, 2.2rem);
        }

        .admin-page-header p:last-child {
          margin: 8px 0 0;
          color: var(--text-secondary);
          max-width: 58ch;
        }

        .admin-tabs {
          display: flex;
          gap: 4px;
          margin-bottom: 20px;
          border-bottom: 1px solid var(--border, color-mix(in srgb, var(--text-secondary) 20%, transparent));
        }

        .admin-tab {
          padding: 8px 14px;
          margin-bottom: -1px;
          border-bottom: 2px solid transparent;
          color: var(--text-secondary);
          font-size: 14px;
          text-decoration: none;
        }

        .admin-tab:hover {
          color: var(--text-primary);
        }

        .admin-tab.active {
          color: var(--text-primary);
          border-bottom-color: var(--accent, #60a5fa);
          font-weight: 600;
        }

        .admin-page-body {
          min-height: 0;
        }

        @media (max-width: 720px) {
          .admin-page {
            padding: 20px 16px 24px;
          }

          .admin-page-header {
            flex-direction: column;
            align-items: flex-start;
          }
        }
      `}</style>
    </>
  );
}
