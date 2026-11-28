import { fetchRemote, LIST_TIMEOUT_MS } from "../relay/remote.js";
import { getLinkedGateways } from "../relay/state.js";
import type { RemoteGateway } from "../relay/store.js";

export type ReconcileOptions = { gateway: RemoteGateway; force: boolean };
type LinkAttempt = (gateway: RemoteGateway, signal: AbortSignal) => Promise<void>;

const RECONCILE_INTERVAL_MS = 60_000;

type LinkSync = {
  generation: RemoteGateway["generation"];
  unsynced: boolean;
  attemptsStarted: number;
  latestCompleted: number;
  lastReconcile?: number;
  reconciling?: { controller: AbortController; pending: Promise<void> };
};

export function createLinkedSync() {
  const states = new Map<string, LinkSync>();

  function currentLinks() {
    const links = getLinkedGateways();
    const current = new Map(links.map((gateway) => [gateway.name, gateway]));
    for (const [name, state] of states) {
      const gateway = current.get(name);
      if (!gateway || state.generation !== gateway.generation) {
        state.reconciling?.controller.abort();
        states.delete(name);
      }
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

  async function attempt(state: LinkSync, run: (signal: AbortSignal) => Promise<void>, superseded?: AbortSignal): Promise<void> {
    const id = ++state.attemptsStarted;
    let unsynced = false;
    try {
      const deadline = AbortSignal.timeout(LIST_TIMEOUT_MS);
      await run(superseded ? AbortSignal.any([deadline, superseded]) : deadline);
    } catch {
      unsynced = true;
    }
    // A pending attempt must leave the most recent completed result visible.
    if (!superseded?.aborted && id > state.latestCompleted) {
      state.latestCompleted = id;
      state.unsynced = unsynced;
    }
  }

  function unsyncedLinks(): string[] {
    return currentLinks().filter(({ name }) => states.get(name)?.unsynced).map(({ name }) => name);
  }

  return {
    async pushToLinks(run: LinkAttempt): Promise<string[]> {
      await Promise.all(currentLinks().map((gateway) =>
        attempt(stateFor(gateway), (signal) => run(gateway, signal))));
      return unsyncedLinks();
    },
    async reconcile(run: LinkAttempt, options?: ReconcileOptions): Promise<string[]> {
      const links = currentLinks();
      const target = options?.gateway;
      const selected = target
        ? links.filter(({ name, generation }) => name === target.name && generation === target.generation)
        : links;
      await Promise.all(selected.map((gateway) => {
        const state = stateFor(gateway);
        const startedAt = Date.now();
        if (!options?.force && state.lastReconcile !== undefined && startedAt - state.lastReconcile < RECONCILE_INTERVAL_MS) {
          return state.reconciling?.pending;
        }
        state.reconciling?.controller.abort();
        const controller = new AbortController();
        state.lastReconcile = startedAt;
        const pending = attempt(state, (signal) => run(gateway, signal), controller.signal).finally(() => {
          if (state.reconciling?.controller === controller) state.reconciling = undefined;
        });
        state.reconciling = { controller, pending };
        return pending;
      }));
      return unsyncedLinks();
    },
  };
}

async function requireOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  await response.body?.cancel();
  throw new Error("Linked gateway sync failed");
}

export async function readLinkedSetting(gateway: RemoteGateway, route: string, signal: AbortSignal): Promise<unknown> {
  const response = await requireOk(await fetchRemote(gateway, route + "?local=1", { signal }));
  return response.json();
}

export async function writeLinkedSetting(gateway: RemoteGateway, route: string, setting: unknown, signal: AbortSignal): Promise<void> {
  const response = await requireOk(await fetchRemote(gateway, route, {
    method: "PUT",
    body: JSON.stringify(setting),
    headers: { "content-type": "application/json" },
    signal,
  }));
  await response.arrayBuffer();
}
