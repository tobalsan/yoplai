// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal, type JSX } from "solid-js";
import { ScheduleAlertsBanner } from "./ScheduleAlertsBanner";
import { refreshScheduleAlerts, useScheduleAlerts } from "../lib/schedule-alerts";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";

vi.mock("@solidjs/router", () => ({
  A: (props: { href: string; children?: JSX.Element; class?: string }) => <a href={props.href} class={props.class}>{props.children}</a>,
}));

const alert = (agentId = "scribe", jobId = "digest") => ({
  agentId, jobId, jobName: "Morning digest", mode: "owner",
  pausedReason: { kind: "credentials", integration: "Acme Mail", connectPath: "/agents/scribe/extensions/acme-mail", at: "2026-11-07T12:00:00Z" },
});

let container: HTMLElement;
let dispose: (() => void) | undefined;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  dispose?.();
  container.remove();
  fetchMock.mockResolvedValue(new Response("[]"));
  await refreshScheduleAlerts();
  resetCapabilitiesForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ScheduleAlertsBanner", () => {
  it("shows only this agent's paused jobs with the reconnect card", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([alert(), { ...alert("other"), jobName: "Other digest" }])));
    await refreshScheduleAlerts();
    dispose = render(() => <ScheduleAlertsBanner agentId="scribe" />, container);
    expect(container.textContent).toContain("Morning digest is paused: reconnect Acme Mail, then resume it.");
    expect(container.textContent).not.toContain("Other digest");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/agents/scribe/extensions/acme-mail");
  });

  it("resumes the job and removes the banner after refreshing alerts", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([alert()])));
    await refreshScheduleAlerts();
    dispose = render(() => <ScheduleAlertsBanner agentId="scribe" />, container);
    fetchMock.mockResolvedValueOnce(new Response("{}"));
    fetchMock.mockResolvedValueOnce(new Response("[]"));
    const resume = container.querySelector<HTMLButtonElement>("button");
    expect(resume?.textContent).toBe("Resume");
    resume!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledWith("/api/schedules/scribe/digest", expect.objectContaining({
      method: "PATCH", credentials: "include", body: '{"enabled":true}',
    }));
    expect(container.querySelector('[aria-label="Paused scheduled jobs"]')).toBeNull();
  });

  it("shows a failed resume inline and leaves the job available to retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([alert()])));
    await refreshScheduleAlerts();
    dispose = render(() => <ScheduleAlertsBanner agentId="scribe" />, container);
    fetchMock.mockResolvedValueOnce(new Response('{"error":"team_requires_admin"}', { status: 403 }));
    container.querySelector<HTMLButtonElement>("button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Only admins can pause or resume Team jobs.");
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
    expect(container.textContent).toContain("Morning digest is paused");
  });

  it("caps the banner at three jobs and links remaining jobs to Schedules", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      alert("scribe", "one"), alert("scribe", "two"), alert("scribe", "three"), alert("scribe", "four"), alert("scribe", "five"),
    ])));
    await refreshScheduleAlerts();
    dispose = render(() => <ScheduleAlertsBanner agentId="scribe" schedulesAgentId="pool-scribe" />, container);
    expect(container.querySelectorAll("button")).toHaveLength(3);
    const more = Array.from(container.querySelectorAll("a")).find((link) => link.textContent === "+2 more, open Schedules");
    expect(more?.getAttribute("href")).toBe("/agents/pool-scribe/edit?tab=schedules");
  });

  it("refreshes after sign-in, focus, OAuth return, and chat navigation", async () => {
    setCapabilitiesForTests({ extensions: { scheduler: true }, multiUser: true, user: { id: "owner", role: "user", name: "Owner" } });
    const [chat, setChat] = createSignal<string | null>("scribe");
    const Harness = () => {
      useScheduleAlerts(() => true, chat);
      return <ScheduleAlertsBanner agentId="scribe" />;
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([alert()])));
    dispose = render(Harness, container);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain("Morning digest is paused");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ ...alert(), jobName: "Focused digest" }])));
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain("Focused digest is paused");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ ...alert(), jobName: "Reconnected digest" }])));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "yoplai-oauth" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain("Reconnected digest is paused");
    fetchMock.mockResolvedValueOnce(new Response("[]"));
    setChat(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('[aria-label="Paused scheduled jobs"]')).toBeNull();
  });

  it("bounds a hung refresh, retains the alert, and permits another refresh", async () => {
    vi.useFakeTimers();
    setCapabilitiesForTests({ extensions: { scheduler: true } });
    const Harness = () => {
      useScheduleAlerts(() => true, () => "scribe");
      return <ScheduleAlertsBanner agentId="scribe" />;
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([alert()])));
    dispose = render(Harness, container);
    await vi.advanceTimersByTimeAsync(0);
    let cancelled = false;
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        cancelled = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
    }));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cancelled).toBe(true);
    expect(container.textContent).toContain("Morning digest is paused");
    fetchMock.mockResolvedValueOnce(new Response("[]"));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[aria-label="Paused scheduled jobs"]')).toBeNull();
  });

  it("never restores the previous user's alerts from a late response", async () => {
    setCapabilitiesForTests({ extensions: { scheduler: true }, multiUser: true, user: { id: "first", role: "user", name: "First" } });
    const Harness = () => {
      useScheduleAlerts(() => true, () => "scribe");
      return <ScheduleAlertsBanner agentId="scribe" />;
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([alert()])));
    dispose = render(Harness, container);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let finishOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    window.dispatchEvent(new Event("focus"));
    fetchMock.mockResolvedValueOnce(new Response("[]"));
    setCapabilitiesForTests({ extensions: { scheduler: true }, multiUser: true, user: { id: "second", role: "user", name: "Second" } });
    expect(container.querySelector('[aria-label="Paused scheduled jobs"]')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishOld(new Response(JSON.stringify([alert()])));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('[aria-label="Paused scheduled jobs"]')).toBeNull();
  });

  it("clears alerts when the session loses access", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([alert()])));
    await refreshScheduleAlerts();
    dispose = render(() => <ScheduleAlertsBanner agentId="scribe" />, container);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await refreshScheduleAlerts();
    expect(container.querySelector('[aria-label="Paused scheduled jobs"]')).toBeNull();
  });

  it("lets the owner retry a resume that times out", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([alert()])));
    await refreshScheduleAlerts();
    dispose = render(() => <ScheduleAlertsBanner agentId="scribe" />, container);
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    container.querySelector<HTMLButtonElement>("button")!.click();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Updating scheduled job timed out. Try again.");
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response("{}"));
    fetchMock.mockResolvedValueOnce(new Response("[]"));
    container.querySelector<HTMLButtonElement>("button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[aria-label="Paused scheduled jobs"]')).toBeNull();
  });
});
