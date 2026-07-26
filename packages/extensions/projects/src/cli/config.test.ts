import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "./config.js";

describe("cli config", () => {
  let prevHome: string | undefined;
  let prevHomeDir: string | undefined;
  let prevApiUrl: string | undefined;
  let prevUrl: string | undefined;
  let prevToken: string | undefined;
  let tmpHome = "";

  beforeEach(async () => {
    prevHome = process.env.HOME;
    prevHomeDir = process.env.YOPLAI_HOME;
    prevApiUrl = process.env.YOPLAI_API_URL;
    prevUrl = process.env.YOPLAI_URL;
    prevToken = process.env.YOPLAI_TOKEN;

    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-cli-test-"));
    process.env.HOME = tmpHome;
    process.env.YOPLAI_HOME = path.join(tmpHome, ".yoplai");
    delete process.env.YOPLAI_API_URL;
    delete process.env.YOPLAI_URL;
    delete process.env.YOPLAI_TOKEN;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    if (prevApiUrl === undefined) delete process.env.YOPLAI_API_URL;
    else process.env.YOPLAI_API_URL = prevApiUrl;
    if (prevUrl === undefined) delete process.env.YOPLAI_URL;
    else process.env.YOPLAI_URL = prevUrl;
    if (prevToken === undefined) delete process.env.YOPLAI_TOKEN;
    else process.env.YOPLAI_TOKEN = prevToken;

    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("uses YOPLAI_API_URL over YOPLAI_URL and config file", async () => {
    await fs.mkdir(process.env.YOPLAI_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.YOPLAI_HOME!, "yoplai.json"),
      JSON.stringify({ apiUrl: "http://file-url", token: "file-token" })
    );

    process.env.YOPLAI_URL = "http://env-url";
    process.env.YOPLAI_API_URL = "http://api-url";
    process.env.YOPLAI_TOKEN = "env-token";

    expect(resolveConfig()).toEqual({
      apiUrl: "http://api-url",
      token: "env-token",
    });
  });

  it("uses config file when env is missing", async () => {
    await fs.mkdir(process.env.YOPLAI_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.YOPLAI_HOME!, "yoplai.json"),
      JSON.stringify({ apiUrl: "http://from-file", token: "file-token" })
    );

    expect(resolveConfig()).toEqual({
      apiUrl: "http://from-file",
      token: "file-token",
    });
  });

  it("uses YOPLAI_URL when YOPLAI_API_URL is not set", () => {
    process.env.YOPLAI_URL = "http://legacy-url";
    expect(resolveConfig()).toEqual({ apiUrl: "http://legacy-url" });
  });

  it("throws when no API URL is configured", () => {
    expect(() => resolveConfig()).toThrow(/Missing Yoplai API URL/);
  });

  it("falls back to legacy aihub.json when yoplai.json is absent", async () => {
    await fs.mkdir(process.env.YOPLAI_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.YOPLAI_HOME!, "aihub.json"),
      JSON.stringify({ apiUrl: "http://legacy-file-url", token: "legacy-file-token" })
    );

    expect(resolveConfig()).toEqual({
      apiUrl: "http://legacy-file-url",
      token: "legacy-file-token",
    });
  });
});
