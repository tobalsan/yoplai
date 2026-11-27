import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { FeedDetail, FeedWindow } from "@yoplai/shared";
import type { FeedSelector } from "../durable/feed.js";
import type { WebSender } from "../durable/contract.js";
import { projectRoomMessage, type RoomMessage } from "./projection.js";
import { ChatProjectStore, isSafeChatProjectId } from "../chat-projects/store.js";
import { roomMentions } from "./mentions.js";

type Room = { id: string; ownerUserId: string };
export type RoomSummary = Room & { name: string; role: "owner" | "member" };
export type RoomMembership = { roomId: string; ownerUserId: string; agentId: string; generation: number; joinSeq: number };

type RoomAuthor =
  | { kind: "user"; mentions?: string[] }
  | { kind: "agent"; agentId: string; ref: NonNullable<RoomMessage["ref"]> }
  | { kind: "digest" };

type StoredMessage = Omit<RoomMessage, "mentions" | "ref"> & { mentions: string; ref: string | null };

export type RoomEvent =
  | { type: "appended"; roomId: string; row: RoomMessage }
  | { type: "memberRemoved"; roomId: string; userId: string }
  | { type: "agentAdded" | "agentRemoved"; roomId: string; agentId: string }
  | { type: "roomDeleted"; roomId: string };

function decode(row: StoredMessage): RoomMessage {
  return { ...row, mentions: JSON.parse(row.mentions), ref: row.ref === null ? null : JSON.parse(row.ref) };
}

function migrate(db: Database.Database) {
  db.transaction(() => {
    const logColumns = db.pragma("table_info(room_log)") as { name: string }[];
    if (!logColumns.some(({ name }) => name === "authorKind")) db.exec(`
      ALTER TABLE room_log ADD COLUMN authorKind TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE room_log ADD COLUMN agentId TEXT;
      ALTER TABLE room_log ADD COLUMN ref TEXT;
      ALTER TABLE room_log ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
    `);
    const agentColumns = db.pragma("table_info(room_agents)") as { name: string }[];
    if (!agentColumns.some(({ name }) => name === "generation")) db.exec(`
      ALTER TABLE room_agents ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE room_agents ADD COLUMN joinSeq INTEGER NOT NULL DEFAULT 0;
      UPDATE room_agents SET joinSeq = COALESCE(
        (SELECT MAX(seq) FROM room_log WHERE room_log.roomId = room_agents.roomId), 0
      );
    `);
  }).immediate();
}

export class RoomStore {
  private readonly listeners = new Set<(event: RoomEvent) => void>();
  private readonly filename: string;
  private db?: Database.Database;
  private closed = false;

  constructor(private readonly dataDir: string) {
    this.filename = path.join(dataDir, "rooms.sqlite");
  }

