import { inflateRawSync, crc32 } from "node:zlib";
import { parse } from "yaml";
import { MAX_UPLOAD_SIZE_BYTES } from "../media/upload.js";
import { SkillError, type SkillInput } from "./types.js";

type SkillFile = { path: string; data: Buffer };
export function readSkillMetadata(text: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new SkillError("invalid_frontmatter");
  let metadata: unknown;
  try { metadata = parse(match[1], { maxAliasCount: 100 }); } catch { throw new SkillError("invalid_frontmatter"); }
  if (!metadata || typeof metadata !== "object") throw new SkillError("invalid_frontmatter");
  const { name, description } = metadata as Record<string, unknown>;
  if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new SkillError("invalid_name");
  if (typeof description !== "string" || !description.trim()) throw new SkillError("missing_description");
  return { name, description: description.trim() };
}

function validatePath(name: string): void {
  if (typeof name !== "string" || name.length > 200 || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new SkillError("invalid_path");
  const segments = name.split("/");
  if (segments.length > 20 || segments.some((segment) => !segment || segment === "." || segment === "..") || segments.slice(0, -1).some((segment) => segment.startsWith("."))) throw new SkillError("invalid_path");
}

function unzip(archive: Buffer): SkillFile[] {
  if (archive.length > MAX_UPLOAD_SIZE_BYTES) throw new SkillError("content_too_large", 413);
  try {
    let end = archive.length - 22;
    for (; end >= Math.max(0, archive.length - 65557); end--) {
      if (archive.readUInt32LE(end) === 0x06054b50 && end + 22 + archive.readUInt16LE(end + 20) === archive.length) break;
    }
    if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6)) throw new SkillError("invalid_zip");
    const count = archive.readUInt16LE(end + 10);
    if (count > 200) throw new SkillError("too_many_entries");
    if (archive.readUInt16LE(end + 8) !== count) throw new SkillError("invalid_zip");
    let cursor = archive.readUInt32LE(end + 16);
    const centralStart = cursor;
    if (cursor + archive.readUInt32LE(end + 12) !== end) throw new SkillError("invalid_zip");
    let expanded = 0;
    const seen = new Set<string>();
    const entries: { path: string; directory: boolean; data: Buffer }[] = [];
    for (let entry = 0; entry < count; entry++) {
      if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) throw new SkillError("invalid_zip");
      const flags = archive.readUInt16LE(cursor + 8);
      const method = archive.readUInt16LE(cursor + 10);
      const compressedSize = archive.readUInt32LE(cursor + 20);
      const expandedSize = archive.readUInt32LE(cursor + 24);
      const nameLength = archive.readUInt16LE(cursor + 28);
      const attributes = archive.readUInt32LE(cursor + 38);
      const local = archive.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameLength + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
      if (next > end || flags & 1 || ![0, 8].includes(method) || archive.readUInt16LE(cursor + 34) !== 0) throw new SkillError("invalid_zip");
      const filename = archive.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = filename.toString("utf8");
      const directory = name.endsWith("/");
      const normalized = directory ? name.slice(0, -1) : name;
      validatePath(normalized);
      if (directory && normalized.split("/").some((segment) => segment.startsWith("."))) throw new SkillError("invalid_path");
      if (seen.has(normalized)) throw new SkillError("duplicate_path");
      seen.add(normalized);
      const fileType = (attributes >>> 16) & 0xf000;
      if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000 || directory && fileType === 0x8000 || !directory && fileType === 0x4000 || attributes & 0x8) throw new SkillError("special_entry");
      if (expandedSize > MAX_UPLOAD_SIZE_BYTES - expanded) throw new SkillError("content_too_large", 413);
      if (local + 30 > centralStart || archive.readUInt32LE(local) !== 0x04034b50 || archive.readUInt16LE(local + 8) !== method || archive.readUInt16LE(local + 6) !== flags) throw new SkillError("invalid_zip");
      const localNameLength = archive.readUInt16LE(local + 26);
      const dataStart = local + 30 + localNameLength + archive.readUInt16LE(local + 28);
      if (!archive.subarray(local + 30, local + 30 + localNameLength).equals(filename) || dataStart + compressedSize > centralStart) throw new SkillError("invalid_zip");
      const compressed = archive.subarray(dataStart, dataStart + compressedSize);
      let data: Buffer;
      try { data = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, MAX_UPLOAD_SIZE_BYTES - expanded) }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new SkillError("content_too_large", 413); throw error; }
      expanded += data.length;
      if (expanded > MAX_UPLOAD_SIZE_BYTES) throw new SkillError("content_too_large", 413);
      if (data.length !== expandedSize || crc32(data) !== archive.readUInt32LE(cursor + 16) || directory && data.length) throw new SkillError("invalid_zip");
      entries.push({ path: normalized, directory, data });
      cursor = next;
    }
    if (cursor !== end) throw new SkillError("invalid_zip");
    const files = entries.filter((entry) => !entry.directory);
    const root = files[0]?.path.split("/")[0];
    const wrapped = root && files.every((file) => file.path.startsWith(`${root}/`));
    return files.map((file) => ({ path: wrapped ? file.path.slice(root.length + 1) : file.path, data: file.data }));
  } catch (error) { if (error instanceof SkillError) throw error; throw new SkillError("invalid_zip"); }
}

export async function ingestSkill(input: SkillInput): Promise<{ name: string; description: string; files: SkillFile[] }> {
  if (!input || typeof input !== "object") throw new SkillError("invalid_files");
  let decoded: SkillFile[];
  if ("zip" in input) decoded = unzip(input.zip);
  else {
    if (!Array.isArray(input.files)) throw new SkillError("invalid_files");
    if (input.files.length > 200) throw new SkillError("too_many_entries");
    let size = 0;
    decoded = input.files.map((file) => {
      validatePath(file.path);
      if (typeof file.content !== "string" || (file.encoding !== undefined && file.encoding !== "utf8" && file.encoding !== "base64")) throw new SkillError("invalid_files");
      if (file.encoding === "base64" && (file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content))) throw new SkillError("invalid_encoding");
      size += Buffer.byteLength(file.content, file.encoding === "base64" ? "base64" : "utf8");
      if (size > MAX_UPLOAD_SIZE_BYTES) throw new SkillError("content_too_large", 413);
      return { path: file.path, data: Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8") };
    });
  }
  const seen = new Set<string>();
  const files = decoded.filter((file) => {
    validatePath(file.path);
    if (seen.has(file.path)) throw new SkillError("duplicate_path");
    seen.add(file.path);
    const basename = file.path.split("/").at(-1)!;
    return !basename.startsWith(".") || basename === ".yoplai.json";
  });
  const root = files.find((file) => file.path === "SKILL.md");
  if (!root) throw new SkillError("missing_skill_md");
  const metadata = readSkillMetadata(root.data.toString("utf8"));
  if ("name" in input && input.name !== undefined && input.name !== metadata.name) throw new SkillError("name_mismatch");
  return { ...metadata, files };
}
