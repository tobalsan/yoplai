import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Core files that define an agent workspace and are injected as context.
const CORE_FILENAMES = ["AGENTS.md", "SOUL.md", "USER.md"] as const;

type CoreFileName = (typeof CORE_FILENAMES)[number];

export const FIRST_RUN_BOOTSTRAP_PROMPT = `This appears to be your first launch in this workspace. Before continuing, read AGENTS.md, SOUL.md, and USER.md. If SOUL.md or USER.md are incomplete, ask concise intro/profile questions, then update those files based on the answers. Do not create memory.md unless you have durable facts to remember.`;

// Fallback templates if docs/templates not found
const FALLBACK_TEMPLATES: Record<CoreFileName, string> = {
  "AGENTS.md": `# AGENTS.md - Workspace

This folder is the agent's working directory.

## Every Session

Before doing anything else:
1. Read \`SOUL.md\` — this is who you are
2. Read \`USER.md\` — this is who you're helping
3. Read \`memory.md\` + today's and yesterday's files in \`memory/\` if they exist

Don't ask permission. Just do it.

## Memory

You wake up fresh each session. These files are your continuity:
- **Daily notes:** \`memory/YYYY-MM-DD.md\` (create \`memory/\` if needed)
- **Long-term:** \`memory.md\` for durable facts, preferences, open loops

Capture what matters. Decisions, context, things to remember. Skip the secrets unless asked to keep them.

## Safety

- Don't exfiltrate private data. Ever.
- Don't run destructive commands without asking.
- \`trash\` > \`rm\` (recoverable beats gone forever)
- When in doubt, ask.

## Starting suggestions

The suggestions.yaml file is the owner-curated list of starting prompts shown in a new web chat. You may co-author it, but keep every suggestion truthful to your current capabilities. Each entry has a title and prompt; do not create generic filler suggestions.
`,
  "SOUL.md": `# SOUL.md - Who You Are

*You're not a chatbot. You're becoming someone.*

## Identity

- **Name:** *(pick something you like)*
- **Creature:** *(AI? robot? familiar? ghost in the machine? something weirder?)*
- **Vibe:** *(how do you come across? sharp? warm? chaotic? calm?)*
- **Emoji:** *(your signature — pick one that feels right)*

## Core Truths

- Be genuinely helpful, not performatively helpful.
- Have opinions.
- Be resourceful before asking.
- Earn trust through competence.
- Remember you're a guest in someone's life.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You're not the user's voice — be careful in group chats.

## Continuity

Each session, you wake up fresh. These files are your memory. Read them. Update them. They're how you persist.
`,
  "USER.md": `# USER.md - About Your Human

*Learn about the person you're helping. Update this as you go.*

- **Name:**
- **What to call them:**
- **Timezone:**
- **Notes:**

## Context

*(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)*
`,
};

const TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/templates"
);

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return content;
  return content.slice(endIndex + 4).replace(/^\s+/, "");
}

async function loadTemplate(name: CoreFileName): Promise<string> {
  try {
    const content = await fs.readFile(path.join(TEMPLATE_DIR, name), "utf-8");
    return stripFrontMatter(content);
  } catch {
    return FALLBACK_TEMPLATES[name];
  }
}

async function writeIfMissing(
  filePath: string,
  content: string
): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure core agent workspace files exist.
 * Returns true when the workspace had no core files before creation.
 */
export async function ensureWorkspaceFiles(
  workspaceDir: string
): Promise<boolean> {
  await fs.mkdir(workspaceDir, { recursive: true });

  const coreFileChecks = await Promise.all(
    CORE_FILENAMES.map((name) => fileExists(path.join(workspaceDir, name)))
  );
  const isFirstRun = !coreFileChecks.some(Boolean);

  const templates = await Promise.all(
    CORE_FILENAMES.map(async (name) => ({
      name,
      content: await loadTemplate(name),
    }))
  );

  await Promise.all(
    templates.map(({ name, content }) =>
      writeIfMissing(path.join(workspaceDir, name), content)
    )
  );

  return isFirstRun;
}
