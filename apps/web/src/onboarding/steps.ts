export type TourAdvance = "next" | "click" | "done";

export type TourStep = {
  /** Matches the router path (base stripped) where this step is shown. */
  route: RegExp;
  /** Resolves the highlighted element; null target is a centered popover. */
  target: ((root: ParentNode) => Element | null) | null;
  title: string;
  description: string;
  advance: TourAdvance;
  nextLabel?: string;
  skipLabel?: string;
  /** Popover side; panels use "top" so the list stays visible. */
  side?: "top" | "bottom" | "left" | "right";
  /** Runs before the target lookup, e.g. to open the tab being explained. */
  prepare?: (root: ParentNode) => void;
  /** Also advance when Enter (without Shift) is pressed in the composer. */
  advanceOnEnter?: boolean;
  /** Suggested chat request offered with a "Use this" button. */
  suggestion?: string;
};

const HOME = /^\/(agents)?\/?$/;
const AGENT_EDIT = /^\/agents\/[^/]+\/edit\/?$/;
const EXTENSION_DETAILS = /^\/agents\/[^/]+\/extensions\/[^/]+/;
const CHAT = /^\/chat\/[^/]+/;

export const CHAT_SUGGESTION =
  "Create a simple dashboard that explains what you can do for me";

const byTour = (root: ParentNode, name: string) =>
  root.querySelector(`[data-tour="${name}"]`);

function extensionTarget(root: ParentNode): Element | null {
  return (
    root.querySelector('[data-tour="ext-add"][data-tour-ext="gmail"]') ??
    root.querySelector('[data-tour="ext-card"][data-tour-ext="gmail"]') ??
    byTour(root, "ext-add") ??
    byTour(root, "ext-card")
  );
}

export const TOUR_STEPS: TourStep[] = [
  {
    route: HOME,
    target: null,
    title: "Welcome to {brand}",
    description: "Take a quick tour to see how agents, extensions and dashboards fit together.",
    advance: "next",
    nextLabel: "Take the tour",
    skipLabel: "Skip",
  },
  {
    route: HOME,
    target: (r) => byTour(r, "agent-grid"),
    title: "Your team of AI agents",
    description: "Each agent has its own purpose.",
    advance: "next",
  },
  {
    route: HOME,
    target: (r) => byTour(r, "agent-edit"),
    title: "Agent settings",
    description: "Click the edit icon to open the agent settings.",
    advance: "click",
  },
  {
    route: AGENT_EDIT,
    target: extensionTarget,
    title: "Extensions",
    description: "Extensions give the agent tools. Click + to connect your Gmail.",
    advance: "click",
  },
  {
    route: EXTENSION_DETAILS,
    target: (r) => byTour(r, "cred-tabs"),
    title: "Who will use these credentials?",
    description: "<b>Just me</b>: only used by you.<br><b>Whole team</b>: can be used by the whole team.",
    advance: "next",
  },
  {
    route: EXTENSION_DETAILS,
    target: (r) => byTour(r, "oauth-connect"),
    title: "Connect your account",
    description: "Connect your own account here. This is optional; you can do it later.",
    advance: "next",
  },
  {
    route: EXTENSION_DETAILS,
    target: (r) => byTour(r, "back-to-agent"),
    title: "Back to the agent",
    description: "Click to go back to the agent.",
    advance: "click",
  },
  {
    route: AGENT_EDIT,
    prepare: (r) => (byTour(r, "tab-connections") as HTMLElement | null)?.click(),
    target: (r) => byTour(r, "panel-connections"),
    side: "top",
    title: "My connections",
    description: "Manage your connections and see what is enabled for this agent.",
    advance: "next",
  },
  {
    route: AGENT_EDIT,
    prepare: (r) => (byTour(r, "tab-dashboards") as HTMLElement | null)?.click(),
    target: (r) => byTour(r, "panel-dashboards"),
    side: "top",
    title: "Dashboards",
    description: "Dashboards created by the agent show up here.",
    advance: "next",
  },
  {
    route: AGENT_EDIT,
    target: (r) => byTour(r, "back-to-agents"),
    title: "Back to agents",
    description: "Click to return to all agents.",
    advance: "click",
  },
  {
    route: HOME,
    target: (r) => byTour(r, "agent-chat"),
    title: "Start chatting",
    description: "Chat starts a new session with this agent.",
    advance: "click",
  },
  {
    route: CHAT,
    target: (r) => byTour(r, "composer"),
    title: "Try a first request",
    description: `Suggested: "${CHAT_SUGGESTION}"`,
    advance: "done",
    nextLabel: "Done",
    suggestion: CHAT_SUGGESTION,
  },
  {
    // Reached only via "Use this" on the previous step.
    route: CHAT,
    target: (r) => byTour(r, "send"),
    title: "Send it",
    description: "Click here to send your message or press Enter.",
    advance: "click",
    advanceOnEnter: true,
  },
];
