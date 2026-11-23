import type { AgentConfig } from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import type { DurableHostOptions } from "./host.js";

export class DurableWeb {
  private readonly hosts = new Map<string, ReturnType<typeof import("./host.js").DurableHost.open>>();
  private closing?: Promise<void>;

  constructor(private readonly runtime: ExtensionRuntime, private readonly options: DurableHostOptions = {}) {}

  host(agent: AgentConfig) {
    if (this.closing) throw new Error("Gateway is shutting down.");
    let host = this.hosts.get(agent.id);
    if (!host) {
      host = import("./host.js").then(({ DurableHost }) => DurableHost.open(CONFIG_DIR, agent, this.runtime, this.options));
      this.hosts.set(agent.id, host);
      void host.catch(() => this.hosts.delete(agent.id));
    }
    return host;
  }

  close() {
    return this.closing ??= Promise.all([...this.hosts.values()].map(async (opening) => {
      const host = await opening.catch(() => undefined);
      await host?.close();
    })).then(() => undefined);
  }
}
