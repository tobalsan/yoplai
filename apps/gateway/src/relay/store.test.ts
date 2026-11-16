import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileRemoteGatewayStore } from "./store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-store-"));
  file = path.join(dir, "remote-gateways.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const link = { name: "ams", url: "http://127.0.0.1:9", token: "fake-bearer-store" };

describe("remote gateway store link generation", () => {
  it("gives each new link a generation that is not the URL or the bearer", () => {
    const store = createFileRemoteGatewayStore(file);
    store.save(link);
    const [saved] = store.list();
    expect(saved).toMatchObject(link);
    expect(saved.generation).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.generation).not.toContain(link.token);
  });

  it("keeps the generation for an equal save and changes it for another URL or bearer", () => {
    const store = createFileRemoteGatewayStore(file);
    store.save(link);
    const first = store.list()[0].generation;
    store.save({ ...link });
    expect(store.list()[0].generation).toBe(first);
    store.save({ ...link, token: "fake-bearer-rotated" });
    const rotated = store.list()[0].generation;
    expect(rotated).not.toBe(first);
    store.save({ ...link, token: "fake-bearer-rotated", url: "http://127.0.0.1:10" });
    expect(store.list()[0].generation).not.toBe(rotated);
  });

  it("changes the generation when a link is removed and created again with equal values", () => {
    const store = createFileRemoteGatewayStore(file);
    store.save(link);
    const first = store.list()[0].generation;
    expect(store.remove("ams")).toBe(true);
    store.save({ ...link });
    expect(store.list()[0].generation).not.toBe(first);
  });

  it("does not let a caller choose the generation", () => {
    const store = createFileRemoteGatewayStore(file);
    store.save({ ...link, generation: "chosen-by-caller" });
    expect(store.list()[0].generation).not.toBe("chosen-by-caller");
  });

  it("reads an older file with no generation and gives it one on the next save", async () => {
    await fs.writeFile(file, `${JSON.stringify([{ name: "ams", url: link.url, token: link.token }, { name: "east", url: "http://127.0.0.1:11" }])}\n`);
    const store = createFileRemoteGatewayStore(file);
    expect(store.list()).toEqual([{ name: "ams", url: link.url, token: link.token }, { name: "east", url: "http://127.0.0.1:11" }]);
    store.save({ ...link });
    const saved = store.list();
    expect(saved.find((item) => item.name === "ams")?.generation).toBeTruthy();
    expect(saved.find((item) => item.name === "east")).toEqual({ name: "east", url: "http://127.0.0.1:11" });
  });

  it("keeps the file mode 0600", async () => {
    createFileRemoteGatewayStore(file).save(link);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("remote gateway store generation checks", () => {
  it("saves a new link only when no link of that name exists", () => {
    const store = createFileRemoteGatewayStore(file);
    expect(store.saveIfGeneration(link, null)).toBe(true);
    expect(store.saveIfGeneration({ ...link, token: "fake-bearer-second" }, null)).toBe(false);
    expect(store.list()[0].token).toBe(link.token);
  });

  it("replaces a link only while its generation is the one the caller saw", () => {
    const store = createFileRemoteGatewayStore(file);
    store.save(link);
    const seen = store.list()[0].generation!;
    expect(store.saveIfGeneration({ ...link, token: "fake-bearer-next" }, seen)).toBe(true);
    const next = store.list()[0].generation;
    expect(next).not.toBe(seen);
    // A second writer still holds the old generation, so its write loses.
    expect(store.saveIfGeneration({ ...link, token: "fake-bearer-late" }, seen)).toBe(false);
    expect(store.list()[0]).toMatchObject({ token: "fake-bearer-next", generation: next });
  });

  it("removes a link only while its generation matches", () => {
    const store = createFileRemoteGatewayStore(file);
    store.save(link);
    const seen = store.list()[0].generation;
    expect(store.removeIfGeneration("ams", "another-generation")).toBe(false);
    expect(store.list()).toHaveLength(1);
    expect(store.removeIfGeneration("ams", seen)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.removeIfGeneration("ams", seen)).toBe(false);
  });

  it("keeps the managed facts of a link in the 0600 file", async () => {
    const store = createFileRemoteGatewayStore(file);
    const managed = {
      linkId: "link-1",
      account: { email: "user@example.test", name: null },
      deviceLabel: "Laptop",
      expiresAt: "2026-04-02T00:00:00.000Z",
      linkedAt: "2026-01-02T00:00:00.000Z",
    };
    expect(store.saveIfGeneration({ ...link, managed }, null)).toBe(true);
    expect(store.list()[0].managed).toEqual(managed);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
