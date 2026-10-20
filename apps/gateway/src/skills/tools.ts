import { z } from "zod";
import type { ContainerExtensionTool } from "@yoplai/shared";
import { getSkillContext, resolveSkillActor } from "./context.js";
import { SkillError } from "./types.js";

export const skillSaveTool: ContainerExtensionTool = {
  extensionId: "gateway", name: "skill_save",
  description: "Save a finished skill to the requesting user's Skills page. Existing owned names replace content and keep sharing; pass skillId to update a shared skill you can write. Names cannot change.",
  parameters: {
    type: "object", properties: {
      name: { type: "string" }, skillId: { type: "string" },
      files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, encoding: { type: "string", enum: ["utf8", "base64"] } }, required: ["path", "content"] } },
    }, required: ["name", "files"],
  },
};

const inputSchema = z.object({
  name: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string(), encoding: z.enum(["utf8", "base64"]).optional() })),
  skillId: z.string().optional(),
});

export async function executeSkillSave(args: unknown, context: { userId?: string }): Promise<{ id: string; name: string; url: string }> {
  const input = inputSchema.parse(args);
  const actor = await resolveSkillActor(context.userId);
  if (!actor) throw new Error("skill_save requires an eligible requesting user. Continue in a personal chat; Team-mode and userless runs cannot save skills.");
  const { store, policy } = await getSkillContext();
  let skill;
  if (input.skillId) {
    const existing = await store.get(input.skillId);
    if (!existing || !await policy.canWrite(existing, actor)) throw new SkillError("not_found", 404);
    skill = await store.replace(existing.id, input);
  } else {
    try { skill = (await store.create(actor.userId, input, { replaceOwn: true })).skill; }
    catch (error) {
      if (error instanceof SkillError && error.code === "name_taken") throw new Error("That name belongs to a default, built-in, or another user's skill. Choose a new name, or pass skillId if you have write access to that skill.");
      throw error;
    }
  }
  return { id: skill.id, name: skill.name, url: `/skills/${skill.id}` };
}
