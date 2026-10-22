// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const { fetchUsers } = vi.hoisted(() => ({ fetchUsers: vi.fn() }));
vi.mock("../../api/admin", () => ({ fetchUsers, startImpersonation: vi.fn(), updateUser: vi.fn() }));
vi.mock("../../auth/client", () => ({ useSession: () => () => ({ data: { user: { id: "owner", role: "superadmin" } } }) }));
vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/admin/users" }),
}));

import AdminUsersPage from "./Users";

it("shows user photos with initials when photos are missing or fail", async () => {
  fetchUsers.mockResolvedValue([
    { id: "ada", name: "Ada Lovelace", email: "ada@example.test", image: "https://lh3.googleusercontent.com/ada", role: "user", approved: true },
    { id: "bob", name: "Bob Ross", email: "bob@example.test", image: null, role: "user", approved: true },
  ]);
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => <AdminUsersPage />, root);
  try {
    await vi.waitFor(() => expect(root.textContent).toContain("Ada Lovelace"));
    const rows = root.querySelectorAll("tbody tr");
    const photo = rows[0]!.querySelector("img");
    expect(photo?.getAttribute("src")).toBe("https://lh3.googleusercontent.com/ada");
    expect(rows[1]!.querySelector(".admin-user-avatar")?.textContent).toBe("BR");
    photo!.dispatchEvent(new Event("error"));
    expect(rows[0]!.querySelector("img")).toBeNull();
    expect(rows[0]!.querySelector(".admin-user-avatar")?.textContent).toBe("AL");
  } finally { dispose(); root.remove(); }
});
