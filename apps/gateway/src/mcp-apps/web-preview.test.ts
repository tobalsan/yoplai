import { createServer, type Server, type RequestListener } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { AgentConfigSchema, GatewayConfigSchema } from "@yoplai/shared";
import { checkPreviewUrl } from "./web-preview.js";

// Pom approved this public URL-check seam in ALG-656 comment 77af29fb.
// Real HTTP covers URL policy, headers, redirects and failure; runtime capture
// and browser enforcement are exercised separately.
const servers: Server[] = [];
async function serve(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  return `http://127.0.0.1:${address.port}`;
}
const context = {
  agent: AgentConfigSchema.parse({ id: "preview", name: "Preview", workspace: "/tmp/preview", model: { provider: "test", model: "test" } }),
  config: GatewayConfigSchema.parse({ agents: [] }),
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  })));
});

it("checks a local page with the preview user agent and reports its final status", async () => {
  let userAgent: string | undefined;
  let method: string | undefined;
  let authenticated = false;
  const url = await serve((req, res) => { userAgent = req.headers["user-agent"]; method = req.method; authenticated = !!(req.headers.cookie || req.headers.authorization); res.writeHead(404); res.end("Page"); });
  expect(await checkPreviewUrl(`${url}/page#section`, context)).toEqual({
    frameable: true, reason: null, finalUrl: `${url}/page#section`, status: 404,
  });
  expect(userAgent).toBe("Yoplai-WebPreview/1");
  expect(method).toBe("GET");
  expect(authenticated).toBe(false);
});

it("refuses unsafe schemes, non-loopback HTTP, credentials, oversized URLs and malformed URLs before connecting", async () => {
  for (const [url, reason] of [
    ["http://example.test/page", "HTTPS"],
    ["ftp://example.test/page", "HTTPS"],
    ["https://user:password@example.test/page", "credentials"],
    [`https://example.test/${"a".repeat(2048)}`, "2048"],
    ["not a URL", "valid URL"],
  ]) {
    await expect(checkPreviewUrl(url!, context)).rejects.toThrow(reason);
  }
});

it("refuses sandbox loopback and every configured Yoplai origin or loopback port", async () => {
  const sandbox = { ...context, agent: AgentConfigSchema.parse({ ...context.agent, sandbox: { enabled: true } }) };
  for (const url of ["http://localhost:5173", "https://localhost:5173", "https://127.0.0.1:5173", "https://[::1]:5173"]) {
    await expect(checkPreviewUrl(url, sandbox)).rejects.toThrow("sandbox");
  }
  const own = { ...context, config: GatewayConfigSchema.parse({
    agents: [], server: { baseUrl: "https://chat.example.test", port: 4102 },
    web: { baseUrl: "https://web.example.test" }, apps: { origin: "https://apps.example.test", port: 4103 },
    gateway: { port: 4101 }, ui: { port: 3100 },
  }) };
  for (const url of [
    "https://chat.example.test/a", "https://web.example.test/a", "https://apps.example.test/a",
    "http://localhost:3100", "https://127.0.0.1:4101", "http://[::1]:4102", "https://localhost:4103",
  ]) {
    await expect(checkPreviewUrl(url, own)).rejects.toThrow("Yoplai");
  }
  for (const port of [3000, 4000, 4001]) {
    await expect(checkPreviewUrl(`http://[::1]:${port}`, context)).rejects.toThrow("Yoplai");
  }
});

it("follows at most five redirects and revalidates every target", async () => {
  const paths: string[] = [];
  const url = await serve((req, res) => {
    const pathname = req.url ?? "/";
    paths.push(pathname);
    if (pathname === "/unsafe") { res.writeHead(302, { Location: "http://example.test/private" }); res.end(); return; }
    if (pathname === "/own") { res.writeHead(302, { Location: "http://localhost:3000" }); res.end(); return; }
    const step = Number(pathname.slice(1));
    if (step > 0) res.writeHead(302, { Location: `/${step - 1}` });
    res.end("Final");
  });
  expect(await checkPreviewUrl(`${url}/5`, context)).toEqual({ frameable: true, reason: null, finalUrl: `${url}/0`, status: 200 });
  paths.length = 0;
  await expect(checkPreviewUrl(`${url}/6`, context)).rejects.toThrow("5 redirects");
  expect(paths).toEqual(["/6", "/5", "/4", "/3", "/2", "/1"]);
  await expect(checkPreviewUrl(`${url}/unsafe`, context)).rejects.toThrow("HTTPS");
  await expect(checkPreviewUrl(`${url}/own`, context)).rejects.toThrow("Yoplai");
});

