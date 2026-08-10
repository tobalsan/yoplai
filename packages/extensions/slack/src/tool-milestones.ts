// Derives a friendly progress milestone label from a tool_call event's tool
// name, so the Slack progress bubble reflects what the agent is actually
// doing even when it never calls task.checkpoint.

const TASK_LIFECYCLE_PREFIXES = ["task.", "task_"];

const exactLabels: Record<string, string> = {
  read: "Reading files",
  write: "Editing files",
  edit: "Editing files",
  bash: "Running commands",
  extract_document: "Reading documents",
  describe_image: "Looking at an image",
};

const prefixLabels: [string, string][] = [
  ["notion_", "Working in Notion"],
  ["slack_", "Using Slack"],
  ["pennylane_", "Working in Pennylane"],
  ["pipedrive_", "Working in Pipedrive"],
  ["scheduler_", "Managing scheduled jobs"],
  ["web_search", "Searching the web"],
  ["websearch", "Searching the web"],
  ["fetch", "Searching the web"],
];

function humanize(name: string): string {
  const dotIndex = name.indexOf(".");
  const rest = dotIndex === -1 ? name : name.slice(dotIndex + 1);
  const words = rest.replace(/[_\-.]+/g, " ").trim().toLowerCase();
  return `Using ${words}`;
}

/**
 * Maps a tool_call event's tool `name` to a short progress milestone label,
 * or `undefined` when the tool is task lifecycle/bookkeeping and shouldn't
 * surface a milestone of its own (task.checkpoint already drives explicit
 * `progress` events).
 */
export function toolCallMilestone(name: string): string | undefined {
  if (TASK_LIFECYCLE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return undefined;
  }
  // Normalize dot/dash separators to underscores so namespaced tool names
  // (e.g. "slack.send_message") hit the same maps as underscore-style ones.
  const normalized = name.toLowerCase().replace(/[.-]/g, "_");
  if (normalized in exactLabels) return exactLabels[normalized];
  for (const [prefix, label] of prefixLabels) {
    if (normalized.startsWith(prefix)) return label;
  }
  return humanize(name);
}
