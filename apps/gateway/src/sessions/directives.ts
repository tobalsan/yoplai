import type { ThinkLevel } from "@yoplai/shared";

// Aliases for think levels
const THINK_ALIASES: Record<string, ThinkLevel> = {
  min: "minimal",
  mid: "medium",
  med: "medium",
  max: "high",
  ultra: "high",
  none: "off",
};

// Valid think levels (including aliases)
const VALID_LEVELS = new Set<string>([
  "off", "minimal", "low", "medium", "high", "xhigh",
  ...Object.keys(THINK_ALIASES),
]);

export type ThinkDirectiveResult = {
  message: string;          // Stripped message
  hasDirective: boolean;    // /think found
  thinkLevel?: ThinkLevel;  // Parsed level (undefined if no arg)
  rawLevel?: string;        // Raw arg for error messages
};

/**
 * Parse /think, /think level, /think:level, /t, /t level, /t:level
 * Returns stripped message and parsed think level
 */
export function parseThinkDirective(message: string): ThinkDirectiveResult {
  const trimmed = message.trim();

  // Match patterns: /think, /think level, /think:level, /t, /t level, /t:level
  // Pattern: start with /think or /t, optionally followed by :level or space+level
  const match = trimmed.match(/^\/(?:think|t)(?::(\S+)|\s+(\S+))?(?:\s+(.*))?$/i);

  if (!match) {
    return { message, hasDirective: false };
  }

  const rawLevel = match[1] ?? match[2]; // colon-style or space-style
  const restMessage = match[3] ?? "";

  // No level argument - just /think or /t
  if (!rawLevel) {
    return {
      message: restMessage,
      hasDirective: true,
      thinkLevel: undefined,
      rawLevel: undefined,
    };
  }

  const normalizedLevel = rawLevel.toLowerCase();

  // Check if valid level or alias
  if (!VALID_LEVELS.has(normalizedLevel)) {
    return {
      message: restMessage,
      hasDirective: true,
      thinkLevel: undefined,
      rawLevel,
    };
  }

  // Resolve alias to canonical level
  const thinkLevel = (THINK_ALIASES[normalizedLevel] ?? normalizedLevel) as ThinkLevel;

  return {
    message: restMessage,
    hasDirective: true,
    thinkLevel,
    rawLevel,
  };
}
