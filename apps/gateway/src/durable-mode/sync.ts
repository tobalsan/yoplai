import { fetchRemote, LIST_TIMEOUT_MS } from "../relay/remote.js";
import { getLinkedGateways } from "../relay/state.js";
import type { RemoteGateway } from "../relay/store.js";
import { durableModeTime, type DurableMode, type DurableModeStore } from "./store.js";

const route = "/api/me/durable-mode";
const RECONCILE_INTERVAL_MS = 60_000;

type LinkSync = {
  generation: RemoteGateway["generation"];
  unsynced: boolean;
  attemptsStarted: number;
  latestCompleted: number;
  lastReconcile?: number;
  reconciling?: Promise<void>;
};

function createDurableModeSync(getGateways: () => RemoteGateway[], remoteFetch: typeof fetchRemote, now: () => number) {
  const states = new Map<string, LinkSync>();

  function currentLinks() {
    const links = getGateways();
    const current = new Map(links.map((gateway) => [gateway.name, gateway]));
    for (const [name, state] of states) {
      const gateway = current.get(name);
      if (!gateway || state.generation !== gateway.generation) states.delete(name);
    }
    return links;
  }

  function stateFor(gateway: RemoteGateway): LinkSync {
    const existing = states.get(gateway.name);
    if (existing) return existing;
    const state = { generation: gateway.generation, unsynced: false, attemptsStarted: 0, latestCompleted: 0 };
    states.set(gateway.name, state);
    return state;
  }

  async function attempt(state: LinkSync, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const id = ++state.attemptsStarted;
    let unsynced = false;
    try {
      await run(AbortSignal.timeout(LIST_TIMEOUT_MS));
    } catch {
      unsynced = true;
    }
    // A pending attempt must leave the most recent completed result visible.
    if (id > state.latestCompleted) {
      state.latestCompleted = id;
      state.unsynced = unsynced;
    }
  }

  function unsyncedLinks(): string[] {
    return currentLinks().filter(({ name }) => states.get(name)?.unsynced).map(({ name }) => name);
  }

  async function requireOk(response: Response): Promise<Response> {
    if (response.ok) return response;
    await response.body?.cancel();
    throw new Error("Durable mode sync failed");
  }

  async function writeRemote(gateway: RemoteGateway, local: DurableMode, signal: AbortSignal): Promise<void> {
    const response = await requireOk(await remoteFetch(gateway, route, {
      method: "PUT",
      body: JSON.stringify(local),
      headers: { "content-type": "application/json" },
      signal,
    }));
    await response.arrayBuffer();
  }

  async function reconcileLink(store: DurableModeStore, gateway: RemoteGateway, signal: AbortSignal): Promise<void> {
    const local = await store.read();
    const response = await requireOk(await remoteFetch(gateway, route + "?local=1", { signal }));
    const remote = await response.json() as Partial<DurableMode> | null;
    if (typeof remote?.enabled !== "boolean") throw new Error("Invalid remote Durable mode");
    const localTime = durableModeTime(local.updatedAt);
    const remoteTime = durableModeTime(remote.updatedAt);
    if (remoteTime > localTime) {
      await store.set(remote.enabled, remote.updatedAt);
    } else if (localTime > remoteTime) {
      await writeRemote(gateway, local, signal);
    }
  }

  return {
    async pushToLinks(local: DurableMode): Promise<string[]> {
      await Promise.all(currentLinks().map((gateway) =>
        attempt(stateFor(gateway), (signal) => writeRemote(gateway, local, signal))));
      return unsyncedLinks();
    },
    async reconcile(store: DurableModeStore, options?: { gateway: RemoteGateway; force: boolean }): Promise<string[]> {
      const links = currentLinks();
      const target = options?.gateway;
      const selected = target
        ? links.filter(({ name, generation }) => name === target.name && generation === target.generation)
        : links;
      await Promise.all(selected.map((gateway) => {
        const state = stateFor(gateway);
        const startedAt = now();
        if (!options?.force && state.lastReconcile !== undefined && startedAt - state.lastReconcile < RECONCILE_INTERVAL_MS) {
          return state.reconciling;
        }
        state.lastReconcile = startedAt;
        const pending = attempt(state, (signal) => reconcileLink(store, gateway, signal)).finally(() => {
          if (state.reconciling === pending) state.reconciling = undefined;
        });
        state.reconciling = pending;
        return pending;
      }));
      return unsyncedLinks();
    },
  };
}

export const durableModeSync = createDurableModeSync(() => getLinkedGateways(), fetchRemote, () => Date.now());
