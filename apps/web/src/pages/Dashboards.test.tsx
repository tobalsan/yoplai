// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Dashboards } from "./Dashboards";
import type { DashboardRow } from "../api/dashboards";

let root: HTMLDivElement;
let dispose: () => void;
beforeEach(() => { root = document.createElement("div"); document.body.appendChild(root); });
afterEach(() => { dispose?.(); root.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

const row = (id: string, isOwner: boolean): DashboardRow => ({
  id, title: id, agentId: "agent", agentName: "Agent", slug: `${id}.html`, link: `/d/${id}`,
  params: [], linksTo: [], updatedAt: null, publishedAt: null, legacy: false,
  isOwner, shared: !isOwner, ownerName: isOwner ? "Alice" : "Bob", mode: "read", pinned: false,
});
const section = (name: string) => Array.from(root.querySelectorAll("main > section")).find((element) => element.querySelector("h2")?.textContent === name);
const dashboard = (title: string) => Array.from(root.querySelectorAll(".dashboard-list-row")).find((element) => element.querySelector("strong")?.textContent === title)!;
const toggle = (title: string) => dashboard(title).querySelector<HTMLButtonElement>('button[aria-pressed]')!;

it.each(["failure", "timeout"])("moves pins without duplicates and rolls back only the %s row while other work progresses", async (failure) => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  let failOwn: () => void = () => {};
  let finishShared: () => void = () => {};
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
    if (input === "/api/agents") return Promise.resolve(Response.json([]));
    if (input === "/api/dashboards") return Promise.resolve(Response.json({ owned: [row("Own", true)], shared: [row("Shared", false)] }));
    if (input === "/api/dashboards/Own/pin") return new Promise<Response>((resolve, reject) => {
      failOwn = () => resolve(new Response("Unavailable", { status: 500 }));
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    if (input === "/api/dashboards/Shared/pin") return new Promise<Response>((resolve) => {
      finishShared = () => resolve(Response.json({ ok: true, pinned: true }));
    });
    throw new Error(`Unexpected request: ${input}`);
  }));
  dispose = render(() => <Dashboards />, root);
  await vi.advanceTimersByTimeAsync(0);
  expect(section("Pinned")).toBeUndefined();
  expect(section("My dashboards")?.textContent).toContain("Own");
  expect(section("Shared with me")?.textContent).toContain("Shared");
  toggle("Own").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(section("Pinned")?.textContent).toContain("Own");
  expect(section("My dashboards")).toBeUndefined();
  expect(toggle("Own").disabled).toBe(true);
  expect(dashboard("Own").textContent).toContain("Agent");
  expect(dashboard("Own").textContent).toContain("Manage access");
  expect(dashboard("Own").textContent).toContain("Delete");
  await vi.advanceTimersByTimeAsync(1000);
  toggle("Shared").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(section("Shared with me")).toBeUndefined();
  expect(root.querySelectorAll(".dashboard-list-row")).toHaveLength(2);
  expect(Array.from(section("Pinned")!.querySelectorAll("strong")).map((element) => element.textContent)).toEqual(["Own", "Shared"]);
  expect(dashboard("Shared").textContent).not.toContain("Manage access");
  expect(dashboard("Shared").textContent).not.toContain("Delete");
  if (failure === "timeout") await vi.advanceTimersByTimeAsync(14_000);
  else { failOwn(); await vi.advanceTimersByTimeAsync(0); }
  expect(root.querySelector('[role="alert"]')?.textContent).toContain(failure === "timeout" ? "Unable to update pin" : "500");
  expect(section("My dashboards")?.textContent).toContain("Own");
  expect(toggle("Own").getAttribute("aria-pressed")).toBe("false");
  expect(toggle("Own").disabled).toBe(false);
  expect(section("Pinned")?.querySelectorAll("strong")).toHaveLength(1);
  expect(toggle("Shared").getAttribute("aria-pressed")).toBe("true");
  expect(toggle("Shared").disabled).toBe(true);
  finishShared();
  await vi.advanceTimersByTimeAsync(0);
  expect(toggle("Shared").disabled).toBe(false);
});

it("keeps a successful pin when an overlapping delete refresh returns an older snapshot", async () => {
  let finishPin: () => void = () => {};
  let finishRefresh: () => void = () => {};
  let refreshing = false;
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
    if (input === "/api/agents") return Promise.resolve(Response.json([]));
    if (input === "/api/dashboards" && !refreshing) return Promise.resolve(Response.json({ owned: [row("Own", true), row("Other", true)], shared: [] }));
    if (input === "/api/dashboards") return new Promise<Response>((resolve) => {
      finishRefresh = () => resolve(Response.json({ owned: [row("Own", true)], shared: [] }));
    });
    if (input === "/api/dashboards/Own/pin") return new Promise<Response>((resolve) => {
      finishPin = () => resolve(Response.json({ ok: true, pinned: true }));
    });
    if (input === "/api/dashboards/Other" && init?.method === "DELETE") {
      refreshing = true;
      return Promise.resolve(Response.json({ ok: true }));
    }
    throw new Error(`Unexpected request: ${input}`);
  }));
  dispose = render(() => <Dashboards />, root);
  await vi.waitFor(() => expect(root.querySelectorAll(".dashboard-list-row")).toHaveLength(2));
  toggle("Own").click();
  Array.from(dashboard("Other").querySelectorAll("button")).find((button) => button.textContent?.trim() === "Delete")!.click();
  Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((button) => button.textContent?.trim() === "Delete")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await vi.waitFor(() => expect(refreshing).toBe(true));
  finishPin();
  await vi.waitFor(() => expect(toggle("Own").disabled).toBe(false));
  finishRefresh();
  await vi.waitFor(() => expect(root.querySelectorAll(".dashboard-list-row")).toHaveLength(1));
  expect(section("Pinned")?.textContent).toContain("Own");
  expect(toggle("Own").getAttribute("aria-pressed")).toBe("true");
});
