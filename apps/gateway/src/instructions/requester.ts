import { resolveSkillActor } from "../skills/context.js";

export type InstructionRequester = {
  source?: string;
  sender?: { kind: string };
  userId?: string;
};

const CHAT_SOURCES = new Set(["web", "slack", "discord", "telegram", "mattermost", "irc", "threadit"]);

export async function requireInstructionRequester(context: InstructionRequester, shared = false): Promise<void> {
  if (!context.source || !CHAT_SOURCES.has(context.source) || context.sender) {
    throw new Error("Instruction changes require a human chat requester.");
  }
  const actor = await resolveSkillActor(context.userId);
  if (!actor) throw new Error("Cannot identify an eligible requester; use the web app or ask an admin.");
  if (shared ? actor.role !== "superadmin" : actor.role !== "admin" && actor.role !== "superadmin") {
    throw new Error(shared
      ? "Only superadmins can change shared system files."
      : "Only admins can change agent instructions; ask an admin.");
  }
}

