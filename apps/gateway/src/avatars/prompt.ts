import type { AgentConfig } from "@yoplai/shared";
import type { AvatarStyle } from "./styles.js";

/** The image prompt for one agent: who it is, what it does, and the chosen look. */
export function buildAvatarPrompt(
  agent: Pick<AgentConfig, "name" | "role" | "description">,
  style: AvatarStyle
): string {
  const job = [agent.role, agent.description].filter(Boolean).join(". ");
  return [
    `Create a square avatar portrait for an AI assistant named "${agent.name}".`,
    job ? `Its job: ${job}.` : "",
    "Show one character, head and shoulders, centered, facing the viewer, with a prop or setting that hints at the job.",
    `Style: ${style.prompt}.`,
    "No text, letters, logos or watermarks anywhere in the image.",
  ]
    .filter(Boolean)
    .join("\n");
}
