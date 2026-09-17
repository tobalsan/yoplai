import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeMcpServerConfig } from "./mcp-config.js";

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.map((dir) =>
      import("node:fs/promises").then(({ rm }) =>
        rm(dir, { recursive: true, force: true })
      )
    )
  );
  dirs = [];
});

describe("mergeMcpServerConfig", () => {
  it("preserves existing servers while attaching the selected server", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "yoplai-mcp-"));
    dirs.push(dir);
    await writeFile(
      path.join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { keep: { command: "keep" } } })
    );

    await mergeMcpServerConfig(dir, "sheets", {
      url: "https://sheets.example",
    });

    expect(
      JSON.parse(await readFile(path.join(dir, "mcp.json"), "utf8"))
    ).toEqual({
      mcpServers: {
        keep: { command: "keep" },
        sheets: { url: "https://sheets.example" },
      },
    });
  });
});
