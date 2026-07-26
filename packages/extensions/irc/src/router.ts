import type { AgentConfig, ExtensionContext, IrcContext, IrcExtensionConfig } from "@yoplai/shared";
import { IrcLoopGuard } from "./loop-guard.js";
import { isAddressed, nickFromPrefix, normalizeIrcText, splitIrcText, toPlainIrcText, type IrcMessage } from "./protocol.js";
import type { IrcService } from "./service.js";
type History = { sender: string; text: string }[];
export class IrcRouter {
  private history = new Map<string, History>(); private guard: IrcLoopGuard;
  private pending = new Map<string, { timer: NodeJS.Timeout; content: string; agent: string; sender: string; destination: string; key: string; isChannel: boolean }>();
  private stopped = false;
  constructor(private ctx: ExtensionContext, private config: IrcExtensionConfig, private service: Pick<IrcService, "send" | "nick">, private ownerAgentId?: string) { this.guard = new IrcLoopGuard(config.maxA2ATurns, config.humanNicks); }
  handle(message: IrcMessage): void {
    if (message.command !== "PRIVMSG" || !message.params[0] || !message.trailing) return;
    const sender = nickFromPrefix(message.prefix); const target = message.params[0]; if (!sender || sender.toLowerCase() === this.service.nick.toLowerCase()) return;
    if (this.stopped) return;
    const isChannel = target.startsWith("#") || target.startsWith("&"); const text = normalizeIrcText(message.trailing); const key = isChannel ? target.toLowerCase() : sender.toLowerCase();
    const isHuman = this.config.humanNicks.some((nick) => nick.toLowerCase() === sender.toLowerCase());
    if (isChannel && isHuman) this.guard.allow(target, sender);
    if (!isChannel && this.config.dm?.allowFrom?.length && !this.config.dm.allowFrom.some((nick) => nick.toLowerCase() === sender.toLowerCase())) return;
    const route = isChannel ? Object.entries(this.config.channels).find(([channel]) => channel.toLowerCase() === target.toLowerCase())?.[1] : this.config.dm?.enabled === true && this.config.dm.agent ? { agent: this.config.dm.agent, mode: "reply-all" as const } : undefined;
    if (!route?.agent || !this.enabled(route.agent)) return;
    this.record(key, sender, text);
    const batchKey = isChannel ? `${key}:${sender.toLowerCase()}` : key;
    const addressed = isAddressed(text, this.service.nick);
    if (isChannel && route.mode === "mention-only" && !addressed.addressed) { const pending = this.pending.get(batchKey); if (pending) pending.content += `\n${text}`; return; }
    const content = addressed.text.trim() || text;
    const debounceMs = isChannel ? this.config.debounceMs : this.config.dm?.debounceMs;
    const pending = debounceMs ? this.pending.get(batchKey) : undefined;
    if (pending) { pending.content += `\n${content}`; return; }
    if (isChannel && !isHuman && !this.guard.allow(target, sender)) { console.warn(`[irc] A2A cap reached in ${target}`); return; }
    if (debounceMs) { const destination = isChannel ? target : sender; const timer = setTimeout(() => { const item = this.pending.get(batchKey); if (!item) return; this.pending.delete(batchKey); if (!this.enabled(item.agent)) return; this.run(item.agent, item.content, item.destination, item.key, item.isChannel, item.sender); }, debounceMs); this.pending.set(batchKey, { timer, content, agent: route.agent, sender, destination, key, isChannel }); return; }
    this.run(route.agent, content, isChannel ? target : sender, key, isChannel, sender);
  }
  stop(): void { this.stopped = true; for (const { timer } of this.pending.values()) clearTimeout(timer); this.pending.clear(); }
  private run(agentId: string, content: string, destination: string, key: string, isChannel: boolean, sender = destination): void {
    if (this.stopped) return;
    const context: IrcContext = { kind: "irc", blocks: [{ type: "metadata", channel: "irc", place: isChannel ? destination : `direct message / ${sender}`, conversationType: isChannel ? "channel_message" : "direct_message", sender }, { type: "history", messages: (this.history.get(key) ?? []).map((entry) => ({ author: entry.sender, content: entry.text, timestamp: Date.now() })) }] };
    this.service.send(destination, "👀");
    void this.ctx.runAgent({ agentId, message: content, sessionKey: `irc:${key}`, source: "irc", context }).then(async (result) => { for (const payload of result.payloads) for (const part of splitIrcText(toPlainIrcText(payload.text ?? ""))) { if (this.stopped) return; this.service.send(destination, part); await new Promise((resolve) => setTimeout(resolve, 400)); } }).catch((error) => { if (!this.stopped) console.error("[irc] agent run failed:", error); });
  }
  private enabled(agentId: string): boolean { const agent: AgentConfig | undefined = this.ctx.getAgent(agentId); const eligible = this.ownerAgentId === agentId || agent?.extensions?.irc?.enabled === true; return !!agent && eligible && this.ctx.isAgentActive(agentId); }
  private record(key: string, sender: string, text: string): void { const entries = this.history.get(key) ?? []; entries.push({ sender, text }); while (entries.length > this.config.historyLimit) entries.shift(); this.history.set(key, entries); }
}
