// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { DashboardListRow } from "./DashboardListRow";
import type { DashboardRow } from "../api/dashboards";

let root: HTMLDivElement;
let dispose: () => void;
beforeEach(() => { root = document.createElement("div"); document.body.appendChild(root); });
afterEach(() => { dispose?.(); root.remove(); });

const row = (overrides: Partial<DashboardRow>): DashboardRow => ({
  id: "d1", agentId: "a", agentName: "Agent", title: "Revenue", slug: "revenue.html", link: "/d/d1",
  params: [], linksTo: [], updatedAt: "2026-10-19T09:21:20.000Z", publishedAt: null,
  legacy: false, isOwner: false, shared: false, ownerName: "Alice", mode: "read", ...overrides,
});
const show = (dashboard: DashboardRow) => { dispose = render(() => <DashboardListRow dashboard={dashboard} onManage={() => {}} onClaim={() => {}} />, root); };
const buttons = () => Array.from(root.querySelectorAll("button")).map((button) => button.textContent?.trim());

describe("DashboardListRow ownership label", () => {
  it("exposes an accessible pin toggle only when a callback is supplied", () => {
    const onPin = vi.fn();
    const [pinned, setPinned] = createSignal(false);
    const [pending, setPending] = createSignal(false);
    dispose = render(() => <DashboardListRow dashboard={row({ pinned: pinned() })} onPin={onPin} pinPending={pending()} />, root);
    const toggle = () => root.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    expect(toggle().getAttribute("aria-label")).toBe("Pin");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    toggle().click();
    expect(onPin).toHaveBeenCalledOnce();
    setPinned(true);
    expect(toggle().getAttribute("aria-label")).toBe("Unpin");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    setPending(true);
    expect(toggle().disabled).toBe(true);
    toggle().click();
    expect(onPin).toHaveBeenCalledOnce();
    dispose();
    show(row({}));
    expect(root.querySelector('button[aria-pressed]')).toBeNull();
  });
  it("says Owned by you for owners and offers Manage access", () => {
    show(row({ isOwner: true, shares: [{ kind: "user", id: "u", mode: "read" }] }));
    expect(root.textContent).toContain("Owned by you");
    expect(root.textContent).toContain("1 person");
    expect(buttons()).toContain("Manage access");
  });
  it("says Shared by owner for recipients with their permission", () => {
    show(row({ shared: true, mode: "write" }));
    expect(root.textContent).toContain("Shared by Alice");
    expect(root.textContent).toContain("Can edit");
    expect(buttons()).not.toContain("Manage access");
  });
  it("says Owned by owner for a superadmin who was not shared the dashboard", () => {
    show(row({ shared: false }));
    expect(root.textContent).toContain("Owned by Alice");
    expect(root.textContent).not.toContain("Shared by");
  });
  it("says Not claimed for legacy dashboards and offers Claim", () => {
    show(row({ legacy: true, ownerName: null }));
    expect(root.textContent).toContain("Not claimed");
    expect(buttons()).toContain("Claim");
  });
  it("shows required parameters instead of Open", () => {
    show(row({ params: ["id", "name"] }));
    expect(root.textContent).toContain("Needs id, name");
    expect(Array.from(root.querySelectorAll("a")).some((a) => a.textContent?.trim() === "Open")).toBe(false);
  });
});
