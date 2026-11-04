import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net, { type AddressInfo } from "node:net";
import { writeTestV3Config } from "../test-utils/v3-config.js";

// ALG-614: Thinh approved HTTP/auth/record/media seam 5 in fa28457a-d6a4-4709-97cd-91ff575553b9.
// Exercises real ownership, protocol and policy; browser enforcement is validated separately.
describe("built-in file app over authenticated HTTP without an MCP extension", () => {
  let home: string;
  const previousHome = process.env.YOPLAI_HOME;
  let server: ReturnType<typeof import("../server/index.js").startServer>;
  let stopAuth: (() => Promise<void>) | undefined;
  let gatewayUrl: string;
  let owner: { id: string; cookie: string };
  const route = "/api/agents/main/sessions/file-chat/mcp-apps/file-call";
  const fileId = "33333333-3333-4333-8333-333333333333";

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-file-app-"));
    process.env.YOPLAI_HOME = home;
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const appsPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await writeTestV3Config(home, {
      agents: [{ id: "main" }],
      extensions: { multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "file-app-test-session-secret-32-characters" } },
      extraConfig: { apps: { port: appsPort } },
    });
    vi.resetModules();
    const { loadConfig } = await import("../config/index.js");
    const { multiUserExtension } = await import("@yoplai/extension-multi-user");
    const { createExtensionContext } = await import("../extensions/context.js");
    await multiUserExtension.start(createExtensionContext(loadConfig()));
    stopAuth = () => multiUserExtension.stop();
    const { getExtensionRuntime } = await import("../extensions/registry.js");
    const runtime = getExtensionRuntime();
    runtime.load([multiUserExtension]);
    const { api } = await import("../server/api.core.js");
    multiUserExtension.registerRoutes(api);
    const { startServer } = await import("../server/index.js");
    server = startServer(0, "127.0.0.1", runtime);
    await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
    gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const signed = await fetch(gatewayUrl + "/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "owner", email: "owner@files.test", password: "e2e-password-123" }),
    });
    expect(signed.status).toBe(200);
    owner = { id: (await signed.json()).user.id, cookie: signed.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
    const history = path.join(home, "sessions", "users", owner.id, "history");
    const records = path.join(history, "mcp-apps", "main", "file-chat");
    await fs.mkdir(records, { recursive: true });
    await fs.writeFile(path.join(history, "2026-11-04T12-00-00-000Z_main-file-chat.jsonl"), "");
    await fs.writeFile(path.join(records, "abcdef0123456789abcdef0123456789.json"), JSON.stringify({
      recordId: "abcdef0123456789abcdef0123456789", agentId: "main", sessionId: "file-chat", ownerUserId: owner.id,
      toolCallId: "file-call", server: "yoplai", tool: "send_file", resourceUri: "ui://yoplai/file-viewer",
      args: { path: "report.html", title: "Quarterly report" },
      result: { content: [{ type: "text", text: "File sent to user" }], structuredContent: { uri: "yoplai-file://" + fileId, fileId, filename: "report.html", mimeType: "text/html", size: 18, title: "Quarterly report" } },
      createdAt: 1793793600000,
    }));
  }, 20_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopAuth?.();
    if (previousHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
    vi.resetModules();
  });

  function post(operation: string, body?: unknown, call = "file-call") {
    return fetch(gatewayUrl + route.replace("file-call", call) + "/" + operation, {
      method: "POST", headers: { Cookie: owner.cookie, Origin: "http://localhost:3000", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function seedMedia(id: string, filename: string, mimeType: string, bytes: string | Buffer, agentId = "main") {
    const { getMediaOutboundDir, registerMediaFile } = await import("../media/metadata.js");
    const dir = getMediaOutboundDir();
    await fs.mkdir(dir, { recursive: true });
    const storedFilename = id + ".bin";
    const filePath = path.join(dir, storedFilename);
    await fs.writeFile(filePath, bytes);
    return registerMediaFile({ fileId: id, direction: "outbound", filename, mimeType, size: Buffer.byteLength(bytes),
      storedFilename, path: filePath, agentId, userId: owner.id, sessionId: "file-chat" });
  }

  function read(uri: string, call = "file-call") {
    return post("rpc", { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri } }, call);
  }

  async function captureFile(call: string, file: { fileId: string; filename: string; mimeType: string; size: number }) {
    const { captureSendFile } = await import("./capture.js");
    await captureSendFile({ agentId: "main", sessionId: "file-chat", userId: owner.id, toolCallId: call }, { path: file.filename }, file);
  }

  it("serves a built-in file viewer with the declared CDN/font policy and stored result", async () => {
    const response = await post("view");
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view).toMatchObject({ available: true, server: "yoplai", toolName: "send_file", prefersBorder: true,
      result: { content: [{ type: "text", text: "File sent to user" }], structuredContent: { filename: "report.html", title: "Quarterly report" } },
      csp: { resourceDomains: ["https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://unpkg.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"], connectDomains: [], frameDomains: [] },
    });
    const bootstrap = await fetch(view.sandboxUrl.replace("localhost", "127.0.0.1"), { headers: { Host: new URL(view.sandboxUrl).host } });
    expect(bootstrap.status).toBe(200);
    const content = await fetch(view.sandboxUrl.replace("/sandbox/", "/content/").replace("localhost", "127.0.0.1"), { headers: { Host: new URL(view.sandboxUrl).host } });
    expect(content.status).toBe(200);
    expect(content.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(content.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(await content.text()).toContain("<!doctype html>");
  });

  it("reads the captured HTML as text even when its MIME type is generic", async () => {
    await seedMedia(fileId, "report.html", "application/octet-stream", "<h1>Report</h1>");
    const response = await read("yoplai-file://" + fileId);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { contents: [{
      uri: "yoplai-file://33333333-3333-4333-8333-333333333333", mimeType: "application/octet-stream", text: "<h1>Report</h1>",
    }] } });
  });

  it("refuses actual file bytes above 10 MiB with a too_large protocol error", async () => {
    const file = await seedMedia("44444444-4444-4444-8444-444444444444", "large.txt", "text/plain", Buffer.alloc(10 * 1024 * 1024 + 1, 65));
    await captureFile("large-call", { ...file, size: 1 });
    const response = await read("yoplai-file://" + file.fileId, "large-call");
    const body = await response.json();
    expect(body.error).toEqual({ code: -32000, message: "MCP Apps request failed", data: { reason: "too_large" } });
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 7 });
  });

  it("downloads the original as an attachment with nosniff", async () => {
    const response = await fetch(gatewayUrl + "/api/media/download/" + fileId, { headers: { Cookie: owner.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="report.html"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("<h1>Report</h1>");
  });

  it("refuses other files, another agent's captured file and unknown records", async () => {
    const other = await seedMedia("55555555-5555-4555-8555-555555555555", "other.txt", "text/plain", "Same agent, different file");
    const foreign = await seedMedia("66666666-6666-4666-8666-666666666666", "foreign.txt", "text/plain", "Another agent's file", "foreign-agent");
    await captureFile("foreign-call", foreign);
    for (const [uri, call] of [["yoplai-file://" + other.fileId, "file-call"], ["yoplai-file://" + foreign.fileId, "foreign-call"], ["file:///etc/passwd", "file-call"]]) {
      const response = await read(uri, call);
      expect((await response.json()).error).toEqual({ code: -32000, message: "MCP Apps request failed", data: { reason: "not_app_visible" } });
    }
    expect((await read("yoplai-file://" + fileId, "missing-call")).status).toBe(404);
  });

  it("refuses tool calls and audits the refusal without tool arguments", async () => {
    const log = vi.spyOn(console, "log");
    try {
      const response = await post("rpc", { jsonrpc: "2.0", id: "no-tools", method: "tools/call", params: { name: "send_file", arguments: { path: "AUDIT-PRIVATE-PATH" } } });
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: "no-tools", error: { code: -32000, message: "MCP Apps request failed", data: { reason: "not_app_visible" } } });
      const audits = log.mock.calls.flatMap(([line]) => typeof line === "string" && line.startsWith("{") ? [JSON.parse(line)] : [])
        .filter((line) => line.msg === "MCP Apps operation");
      expect(audits).toEqual([expect.objectContaining({ server: "yoplai", method: "tools/call", tool: "send_file", outcome: "not_app_visible" })]);
      expect(JSON.stringify(audits)).not.toContain("AUDIT-PRIVATE-PATH");
    } finally { log.mockRestore(); }
  });

  it("returns text formats as text and binary images as base64", async () => {
    const cases: Array<[string, string, string | Buffer, "text" | "blob", string]> = [
      ["note.md", "text/markdown", "# Notes", "text", "# Notes"],
      ["data.json", "application/json", '{"count":3}', "text", '{"count":3}'],
      ["table.csv", "text/csv", "Name,Count\nAda,7", "text", "Name,Count\nAda,7"],
      ["drawing.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>', "text", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ["code.ts", "application/octet-stream", "const count = 3;", "text", "const count = 3;"],
      ["run.log", "application/octet-stream", "Job finished", "text", "Job finished"],
      ["image.png", "image/png", Buffer.from([0, 1, 2, 255]), "blob", "AAEC/w=="],
    ];
    for (const [index, [filename, mimeType, bytes, encoding, expected]] of cases.entries()) {
      const id = `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`;
      const file = await seedMedia(id, filename, mimeType, bytes);
      await captureFile("format-" + index, file);
      const response = await read("yoplai-file://" + id, "format-" + index);
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { contents: [{ uri: "yoplai-file://" + id, mimeType, [encoding]: expected }] } });
    }
  });
});
