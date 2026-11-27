import { Hono, type Context } from "hono";
import { parseDurableWebSend, type WebSender } from "../durable/contract.js";
import { feedWindowQuery } from "../server/feed-query.js";
import { canUseRooms } from "./access.js";
import type { RoomStore, RoomSummary } from "./store.js";

export function createRoomRoutes(deps: {
  getUserId: (c: Context) => Promise<string | undefined>;
  getRooms: (c: Context) => RoomStore;
  isMultiUser: () => boolean;
  getSender: (c: Context) => Promise<WebSender>;
  canAccessAgent: (c: Context, agentId: string) => Promise<boolean>;
}) {
  const routes = new Hono();

  async function principal(c: Context) {
    const userId = await deps.getUserId(c);
    if (await canUseRooms(userId, deps.isMultiUser())) return userId ?? "local";
  }

  routes.get("/rooms", async (c) => {
    const userId = await principal(c);
    if (userId === undefined) return c.json({ error: "forbidden" }, 403);
    return c.json({ items: await deps.getRooms(c).list(userId) });
  });

  function roomRoute(
    action: (c: Context, rooms: RoomStore, room: RoomSummary, userId: string) => Response | Promise<Response>,
    ownerOnly = false,
  ) {
    return async (c: Context) => {
      const rooms = deps.getRooms(c);
      const userId = await principal(c);
      if (userId === undefined) return c.json({ error: "forbidden" }, 403);
      const room = await rooms.resolve(c.req.param("roomId") ?? "", userId);
      if (!room) return notFound(c);
      if (ownerOnly && room.role !== "owner") return c.json({ error: "Room owner required" }, 403);
      return action(c, rooms, room, userId);
    };
  }

  routes.get("/rooms/:roomId", roomRoute((c, rooms, room) =>
    c.json({ ...room, ...rooms.participants(room.id) })));

  routes.post("/rooms/:roomId/members", roomRoute(async (c, rooms, room, userId) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.userId !== "string" || !await canUseRooms(body.userId, deps.isMultiUser())) {
      return c.json({ error: "Eligible user required" }, 400);
    }
    if (rooms.roleOf(room.id, userId) !== "owner") return notFound(c);
    rooms.addMember(room.id, body.userId);
    return c.json({ ok: true });
  }, true));

  routes.delete("/rooms/:roomId/members/:userId", roomRoute((c, rooms, room) => {
    const target = c.req.param("userId") ?? "";
    if (target === room.ownerUserId) return c.json({ error: "Cannot remove the room owner" }, 400);
    rooms.removeMember(room.id, target);
    return c.json({ ok: true });
  }, true));

  async function changeAgent(c: Context, rooms: RoomStore, room: RoomSummary, agentId: unknown, add: boolean) {
    if (typeof agentId !== "string" || !await deps.canAccessAgent(c, agentId)) {
      return c.json({ error: "Accessible agent required" }, 400);
    }
    if (rooms.roleOf(room.id, room.ownerUserId) !== "owner") return notFound(c);
    if (add) rooms.addAgent(room.id, agentId);
    else rooms.removeAgent(room.id, agentId);
    return c.json({ ok: true });
  }

  routes.post("/rooms/:roomId/agents", roomRoute(async (c, rooms, room) => {
    const body = await c.req.json().catch(() => null);
    return changeAgent(c, rooms, room, body?.agentId, true);
  }, true));

  routes.delete("/rooms/:roomId/agents/:agentId", roomRoute((c, rooms, room) =>
    changeAgent(c, rooms, room, c.req.param("agentId"), false), true));

  routes.post("/rooms/:roomId/messages", roomRoute(async (c, rooms, room, userId) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Invalid room message" }, 400);
    const parsed = parseDurableWebSend(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if ("stop" in parsed) return c.json({ error: "Rooms do not support stop commands" }, 400);
    const author = await deps.getSender(c);
    if (!rooms.mayAccess(room.id, userId)) return notFound(c);
    const { clientSendId, message } = parsed.input;
    const { row, duplicate } = rooms.append(room.id, "web:" + author.id + ":" + clientSendId, author, message);
    return c.json({ id: row.id, seq: row.seq, duplicate });
  }));

  routes.get("/rooms/:roomId/feed", roomRoute((c, rooms, room) => {
    const query = feedWindowQuery(c.req);
    if ("error" in query) return c.json(query, 400);
    const window = rooms.window(room.id, query.limit, query.selector);
    return window ? c.json(window) : c.json({ error: "Message not found" }, 404);
  }));

  routes.get("/rooms/:roomId/feed/messages/:messageId", roomRoute((c, rooms, room) => {
    const detail = rooms.get(room.id, c.req.param("messageId") ?? "");
    return detail ? c.json(detail) : c.json({ error: "Message not found" }, 404);
  }));

  return routes;
}

function notFound(c: Context) {
  return c.json({ error: "Room not found" }, 404);
}
