import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { registerAvatarCommand } from "./cli.js";
import { AvatarProviderUnavailableError, chatgptAccountId, generateAvatarImage, type AvatarImageDeps } from "./generate.js";
import { buildAvatarPrompt } from "./prompt.js";
import { createAvatarRoutes } from "./routes.js";
import { generateAgentAvatar } from "./service.js";
import { listAvatarStyles, resolveAvatarStyle } from "./styles.js";

const AGENT_YAML = `id: ops
# Keeps the self-hosted tools current.
name: Ops
role: Self-hosted software updater
description: Keeps Mattermost and GitLab up to date.
model:
  provider: anthropic
  model: claude-sonnet-4-5
`;

const PNG = Buffer.from("fake-png");
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

let workspace: string;
let agent: AgentConfig;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "avatars-"));
  await fs.writeFile(path.join(workspace, "agent.yaml"), AGENT_YAML);
  agent = { id: "ops", name: "Ops", role: "Self-hosted software updater", description: "Keeps Mattermost and GitLab up to date.", workspace, model: { provider: "anthropic", model: "claude-sonnet-4-5" } } as AgentConfig;
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  process.exitCode = undefined;
});

const config = (avatars?: GatewayConfig["avatars"]) => ({ avatars }) as Pick<GatewayConfig, "avatars">;

describe("avatar styles", () => {
  it("defaults to 3d and lets the config add or override styles", () => {
    expect(resolveAvatarStyle(config()).id).toBe("3d");
    const custom = config({ style: "studio", styles: { studio: "Studio photo", manga: "Shonen manga" } });
    expect(resolveAvatarStyle(custom)).toEqual({ id: "studio", label: "studio", prompt: "Studio photo" });
    expect(listAvatarStyles(custom).find((style) => style.id === "manga")).toEqual({ id: "manga", label: "Manga", prompt: "Shonen manga" });
    expect(() => resolveAvatarStyle(config(), "nope")).toThrow('Unknown avatar style "nope"');
  });

  it("describes the agent's job and forbids text in the prompt", () => {
    const prompt = buildAvatarPrompt(agent, resolveAvatarStyle(config(), "manga"));
    expect(prompt).toContain('named "Ops"');
    expect(prompt).toContain("Self-hosted software updater. Keeps Mattermost and GitLab up to date.");
    expect(prompt).toContain("manga");
    expect(prompt).toContain("No text");
  });
});

describe("avatar image generation", () => {
  const sse = (...events: object[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const deps = (auth: Partial<Record<"openai-codex" | "openai", { apiKey: string }>>, fetchImpl: typeof fetch): AvatarImageDeps => ({
    fetch: fetchImpl,
    getAuth: async (provider) => auth[provider],
    listModels: async () => ["gpt-codex-a", "gpt-codex-b"],
  });

  it("uses a ChatGPT subscription first, with the account id taken from the token", async () => {
    const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(sse(
      { type: "response.output_item.done", item: { type: "message" } },
      { type: "response.output_item.done", item: { type: "image_generation_call", result: PNG.toString("base64") } },
      { type: "response.completed" },
    )));
    const image = await generateAvatarImage("a prompt", {}, deps({ "openai-codex": { apiKey: token }, openai: { apiKey: "sk" } }, fetchMock as unknown as typeof fetch));
    expect(image.equals(PNG)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(headers["chatgpt-account-id"]).toBe("acct-1");
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe("gpt-codex-b");
    expect(body.tools[0].type).toBe("image_generation");
  });

  it("falls back to an OpenAI API key, and reports a failed response", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const image = await generateAvatarImage("p", {}, deps({ openai: { apiKey: "sk" } }, fetchMock as unknown as typeof fetch));
    expect(image.equals(PNG)).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.openai.com/v1/images/generations");

    const failing = vi.fn(async () => new Response(sse({ type: "response.failed", response: { error: { message: "quota reached" } } })));
    await expect(generateAvatarImage("p", { provider: "openai-codex" }, deps({ "openai-codex": { apiKey: "t" } }, failing as unknown as typeof fetch)))
      .rejects.toThrow("ChatGPT returned no image: quota reached");
  });

  it("moves to an older ChatGPT model when the account may not use the newest", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { model } = JSON.parse(init!.body as string);
      return model === "gpt-codex-b"
        ? new Response('{"error":{"code":"model_not_found"}}', { status: 400 })
        : new Response(sse({ type: "response.output_item.done", item: { type: "image_generation_call", result: PNG.toString("base64") } }));
    });
    const image = await generateAvatarImage("p", {}, deps({ "openai-codex": { apiKey: "t" } }, fetchMock as unknown as typeof fetch));
    expect(image.equals(PNG)).toBe(true);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string).model)).toEqual(["gpt-codex-b", "gpt-codex-a"]);

    const denied = vi.fn(async () => new Response('{"error":{"code":"model_not_found"}}', { status: 400 }));
    await expect(generateAvatarImage("p", {}, deps({ "openai-codex": { apiKey: "t" } }, denied as unknown as typeof fetch)))
      .rejects.toThrow("None of the ChatGPT models can generate images for this account: gpt-codex-b, gpt-codex-a");
  });

  it("says how to connect a source when none has credentials", async () => {
    await expect(generateAvatarImage("p", {}, deps({}, vi.fn() as unknown as typeof fetch))).rejects.toBeInstanceOf(AvatarProviderUnavailableError);
  });

  it("reads the ChatGPT account id from a token, and tolerates junk", () => {
    expect(chatgptAccountId(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "x" } }))).toBe("x");
    expect(chatgptAccountId("not-a-jwt")).toBeUndefined();
  });
});

