import { useNavigate } from "@solidjs/router";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
} from "solid-js";
import { fetchUsers, startImpersonation, updateUser } from "../../api/admin";
import { useSession } from "../../auth/client";
import AdminLayout from "./AdminLayout";
import { hasStaffRole as hasAdminRole, isSuperadmin as hasSuperadminRole } from "../../lib/roles";
import { UserAvatar } from "../../components/UserAvatar";

type SessionUser = {
  id?: string;
  role?: string | string[] | null;
};

function normalizeRole(role: string | string[] | null | undefined): string {
  const value = Array.isArray(role) ? role[0] : role;
  if (value === "superadmin") return "superadmin";
  if (value === "admin") return "admin";
  return "user";
}

function roleLabel(role: string | string[] | null | undefined): string {
  const normalized = normalizeRole(role);
  if (normalized === "superadmin") return "Superadmin";
  if (normalized === "admin") return "Admin";
  return "User";
}

function formatDate(value: string | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleDateString();
}

export default function AdminUsersPage() {
  const navigate = useNavigate();
  const session = useSession();
  const [users, { refetch }] = createResource(fetchUsers);
  const [pendingUserId, setPendingUserId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const sessionUser = createMemo(
    () => (session().data?.user ?? null) as SessionUser | null
  );

  createEffect(() => {
    if (session().isPending) return;
    if (!hasAdminRole(sessionUser()?.role)) {
      void navigate("/", { replace: true });
    }
  });

  const isSuperadmin = createMemo(() =>
    hasSuperadminRole(sessionUser()?.role)
  );

  const sortedUsers = createMemo(() =>
    [...(users() ?? [])].sort((left, right) => {
      const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
      const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
      return rightTime - leftTime;
    })
  );

  async function handleViewAs(id: string) {
    setPendingUserId(id);
    setError(null);
    try {
      await startImpersonation(id);
      location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Impersonation failed.");
      setPendingUserId(null);
    }
  }

  async function handleUpdate(id: string, payload: { approved?: boolean; role?: string }) {
    setPendingUserId(id);
    setError(null);
    try {
      await updateUser(id, payload);
      await refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Update failed.");
    } finally {
      setPendingUserId(null);
    }
  }

  return (
    <AdminLayout
      title="User access"
      description="Approve pending users and set admin privileges."
    >
      <Show when={error()}>
        {(message) => <p class="admin-error">{message()}</p>}
      </Show>
      <Show when={!users.loading} fallback={<div class="admin-empty">Loading users…</div>}>
        <Show
          when={sortedUsers().length > 0}
          fallback={<div class="admin-empty">No users found.</div>}
        >
          <div class="admin-panel">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Joined</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={sortedUsers()}>
                  {(user) => {
                    const busy = () => pendingUserId() === user.id;
                    return (
                      <tr>
                        <td>
                          <div class="admin-user-cell">
                            <UserAvatar class="admin-user-avatar" name={user.name} email={user.email} image={user.image} />
                            <div>
                              <div class="admin-user-name">
                                {user.name ?? "Unnamed user"}
                              </div>
                              <div class="admin-user-email">{user.email ?? "No email"}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span
                            class={`admin-badge ${
                              hasAdminRole(user.role) ? "admin" : "user"
                            }`}
                          >
                            {roleLabel(user.role)}
                          </span>
                        </td>
                        <td>
                          <span
                            class={`admin-badge ${user.approved ? "approved" : "pending"}`}
                          >
                            {user.approved ? "Approved" : "Pending"}
                          </span>
                        </td>
                        <td>{formatDate(user.createdAt)}</td>
                        <td>
                          <div class="admin-actions">
                            <Show
                              when={
                                isSuperadmin() && user.id !== sessionUser()?.id
                              }
                            >
                              <button
                                type="button"
                                class="admin-action-button"
                                disabled={busy()}
                                onClick={() => void handleViewAs(user.id)}
                              >
                                View as
                              </button>
                            </Show>
                            <button
                              type="button"
                              class="admin-action-button"
                              disabled={busy()}
                              onClick={() =>
                                void handleUpdate(user.id, {
                                  approved: !user.approved,
                                })
                              }
                            >
                              {user.approved ? "Reject" : "Approve"}
                            </button>
                            <Show when={isSuperadmin()}>
                              <label class="admin-select">
                                <span class="sr-only">Role</span>
                                <select
                                  value={normalizeRole(user.role)}
                                  disabled={busy()}
                                  onChange={(event) =>
                                    void handleUpdate(user.id, {
                                      role: event.currentTarget.value,
                                    })
                                  }
                                >
                                  <option value="user">User</option>
                                  <option value="admin">Admin</option>
                                  <option value="superadmin">Superadmin</option>
                                </select>
                              </label>
                            </Show>
                          </div>
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
      <style>{`
        .admin-panel {
          border: 1px solid var(--border-default);
          border-radius: 18px;
          background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
          overflow: auto;
        }

        .admin-table {
          width: 100%;
          border-collapse: collapse;
          min-width: 720px;
        }

        .admin-table th,
        .admin-table td {
          padding: 16px 18px;
          text-align: left;
          border-bottom: 1px solid var(--border-default);
          vertical-align: middle;
        }

        .admin-table th {
          color: var(--text-secondary);
          font-size: 0.82rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        .admin-table tbody tr:last-child td {
          border-bottom: none;
        }

        .admin-user-cell {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }

        .admin-user-avatar {
          width: 38px;
          height: 38px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          background: var(--bg-raised);
          color: var(--text-primary);
          font-weight: 700;
          flex-shrink: 0;
        }

        .admin-user-name,
        .admin-user-email {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .admin-user-name {
          color: var(--text-primary);
          font-weight: 600;
        }

        .admin-user-email {
          color: var(--text-secondary);
          font-size: 0.92rem;
        }

        .admin-badge {
          display: inline-flex;
          align-items: center;
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 0.85rem;
          font-weight: 600;
          background: var(--bg-raised);
          color: var(--text-secondary);
        }

        .admin-badge.admin,
        .admin-badge.approved {
          color: var(--text-primary);
        }

        .admin-badge.pending {
          background: color-mix(in srgb, #f59e0b 18%, var(--bg-raised));
        }

        .admin-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .admin-action-button,
        .admin-select select {
          min-height: 36px;
          border-radius: 10px;
          border: 1px solid var(--border-default);
          background: var(--bg-primary);
          color: var(--text-primary);
          padding: 0 12px;
        }

        .admin-action-button {
          cursor: pointer;
        }

        .admin-error,
        .admin-empty {
          margin: 0;
          padding: 16px 18px;
          border-radius: 16px;
          border: 1px solid var(--border-default);
          background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
          color: var(--text-secondary);
        }

        .admin-error {
          margin-bottom: 16px;
          color: var(--text-primary);
          background: color-mix(in srgb, #ef4444 12%, var(--bg-surface));
        }

        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
      `}</style>
    </AdminLayout>
  );
}
