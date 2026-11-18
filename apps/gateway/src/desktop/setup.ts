import fs from "node:fs/promises";
import path from "node:path";
import { DesktopSetupStateSchema, type DesktopSetupState } from "@yoplai/shared";
import { Hono } from "hono";
import { z } from "zod";
import { getAgent } from "../config/index.js";
import { isSafeSessionId } from "../server/run-request.js";
import { desktopTurnState } from "./turns.js";
import { writeJsonAtomic } from "../util/atomic-write.js";

const updateSchema = DesktopSetupStateSchema.partial().strict();

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
    if (!isSafeSessionId(sessionId) || !z.string().uuid().safeParse(turnId).success) {
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
    const update = pending.then(async () => {
      const previous = await read();
      const state = DesktopSetupStateSchema.parse({ ...previous, ...body.data });
      if (state.completed && !state.firstChat) return null;
      state.completedAt = state.completed ? previous.completedAt ?? new Date().toISOString() : null;
      await writeJsonAtomic(file, state);
      return state;
    });
    pending = update.then(() => undefined, () => undefined);
    try {
      const state = await update;
      return state ? c.json(state) : c.json({ error: "first_chat_required" }, 400);
    } catch {
      return c.json({ error: "setup_write_failed" }, 500);
    }
  });
  return routes;
}
