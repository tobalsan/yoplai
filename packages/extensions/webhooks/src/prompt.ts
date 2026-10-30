import fs from "node:fs/promises";
import path from "node:path";
import { ThinkLevelSchema } from "@yoplai/shared";
import { load } from "js-yaml";
import { z } from "zod";

const WebhookPromptOptionsSchema = z
  .object({
    model: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
      })
      .strict()
      .optional(),
    reasoning: ThinkLevelSchema.optional(),
    script: z.string().min(1).optional(),
    scriptTimeoutMs: z.number().positive().default(30_000),
  })
  .strict();

export type WebhookPrompt = {
  prompt: string;
  options: z.input<typeof WebhookPromptOptionsSchema>;
};

export class WebhookPromptError extends Error {
  constructor(promptFile: string, problem: unknown) {
    super(
      `Invalid webhook frontmatter in ${promptFile}: ${problem instanceof Error ? problem.message : String(problem)}`
    );
  }
}

export type WebhookPromptVariables = {
  originUrl: string;
  headers: Record<string, string>;
  payload: string;
  gateContext?: string;
};

const PROMPT_FILE_EXTENSIONS = new Set([".md", ".txt"]);

export async function resolveWebhookPrompt(
  prompt: string,
  workspaceDir: string
): Promise<WebhookPrompt> {
  const ext = path.extname(prompt).toLowerCase();
  if (!PROMPT_FILE_EXTENSIONS.has(ext)) return { prompt, options: {} };

  const workspaceRoot = path.resolve(workspaceDir);
  const promptPath = path.resolve(workspaceRoot, prompt);
  if (
    promptPath !== workspaceRoot &&
    !promptPath.startsWith(workspaceRoot + path.sep)
  ) {
    throw new Error("Webhook prompt path must stay within agent workspace");
  }

  const content = await fs.readFile(promptPath, "utf8");
  const frontmatter = /^(?:---\r?\n)([\s\S]*?)^---(?:\r?\n|$)/m.exec(content);
  if (!frontmatter || frontmatter.index !== 0)
    return { prompt: content, options: {} };

  try {
    const parsed = load(frontmatter[1]!);
    const empty = frontmatter[1]!
      .split(/\r?\n/)
      .every((line) => !line.trim() || line.trimStart().startsWith("#"));
    return {
      prompt: content.slice(frontmatter[0].length),
      options: WebhookPromptOptionsSchema.parse(empty ? {} : parsed),
    };
  } catch (err) {
    throw new WebhookPromptError(prompt, err);
  }
}

export function interpolateWebhookPrompt(
  prompt: string,
  variables: WebhookPromptVariables
): string {
  const replacements: Record<string, string> = {
    $WEBHOOK_ORIGIN_URL: variables.originUrl,
    $WEBHOOK_HEADERS: JSON.stringify(variables.headers),
    $WEBHOOK_PAYLOAD: variables.payload,
    $WEBHOOK_GATE_CONTEXT: variables.gateContext ?? "",
  };
  return prompt.replace(
    /\$WEBHOOK_(?:ORIGIN_URL|HEADERS|PAYLOAD|GATE_CONTEXT)/g,
    (variable) => replacements[variable]!
  );
}
