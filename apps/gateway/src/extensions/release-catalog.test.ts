import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchReleaseCatalog } from "./release-catalog-fetch.js";
import { fixtureRelease, packFixture } from "./release-bundle.fixture.js";
import { extractReleaseBundle } from "./release-bundle.js";

let root: string;
const source = "http://127.0.0.1:4400";
const fixture = fixtureRelease(source, "1.0.0");
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "release-catalog-")); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

describe("release catalog", () => {
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
