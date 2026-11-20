import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

export function packFixture(files: Record<string, string>, types: Record<string, string> = {}): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const data = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("07033241600\0", 136);
    header.fill(32, 148, 156);
    header.write(types[name] ?? "0", 156);
    header.write("ustar\x0000", 257);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

export function fixtureRelease(base: string, version: string, options: { id?: string; dependencies?: string[]; failStart?: boolean; failSecondStart?: boolean; readOnStop?: boolean; reportPagePrefix?: boolean; failConfig?: boolean; failStop?: boolean; failReload?: boolean; failRoutesOnMarker?: boolean; writeOnStart?: boolean; oauthTokenUrl?: string; providerId?: string } = {}) {
  const id = options.id ?? "sample";
  const metadata = { id, name: "Sample Extension", description: "A local fixture.", tagline: "Read a sample", category: "developer", version, minYoplai: "0.11.0" };
  const bundle = packFixture({
    "manifest.json": JSON.stringify({ ...metadata, entry: "index.js", icon: null }),
    "LICENSE": version,
    "index.js": `
      import assert from "node:assert/strict";
      import { existsSync, readFileSync } from "node:fs";
      let starts = 0;
      let pagePrefix;
      export default {
        id: ${JSON.stringify(id)}, displayName: "Sample Extension", description: "A local fixture.", dependencies: ${JSON.stringify(options.dependencies ?? [])},
        routePrefixes: ["/api/sample"],
        configSchema: { parse: (value) => value, safeParse: (value) => ({ success: true, data: value }) },
        validateConfig: () => ({ valid: ${!options.failConfig}, errors: ${JSON.stringify(options.failConfig ? ["Config rejected."] : [])} }),
        registerRoutes: (api) => {
          ${options.failRoutesOnMarker ? 'if (existsSync(new URL(".fail-routes", import.meta.url))) throw new Error("Route registration failed.");' : ""}
          api.get("/" + ${JSON.stringify(id)}, (c) => c.text(${JSON.stringify(version)}));
          if (${JSON.stringify(id)} === "mcp") {
            api.get("/mcp/servers", (c) => c.json({ version: ${JSON.stringify(version)}, requester: c.env.multiUserAuthContext?.user.id }));
          }
        },
        registerPageRoutes: (api) => api.get("/info", (c) => c.text(${options.reportPagePrefix ? 'pagePrefix ?? "missing prefix"' : JSON.stringify(version)})),
        getAgentTools: () => [{ name: ${JSON.stringify(id + "_version")}, description: "Get the fixture version.", parameters: {}, execute: () => ${JSON.stringify(version)} }],
        ${options.oauthTokenUrl ? `oauthProviders: [{ id: ${JSON.stringify(options.providerId ?? "sampleProvider")}, displayName: "Sample", authorizeUrl: "https://example.test/authorize", tokenUrl: ${JSON.stringify(options.oauthTokenUrl)}, defaultScopes: [] }],` : ""}
        ${options.failReload ? 'onConfigReload: async () => { throw new Error("Reload rejected."); },' : ""}
        capabilities: () => [],
        start: async (ctx) => {
          pagePrefix = ctx.pageRoutePrefix;
          const sibling = readFileSync(new URL("LICENSE", import.meta.url), "utf8");
          console.log(${JSON.stringify(id + " start")}, ${JSON.stringify(version)}, sibling);
          ${options.writeOnStart ? 'await assert.rejects(ctx.updateAgentExtensionConfig("fixture", "sample", { enabled: false }), /Cannot change config during an extension operation/);' : ""}
          ${options.failSecondStart ? 'if (++starts === 2) throw new Error("Restart rejected.");' : ""}
          ${options.failStart ? 'throw new Error("Start rejected.");' : ""}
        },
        stop: async () => {
          ${options.readOnStop ? `assert.equal(readFileSync(new URL("LICENSE", import.meta.url), "utf8"), ${JSON.stringify(version)});` : ""}
          console.log(${JSON.stringify(id + " stop")}, ${JSON.stringify(version)});
          ${options.failStop ? 'throw new Error("Stop rejected.");' : ""}
        },
      };
    `,
  });
  const entry = { ...metadata, url: `${base}/${id}.tgz`, size: bundle.length, sha256: createHash("sha256").update(bundle).digest("hex") };
  const catalog = { schemaVersion: 1, generatedAt: "2026-11-20T00:00:00Z", commit: "fixture", release: `v${version}`, extensions: [entry] };
  return { bundle, catalog, entry };
}
