import fs from "node:fs/promises";
import path from "node:path";
import { getUserSessionsPath } from "@yoplai/extension-multi-user/isolation";
import { z } from "zod";
import { writeJsonAtomic } from "../util/atomic-write.js";
import { serializeByKey } from "../util/serialize.js";

export const sidebarOrderSchema = z.object({
  agentIds: z.array(z.string().min(1)),
  updatedAt: z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value))).optional(),
});
export type SidebarOrder = z.infer<typeof sidebarOrderSchema>;
const writes = new Map<string, Promise<void>>();

export class SidebarOrderStore {
  private readonly file: string;

  constructor(dataDir: string, userId?: string) {
    if (userId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(userId)) throw new Error("Invalid user id");
    this.file = path.join(path.dirname(getUserSessionsPath(userId, dataDir)), "sidebar-order.json");
  }

  async read(): Promise<SidebarOrder> {
    try {
      return sidebarOrderSchema.parse(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { agentIds: [] };
      throw error;
    }
  }

  update(change: (current: SidebarOrder) => SidebarOrder): Promise<SidebarOrder> {
    return serializeByKey(writes, this.file, async () => {
      const current = await this.read();
      const next = change(current);
      if (next !== current) await writeJsonAtomic(this.file, next);
      return next;
    });
  }
}