describe("agent avatar service", () => {
  it("saves avatar.png and points agent.yaml at it, keeping comments", async () => {
    const generateImage = vi.fn(async (_prompt: string) => PNG);
    const result = await generateAgentAvatar(agent, config({ style: "pixel" }), undefined, { generateImage });
    expect(result).toEqual({ style: "pixel", file: path.join(workspace, "avatar.png") });
    expect((await fs.readFile(result.file)).equals(PNG)).toBe(true);
    const yaml = await fs.readFile(path.join(workspace, "agent.yaml"), "utf8");
    expect(yaml).toContain("avatar: avatar.png");
    expect(yaml).toContain("# Keeps the self-hosted tools current.");
    expect(generateImage.mock.calls[0]![0]).toContain("16-bit pixel art");
  });

  it("checks the style before spending an image", async () => {
    const generateImage = vi.fn(async () => PNG);
    await expect(generateAgentAvatar(agent, config(), "nope", { generateImage })).rejects.toThrow("Unknown avatar style");
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe("avatar routes", () => {
  const routes = (overrides: { canManage?: boolean; generateImage?: () => Promise<Buffer> } = {}) => {
    const afterWrite = vi.fn(async () => undefined);
    const audit = vi.fn(async () => undefined);
    const app = createAvatarRoutes({
      getConfig: () => ({ agents: [agent], avatars: { style: "manga" } }) as unknown as GatewayConfig,
      getAgent: (id) => (id === "ops" ? agent : undefined),
      canManageAgent: async () => overrides.canManage ?? true,
      afterWrite,
      audit,
      service: { generateImage: overrides.generateImage ?? (async () => PNG) },
    });
    const post = (id: string, body: unknown = {}) => app.request(`/agents/${id}/avatar`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { app, post, afterWrite, audit };
  };

  it("lists styles with the configured default", async () => {
    const body = await (await routes().app.request("/avatars/styles")).json();
    expect(body.default).toBe("manga");
    expect(body.styles.map((style: { id: string }) => style.id)).toContain("3d");
  });

  it("generates, reloads and audits", async () => {
    const { post, afterWrite, audit } = routes();
    const response = await post("ops", { style: "flat" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.style).toBe("flat");
    expect(body.avatar).toMatch(/^\/api\/agents\/ops\/avatar\?v=\d+$/);
    expect(afterWrite).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(expect.anything(), "ops", undefined, "avatar.png (flat)");
  });

  it("refuses unknown agents, non-managers, bad styles and missing sources", async () => {
    expect((await routes().post("ghost")).status).toBe(404);
    expect((await routes({ canManage: false }).post("ops")).status).toBe(403);
    expect((await routes().post("ops", { style: 3 })).status).toBe(400);
    expect((await routes().post("ops", { style: "nope" })).status).toBe(400);
    const unavailable = routes({ generateImage: async () => { throw new AvatarProviderUnavailableError(); } });
    expect((await unavailable.post("ops")).status).toBe(409);
    const broken = routes({ generateImage: async () => { throw new Error("upstream down"); } });
    const failed = await broken.post("ops");
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe("upstream down");
  });
});

describe("yoplai agent avatar", () => {
  const run = async (args: string[], generateImage = vi.fn(async () => PNG)) => {
    const lines: string[] = [];
    const program = new Command();
    registerAvatarCommand(program.command("agent"), {
      loadConfig: () => ({ agents: [agent] }) as unknown as GatewayConfig,
      service: { generateImage },
      log: (line) => lines.push(line),
    });
    await program.parseAsync(["node", "yoplai", "agent", "avatar", ...args]);
    return { lines, generateImage };
  };

  it("lists styles, marking the default", async () => {
    const { lines } = await run(["--list-styles"]);
    expect(lines).toContain("3d (default): 3D animated");
  });

  it("generates for one agent or all of them", async () => {
    expect((await run(["ops", "--style", "manga"])).lines).toEqual([`ops: ${path.join(workspace, "avatar.png")} (manga)`]);
    expect((await run(["--all"])).generateImage).toHaveBeenCalledOnce();
  });

  it("rejects a missing target and an unknown style without generating", async () => {
    const missing = await run([]);
    expect(missing.lines).toEqual(["Give one agent id, or --all"]);
    expect(process.exitCode).toBe(1);
    const typo = await run(["ops", "--style", "nope"]);
    expect(typo.lines).toEqual(['Unknown avatar style "nope"']);
    expect(typo.generateImage).not.toHaveBeenCalled();
  });
});
