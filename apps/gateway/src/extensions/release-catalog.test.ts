import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayConfigSchema } from "@yoplai/shared";
import { listReleaseCatalog } from "./release-catalog.js";
import { fetchReleaseCatalog } from "./release-catalog-fetch.js";
import { fixtureRelease, packFixture } from "./release-bundle.fixture.js";
import { extractReleaseBundle } from "./release-bundle.js";

let root: string;
const source = "http://127.0.0.1:4400";
const fixture = fixtureRelease(source, "1.0.0");
const listConfig = () => GatewayConfigSchema.parse({
  version: 3, agents: [], extensionsPath: root, extensionCatalog: { url: source },
});
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "release-catalog-")); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

describe("release catalog", () => {
  it("inlines SVG bytes even when the asset is served as application/octet-stream", async () => {
    const iconUrl = "https://assets.example.test/v1/sample.svg";
    const svg = '<?xml version="1.0"?><?icon fixture?><!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>';
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({
        ...fixture.catalog, extensions: [{ ...fixture.entry, iconUrl }],
      }))
      .mockResolvedValueOnce(new Response(svg, { headers: { "content-type": "application/octet-stream" } })));

    expect((await listReleaseCatalog(listConfig())).entries).toMatchObject([{
      id: "sample", iconUrl,
      iconDataUri: "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIj8+PD9pY29uIGZpeHR1cmU/PjwhRE9DVFlQRSBzdmc+PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxwYXRoIGQ9Ik0wIDBoMXYxSDB6Ii8+PC9zdmc+",
    }]);
  });

  it("inlines PNG bytes regardless of the asset name or media type", async () => {
    const iconUrl = "https://assets.example.test/v1/png-icon.svg";
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12NgYPj/HwADAgH/HXJk1AAAAABJRU5ErkJggg==";
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({
        ...fixture.catalog, extensions: [{ ...fixture.entry, iconUrl }],
      }))
      .mockResolvedValueOnce(new Response(Uint8Array.from(Buffer.from(pixel, "base64")), {
        headers: { "content-type": "image/svg+xml" },
      })));

    expect((await listReleaseCatalog(listConfig())).entries[0]?.iconDataUri).toBe(`data:image/png;base64,${pixel}`);
  });

  it("reuses a successfully fetched icon for shared rows, later lists, and refresh", async () => {
    const iconUrl = "https://assets.example.test/v2/shared.svg";
    const config = listConfig();
    const fetch = vi.fn<typeof globalThis.fetch>(async (target) => {
      if (String(target) === iconUrl) return new Response("<svg/>");
      return Response.json({ ...fixture.catalog, extensions: [
        { ...fixture.entry, iconUrl }, { ...fixture.entry, id: "other", iconUrl },
      ] });
    });
    vi.stubGlobal("fetch", fetch);

    for (const refresh of [false, false, true]) {
      expect((await listReleaseCatalog(config, refresh)).entries).toMatchObject([
        { id: "sample", iconDataUri: "data:image/svg+xml;base64,PHN2Zy8+" },
        { id: "other", iconDataUri: "data:image/svg+xml;base64,PHN2Zy8+" },
      ]);
    }
    expect(fetch.mock.calls.map(([target]) => String(target))).toEqual([`${source}/`, iconUrl, `${source}/`]);
  });

  it.each([
    { name: "404", response: () => new Response("Missing", { status: 404 }) },
    { name: "oversize SVG", response: () => new Response(`<svg>${" ".repeat(256 * 1024)}</svg>`) },
    { name: "non-image bytes", response: () => new Response("<html><svg/></html>", {
      headers: { "content-type": "image/svg+xml" },
    }) },
  ])("keeps the row and the rest of the list when an icon returns $name", async ({ response }) => {
    const iconUrl = "https://assets.example.test/v1/bad.svg";
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({
        ...fixture.catalog, extensions: [fixture.entry, { ...fixture.entry, id: "bad", iconUrl }],
      }))
      .mockResolvedValueOnce(response()));

    const result = await listReleaseCatalog(listConfig());
    expect(result).toMatchObject({ stale: false, entries: [{ id: "sample" }, { id: "bad", iconUrl }] });
    expect(result.entries[1]).not.toHaveProperty("iconDataUri");
  });

  it("keeps a row with a loopback HTTP icon without requesting that icon", async () => {
    const iconUrl = `${source}/icon.svg`;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({
      ...fixture.catalog, extensions: [{ ...fixture.entry, iconUrl }],
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await listReleaseCatalog(listConfig());
    expect(result.entries).toMatchObject([{ id: "sample", iconUrl }]);
    expect(result.entries[0]).not.toHaveProperty("iconDataUri");
    expect(fetch.mock.calls.map(([target]) => String(target))).toEqual([`${source}/`]);
  });

  it("uses the ETag and returns the last copy when offline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(fixture.catalog, { headers: { etag: '"first"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockRejectedValueOnce(new Error("Offline."));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchReleaseCatalog(root, source)).toMatchObject({ stale: false, catalog: fixture.catalog });
    expect(await fetchReleaseCatalog(root, source, true)).toMatchObject({ stale: false, catalog: fixture.catalog });
    expect(fetch.mock.calls[1][1]?.headers).toEqual({ "If-None-Match": '"first"' });
    expect(await fetchReleaseCatalog(root, source, true)).toMatchObject({ stale: true, catalog: fixture.catalog });
    expect(JSON.parse(await fs.readFile(path.join(root, ".cache/catalog.json"), "utf8"))).toMatchObject({ source, etag: '"first"' });
  });

  it("rejects plain HTTP outside loopback and reports no copy", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await fetchReleaseCatalog(root, "http://example.com/")).toMatchObject({ stale: true, fetchedAt: null, error: "Catalog not reachable." });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops invalid entries and both members of an ID collision", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...fixture.catalog, extensions: [fixture.entry,
      { ...fixture.entry, id: "SAMPLE" }, { ...fixture.entry, id: "bad", size: 50_000_001 },
      { ...fixture.entry, id: "ok" }, { ...fixture.entry, id: "unsafe", iconUrl: "http://example.com/icon.svg" },
    ] })));
    expect((await fetchReleaseCatalog(root, source)).catalog?.extensions.map((entry) => entry.id)).toEqual(["ok"]);
  });

  it("extracts the regular files of a fixture", async () => {
    await extractReleaseBundle(fixture.bundle, root);
    expect(await fs.readFile(path.join(root, "LICENSE"), "utf8")).toBe("1.0.0");
  });

  it.each(["extra.txt", "nested/file.txt"])("rejects an archive with %s", async (name) => {
    await expect(extractReleaseBundle(packFixture({ [name]: "extra" }), root)).rejects.toThrow("not allowed");
    expect(await fs.readdir(root)).toEqual([]);
  });
});
