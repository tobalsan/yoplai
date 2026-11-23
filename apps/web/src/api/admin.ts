import { apiFetch } from "./core";

export type AdminUser = {
  id: string;
  name: string | null;
  email: string | null;
  image?: string | null;
  role: string | string[] | null;
  approved: boolean | null;
  createdAt?: string;
};

export type ImpersonationStatus =
  | { active: false }
  | {
      active: true;
      admin: { id: string; email?: string };
      target: { id: string; name: string | null; email: string | null };
    };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const error = await res
      .json()
      .catch(() => ({ error: `Request failed (${res.status})` }));
    throw new Error(
      typeof error?.error === "string"
        ? error.error
        : `Request failed (${res.status})`
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function fetchUsers(): Promise<AdminUser[]> {
  const data = await request<{ users: AdminUser[] }>("/api/admin/users");
  return data.users;
}

export async function updateUser(
  id: string,
  data: { approved?: boolean; role?: string }
): Promise<void> {
  await request(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function startImpersonation(targetUserId: string): Promise<void> {
  await request("/api/admin/impersonate/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetUserId }),
  });
}

export async function endImpersonation(): Promise<void> {
  const res = await globalThis.fetch("/api/admin/impersonate/end", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}

export async function fetchImpersonationStatus(): Promise<ImpersonationStatus> {
  return request<ImpersonationStatus>("/api/impersonation/status");
}
