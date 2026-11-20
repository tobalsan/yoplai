import fs from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { stubDesktopTestEnv } from "../test-utils/desktop-test-env.js";
import { writeTestV3Config } from "../test-utils/v3-config.js";

it("closes setup, links and external chat credentials on a live multi-user reload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-mode-"));
  const home = path.join(root, "yoplai");
  stubDesktopTestEnv(root, home);
  const readExternal = vi.fn(async () => ({ type: "oauth" as const, key: "synthetic-key", source: "test" }));
  vi.doMock("../desktop/external-sources.js", async (load) => ({
    ...await load<typeof import("../desktop/external-sources.js")>(),
    getExternalSources: () => ({ resolve: readExternal }),
  }));
  const closers: (() => void | Promise<void>)[] = [];
  try {
    const extraConfig = { apps: { port: 0 } };
    await writeTestV3Config(home, { extraConfig });
    const config = await import("../config/index.js");
    const registry = await import("../extensions/registry.js");
    const { createExtensionContext, bindExtensionContext } = await import("../extensions/context.js");
    const { buildInnerApi } = await import("./api.core.js");
    const initialConfig = config.loadConfig();
    const extensions = await registry.loadExtensions(initialConfig);
    const context = createExtensionContext(initialConfig);
    for (const extension of extensions) await extension.start(bindExtensionContext(context, extension.id));
    closers.push(registry.stopCurrentExtensions);
    registry.setExtensionActivator(async (extension) => { await extension.start(bindExtensionContext(context, extension.id)); }, buildInnerApi, buildInnerApi(extensions));
    const signals = ["SIGTERM", "SIGINT"] as const;
    const previous = signals.map((signal) => process.listeners(signal));
    const { startServer } = await import("./index.js");
    const server = startServer(0, "127.0.0.1");
    closers.push(async () => {
      signals.forEach((signal, index) => {
        for (const listener of process.listeners(signal)) {
          if (!previous[index].includes(listener)) process.off(signal, listener);
        }
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    if (!server.listening) await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = (route: string) => fetch(`${url}${route}`, { headers: { connection: "close" } });
    const setup = () => get("/api/desktop-setup");
    const link = () => get("/api/relay/link/callback");
    const { createModelAuth } = await import("../desktop/model-auth.js");
    const opts = { primaryProvider: "openai-codex", mode: "oauth" as const };
    const { runtime, requireModelAuth } = await createModelAuth(opts);
    const model = runtime.getModels(opts.primaryProvider)[0];
    expect((await setup()).status).toBe(200);
    expect((await link()).status).toBe(200);
    await requireModelAuth(model);
    expect((await runtime.getAuth(model))?.auth.apiKey).toBe("synthetic-key");
    expect(await runtime.checkAuth(opts.primaryProvider)).toMatchObject({ type: "oauth", source: "test" });

    await writeTestV3Config(home, {
      extraConfig,
      extensions: { multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "x".repeat(32) } },
    });
    const nextConfig = config.reloadConfig();
    config.setLoadedConfig(nextConfig);
    await registry.reloadExtensions(nextConfig);
    readExternal.mockClear();

    const [setupStatus, linkStatus, oldAuth, oldCheck, newAuth] = await Promise.all([
      setup().then((response) => response.status),
      link().then((response) => response.status),
      runtime.getAuth(model),
      runtime.checkAuth(opts.primaryProvider),
      createModelAuth(opts).then(({ runtime }) => runtime.getAuth(model)),
    ]);
    expect({ setupStatus, linkStatus, oldAuth: !!oldAuth, oldCheck: !!oldCheck, newAuth: !!newAuth, reads: readExternal.mock.calls.length })
      .toEqual({ setupStatus: 403, linkStatus: 403, oldAuth: false, oldCheck: false, newAuth: false, reads: 0 });
  } finally {
    for (const close of closers.reverse()) await close();
    vi.doUnmock("../desktop/external-sources.js");
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
