import { describe, expect, it } from "vitest";
import { classifyDashboardLink, cleanDashboardQuery, remoteDashboardChatPath, remoteDashboardPath } from "./remote-dashboard";

const origin = "http://localhost:3000";
const here = "a".repeat(32);
const other = "b".repeat(32);
const classify = (href: unknown) => classifyDashboardLink(href, { origin, dashboardId: here });

describe("remote dashboard public route", () => {
  it("holds the gateway, the dashboard, and only the relevant query", () => {
    expect(remoteDashboardPath("east side", here)).toBe(`/remote-dashboards/east%20side/${here}`);
    expect(remoteDashboardPath("east", here, "?week=3&__yoplai_nonce=secret")).toBe(`/remote-dashboards/east/${here}?week=3`);
    expect(remoteDashboardPath("east", here, "__yoplai_a=1")).toBe(`/remote-dashboards/east/${here}`);
  });

  it("keeps an untouched query as it is", () => {
    expect(cleanDashboardQuery("?a=%20b&c=d")).toBe("a=%20b&c=d");
    expect(cleanDashboardQuery(undefined)).toBe("");
  });
});

describe("remote dashboard Chat target", () => {
  const view = { gateway: "east", dashboardId: here, agentId: "agent-7@east", canWrite: true, canEdit: true, annotation: true };
  it("continues the creating session or starts a new chat, for the suffixed agent", () => {
    expect(remoteDashboardChatPath({ ...view, chat: { sessionId: "s 1" } })).toBe(`/chat/agent-7%40east?session=s%201&dashboard=${here}`);
    expect(remoteDashboardChatPath({ ...view, chat: { sessionId: null } })).toBe(`/chat/agent-7%40east?dashboard=${here}&new=1`);
  });
  it("offers nothing without agent access", () => {
    expect(remoteDashboardChatPath({ ...view, chat: null, annotation: false })).toBeUndefined();
  });
});

describe("dashboard link requests", () => {
  it("takes only the dashboard ID and the clean query from a viewer path of the same gateway", () => {
    expect(classify(`${origin}/api/relay/dashboard-views/${other}/?week=2&__yoplai_x=1`)).toEqual({ kind: "dashboard", id: other, query: "week=2" });
  });

  it("resolves a relative link against the checked dashboard", () => {
    expect(classify(`../${other}/?tab=b`)).toEqual({ kind: "dashboard", id: other, query: "tab=b" });
    expect(classify("?week=9")).toEqual({ kind: "dashboard", id: here, query: "week=9" });
  });

  it("ignores other paths and fragments on the host origin, and handle-like paths", () => {
    for (const href of [
      `${origin}/api/relay/dashboard-views/${"c".repeat(43)}/frame`,
      `${origin}/api/relay/dashboard-views/${other}/#part`,
      `${origin}/api/relay/dashboard-views/${other}`,
      `${origin}/api/relay/dashboard-views/short/`,
      `${origin}/chat/agent`,
      `${origin}/api/relay/dashboard-views/${other}%2F/`,
    ]) expect(classify(href)).toEqual({ kind: "ignored" });
  });

  it("asks for a click before an external address opens, and shows the destination without its query", () => {
    expect(classify("https://example.com/report?token=1#x")).toEqual({ kind: "external", href: "https://example.com/report?token=1#x", destination: "https://example.com/report" });
    expect(classify("http://docs.example.org/a")).toMatchObject({ kind: "external" });
  });

  it("ignores executable and non-web schemes", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,x", "blob:http://localhost:3000/x", "file:///etc/passwd", "mailto:a@b.c", "about:blank", "", 7, undefined, `https://example.com/${"x".repeat(2100)}`]) {
      expect(classify(href)).toEqual({ kind: "ignored" });
    }
  });

  it("blocks credentials and addresses of this machine or network", () => {
    expect(classify("https://user:pw@example.com/")).toEqual({ kind: "blocked", reason: "credentials" });
    expect(classify("https://user@example.com/")).toEqual({ kind: "blocked", reason: "credentials" });
    for (const href of [
      "http://localhost:4000/", "http://app.localhost/", "http://127.0.0.1/", "http://127.9.9.9/", "http://0.0.0.0/", "http://10.1.2.3/", "http://192.168.1.5/",
      "http://172.16.0.1/", "http://172.31.255.1/", "http://169.254.169.254/", "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:7f00:1]/",
      "http://2130706433/", "http://printer/", "http://nas.local/",
    ]) expect(classify(href), href).toEqual({ kind: "blocked", reason: "local" });
    expect(classify("http://172.32.0.1/")).toMatchObject({ kind: "external" });
  });

  it("blocks local names that end with a DNS dot, and keeps a public name with a dot usable", () => {
    for (const href of ["http://localhost.:9999/", "http://nas.local./", "http://app.localhost./x", "http://printer./", "http://127.0.0.1./", "http://localhost../", "http://svc.internal./"]) {
      expect(classify(href), href).toEqual({ kind: "blocked", reason: "local" });
    }
    expect(classify("https://example.com./report")).toMatchObject({ kind: "external", destination: "https://example.com./report" });
  });
});
