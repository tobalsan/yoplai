import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { FeedDetail, FeedWindow } from "@yoplai/shared";
import type { FeedSelector } from "../durable/feed.js";
import type { WebSender } from "../durable/contract.js";
import { projectRoomMessage, type RoomMessage } from "./projection.js";
import { ChatProjectStore, isSafeChatProjectId } from "../chat-projects/store.js";

type Room = { id: string; ownerUserId: string };
export type RoomSummary = Room & { name: string; role: "owner" | "member" };

type RoomEvent =
  | { type: "appended"; roomId: string; row: RoomMessage }
  | { type: "memberRemoved"; roomId: string; userId: string }
  | { type: "roomDeleted"; roomId: string };

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
    this.open().prepare("INSERT OR IGNORE INTO room_agents VALUES (?, ?)").run(roomId, agentId);
  }

  removeAgent(roomId: string, agentId: string) {
    this.open().prepare("DELETE FROM room_agents WHERE roomId = ? AND agentId = ?").run(roomId, agentId);
  }

  deleteRoom(roomId: string, ownerUserId: string) {
    if (!this.db && !fs.existsSync(this.filename)) return;
    const { changes } = this.open().prepare("DELETE FROM rooms WHERE id = ? AND ownerUserId = ?").run(roomId, ownerUserId);
    if (changes) this.emit({ type: "roomDeleted", roomId });
  }

  private lastSeq(roomId: string): number {
    const row = this.open().prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM room_log WHERE roomId = ?")
      .get(roomId) as { seq: number };
    return row.seq;
  }

  append(roomId: string, producerId: string, author: WebSender, text: string) {
    const db = this.open();
    const result = db.transaction(() => {
      const existing = db.prepare("SELECT * FROM room_log WHERE roomId = ? AND producerId = ?")
        .get(roomId, producerId) as RoomMessage | undefined;
      if (existing) return { row: existing, duplicate: true };

      const seq = this.lastSeq(roomId) + 1;
      const row: RoomMessage = {
        roomId, seq, id: "r_" + seq, producerId, authorId: author.id, authorName: author.name,
        audience: "room:" + roomId, text, timestamp: Date.now(),
      };
      db.prepare(`
        INSERT INTO room_log (roomId, seq, id, producerId, authorId, authorName, audience, text, timestamp)
        VALUES (@roomId, @seq, @id, @producerId, @authorId, @authorName, @audience, @text, @timestamp)
      `).run(row);
      return { row, duplicate: false };
    }).immediate();
    if (!result.duplicate) this.emit({ type: "appended", roomId, row: result.row });
    return result;
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
    const rows = this.open().prepare("SELECT * FROM room_log WHERE roomId = ? AND seq > ? AND seq <= ? ORDER BY seq")
      .all(roomId, start, end) as RoomMessage[];
    return { items: rows.map(projectRoomMessage), hasBefore: start > 0, hasAfter: end < last, live: null };
  }

  get(roomId: string, id: string): FeedDetail | undefined {
    const row = this.open().prepare("SELECT * FROM room_log WHERE roomId = ? AND id = ?")
      .get(roomId, id) as RoomMessage | undefined;
    return row && { ...projectRoomMessage(row), reasoning: [], toolCalls: [] };
  }
}
