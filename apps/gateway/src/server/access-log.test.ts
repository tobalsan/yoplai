import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessLogger, stripAnsi } from "./access-log.js";

describe("accessLogger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("suppresses successful polling and health requests", async () => {
    const app = new Hono();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    app.use("*", accessLogger());
    app.get("/api/agents/sessions", (c) => c.json([]));
    app.get("/api/auth/get-session", (c) => c.json({}));
    app.get("/api/agents/alpha/history", (c) => c.json({}));
    app.get("/health", (c) => c.json({ ok: true }));

    await app.request("/api/agents/sessions");
    await app.request("/api/auth/get-session");
    await app.request("/api/agents/alpha/history");
    await app.request("/health");

    expect(log).not.toHaveBeenCalled();
  });

  it("logs unsuccessful polling requests", async () => {
    const app = new Hono();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    app.use("*", accessLogger());
    app.get("/api/agents/sessions", (c) => c.json({ error: "nope" }, 401));

    await app.request("/api/agents/sessions");

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^--> GET \/api\/agents\/sessions 401 \d+ms$/)
    );
  });

  it("logs slow polling requests", async () => {
    const app = new Hono();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(501);
    app.use("*", accessLogger());
    app.get("/api/agents/sessions", (c) => c.json([]));

    await app.request("/api/agents/sessions");

    expect(log).toHaveBeenCalledWith("--> GET /api/agents/sessions 200 501ms");
  });

  it("keeps normal request pairs free of ANSI escapes", async () => {
    const app = new Hono();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    app.use("*", accessLogger());
    app.post("/hooks/test", (c) => c.json({ ok: true }));

    await app.request("/hooks/test", { method: "POST" });

    expect(log).toHaveBeenCalledWith("<-- POST /hooks/test");
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^--> POST \/hooks\/test 200 \d+ms$/)
    );
    expect(log.mock.calls.flat().join("")).not.toContain(
      String.fromCharCode(27)
    );
  });

  it("removes ANSI escape codes", () => {
    expect(stripAnsi("--> GET /hooks/test \u001B[32m200\u001B[0m 5ms")).toBe(
      "--> GET /hooks/test 200 5ms"
    );
  });

  it("redacts dashboard preview tokens in both request log lines", async () => {
    const app = new Hono();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    app.use("*", accessLogger());
    app.get("/internal/dashboards/:slug/html", (c) => c.html("preview"));

    await app.request(
      "/internal/dashboards/clients.html/html?%74oken=secret-value&token=second-secret&theme=dark&id=7"
    );

    expect(log).toHaveBeenCalledTimes(2);
    for (const [message] of log.mock.calls) {
      expect(message).not.toContain("secret");
      expect(message).toContain("token=%5Bredacted%5D&theme=dark&id=7");
    }
  });
});
