import fs from "node:fs/promises";
import path from "node:path";
import { DesktopSetupStateSchema, type DesktopSetupState } from "@yoplai/shared";
import { Hono } from "hono";
import { z } from "zod";
import { getAgent } from "../config/index.js";
import { isSafeSessionId } from "../server/run-request.js";
import { desktopTurnState } from "./turns.js";
import { writeJsonAtomic } from "../util/atomic-write.js";

const turnIdSchema = z.string().uuid();
const updateSchema = DesktopSetupStateSchema.partial().extend({ retryOf: turnIdSchema.optional() }).strict();
const validTurn = (sessionId: string, turnId: string) =>
  isSafeSessionId(sessionId) && turnIdSchema.safeParse(turnId).success;
const sameFirstChat = (a: DesktopSetupState["firstChat"], b: DesktopSetupState["firstChat"]) =>
  a?.agentId === b?.agentId && a?.sessionId === b?.sessionId && a?.turnId === b?.turnId;

export function createDesktopSetupRoutes(home: string) {
  const routes = new Hono();
  const file = path.join(home, "desktop-setup.json");
  let pending = Promise.resolve();

  async function read(): Promise<DesktopSetupState> {
    try {
      return DesktopSetupStateSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return DesktopSetupStateSchema.parse({});
    }
  }

  routes.get("/turns/:agentId/:sessionId/:turnId", async (c) => {
    const { agentId, sessionId, turnId } = c.req.param();
    if (!validTurn(sessionId, turnId)) {
      return c.json({ error: "invalid_turn" }, 400);
    }
    if (!getAgent(agentId)) return c.json({ error: "unknown_agent" }, 404);
    try {
      return c.json({ state: await desktopTurnState(home, agentId, sessionId, turnId.toLowerCase()) });
    } catch {
      return c.json({ error: "turn_read_failed", message: "Yoplai could not read the turn state. Try again." }, 500);
    }
  });

  routes.get("/", async (c) => {
    try {
      return c.json(await read());
    } catch {
      return c.json({ error: "setup_read_failed" }, 500);
    }
  });
  routes.put("/", async (c) => {
    const body = updateSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "invalid_setup_state" }, 400);
    const { retryOf, ...patch } = body.data;
    const { completed, firstChat } = patch;
    if (retryOf && (!firstChat || completed || !validTurn(firstChat.sessionId, firstChat.turnId) || firstChat.turnId.toLowerCase() === retryOf.toLowerCase())) {
      return c.json({ error: "invalid_turn", message: "Specify a fresh turn for the first chat." }, 400);
    }
    if (completed === true && (!firstChat || !validTurn(firstChat.sessionId, firstChat.turnId))) {
      return c.json({ error: "invalid_turn", message: "Specify a valid first chat." }, 400);
    }
    const update = pending.then(async () => {
      const previous = await read();
      if (retryOf && firstChat) {
        const saved = previous.firstChat;
        if (previous.completed || !saved || !sameFirstChat(saved, { ...firstChat, turnId: retryOf }) ||
            !getAgent(saved.agentId) || await desktopTurnState(home, saved.agentId, saved.sessionId, retryOf.toLowerCase()) !== "failed") {
          return "retry_conflict" as const;
        }
      }
      if (completed === true && firstChat) {
        const saved = previous.firstChat;
        if (!saved || !sameFirstChat(saved, firstChat) ||
            !getAgent(saved.agentId) || await desktopTurnState(home, saved.agentId, saved.sessionId, saved.turnId.toLowerCase()) !== "answered") {
          return "turn_conflict" as const;
        }
      }
      const state = DesktopSetupStateSchema.parse({ ...previous, ...patch });
      if (!sameFirstChat(previous.firstChat, state.firstChat)) state.completed = false;
      if (state.completed && !state.firstChat) return null;
      state.completedAt = state.completed ? previous.completedAt ?? new Date().toISOString() : null;
      await writeJsonAtomic(file, state);
      return state;
    });
    pending = update.then(() => undefined, () => undefined);
    try {
      const state = await update;
      if (state === "retry_conflict") return c.json({ error: state, message: "The saved first chat no longer matches a failed turn." }, 409);
      if (state === "turn_conflict") return c.json({ error: state, message: "The saved first chat does not match an answered turn." }, 409);
      return state ? c.json(state) : c.json({ error: "first_chat_required" }, 400);
    } catch {
      return c.json({ error: "setup_write_failed" }, 500);
    }
  });
  return routes;
}