it("turns enforcing frame headers into link cards, including separate CSP policies", async () => {
  const cases: Array<{ headers: Record<string, string | string[]>; reason: "x-frame-options" | "frame-ancestors" | null }> = [
    { headers: { "X-Frame-Options": "DENY" }, reason: "x-frame-options" },
    { headers: { "X-Frame-Options": "" }, reason: "x-frame-options" },
    { headers: { "Content-Security-Policy": "frame-ancestors 'self'" }, reason: "frame-ancestors" },
    { headers: { "Content-Security-Policy": "default-src 'self'; FRAME-ANCESTORS *" }, reason: null },
    { headers: { "Content-Security-Policy-Report-Only": "frame-ancestors 'none'" }, reason: null },
    { headers: { "Content-Security-Policy": ["frame-ancestors *", "default-src 'self'; frame-ancestors 'none'"] }, reason: "frame-ancestors" },
    { headers: { "Content-Security-Policy": "frame-ancestors *, frame-ancestors https://chat.example.test" }, reason: "frame-ancestors" },
    { headers: { "Content-Security-Policy": "frame-ancestors" }, reason: "frame-ancestors" },
  ];
  const url = await serve((req, res) => { res.writeHead(200, cases[Number(req.url?.slice(1))]!.headers); res.end("Header fixture"); });
  for (const [index, fixture] of cases.entries()) {
    expect(await checkPreviewUrl(`${url}/${index}`, context)).toEqual({
      frameable: fixture.reason === null, reason: fixture.reason, finalUrl: `${url}/${index}`, status: 200,
    });
  }
});

it("returns an unreachable card at the last tried URL after a connection failure", async () => {
  let target = "";
  const url = await serve((_req, res) => { res.writeHead(302, { Location: target }); res.end(); });
  const stopped = createServer();
  stopped.listen(0, "127.0.0.1");
  await once(stopped, "listening");
  const address = stopped.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  await new Promise<void>(resolve => stopped.close(() => resolve()));
  target = `http://127.0.0.1:${address.port}/gone`;
  expect(await checkPreviewUrl(url, context)).toEqual({ frameable: false, reason: "unreachable", finalUrl: target, status: null });
});

it("propagates run cancellation while another page check can still finish", async () => {
  let arrived!: () => void;
  const request = new Promise<void>(resolve => { arrived = resolve; });
  const url = await serve((req, res) => {
    if (req.url === "/hang") { arrived(); return; }
    res.end("Other page");
  });
  const controller = new AbortController();
  const pending = checkPreviewUrl(`${url}/hang`, { ...context, signal: controller.signal });
  await request;
  controller.abort(new Error("run cancelled"));
  await expect(pending).rejects.toThrow("run cancelled");
  expect(await checkPreviewUrl(`${url}/ok`, context)).toEqual({ frameable: true, reason: null, finalUrl: `${url}/ok`, status: 200 });
});

it("times out a non-answering page after five seconds and leaves another check working", async () => {
  const url = await serve((req, res) => { if (req.url !== "/hang") res.end("Working"); });
  const started = Date.now();
  expect(await checkPreviewUrl(`${url}/hang`, context)).toEqual({ frameable: false, reason: "unreachable", finalUrl: `${url}/hang`, status: null });
  expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
  expect(Date.now() - started).toBeLessThan(6500);
  expect(await checkPreviewUrl(url, context)).toEqual({ frameable: true, reason: null, finalUrl: `${url}/`, status: 200 });
}, 7500);

it("accepts HTTPS on an invented host even when the host cannot be reached", async () => {
  expect(await checkPreviewUrl("https://preview.example.test/page", context)).toEqual({
    frameable: false, reason: "unreachable", finalUrl: "https://preview.example.test/page", status: null,
  });
});

it("checks headers without waiting for the page body to finish", async () => {
  const url = await serve((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.write("Unfinished page"); });
  expect(await checkPreviewUrl(url, context)).toEqual({ frameable: true, reason: null, finalUrl: `${url}/`, status: 200 });
}, 1500);

it("reports a malformed redirect as a URL refusal without returning the raw redirect value", async () => {
  const url = await serve((_req, res) => { res.writeHead(302, { Location: "https://[invalid" }); res.end(); });
  await expect(checkPreviewUrl(url, context)).rejects.toMatchObject({ code: "invalid_input", message: "Preview requires a valid URL." });
});
