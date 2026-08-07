// Event payload types and event bus shared between gateway and extensions.

import { EventEmitter } from "node:events";
import { sanitizeForStorage } from "./sanitize.js";
import type { StreamEvent, HistoryEvent, AgentTraceContext } from "./types.js";
import type { LeadSessionChangedEvent } from "./lead-sessions/types.js";

export type RunSource =
  | "web"
  | "discord"
  | "slack"
  | "scheduler"
  | "cli"
  | "heartbeat"
  | "webhook";

export type AgentStreamEvent = StreamEvent & {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  source?: RunSource;
  trace?: AgentTraceContext;
};

export type AgentHistoryEvent = HistoryEvent & {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  source?: RunSource;
  trace?: AgentTraceContext;
};

export type AgentStatusChangeEvent = {
  agentId: string;
  /** Agent-wide aggregate status (streaming if any session is streaming). */
  status: "streaming" | "idle";
  /** The specific session whose streaming state changed. */
  sessionId: string;
  /** Streaming status of that specific session. */
  sessionStatus: "streaming" | "idle";
};

export type ProjectFileChangedEvent = {
  type: "file_changed";
  projectId: string;
  file: string;
};

export type ProjectAgentChangedEvent = {
  type: "agent_changed";
  projectId: string;
};

export type SubagentChangedEvent = {
  type: "subagent_changed";
  runId: string;
  parent?: { type: string; id: string };
  status: "starting" | "running" | "done" | "error" | "interrupted";
};

export class AgentEventBus extends EventEmitter {
  private recentEvents: Array<{
    type: string;
    data: unknown;
    timestamp: number;
  }> = [];
  private maxRecentEvents = 50;

  recordEvent(type: string, data: unknown) {
    this.recentEvents.push({ type, data, timestamp: Date.now() });
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.shift();
    }
  }

  getRecentEvents() {
    return [...this.recentEvents];
  }

  emitStreamEvent(event: AgentStreamEvent) {
    this.emit("stream", sanitizeForStorage(event));
  }

  onStreamEvent(handler: (event: AgentStreamEvent) => void) {
    this.on("stream", handler);
    return () => this.off("stream", handler);
  }

  emitHistoryEvent(event: AgentHistoryEvent) {
    this.emit("history", sanitizeForStorage(event));
  }

  onHistoryEvent(handler: (event: AgentHistoryEvent) => void) {
    this.on("history", handler);
    return () => this.off("history", handler);
  }

  emitStatusChange(event: AgentStatusChangeEvent) {
    this.recordEvent("statusChange", event);
    this.emit("statusChange", event);
  }

  onStatusChange(handler: (event: AgentStatusChangeEvent) => void) {
    this.on("statusChange", handler);
    return () => this.off("statusChange", handler);
  }

  emitFileChanged(event: ProjectFileChangedEvent) {
    this.recordEvent("fileChanged", event);
    this.emit("fileChanged", event);
  }

  onFileChanged(handler: (event: ProjectFileChangedEvent) => void) {
    this.on("fileChanged", handler);
    return () => this.off("fileChanged", handler);
  }

  emitAgentChanged(event: ProjectAgentChangedEvent) {
    this.recordEvent("agentChanged", event);
    this.emit("agentChanged", event);
  }

  onAgentChanged(handler: (event: ProjectAgentChangedEvent) => void) {
    this.on("agentChanged", handler);
    return () => this.off("agentChanged", handler);
  }

  emitLeadSessionChanged(event: LeadSessionChangedEvent) {
    this.recordEvent("leadSessionChanged", event);
    this.emit("lead_session.changed", event);
  }

  onLeadSessionChanged(handler: (event: LeadSessionChangedEvent) => void) {
    this.on("lead_session.changed", handler);
    return () => this.off("lead_session.changed", handler);
  }
}

export const agentEventBus = new AgentEventBus();
