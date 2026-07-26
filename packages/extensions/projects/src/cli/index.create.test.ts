import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCreateProjectBody, resolveCreateArea } from "./index.js";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("resolveCreateArea", () => {
  it("returns a valid area id", async () => {
    const client = {
      listAreas: async () => [{ id: "yoplai", title: "Yoplai" }],
    };

    await expect(resolveCreateArea(client, "yoplai")).resolves.toBe("yoplai");
  });

  it("throws with valid ids when the area is unknown", async () => {
    const client = {
      listAreas: async () => [
        { id: "yoplai", title: "Yoplai" },
        { id: "ops", title: "Ops" },
      ],
    };

    await expect(resolveCreateArea(client, "bad-area")).rejects.toThrow(
      'Error: Invalid area "bad-area". Valid areas: yoplai, ops'
    );
  });
});

describe("buildCreateProjectBody", () => {
  const client = {
    listAreas: async () => [],
  };

  it("maps positional pitch to pitch", async () => {
    await expect(
      buildCreateProjectBody("Pitch body", { title: "Test Project" }, client)
    ).resolves.toEqual({ title: "Test Project", pitch: "Pitch body" });
  });

  it("maps --pitch inline content", async () => {
    await expect(
      buildCreateProjectBody(
        undefined,
        { title: "Test Project", pitch: "Inline pitch" },
        client
      )
    ).resolves.toEqual({ title: "Test Project", pitch: "Inline pitch" });
  });

  it("maps --pitch @file content", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-pitch-"));
    const pitchPath = path.join(tmpDir, "PITCH.md");
    await fs.writeFile(pitchPath, "File pitch\n", "utf8");

    await expect(
      buildCreateProjectBody(
        undefined,
        { title: "Test Project", pitch: `@${pitchPath}` },
        client
      )
    ).resolves.toEqual({ title: "Test Project", pitch: "File pitch\n" });
  });

  it("maps --pitch - content from stdin", async () => {
    await expect(
      buildCreateProjectBody(
        undefined,
        { title: "Test Project", pitch: "-" },
        client,
        async () => "stdin pitch\n"
      )
    ).resolves.toEqual({ title: "Test Project", pitch: "stdin pitch\n" });
  });

  it("copies area repo when creating a project for an area with repo", async () => {
    const areaClient = {
      listAreas: async () => [
        {
          id: "yoplai",
          title: "Yoplai",
          color: "#3b8ecc",
          repo: "/tmp/yoplai",
        },
      ],
    };

    await expect(
      buildCreateProjectBody(
        undefined,
        { title: "Test Project", area: "yoplai" },
        areaClient
      )
    ).resolves.toEqual({
      title: "Test Project",
      area: "yoplai",
      repo: "/tmp/yoplai",
    });
  });

  it("keeps explicit repo when area also has repo", async () => {
    const areaClient = {
      listAreas: async () => [
        {
          id: "yoplai",
          title: "Yoplai",
          color: "#3b8ecc",
          repo: "/tmp/yoplai",
        },
      ],
    };

    await expect(
      buildCreateProjectBody(
        undefined,
        { title: "Test Project", area: "yoplai", repo: "/tmp/override" },
        areaClient
      )
    ).resolves.toEqual({
      title: "Test Project",
      area: "yoplai",
      repo: "/tmp/override",
    });
  });

  it("rejects positional and --pitch together", async () => {
    await expect(
      buildCreateProjectBody(
        "Pitch body",
        { title: "Test Project", pitch: "Other pitch" },
        client
      )
    ).rejects.toThrow("Use either positional <pitch> or --pitch, not both.");
  });

  it("rejects removed --specs with migration hint", async () => {
    await expect(
      buildCreateProjectBody(
        undefined,
        { title: "Test Project", specs: "Old specs" },
        client
      )
    ).rejects.toThrow(
      "Project-level --specs was removed. Use --pitch for project prose or `yoplai slices add --specs` for slice specs."
    );
  });
});