  private open() {
    if (this.closed) throw new Error("Room store is closed");
    if (this.db) return this.db;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const db = new Database(this.filename);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          id TEXT PRIMARY KEY,
          ownerUserId TEXT NOT NULL,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS rooms_by_owner ON rooms(ownerUserId);
        CREATE TABLE IF NOT EXISTS room_members (
          roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          userId TEXT NOT NULL,
          PRIMARY KEY (roomId, userId)
        );
        CREATE INDEX IF NOT EXISTS room_members_by_user ON room_members(userId, roomId);
        CREATE TABLE IF NOT EXISTS room_agents (
          roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          agentId TEXT NOT NULL,
          PRIMARY KEY (roomId, agentId)
        );
        CREATE INDEX IF NOT EXISTS room_agents_by_agent ON room_agents(agentId, roomId);
        CREATE TABLE IF NOT EXISTS room_agent_generations (
          roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          agentId TEXT NOT NULL,
          generation INTEGER NOT NULL,
          PRIMARY KEY (roomId, agentId)
        );
        CREATE TABLE IF NOT EXISTS room_log (
          roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          id TEXT NOT NULL,
          producerId TEXT NOT NULL,
          authorId TEXT NOT NULL,
          authorName TEXT NOT NULL,
          audience TEXT NOT NULL,
          text TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          PRIMARY KEY (roomId, seq),
          UNIQUE (roomId, id),
          UNIQUE (roomId, producerId)
        );
      `);
      migrate(db);
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close() {
    this.closed = true;
    this.db?.close();
    this.db = undefined;
  }

  onEvent(listener: (event: RoomEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: RoomEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private room(id: string): Room | undefined {
    return this.open().prepare("SELECT id, ownerUserId FROM rooms WHERE id = ?").get(id) as Room | undefined;
  }

  private projects(ownerUserId: string) {
    return new ChatProjectStore(this.dataDir, ownerUserId === "local" ? undefined : ownerUserId);
  }

  ensureRoom(id: string, ownerUserId: string, createdAt: number) {
    this.open().prepare("INSERT OR IGNORE INTO rooms VALUES (?, ?, ?)").run(id, ownerUserId, createdAt);
  }

  roleOf(id: string, userId: string): RoomSummary["role"] | undefined {
    if (this.room(id)?.ownerUserId === userId) return "owner";
    const member = this.open().prepare("SELECT 1 FROM room_members WHERE roomId = ? AND userId = ?").get(id, userId);
    if (member) return "member";
  }

  mayAccess(id: string, userId: string): boolean {
    return this.roleOf(id, userId) !== undefined;
  }

  async resolve(id: string, userId: string): Promise<RoomSummary | undefined> {
    if (!isSafeChatProjectId(id)) return;
    const room = this.room(id);
    if (room && !this.mayAccess(id, userId)) return;

    const ownerUserId = room?.ownerUserId ?? userId;
    const projects = this.projects(ownerUserId);
    const project = await projects.get(id);
    if (!project) return;
    if (!room) {
      // An async project read can finish after the deletion has already removed its room.
      if (!projects.exists(id)) return;
      this.ensureRoom(id, ownerUserId, project.createdAt);
    }
    const role = this.roleOf(id, userId);
    if (role) return { id, name: project.name, role, ownerUserId };
  }

  async list(userId: string): Promise<RoomSummary[]> {
    const rooms = this.open().prepare(`
      SELECT id FROM rooms
      WHERE ownerUserId = ? OR id IN (SELECT roomId FROM room_members WHERE userId = ?)
      ORDER BY createdAt, id
    `).all(userId, userId) as Array<Pick<Room, "id">>;
    const summaries = await Promise.all(rooms.map(({ id }) => this.resolve(id, userId)));
    return summaries.filter((room) => room !== undefined);
  }

  participants(roomId: string) {
    const db = this.open();
    return {
      members: db.prepare("SELECT userId FROM room_members WHERE roomId = ? ORDER BY userId").pluck().all(roomId) as string[],
      agents: db.prepare("SELECT agentId FROM room_agents WHERE roomId = ? ORDER BY agentId").pluck().all(roomId) as string[],
    };
  }

  addMember(roomId: string, userId: string) {
    if (this.roleOf(roomId, userId) === "owner") return;
    this.open().prepare("INSERT OR IGNORE INTO room_members VALUES (?, ?)").run(roomId, userId);
  }

  removeMember(roomId: string, userId: string) {
    const { changes } = this.open().prepare("DELETE FROM room_members WHERE roomId = ? AND userId = ?").run(roomId, userId);
    if (changes) this.emit({ type: "memberRemoved", roomId, userId });
  }

  addAgent(roomId: string, agentId: string) {
    const db = this.open();
    const { changes } = db.transaction(() => db.prepare(`
      INSERT OR IGNORE INTO room_agents (roomId, agentId, generation, joinSeq)
      VALUES (?, ?, COALESCE((SELECT generation FROM room_agent_generations WHERE roomId = ? AND agentId = ?), 0) + 1, ?)
    `).run(roomId, agentId, roomId, agentId, this.lastSeq(roomId))).immediate();
    if (changes) this.emit({ type: "agentAdded", roomId, agentId });
  }

  removeAgent(roomId: string, agentId: string) {
    const db = this.open();
    const removed = db.transaction(() => {
      const row = db.prepare("DELETE FROM room_agents WHERE roomId = ? AND agentId = ? RETURNING generation")
        .get(roomId, agentId) as { generation: number } | undefined;
      if (!row) return false;
      db.prepare("INSERT OR REPLACE INTO room_agent_generations VALUES (?, ?, ?)").run(roomId, agentId, row.generation);
      return true;
    }).immediate();
    if (removed) this.emit({ type: "agentRemoved", roomId, agentId });
  }

  membership(roomId: string, agentId: string): RoomMembership | undefined {
    return this.open().prepare(`
      SELECT room_agents.*, rooms.ownerUserId FROM room_agents JOIN rooms ON rooms.id = roomId
      WHERE roomId = ? AND agentId = ?
    `).get(roomId, agentId) as RoomMembership | undefined;
  }

  roomsForAgent(agentId: string): { roomId: string }[] {
    return this.open().prepare("SELECT roomId FROM room_agents WHERE agentId = ? ORDER BY roomId")
      .all(agentId) as { roomId: string }[];
  }

  agentsForRoom(roomId: string): string[] {
    return this.open().prepare("SELECT agentId FROM room_agents WHERE roomId = ? ORDER BY agentId")
      .pluck().all(roomId) as string[];
  }

  deleteRoom(roomId: string, ownerUserId: string) {
    if (!this.db && !fs.existsSync(this.filename)) return;
    const { changes } = this.open().prepare("DELETE FROM rooms WHERE id = ? AND ownerUserId = ?").run(roomId, ownerUserId);
    if (changes) this.emit({ type: "roomDeleted", roomId });
  }

  lastSeq(roomId: string): number {
    const row = this.open().prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM room_log WHERE roomId = ?")
      .get(roomId) as { seq: number };
    return row.seq;
  }

  append(roomId: string, producerId: string, author: WebSender, text: string, metadata: RoomAuthor = { kind: "user" }) {
    const db = this.open();
    const result = db.transaction(() => {
      const existing = db.prepare("SELECT * FROM room_log WHERE roomId = ? AND producerId = ?")
        .get(roomId, producerId) as StoredMessage | undefined;
      if (existing) return { row: decode(existing), duplicate: true };

      const seq = this.lastSeq(roomId) + 1;
      const row: StoredMessage = {
        roomId, seq, id: "r_" + seq, producerId, authorId: author.id, authorName: author.name,
        audience: "room:" + roomId, text, timestamp: Date.now(),
        authorKind: metadata.kind,
        agentId: metadata.kind === "agent" ? metadata.agentId : null,
        ref: metadata.kind === "agent" ? JSON.stringify(metadata.ref) : null,
        mentions: JSON.stringify(metadata.kind === "user"
          ? metadata.mentions ?? roomMentions(text, this.agentsForRoom(roomId)) : []),
      };
      db.prepare(`
        INSERT INTO room_log (roomId, seq, id, producerId, authorId, authorName, audience, text, timestamp, authorKind, agentId, ref, mentions)
        VALUES (@roomId, @seq, @id, @producerId, @authorId, @authorName, @audience, @text, @timestamp, @authorKind, @agentId, @ref, @mentions)
      `).run(row);
      return { row: decode(row), duplicate: false };
    }).immediate();
    if (!result.duplicate) this.emit({ type: "appended", roomId, row: result.row });
    return result;
  }

  events(roomId: string, after: number, through: number): RoomMessage[] {
    const rows = this.open().prepare("SELECT * FROM room_log WHERE roomId = ? AND seq > ? AND seq <= ? ORDER BY seq")
      .all(roomId, after, through) as StoredMessage[];
    return rows.map(decode);
  }

  window(roomId: string, limit: number): FeedWindow;
  window(roomId: string, limit: number, selector: FeedSelector | undefined): FeedWindow | undefined;
  window(roomId: string, limit: number, selector?: FeedSelector): FeedWindow | undefined {
    const last = this.lastSeq(roomId);
    let start = Math.max(0, last - limit);
    let end = last;
    if (selector) {
      const seq = this.open().prepare("SELECT seq FROM room_log WHERE roomId = ? AND id = ?")
        .pluck().get(roomId, selector.id) as number | undefined;
      if (seq === undefined) return;
      switch (selector.direction) {
        case "before":
          end = seq - 1;
          start = Math.max(0, end - limit);
          break;
        case "after":
          start = seq;
          end = Math.min(last, start + limit);
          break;
        case "around":
          start = Math.max(0, Math.min(last - limit, seq - 1 - Math.floor(limit / 2)));
          end = Math.min(last, start + limit);
          break;
      }
    }
    return { items: this.events(roomId, start, end).map(projectRoomMessage), hasBefore: start > 0, hasAfter: end < last, live: null };
  }

  get(roomId: string, id: string): FeedDetail | undefined {
    const row = this.open().prepare("SELECT * FROM room_log WHERE roomId = ? AND id = ?")
      .get(roomId, id) as StoredMessage | undefined;
    return row && { ...projectRoomMessage(decode(row)), reasoning: [], toolCalls: [] };
  }
}
