import { spawn, type ChildProcess } from "node:child_process";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileRemoteGatewayStore } from "./store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-store-"));
  file = path.join(dir, "remote-gateways.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("remote gateway store mutation version", () => {
  it("changes for a save and for a removal, and counts one name apart from another", () => {
    const store = createFileRemoteGatewayStore(file);
    const free = store.mutationVersion("ams");
    store.save(link);
    expect(store.mutationVersion("ams")).not.toBe(free);
    const saved = store.mutationVersion("ams");
    store.save({ ...link });
    expect(store.mutationVersion("ams")).toBe(saved);
    store.remove("ams");
    expect(store.mutationVersion("ams")).not.toBe(saved);
    expect(store.mutationVersion("east")).toBe(free);
  });

  it("refuses a save for a name that was linked and removed after the caller saw it free", () => {
    const store = createFileRemoteGatewayStore(file);
    const seen = store.mutationVersion("ams");
    expect(store.saveIfGeneration(link, null, seen)).toBe(true);
    expect(store.removeIfGeneration("ams", store.list()[0].generation)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.saveIfGeneration({ ...link, token: "fake-bearer-late" }, null, seen)).toBe(false);
    expect(store.list()).toEqual([]);
    expect(store.saveIfGeneration({ ...link, token: "fake-bearer-fresh" }, null, store.mutationVersion("ams"))).toBe(true);
  });
});

describe("remote gateway store mutation version in the file", () => {
  it("is shared by a second store object on the same file, also after a removal", () => {
    const first = createFileRemoteGatewayStore(file);
    const second = createFileRemoteGatewayStore(file);
    const seen = first.mutationVersion("ams");
    second.save(link);
    second.remove("ams");
    expect(first.mutationVersion("ams")).toBeGreaterThan(seen);
    expect(first.saveIfGeneration(link, null, seen)).toBe(false);
    expect(first.list()).toEqual([]);
  });

  it("keeps the file a plain array of links, with a count row only for a removed name", async () => {
    const store = createFileRemoteGatewayStore(file);
    store.save(link);
    store.save({ name: "east", url: "http://127.0.0.1:11" });
    store.remove("ams");
    const rows = JSON.parse(await fs.readFile(file, "utf8")) as Array<Record<string, unknown>>;
    expect(rows.filter((row) => row.name !== undefined).map((row) => row.name)).toEqual(["east"]);
    expect(rows.filter((row) => row.removedName !== undefined)).toEqual([{ removedName: "ams", mutations: 2 }]);
    expect(store.list().map((item) => item.name)).toEqual(["east"]);
    expect(store.list()[0]).not.toHaveProperty("mutations");
  });

  it("keeps the file mode 0600 and leaves no lock file after a removal", async () => {
    const store = createFileRemoteGatewayStore(file);
    store.save(link);
    store.remove("ams");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads an older array file with a version of zero, then keeps the count after the next write", async () => {
    await fs.writeFile(file, `${JSON.stringify([{ name: "ams", url: link.url, token: link.token }])}\n`);
    const store = createFileRemoteGatewayStore(file);
    expect(store.mutationVersion("ams")).toBe(0);
    expect(store.remove("ams")).toBe(true);
    expect(store.mutationVersion("ams")).toBe(1);
    expect(store.list()).toEqual([]);
    expect(createFileRemoteGatewayStore(file).mutationVersion("ams")).toBe(1);
  });

});

const lockFileOf = (storeFile: string) => `${storeFile}.lock`;
const storeModule = fileURLToPath(new URL("./store.ts", import.meta.url));
const packageDir = path.dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

type Holder = { child: ChildProcess; pid: number; sync: string; exited: Promise<number | null> };

/**
 * Starts a real Node process that saves one link and stops inside its write, while it holds the lock. It stops when
 * the file `go` appears in its sync directory.
 */
async function startPausedWriter(storeFile: string, syncDir: string): Promise<Holder> {
  await fs.mkdir(syncDir, { recursive: true });
  const script = `
    import fs from "node:fs";
    const { createFileRemoteGatewayStore } = await import(${JSON.stringify(storeModule)});
    const [file, sync] = process.argv.slice(1);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      fs.writeFileSync(sync + "/paused", "");
      while (!fs.existsSync(sync + "/go")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      return rename(from, to);
    };
    createFileRemoteGatewayStore(file).save({ name: "writer", url: "http://127.0.0.1:9" });
  `;
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-e", script, storeFile, syncDir], {
    cwd: packageDir,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  while (!nodeFs.existsSync(path.join(syncDir, "paused"))) await new Promise((resolve) => setTimeout(resolve, 20));
  return { child, pid: child.pid!, sync: syncDir, exited };
}

describe("remote gateway store lock", () => {
  it("fails with the lock file and the process ID when the owner process is dead, and changes nothing", async () => {
    const store = createFileRemoteGatewayStore(file, { lockWaitMs: 150 });
    store.save({ name: "victim", url: link.url });
    const storeBefore = await fs.readFile(file, "utf8");
    const holder = await startPausedWriter(file, path.join(dir, "sync"));
    holder.child.kill("SIGKILL");
    await holder.exited;
    const lockFile = lockFileOf(file);
    const lockBefore = await fs.readFile(lockFile, "utf8");
    expect(JSON.parse(lockBefore)).toMatchObject({ pid: holder.pid });
    const listing = (await fs.readdir(dir)).sort();

    for (const write of [() => store.save(link), () => store.remove("victim"), () => store.saveIfGeneration(link, null), () => store.removeIfGeneration("victim", undefined)]) {
      let message = "";
      try {
        write();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(`Process ${holder.pid} died`);
      expect(message).toContain(lockFile);
      expect(message).toContain("Delete that file");
    }
    expect(await fs.readFile(lockFile, "utf8")).toBe(lockBefore);
    expect(await fs.readFile(file, "utf8")).toBe(storeBefore);
    expect((await fs.readdir(dir)).sort()).toEqual(listing);

    // The user deletes the file by hand. Then writes work again.
    await fs.rm(lockFile);
    store.save(link);
    expect(store.list().map((item) => item.name).sort()).toEqual(["ams", "victim"]);
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("keeps the lock of a live owner that pauses, and fails with its process ID", async () => {
    const store = createFileRemoteGatewayStore(file, { lockWaitMs: 150 });
    store.save({ name: "victim", url: link.url });
    const storeBefore = await fs.readFile(file, "utf8");
    const holder = await startPausedWriter(file, path.join(dir, "sync"));
    const lockFile = lockFileOf(file);
    const lockBefore = await fs.readFile(lockFile, "utf8");
    expect(() => store.remove("victim")).toThrow(new RegExp(`Process ${holder.pid} holds the lock`));
    expect(() => store.save(link)).toThrow(/Cannot lock remote-gateways\.json/);
    expect(await fs.readFile(lockFile, "utf8")).toBe(lockBefore);
    expect(await fs.readFile(file, "utf8")).toBe(storeBefore);
    // The owner finishes its own write and deletes its own lock.
    await fs.writeFile(path.join(holder.sync, "go"), "");
    expect(await holder.exited).toBe(0);
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.list().map((item) => item.name).sort()).toEqual(["victim", "writer"]);
    expect(store.remove("victim")).toBe(true);
  }, 30_000);

  it("deletes its own lock after a write and after a failed change", async () => {
    const store = createFileRemoteGatewayStore(file);
    store.save(link);
    await expect(fs.stat(lockFileOf(file))).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.remove("missing")).toBe(false);
    await expect(fs.stat(lockFileOf(file))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(dir)).sort()).toEqual(["remote-gateways.json"]);
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
