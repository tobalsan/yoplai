import fs from "node:fs";
import fsPromises from "node:fs/promises";
import * as metadata from "../../media/metadata.js";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContainerFileOutputAdapter,
  isFileOutputRejectedError,
  resolveContainerDataFile,
} from "./file-output.js";
import type { SdkRunParams } from "../types.js";
import { ChatProjectStore } from "../../chat-projects/store.js";
import { appendSessionMeta } from "../../history/store.js";

vi.mock("../../config/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../config/index.js")>(),
  get CONFIG_DIR() { return process.env.YOPLAI_HOME ?? "/tmp/file-output-import-only"; },
}));

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-file-output-"));
  tempDirs.push(dir);
  return dir;
}

async function projectFile(filename = "notes.txt", content = Buffer.from("Shared findings")) {
  const root = tempDir();
  process.env.YOPLAI_HOME = root;
  const store = new ChatProjectStore(root, "writer");
  const project = await store.create("Example research");
  const data = path.join(root, "data");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, filename), content);
  const params = {
    agentId: "author", sessionId: project.id, userId: "writer",
    context: { kind: "web", project: { id: project.id, instructions: "" } },
    onHistoryEvent: vi.fn(), onEvent: vi.fn(),
  } as unknown as SdkRunParams;
  await appendSessionMeta(params.agentId, params.sessionId, "project", project.id, params.userId);
  const send = () => new ContainerFileOutputAdapter().handle(params, {
    type: "file_output", path: `/workspace/data/${filename}`,
  }, data);
  return { root, store, project, data, params, send };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.YOPLAI_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("container file output adapter", () => {
  it.each([
    ["oversized.txt", Buffer.alloc(25 * 1024 * 1024 + 1), "File exceeds the 25MB upload limit"],
    ["program.exe", Buffer.from("Unsupported sample"), "Unsupported file extension: .exe"],
  ])("delivers %s to chat while refusing it in the project", async (filename, content, reason) => {
    const run = await projectFile(filename, content);

    const result = await run.send();

    expect(result.project).toEqual({ status: "not_added", reason });
    expect(await run.store.listFiles(run.project.id)).toEqual([]);
    expect(run.params.onHistoryEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_file", size: content.length }));
    expect(run.params.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "file_output", size: content.length }));
    expect((await fsPromises.stat(result.path)).size).toBe(content.length);
  });

  it.each(["changed", "deleted", "store failure"])("keeps delivery successful after project %s", async (failure) => {
    const run = await projectFile();
    if (failure === "changed") await appendSessionMeta(run.params.agentId, run.params.sessionId, "project", null, "writer");
    if (failure === "deleted") await run.store.delete(run.project.id);
    if (failure === "store failure") fs.writeFileSync(path.join(run.store.filesDirectory(run.project.id), "..", "files.json"), "invalid json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await run.send();

    expect(result.project).toMatchObject({ status: "not_added", reason: expect.any(String) });
    if (failure !== "store failure") expect(result.project?.reason).toBe(failure === "changed" ? "project changed" : "project not found");
    expect(run.params.onHistoryEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_file" }));
    expect(run.params.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "file_output" }));
    expect(await fsPromises.readFile(result.path, "utf8")).toBe("Shared findings");
    expect(warn).toHaveBeenCalled();
    run.params.context = undefined;
    expect((await run.send()).project).toBeUndefined();
    expect(run.params.onEvent).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct versions and deduplicates a re-sent suffixed file", async () => {
    const run = await projectFile();
    expect((await run.send()).project).toEqual({ status: "added", name: "notes.txt" });
    fs.writeFileSync(path.join(run.data, "notes.txt"), "Updated findings");
    expect((await run.send()).project).toEqual({ status: "added", name: "notes (2).txt" });
    expect((await run.send()).project).toEqual({ status: "already_in_project", name: "notes (2).txt" });
    const files = await run.store.listFiles(run.project.id);
    expect(files.map(file => file.name)).toEqual(["notes.txt", "notes (2).txt"]);
    expect(await fsPromises.readFile(path.join(run.store.filesDirectory(run.project.id), files[0].id), "utf8")).toBe("Shared findings");
    expect(await fsPromises.readFile(path.join(run.store.filesDirectory(run.project.id), files[1].id), "utf8")).toBe("Updated findings");
  });

  it.each([
    ["broken.docx", Buffer.from("Invalid office document"), "Text extraction failed"],
    ["encrypted.pdf", fs.readFileSync(new URL("../../media/__fixtures__/encrypted.pdf", import.meta.url)), "PDF is password-protected"],
  ])("stores %s despite extraction failure and reports the reason", async (filename, content, extractionError) => {
    const run = await projectFile(filename, content);
    const result = await run.send();
    expect(result.project).toEqual({ status: "added", name: filename, extractionError });
    const files = await run.store.listFiles(run.project.id);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: filename, extractionError });
    expect(await fsPromises.readFile(path.join(run.store.filesDirectory(run.project.id), files[0].id))).toEqual(content);
    expect(run.params.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "file_output" }));
  });

  it("accepts the 25MB boundary and caps extracted text like an upload", async () => {
    const run = await projectFile("large.txt", Buffer.alloc(25 * 1024 * 1024, "x"));
    expect((await run.send()).project).toEqual({ status: "added", name: "large.txt" });
    const files = await run.store.listFiles(run.project.id);
    expect(files[0].text).toBe("x".repeat(250_000));
  });

  it("delivers before adding the received bytes and extracted text to the user's project", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = root;
    const store = new ChatProjectStore(root, "writer");
    const project = await store.create("Example research");
    const data = path.join(root, "data");
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, "notes.txt"), "Shared findings");
    let filesAtDelivery: ReturnType<ChatProjectStore["listFiles"]> | undefined;
    const params = {
      agentId: "author", sessionId: project.id, userId: "writer",
      context: { kind: "web", project: { id: project.id, instructions: "" } },
      onHistoryEvent: vi.fn(),
      onEvent: vi.fn(() => {
        filesAtDelivery = store.listFiles(project.id);
        fs.writeFileSync(path.join(data, "notes.txt"), "Changed after delivery");
      }),
    } as unknown as SdkRunParams;
    await appendSessionMeta(params.agentId, params.sessionId, "project", project.id, params.userId);

    const result = await new ContainerFileOutputAdapter().handle(params, {
      type: "file_output", path: "/workspace/data/notes.txt", mimeType: "application/octet-stream",
    }, data);

    expect(result).toMatchObject({ project: { status: "added", name: "notes.txt" } });
    expect(await filesAtDelivery).toEqual([]);
    const files = await store.listFiles(project.id);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "notes.txt", mimeType: "text/plain", text: "Shared findings" });
    expect(await fsPromises.readFile(path.join(store.filesDirectory(project.id), files[0].id), "utf8")).toBe("Shared findings");
    expect(params.onHistoryEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_file" }));
    expect(params.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "file_output" }));
    expect(await new ChatProjectStore(root, "other").list()).toEqual([]);
  });

  it("resolves only files under the container data directory", () => {
    expect(
      resolveContainerDataFile("/host/data", "/workspace/data/a/b.txt")
    ).toBe(path.join("/host/data", "a", "b.txt"));
    expect(() =>
      resolveContainerDataFile("/host/data", "/workspace/other/b.txt")
    ).toThrow("file_output path must be under /workspace/data");
  });

  it.each(["report.csv", "sub/dir/report.csv"])(
    "registers legacy outbound media %s and emits history plus stream events",
    async (source) => {
      const root = tempDir();
      process.env.YOPLAI_HOME = root;
      const hostDataDir = path.join(root, "agents", "cloud", "data");
      fs.mkdirSync(hostDataDir, { recursive: true });
      fs.mkdirSync(path.dirname(path.join(hostDataDir, source)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(hostDataDir, source), "a,b\n");
      const params = {
        agentId: "cloud",
        sessionId: "session-1",
        onHistoryEvent: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as SdkRunParams;

      const result = await new ContainerFileOutputAdapter().handle(
        params,
        {
          type: "file_output",
          path: `/workspace/data/${source}`,
          filename: "report.csv",
          mimeType: "text/csv",
        },
        hostDataDir
      );

      expect(result.project).toBeUndefined();
      expect(await new ChatProjectStore(root).list()).toEqual([]);

      expect(params.onHistoryEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "assistant_file",
          filename: "report.csv",
          mimeType: "text/csv",
          size: 4,
        })
      );
      expect(params.onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "file_output",
          filename: "report.csv",
          mimeType: "text/csv",
          size: 4,
        })
      );
    }
  );

  it.each([
    ["diagram.png", undefined, "image/png"],
    ["portrait.jpg", undefined, "image/jpeg"],
    ["portrait.jpeg", undefined, "image/jpeg"],
    ["animation.gif", undefined, "image/gif"],
    ["preview.webp", undefined, "image/webp"],
    ["vector.svg", undefined, "image/svg+xml"],
    ["report.pdf", undefined, "application/pdf"],
    ["table.csv", undefined, "text/csv"],
    ["diagram.PNG", undefined, "image/png"],
    ["archive.unknown", undefined, "application/octet-stream"],
    ["download", undefined, "application/octet-stream"],
    ["diagram.png", "application/custom", "application/custom"],
    ["diagram.png", "", "image/png"],
  ])(
    "uses %s and optional MIME %s for outbound history and live media",
    async (filename, mimeType, expectedMimeType) => {
      const root = tempDir();
      process.env.YOPLAI_HOME = root;
      const data = path.join(root, "files");
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, "output"), "fixture");
      const params = {
        agentId: "illustrator",
        sessionId: "image-session",
        onHistoryEvent: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as SdkRunParams;

      await new ContainerFileOutputAdapter().handle(
        params,
        {
          type: "file_output",
          path: "/conversation/files/output",
          filename,
          mimeType,
        },
        undefined,
        undefined,
        { hostPath: data, runtimePath: "/conversation/files" }
      );

      expect(params.onHistoryEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "assistant_file",
          filename,
          mimeType: expectedMimeType,
        })
      );
      expect(params.onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "file_output",
          filename,
          mimeType: expectedMimeType,
        })
      );
    }
  );

  it.each(["sub/dir/report.csv", "sub/dir/../dir/report.csv"])(
    "sends nested conversation file %s with its basename and original bytes",
    async (source) => {
      const root = tempDir();
      process.env.YOPLAI_HOME = root;
      const data = path.join(root, "files");
      fs.mkdirSync(path.join(data, "sub", "dir"), { recursive: true });
      fs.writeFileSync(path.join(data, "sub", "dir", "report.csv"), "a,b\n");
      const params = {
        agentId: "cloud",
        sessionId: "session-1",
        onHistoryEvent: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as SdkRunParams;

      await new ContainerFileOutputAdapter().handle(
        params,
        { type: "file_output", path: `/conversation/files/${source}` },
        undefined,
        undefined,
        { hostPath: data, runtimePath: "/conversation/files" }
      );

      expect(params.onHistoryEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "assistant_file",
          filename: "report.csv",
          size: 4,
        })
      );
      expect(params.onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "file_output",
          filename: "report.csv",
          size: 4,
        })
      );
      const event = vi.mocked(params.onEvent).mock.calls[0][0];
      if (event.type !== "file_output") throw new Error("Expected file output");
      const stored = await metadata.getMediaFileMetadata(event.fileId);
      expect(stored).not.toBeNull();
      expect(
        await fsPromises.readFile(
          await metadata.resolveMediaFilePath(stored!),
          "utf8"
        )
      ).toBe("a,b\n");
    }
  );
  it.each(["missing", "directory", "symlink", "outside"])(
    "rejects %s sources without emitting a card",
    async (kind) => {
      const root = tempDir();
      const data = path.join(root, "data");
      fs.mkdirSync(data);
      fs.mkdirSync(path.join(data, "directory"));
      fs.writeFileSync(path.join(root, "outside"), "private");
      fs.symlinkSync(path.join(root, "outside"), path.join(data, "symlink"));
      const params = {
        agentId: "cloud",
        sessionId: "session-1",
        onHistoryEvent: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as SdkRunParams;
      const error = await new ContainerFileOutputAdapter()
        .handle(
          params,
          {
            type: "file_output",
            path:
              kind === "outside"
                ? "/workspace/data/../outside"
                : `/workspace/data/${kind}`,
          },
          data
        )
        .catch((error: unknown) => error);
      expect(isFileOutputRejectedError(error)).toBe(true);
      expect(params.onHistoryEvent).not.toHaveBeenCalled();
      expect(params.onEvent).not.toHaveBeenCalled();
    }
  );

  it.each([
    "missing.csv",
    "missing/report.csv",
    "directory",
    "symlink",
    "file/report.csv",
    "../../outside.csv",
  ])(
    "classifies invalid nested conversation file %s as rejected output",
    async (source) => {
      const root = tempDir();
      const data = path.join(root, "files");
      fs.mkdirSync(path.join(data, "sub"), { recursive: true });
      fs.mkdirSync(path.join(data, "sub", "directory"));
      fs.writeFileSync(path.join(data, "sub", "file"), "a,b\n");
      fs.symlinkSync(
        path.join(data, "sub", "file"),
        path.join(data, "sub", "symlink")
      );
      const params = {
        agentId: "cloud",
        sessionId: "session-1",
        onHistoryEvent: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as SdkRunParams;

      const error = await new ContainerFileOutputAdapter()
        .handle(
          params,
          { type: "file_output", path: `/conversation/files/sub/${source}` },
          undefined,
          undefined,
          { hostPath: data, runtimePath: "/conversation/files" }
        )
        .catch((error: unknown) => error);

      expect(isFileOutputRejectedError(error)).toBe(true);
      expect(params.onHistoryEvent).not.toHaveBeenCalled();
      expect(params.onEvent).not.toHaveBeenCalled();
    }
  );

  it.each(["inside", "outside"])(
    "rejects a conversation directory symlink pointing %s the root",
    async (kind) => {
      const root = tempDir();
      process.env.YOPLAI_HOME = root;
      const data = path.join(root, "files");
      const destination = path.join(kind === "inside" ? data : root, "real");
      fs.mkdirSync(destination, { recursive: true });
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(destination, "report.csv"), "a,b\n");
      fs.symlinkSync(destination, path.join(data, "linked"));
      const params = {
        agentId: "cloud",
        sessionId: "session-1",
        onHistoryEvent: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as SdkRunParams;

      const error = await new ContainerFileOutputAdapter()
        .handle(
          params,
          {
            type: "file_output",
            path: "/conversation/files/linked/report.csv",
          },
          undefined,
          undefined,
          { hostPath: data, runtimePath: "/conversation/files" }
        )
        .catch((error: unknown) => error);

      expect(isFileOutputRejectedError(error)).toBe(true);
      expect(params.onHistoryEvent).not.toHaveBeenCalled();
      expect(params.onEvent).not.toHaveBeenCalled();
    }
  );

  it("classifies an unavailable conversation files directory as rejected output", async () => {
    const params = {
      agentId: "cloud",
      sessionId: "session-1",
      onHistoryEvent: vi.fn(),
      onEvent: vi.fn(),
    } as unknown as SdkRunParams;
    const error = await new ContainerFileOutputAdapter()
      .handle(
        params,
        { type: "file_output", path: "/conversation/files/report.csv" },
        undefined
      )
      .catch((error: unknown) => error);
    expect(isFileOutputRejectedError(error)).toBe(true);
    expect(error).toHaveProperty(
      "message",
      "File path must be under the conversation files directory"
    );
    expect(params.onHistoryEvent).not.toHaveBeenCalled();
    expect(params.onEvent).not.toHaveBeenCalled();
  });

  it.each(["copy", "registration", "history", "card"])(
    "propagates %s failures",
    async (kind) => {
      const root = tempDir();
      process.env.YOPLAI_HOME = root;
      const data = path.join(root, "data");
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, "report.csv"), "a,b\n");
      const failure = new Error(`${kind} failed`);
      const params = {
        agentId: "cloud",
        sessionId: "session-1",
        onHistoryEvent: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as SdkRunParams;
      if (kind === "copy")
        vi.spyOn(fsPromises, "copyFile").mockRejectedValueOnce(failure);
      if (kind === "registration")
        vi.spyOn(metadata, "registerMediaFile").mockRejectedValueOnce(failure);
      if (kind === "history")
        vi.mocked(params.onHistoryEvent).mockImplementationOnce(() => {
          throw failure;
        });
      if (kind === "card")
        vi.mocked(params.onEvent).mockImplementationOnce(() => {
          throw failure;
        });
      const error = await new ContainerFileOutputAdapter()
        .handle(
          params,
          { type: "file_output", path: "/workspace/data/report.csv" },
          data
        )
        .catch((error: unknown) => error);
      expect(error).toBe(failure);
      expect(isFileOutputRejectedError(error)).toBe(false);
      if (kind !== "card") expect(params.onEvent).not.toHaveBeenCalled();
    }
  );
});
