import { releaseCatalogChanged } from "../api/release-catalog";
import { decodeRouteParam } from "../lib/path";
import {
  createComputed,
  createMemo,
  createResource,
  createEffect,
  createSignal,
  For,
  onCleanup,
  untrack,
  Show,
} from "solid-js";
import { A, useLocation, useParams } from "@solidjs/router";
import { normalizeMcpServerUrl } from "@yoplai/shared/mcp-url";
import { EMPTY_TOP_EXTENSIONS, fetchTopExtensions } from "../api/top-extensions";
import { gatewayApiPath, gatewayKey, qualifiedAgentId, qualifyAgentRoute, rawAgentId, type GatewayName } from "../api/gateway";
import { useAgentTarget } from "../lib/agent-target";
import { RequesterFailure } from "../lib/page-visit";
import { useRequester } from "../lib/requester";
import { createResourceKey } from "../lib/resource-key";
import { createOAuthPopupFlow, type OAuthVerdict } from "../lib/oauth-popup-flow";
import { fetchMcpStatus, type McpServerStatus } from "../api/connections";
import { fetchAgentDashboards, fetchAgents, fetchPool } from "../api";
import type { AgentDashboard } from "../api/agents";
import {
  detailsPath,
  fetchAgentExtensions,
  type ExtensionCatalogEntry,
} from "../api/extensions";
import {
  fetchForks,
  fetchPoolActions,
  fetchTeams,
  setForkTeams,
  setForkVisibility,
  type AgentFork,
  type Team,
} from "../api/teams";
import { ToastNotification, type ToastVariant } from "../components/ui/Toast";
import { SchedulesPanel } from "./SchedulesPanel";
import { AgentConnectionsPanel } from "../components/AgentConnectionsPanel";
import { McpExtensionCard, MCP_EXTENSION_STYLES } from "../components/McpExtensionCard";
import { addMcpServer, mcpDisplayName, fetchMcpServer, fetchMcpServersFast, type McpScope, type McpServer } from "../api/mcp-servers";
import { onOAuthReturn } from "../lib/oauth-popup";
import { readOAuthResult } from "../lib/oauth-return";
import { claimDashboard } from "../api/dashboards";
import { DashboardListActions, DashboardListRow, dashboardOpenHref, ownershipLabel } from "../components/DashboardListRow";
import { DashboardAccessDialog } from "../components/DashboardAccessDialog";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { teamRemovalWarning } from "../lib/team-removal";
import { usePrivateItemsVisibility, visibleDashboards } from "../lib/private-items";
import { defaultAvatarUrl } from "../lib/default-avatar";

const DUPLICATE_MCP_MESSAGE = "This MCP server has already been added.";

function isEmoji(str: string): boolean {
  return /^\p{Emoji}/u.test(str) && str.length <= 4;
}

function dashboardSections(dashboards: AgentDashboard[]) {
  const bySlug = new Map(dashboards.map((dashboard) => [dashboard.slug, dashboard]));
  const top = dashboards.filter((dashboard) => dashboard.params.length === 0);
  const usedBy = new Map<string, AgentDashboard[]>();
  for (const root of top) {
    const seen = new Set<string>();
    const visit = (dashboard: AgentDashboard) => {
      for (const slug of dashboard.linksTo) {
        const child = bySlug.get(slug);
        if (!child?.params.length || seen.has(slug)) continue;
        seen.add(slug);
        usedBy.set(slug, [...(usedBy.get(slug) ?? []), root]);
        visit(child);
      }
    };
    visit(root);
  }
  const sub = dashboards.filter((dashboard) => dashboard.params.length > 0)
    .map((dashboard) => ({ dashboard, usedBy: usedBy.get(dashboard.slug) ?? [] }));
  return { top, sub };
}

// Team assignment for the edit page: assign a never-forked pool agent to a
// team, or move an already-forked agent between teams. Reuses the same
// admin-guarded fork APIs the catalog cards used before this control moved here.
function TeamAssignment(props: {
  poolId: string;
  agentName: string;
  teams: Team[];
  fork: AgentFork | undefined;
  /** Admins may only (un)assign their own teams. */
  superadmin: boolean;
  /** Linked gateway that owns the pool. Absent for the local pool. */
  gateway?: GatewayName;
  onChanged: () => void;
}) {
  // The page mounts a new control for each gateway and pool. This control reads that identity once,
  // and an answer after it is gone changes nothing.
  const bound = { poolId: props.poolId, gateway: props.gateway };
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const [selected, setSelected] = createSignal<string[]>(props.fork?.assignment.teamIds ?? []);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    const assignment = props.fork?.assignment;
    setSelected(assignment?.teamIds ?? []);
  });

  const handleAssign = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      // Admins send only their own teams; the server keeps other teams' links.
      const own = new Set(props.teams.map((team) => team.id));
      const teamIds = props.superadmin ? selected() : selected().filter((id) => own.has(id));
      await setForkTeams(bound.poolId, { mode: "list", teamIds }, bound.gateway);
      if (!disposed) props.onChanged();
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Failed to assign.");
    } finally {
      if (!disposed) setBusy(false);
    }
  };

  // Dirty state compares current selection against the last-synced fork
  // assignment, so the Save/Cancel row only appears when there's something
  // to persist or discard.
  const baseline = () => props.fork?.assignment.teamIds ?? [];
  const dirty = createMemo(() => {
    const ids = selected();
    const saved = baseline();
    return ids.length !== saved.length || ids.some((id) => !saved.includes(id));
  });
  const reset = () => setSelected(baseline());
  // Saving without a team the agent had asks first: its members lose access.
  const removedTeams = () => props.teams.filter((team) => baseline().includes(team.id) && !selected().includes(team.id));
  const [confirmRemoval, setConfirmRemoval] = createSignal(false);
  const save = () => {
    if (removedTeams().length > 0) setConfirmRemoval(true);
    else void handleAssign();
  };

  return (
    <section class="edit-agent-team">
      <div class="edit-agent-team-head">
        <h2 class="edit-agent-section-title">Teams</h2>
        <Show when={dirty()}>
          <div class="edit-agent-team-actions">
            <button type="button" class="edit-agent-team-cancel" disabled={busy()} onClick={reset}>Cancel</button>
            <button type="button" class="edit-agent-team-button" disabled={busy()} onClick={save}>Save</button>
          </div>
        </Show>
      </div>
      <div class="edit-agent-team-pills">
        <For each={props.teams}>{(team) => (
          <button
            type="button"
            class="edit-agent-team-pill"
            classList={{ selected: selected().includes(team.id) }}
            aria-pressed={selected().includes(team.id)}
            disabled={busy()}
            onClick={() => setSelected((ids) => ids.includes(team.id) ? ids.filter((id) => id !== team.id) : [...ids, team.id])}
          >
            {team.name}
          </button>
        )}</For>
      </div>
      <Show when={error()}>
        {(message) => <p class="edit-agent-team-error">{message()}</p>}
      </Show>
      <Show when={confirmRemoval()}>
        <ConfirmDialog
          title={`Remove ${props.agentName} from ${removedTeams().map((team) => team.name).join(", ")}?`}
          description={teamRemovalWarning(props.agentName, removedTeams().map((team) => team.name).join(", "), selected().length === 0, props.fork?.public === true)}
          confirmLabel="Remove"
          danger
          onConfirm={async () => {
            await handleAssign();
            setConfirmRemoval(false);
          }}
          onCancel={() => setConfirmRemoval(false)}
        />
      </Show>
    </section>
  );
}

function ForkVisibility(props: { fork: AgentFork; canManage: boolean; gateway?: GatewayName; onChanged: () => unknown }) {
  // One control per gateway and pool. It reads its identity once, and an answer after it is gone changes nothing.
  const bound = { gateway: props.gateway };
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const toggle = async () => {
    if (busy() || !props.canManage) return;
    const poolId = props.fork.sourcePoolId;
    const isPublic = props.fork.public;
    setBusy(true);
    setError(undefined);
    try {
      await setForkVisibility(poolId, !isPublic, bound.gateway);
      if (!disposed) await props.onChanged();
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Failed to update visibility.");
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  const tooltip = () => {
    const access = props.fork.public
      ? "Public: every user can chat with this agent."
      : "Private: only members of the assigned teams can chat with this agent.";
    return props.canManage ? `${access} Click to make it ${props.fork.public ? "private" : "public"}.` : access;
  };
  return (
    <>
      {/* The title sits on a wrapper because disabled buttons do not always show it. */}
      <span class="edit-agent-visibility" title={tooltip()}>
        <button type="button" class="edit-agent-visibility-toggle" aria-label="Agent visibility" aria-pressed={props.fork.public} disabled={busy() || !props.canManage} onClick={() => void toggle()}>
          <i class={props.fork.public ? "fa-solid fa-globe" : "fa-solid fa-lock"} aria-hidden="true" />
          {busy() ? "Saving…" : props.fork.public ? "Public" : "Private"}
        </button>
      </span>
      <Show when={error()}>{(message) => <p role="alert" class="edit-agent-team-error edit-agent-visibility-error">{message()}</p>}</Show>
    </>
  );
}

export function EditAgent() {
  const routeParams = useParams<{ agentId: string }>();
  const params = { get agentId() { return decodeRouteParam(routeParams.agentId); } };
  // The chat cog passes its page in history state so Back returns there.
  const location = useLocation<{ backTo?: string }>();
  const backTo = () => {
    const target = location.state?.backTo;
    return typeof target === "string" && target.startsWith("/") && !target.startsWith("//") ? target : undefined;
  };
  // The agent route holds the qualified ID. The page resolves its gateway once from the local agent list.
  const { target, retry: retryTarget } = useAgentTarget(() => params.agentId);
  const targetReady = () => target().state === "ready";
  const gateway = (): GatewayName => { const current = target(); return current.state === "ready" ? current.gateway : undefined; };
  // Everything below that asks "who am I" uses the requester of this agent's gateway, never the local session.
  const requester = useRequester(gateway);
  const { showPrivateItems, togglePrivateItems } = usePrivateItemsVisibility();
  const isAdmin = createMemo(() => requester().isStaff);
  // Superadmins see every agent; admins are scoped to their teams.
  const isSuperadmin = createMemo(() => requester().isSuperadmin);
  // A page is ready when its gateway is resolved and the requester context of that gateway is loaded.
  const contextReady = () => targetReady() && requester().ready;
  const forkedAgents = () => requester().forkedAgents;
  // Pool rows carry raw remote IDs. Chat agent rows carry qualified IDs.
  const rawId = () => rawAgentId(params.agentId, gateway());
  const poolKey = () => (forkedAgents() ? rawId() : params.agentId);
  const qualify = (id: string | undefined) => (id === undefined ? undefined : qualifiedAgentId(id, gateway()));

  const [agents] = createResource(
    createResourceKey(() => (contextReady() ? { gateway: gateway(), pool: forkedAgents() } : null)),
    ({ gateway: host, pool }) => (pool ? fetchPool(host) : fetchAgents())
  );
  const [activeAgents] = createResource(
    createResourceKey(() => (contextReady() ? { pool: forkedAgents() } : null)),
    ({ pool }) => (pool ? fetchAgents() : Promise.resolve([]))
  );
  // Reading a failed resource throws, so a failed remote read must show as "no data", not a blank page.
  const poolAgent = createMemo(() =>
    (agents.error ? [] : agents() ?? []).find((candidate) => candidate.id === poolKey())
  );
  const activeAgent = createMemo(() =>
    (activeAgents.error ? [] : activeAgents() ?? []).find((candidate) => candidate.id === params.agentId)
  );
  const agent = createMemo(() =>
    poolAgent() ?? (!agents.loading ? activeAgent() : undefined)
  );

  const [teams] = createResource(
    createResourceKey(() => (contextReady() ? { gateway: gateway(), admin: isAdmin() && forkedAgents() } : null)),
    ({ gateway: host, admin }) => (admin ? fetchTeams(host) : Promise.resolve([] as Team[]))
  );
  const [forks, { refetch: refetchForks }] = createResource(
    createResourceKey(() => (contextReady() ? { gateway: gateway(), admin: isAdmin() && forkedAgents() } : null)),
    ({ gateway: host, admin }) => (admin ? fetchForks(host) : Promise.resolve([] as AgentFork[]))
  );
  const teamList = () => (teams.error ? [] : teams() ?? []);
  const fork = createMemo(() =>
    (forks.error ? [] : forks() ?? []).find((entry) => entry.sourcePoolId === rawId() || entry.forkAgentId === rawId())
  );
  const canManageFork = createMemo(() => isSuperadmin() || Boolean(fork()?.assignment.teamIds.some((id) => teamList().some((team) => team.id === id && team.canManage))));
  const [poolActions] = createResource(
    createResourceKey(() => (contextReady() ? { gateway: gateway(), enabled: forkedAgents() && !isSuperadmin() } : null)),
    ({ gateway: host, enabled }) => (enabled ? fetchPoolActions(host) : Promise.resolve([]))
  );
  const dashboardAgentId = createMemo(() =>
    forkedAgents()
      ? poolAgent()
        ? (isSuperadmin() ? qualify(fork()?.forkAgentId) : undefined) ?? qualify((poolActions.error ? undefined : poolActions())?.find((entry) =>
            entry.poolId === rawId() && entry.action === "chat"
          )?.chatAgentId ?? undefined)
        : !agents.loading ? activeAgent()?.id : undefined
      : params.agentId
  );
  // Resource keys hold the gateway, so equal object IDs on two gateways never share data.
  const agentKey = createResourceKey(() => { const id = dashboardAgentId(); return id === undefined || !contextReady() ? null : { id, gateway: gateway() }; });
  const [tab, setTab] = createSignal<"extensions" | "connections" | "dashboards" | "schedules">("extensions");
  createEffect(() => {
    if (new URLSearchParams(location.search).get("tab") === "schedules") setTab("schedules");
  });
  const [dashboards, { refetch: refetchDashboards }] = createResource(
    createResourceKey(() => tab() === "dashboards" ? agentKey() : null),
    (key) => fetchAgentDashboards(key.id, key.gateway)
  );
  const [accessDashboard, setAccessDashboard] = createSignal<AgentDashboard>();
  const [claimTarget, setClaimTarget] = createSignal<AgentDashboard>();
  const [claimError, setClaimError] = createSignal<string>();
  const visibleAgentDashboards = createMemo(() => visibleDashboards(
    dashboards.loading || dashboards.error ? [] : dashboards() ?? [],
    isSuperadmin() ? requester().user?.id : undefined,
    showPrivateItems(),
  ));
  const sections = createMemo(() => dashboardSections(visibleAgentDashboards()));
  const openClaim = (dashboard: AgentDashboard) => { setClaimError(undefined); setClaimTarget(dashboard); };
  // A new agent or gateway drops dialogs of the old one, so no action runs against another gateway.
  createEffect(() => {
    void dashboardAgentId();
    void gateway();
    setAccessDashboard(undefined);
    setClaimTarget(undefined);
    setClaimError(undefined);
  });

  const [extensions, { refetch: refetchExtensions }] = createResource(
    createResourceKey(() => {
      const id = contextReady() ? (dashboardAgentId() ?? (isAdmin() ? params.agentId : null)) : null;
      return id ? { id, gateway: gateway() } : null;
    }),
    (key) => fetchAgentExtensions(key.id, key.gateway)
  );
  const refreshInstalled = (event: Event) => {
    if (event instanceof CustomEvent && event.detail === gateway()) void refetchExtensions();
  };
  window.addEventListener(releaseCatalogChanged, refreshInstalled);
  onCleanup(() => window.removeEventListener(releaseCatalogChanged, refreshInstalled));
  const extensionCatalog = () => extensions.error ? [] : extensions() ?? [];
  // Without the mcp extension on the gateway, the page reads no MCP servers and shows no MCP control.
  const mcpAvailable = () => requester().isExtensionEnabled("mcp");
  // A known single-user gateway has no personal connections.
  const singleUser = () => requester().ready && !requester().unknown && !requester().multiUser;
  const [mcpServers, { refetch: refetchMcpServers }] = createResource(
    createResourceKey(() => (mcpAvailable() ? agentKey() : null)),
    async (key) => ({ agentId: key.id, gateway: key.gateway, list: await fetchMcpServersFast(key.id, undefined, key.gateway) })
  );
  const mcpStatus = createMemo(() => {
    const loaded = !mcpServers.error && ["ready", "refreshing"].includes(mcpServers.state) ? mcpServers.latest : undefined;
    return loaded?.agentId === dashboardAgentId() && loaded?.gateway === gateway() ? loaded?.list : undefined;
  });
  const [liveServers, setLiveServers] = createSignal<Record<string, { server?: McpServer; checking: boolean; failed: boolean }>>({});
  let generation = 0;
  const requests = new Map<string, number>();
  createEffect(() => {
    void dashboardAgentId();
    void gateway();
    generation++;
    requests.clear();
    setLiveServers({});
  });
  onCleanup(() => { generation++; });
  // `quiet` keeps the last result on screen (focus and OAuth-return refresh), so cards do not flash on each tab switch.
  const checkServer = async (name: string, quiet = false) => {
    const id = dashboardAgentId();
    if (!id) return;
    const host = gateway();
    const currentGeneration = generation;
    const request = (requests.get(name) ?? 0) + 1;
    requests.set(name, request);
    if (!quiet || !liveServers()[name]?.server) setLiveServers((previous) => ({ ...previous, [name]: { ...previous[name], checking: true, failed: false } }));
    const current = () => generation === currentGeneration && dashboardAgentId() === id && gateway() === host && requests.get(name) === request;
    try {
      const list = await fetchMcpServer(id, name, host);
      if (current()) setLiveServers((previous) => ({ ...previous, [name]: { server: list.servers.find((server) => server.name === name) ?? previous[name]?.server, checking: false, failed: false } }));
    } catch {
      if (current()) setLiveServers((previous) => ({ ...previous, [name]: { ...previous[name], checking: false, failed: true } }));
    }
  };
  const refreshMcpStatus = () => {
    if (!extensionListLoaded()) return;
    for (const server of mcpStatus()?.servers ?? []) {
      if (!server.shared || server.enabled) void checkServer(server.name, true);
    }
  };
  const [addOpen, setAddOpen] = createSignal(false);
  const [mcpUrl, setMcpUrl] = createSignal("");
  const [mcpScope, setMcpScope] = createSignal<McpScope>("personal");
  const [mcpError, setMcpError] = createSignal<string>();
  const oauthResult = readOAuthResult();
  const [mcpAddedToast, setMcpAddedToast] = createSignal<{ message: string; variant: ToastVariant } | undefined>(oauthResult
    ? { message: oauthResult.status === "connected" ? "Connected" : oauthResult.error ?? "Connection failed.", variant: oauthResult.status === "connected" ? "success" : "error" }
    : undefined);
  const [mcpBusy, setMcpBusy] = createSignal(false);
  // After an uncertain add error the list read failed too. Another add stays off until a read works.
  const [mcpListUnknown, setMcpListUnknown] = createSignal(false);
  // The identity of the add dialog: gateway and runnable agent. Each change starts a new generation, so a late
  // answer of an older add changes no dialog, toast, or list, and refreshes no other target.
  const addIdentity = createMemo(() => { const id = contextReady() ? dashboardAgentId() : undefined; return id === undefined ? undefined : gatewayKey(gateway(), id); });
  let addGeneration = 0;
  createComputed(() => {
    void addIdentity();
    addGeneration++;
    setMcpBusy(false);
    setMcpListUnknown(false);
    setMcpError(undefined);
    setAddOpen(false);
    setMcpUrl("");
  });
  // Wait for the gateway context. Before it loads, the local requester would force the team scope.
  createEffect(() => {
    if (contextReady() && !requester().user) setMcpScope("team");
  });
  createEffect(() => {
    onCleanup(onOAuthReturn(refreshMcpStatus, { extension: "mcp" }));
  });

  const addFlow = createOAuthPopupFlow();
  // A new agent or gateway ends the sign-in of the old one.
  createEffect(() => {
    void dashboardAgentId();
    void gateway();
    addFlow.cancel();
  });
  const addFlowBusy = () => addFlow.state().phase === "preparing" || addFlow.state().phase === "waiting";
  const addFlowFailure = () => {
    const current = addFlow.state();
    // A failed add already shows its own error in the dialog.
    return current.phase === "failed" && current.reason !== "start_failed" ? current.message : undefined;
  };

  // One add attempt has its own record. It ends on Cancel, on replacement by a newer attempt, on a new target,
  // and when the page closes. Every effect of the attempt checks the record first. A cancelled fetch or popup
  // does not prove that the server stopped, so a cancelled submitted add needs a list read before another add.
  type AddAttempt = { gen: number; key: string; submitted: boolean; state: "pending" | "added" | "failed" };
  let activeAttempt: AddAttempt | undefined;
  const attemptLive = (attempt: AddAttempt) => activeAttempt === attempt && attempt.gen === addGeneration && addIdentity() === attempt.key;
  const targetLive = (attempt: AddAttempt) => attempt.gen === addGeneration && addIdentity() === attempt.key;
  // The busy state belongs to the newest attempt. An older attempt never frees it.
  const release = (attempt: AddAttempt) => { if (targetLive(attempt) && (activeAttempt === attempt || activeAttempt === undefined)) setMcpBusy(false); };

  // Reads the list of the exact target again and keeps another add off while the state is unknown.
  const settleList = async (live: () => boolean) => {
    if (!live()) return;
    try { await refetchMcpServers(); } catch { /* The error state of the resource tells the result. */ }
    if (live()) setMcpListUnknown(Boolean(mcpServers.error));
  };
  const retryListRead = async () => {
    const mine = addGeneration;
    const key = addIdentity();
    setMcpBusy(true);
    const live = () => addGeneration === mine && addIdentity() === key;
    await settleList(live);
    if (live()) setMcpBusy(false);
  };

  /** Ends the active attempt. A submitted add that has no answer yet is uncertain, so the list of its target is read first. */
  const endAttempt = (recover: boolean) => {
    const attempt = activeAttempt;
    if (!attempt) return;
    activeAttempt = undefined;
    addFlow.cancel();
    if (!targetLive(attempt)) return;
    if (attempt.state !== "pending") return;
    if (recover && attempt.submitted) {
      void settleList(() => targetLive(attempt)).then(() => { if (targetLive(attempt) && activeAttempt === undefined) setMcpBusy(false); });
    } else if (!attempt.submitted) {
      setMcpBusy(false);
    }
  };
  const cancelAdd = () => endAttempt(true);
  /** The answer of an ended attempt changes no dialog. The add may still have changed the server, so the list of its target is read again. */
  const lateAnswer = (attempt: AddAttempt) => {
    if (targetLive(attempt)) void settleList(() => targetLive(attempt));
  };
  onCleanup(() => { addGeneration++; activeAttempt = undefined; });

  /**
   * Remote add. The click opens the popup first. The add result can already hold the
   * authorization URL, and the page opens it directly: no second grant starts.
   */
  const addRemoteExtension = (attempt: AddAttempt, targetId: string, host: string, href: string, run: { onAdded: (result: Awaited<ReturnType<typeof addMcpServer>>) => void; onFailed: (cause: unknown) => void; done: () => Promise<void> }) => {
    const scope = mcpScope();
    let addedName: string | undefined;
    let firstRead = true;
    const stateOf = (statuses: McpServerStatus[]) => statuses.find((item) => item.name === addedName)?.state;
    void addFlow.begin<McpServerStatus[]>({
      // The server does not exist before the add, so the first snapshot is empty and needs no request.
      read: async (signal) => {
        if (firstRead) { firstRead = false; return []; }
        return fetchMcpStatus(targetId, scope, host, signal);
      },
      start: async () => {
        attempt.submitted = true;
        try {
          const result = await addMcpServer(targetId, href, scope, undefined, host);
          if (!attemptLive(attempt)) { lateAnswer(attempt); return undefined; }
          addedName = result.server.name;
          run.onAdded(result);
          return result.authorizationUrl;
        } catch (cause) {
          if (!attemptLive(attempt)) lateAnswer(attempt);
          run.onFailed(cause);
          throw cause;
        }
      },
      // The add call can run longer than the default deadline: the remote discovers the server first.
      startTimeoutMs: 50_000,
      verdict: (_before, now): OAuthVerdict => (stateOf(now) === "connected" ? "connected" : "pending"),
      canProve: () => true,
      onConnected: async () => {
        if (!attemptLive(attempt)) return;
        await refetchMcpServers();
        if (attemptLive(attempt) && addedName) void checkServer(addedName, true);
      },
    }).then(run.done);
  };

  const addCustomExtension = async (event: SubmitEvent) => {
    event.preventDefault();
    const targetId = dashboardAgentId();
    const key = addIdentity();
    // No resolved target means no add: a lookup that failed must not fall back to a local call.
    if (mcpBusy() || mcpListUnknown() || !targetId || !key) return;
    let url: URL;
    try {
      url = new URL(mcpUrl().trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      setMcpError("Enter an HTTP or HTTPS server URL.");
      return;
    }
    const sameUrl = (candidate: string) => candidate.replace(/\/+$/, "") === url.href.replace(/\/+$/, "");
    if (mcpStatus()?.servers.some((server) => server.url && sameUrl(new URL(server.url).href))) {
      setMcpAddedToast({ message: DUPLICATE_MCP_MESSAGE, variant: "warning" });
      return;
    }
    // A newer attempt replaces the older one. The older one is certain here: its add already answered.
    if (activeAttempt) { activeAttempt = undefined; addFlow.cancel(); }
    const attempt: AddAttempt = { gen: addGeneration, key, submitted: false, state: "pending" };
    activeAttempt = attempt;
    setMcpBusy(true);
    setMcpError(undefined);
    const host = gateway();
    const run = {
      onAdded: (result: Awaited<ReturnType<typeof addMcpServer>>) => {
        attempt.state = "added";
        setAddOpen(false);
        setMcpUrl("");
        setMcpAddedToast({ message: `Added ${mcpDisplayName(result.server.name, result.server.title)}.`, variant: "success" });
        void refetchMcpServers();
        // The add answered, so the dialog is free again. A remote sign-in may still wait.
        release(attempt);
      },
      onFailed: (cause: unknown) => {
        if (!attemptLive(attempt)) return;
        attempt.state = "failed";
        const message = cause instanceof Error ? cause.message : "Failed to add MCP server.";
        if (message === DUPLICATE_MCP_MESSAGE) setMcpAddedToast({ message, variant: "warning" });
        else setMcpError(message);
      },
      // The remote can add before its answer fails, so the list of this target must settle before another add.
      done: async () => {
        // An ended attempt frees nothing: its recovery read owns the busy state.
        if (!attemptLive(attempt)) return;
        if (attempt.state === "failed") await settleList(() => targetLive(attempt));
        if (attempt.state !== "added") release(attempt);
      },
    };
    if (host !== undefined) {
      addRemoteExtension(attempt, targetId, host, url.href, run);
      return;
    }
    try {
      attempt.submitted = true;
      const result = await addMcpServer(targetId, url.href, mcpScope(), window.location.pathname + window.location.search + window.location.hash);
      if (attemptLive(attempt)) {
        run.onAdded(result);
        if (result.authorizationUrl) window.location.assign(result.authorizationUrl);
      } else lateAnswer(attempt);
    } catch (cause) {
      if (attemptLive(attempt)) run.onFailed(cause);
      else lateAnswer(attempt);
    }
    await run.done();
  };

  // Hold the list until regular extensions, Top flags, and fast MCP configuration settle.
  // A fetch still unresolved once agent resolution is done was never started (no chat agent / not admin): nothing to wait for.
  // The Top flags belong to the gateway of this agent. A remote agent never reads the local flags.
  const [topExtensions] = createResource(
    createResourceKey(() => (contextReady() ? { gateway: gateway() } : null)),
    (key) => fetchTopExtensions(key.gateway).catch(() => EMPTY_TOP_EXTENSIONS)
  );
  const [extensionListLoaded, setExtensionListLoaded] = createSignal(false);
  createEffect(() => {
    void dashboardAgentId();
    void gateway();
    setExtensionListLoaded(false);
  });
  createEffect(() => {
    if (!contextReady()) return;
    const agentResolved = !agents.loading && !forks.loading && !poolActions.loading;
    const settled = (state: string) => state === "ready" || state === "errored" || (agentResolved && state === "unresolved");
    if (settled(extensions.state) && settled(mcpServers.state) && settled(topExtensions.state)) setExtensionListLoaded(true);
  });

  createEffect(() => {
    if (!extensionListLoaded() || !mcpStatus()) return;
    untrack(refreshMcpStatus);
  });

  // Normal extensions and MCP servers share one list: admin-flagged Top first, then by display name.
  const extensionListItems = createMemo(() => {
    const top = topExtensions() ?? EMPTY_TOP_EXTENSIONS;
    const topIds = new Set(top.extensions);
    const topUrls = new Set(top.mcp);
    const systemIds = new Set(requester().multiUser ? top.system.extensions : []);
    const systemUrls = new Set(requester().multiUser ? top.system.mcp : []);
    const items: { name: string; top: boolean; system: boolean; ext?: ExtensionCatalogEntry; server?: McpServer }[] = [
      ...extensionCatalog().filter((ext) => ext.id !== "mcp").map((ext) => ({ name: ext.displayName, top: topIds.has(ext.id), system: systemIds.has(ext.id), ext })),
      ...(mcpStatus()?.servers ?? []).map((server) => {
        const url = server.url ? normalizeMcpServerUrl(server.url) : null;
        return { name: mcpDisplayName(server.name, server.title), top: url !== null && topUrls.has(url), system: url !== null && systemUrls.has(url), server };
      }),
    ];
    return items.filter((item) => isSuperadmin() || !item.system)
      .sort((a, b) => Number(b.top) - Number(a.top) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  });

  // Set up = credentials exist for Just me or Whole team (OAuth connection or
  // secrets). Extensions without settings are a plain on/off, flipped on their
  // details page.
  const isExtensionSetUp = (ext: ExtensionCatalogEntry) => {
    if (ext.oauth) return !!ext.oauthConnected;
    if (ext.tier === "toggle-only") return ext.enabled;
    const secretFields = ext.requiredSecrets ?? [];
    if (secretFields.length === 0) return ext.enabled && ext.configured;
    const team = secretFields.some((field) => ext.configValues?.[field] != null);
    return team || (ext.personalSecretFields?.length ?? 0) > 0;
  };

  // One click reaches the settings: bespoke pages directly, everything else
  // on the details page, which renders OAuth and auto-form settings inline.
  // A remote catalog names the raw remote agent in its config route. The link must keep the gateway.
  const extensionPath = (ext: ExtensionCatalogEntry) =>
    (ext.tier === "bespoke-route" && ext.configRoutePath
      ? qualifyAgentRoute(ext.configRoutePath, dashboardAgentId() ?? params.agentId, gateway())
      : undefined) ?? detailsPath(dashboardAgentId() ?? params.agentId, ext.id);

  return (
    <Show when={requester().ready}>
      <div class="edit-agent">
        <A href={backTo() ?? "/agents"} class="edit-agent-back" data-tour="back-to-agents">
          {backTo() ? "← Back to chat" : "← Back to agents"}
        </A>

        <Show when={target().state === "loading" || (targetReady() && !contextReady()) || agents.loading}>
          <div class="loading">Loading agent…</div>
        </Show>

        <Show when={target().state === "missing"}>
          <div class="error" role="alert">This agent is unavailable. Check that its gateway is online. <button type="button" onClick={retryTarget}>Retry</button></div>
        </Show>

        <Show when={contextReady() && requester().unknown}>
          <RequesterFailure requester={requester} class="error">Could not read your permissions on {gateway()}. Controls that need them stay off.</RequesterFailure>
        </Show>

        <Show when={contextReady() && !agents.loading && !activeAgents.loading && !agent()}>
          <div class="error">Agent not found.</div>
        </Show>

        <Show when={agent()}>
          {(current) => (
            <div class="edit-agent-header">
              <Show when={current().avatar} fallback={<div class="edit-agent-avatar"><img src={defaultAvatarUrl(params.agentId)} alt={current().name} class="avatar-img" /></div>}>
                {(avatar) => (
                  <div class="edit-agent-avatar">
                    {isEmoji(avatar()) ? (
                      <span class="avatar-emoji">{avatar()}</span>
                    ) : (
                      <img
                        // A pool avatar path names the remote gateway. It loads through the relay.
                        src={gateway() !== undefined && forkedAgents() && avatar().startsWith("/api/") ? gatewayApiPath(gateway(), avatar()) : avatar()}
                        alt={current().name}
                        class="avatar-img"
                      />
                    )}
                  </div>
                )}
              </Show>
              <div class="edit-agent-identity">
                <div class="edit-agent-name-row">
                  <h1 class="edit-agent-name">{current().name}</h1>
                  <Show when={isAdmin() && forkedAgents() && fork()}>
                    {(currentFork) => <Show when={gatewayKey(gateway(), currentFork().sourcePoolId)} keyed>{(_id) => <ForkVisibility fork={currentFork()} canManage={canManageFork()} gateway={gateway()} onChanged={refetchForks} />}</Show>}
                  </Show>
                </div>
                <Show when={current().role}>
                  <div class="edit-agent-role">{current().role}</div>
                </Show>
              </div>
            </div>
          )}
        </Show>

        <Show when={isAdmin() && forkedAgents() && poolAgent() && (isSuperadmin() || !fork() || fork()!.public || canManageFork())}>
          <Show when={gatewayKey(gateway(), rawId())} keyed>
            {(_id) => (
              <TeamAssignment
                poolId={rawId()}
                agentName={agent()?.name ?? params.agentId}
                teams={teamList().filter((team) => team.canManage)}
                superadmin={isSuperadmin()}
                gateway={gateway()}
                fork={fork()}
                onChanged={() => {
                  void refetchForks();
                  void refetchExtensions();
                }}
              />
            )}
          </Show>
        </Show>

        <Show when={agent()}>
          <div class="edit-agent-tabs-row">
            <div class="edit-agent-tabs" role="tablist" aria-label="Agent sections">
              <button type="button" role="tab" aria-selected={tab() === "extensions"} onClick={() => setTab("extensions")}>Extensions</button>
              <button type="button" role="tab" data-tour="tab-connections" aria-selected={tab() === "connections"} onClick={() => setTab("connections")}>My connections</button>
              <Show when={dashboardAgentId()}><button type="button" role="tab" data-tour="tab-dashboards" aria-selected={tab() === "dashboards"} onClick={() => setTab("dashboards")}>Dashboards</button></Show>
              <Show when={dashboardAgentId() && requester().isExtensionEnabled("scheduler")}><button type="button" role="tab" aria-selected={tab() === "schedules"} onClick={() => setTab("schedules")}>Scheduled jobs</button></Show>
            </div>
            <Show when={isSuperadmin() && (tab() === "dashboards" || tab() === "schedules")}>
              <button
                type="button"
                class="edit-agent-private-toggle"
                aria-label="Show other users’ private items"
                aria-pressed={showPrivateItems()}
                title={showPrivateItems() ? "Hide other users’ private items" : "Show other users’ private items"}
                onClick={togglePrivateItems}
              ><i class={showPrivateItems() ? "fa-solid fa-eye" : "fa-solid fa-eye-slash"} aria-hidden="true" /></button>
            </Show>
          </div>
        </Show>

        <Show when={agent() && tab() === "connections"}>
          <div data-tour="panel-connections">
            <Show when={dashboardAgentId()} fallback={<p>No runnable agent is available for connections yet.</p>}>
              {(id) => <AgentConnectionsPanel agentId={id()} gateway={gateway()} includeMcp extensions={extensionCatalog()} />}
            </Show>
          </div>
        </Show>

        <Show when={agent() && tab() === "schedules" && dashboardAgentId() && requester().isExtensionEnabled("scheduler")}>
          <SchedulesPanel agentId={dashboardAgentId()!} agentName={agent()!.name} gateway={gateway()} />
        </Show>

        <Show when={agent() && tab() === "dashboards" && dashboardAgentId()}>
          <section class="edit-agent-dashboards" role="tabpanel" data-tour="panel-dashboards">
            <Show when={dashboards.loading}><p>Loading dashboards…</p></Show>
            <Show when={dashboards.error}><p>Failed to load dashboards.</p></Show>
            <Show when={!dashboards.loading && !dashboards.error && visibleAgentDashboards().length === 0}>
              <p>No dashboards yet.</p>
            </Show>
            <Show when={!dashboards.error}>
              <ul class="edit-agent-dashboard-list">
                <For each={sections().top}>{(dashboard) => <li class="edit-agent-dashboard"><DashboardListRow dashboard={dashboard} gateway={gateway()} onManage={() => setAccessDashboard(dashboard)} onClaim={() => openClaim(dashboard)} /></li>}</For>
              </ul>
              <Show when={sections().sub.length}>
                <div class="edit-agent-subpages">
                  <h2 class="edit-agent-section-title">Detail pages</h2>
                  <p>These pages need dynamic arguments in the URL, so open them from their parent dashboard.</p>
                  <ul>
                    <For each={sections().sub}>{(item) => (
                      <li>
                        <strong>{item.dashboard.title}</strong>
                        {" — "}
                        <Show when={item.usedBy.length} fallback={<span>not linked from any top page</span>}>
                          used by{" "}
                          <For each={item.usedBy}>{(parent, i) => (
                            <>{i() > 0 ? ", " : ""}<a href={dashboardOpenHref(parent, gateway()) ?? "#"} target="_blank" rel="noopener noreferrer">{parent.title}</a></>
                          )}</For>
                        </Show>
                        <span>{" · "}{ownershipLabel(item.dashboard)}</span>
                        <span class="edit-agent-subpage-actions">
                          <DashboardListActions dashboard={item.dashboard} gateway={gateway()} onManage={() => setAccessDashboard(item.dashboard)} onClaim={() => openClaim(item.dashboard)} />
                        </span>
                      </li>
                    )}</For>
                  </ul>
                </div>
              </Show>
            </Show>
          </section>
          <Show when={accessDashboard()}>{(dashboard) => <DashboardAccessDialog dashboard={dashboard()} gateway={gateway()} onClose={() => setAccessDashboard(undefined)} onSaved={async () => { await refetchDashboards(); }} />}</Show>
          <Show when={claimTarget()}>{(dashboard) => <ConfirmDialog title="Claim dashboard" description="This publishes the current HTML and makes the dashboard private to you. Previous viewers lose access until you share it." confirmLabel="Claim dashboard" error={claimError()} onCancel={() => setClaimTarget(undefined)} onConfirm={async () => {
            const key = addIdentity();
            const mine = addGeneration;
            const live = () => addGeneration === mine && addIdentity() === key;
            if (!key) return;
            try { await claimDashboard(dashboard().id, gateway()); if (live()) { await refetchDashboards(); if (live()) setClaimTarget(undefined); } }
            catch (cause) { if (live()) setClaimError(cause instanceof Error ? cause.message : "Unable to claim dashboard."); }
          }} />}</Show>
        </Show>

        <Show when={agent() && tab() === "extensions"}>
          <Show when={singleUser() || isSuperadmin()}>
            <A href={gateway() === undefined ? "/admin/extensions" : `/admin/extensions?gateway=${encodeURIComponent(gateway()!)}`}>Browse the catalog</A>
          </Show>
          <section class="edit-agent-extensions">
            <div class="edit-agent-ext-head">
              <h2 class="edit-agent-section-title">Extensions</h2>
              <Show when={mcpAvailable()}>
                <button type="button" class="mcp-ext-add-button" disabled={!dashboardAgentId()} title={!dashboardAgentId() ? "An agent fork is required first" : undefined} onClick={() => { setMcpError(undefined); setAddOpen(true); }}>Add custom extension</button>
              </Show>
            </div>
            <Show when={!addOpen() ? mcpError() : undefined}>{(message) => <p role="alert" class="mcp-ext-error">{message()}</p>}</Show>
            <Show when={mcpServers.error}>
              <p role="alert" class="mcp-ext-error">Failed to load MCP servers. <button type="button" onClick={() => void refetchMcpServers()}>Retry</button></p>
            </Show>
            <Show when={addFlowBusy()}>
              <p role="status" class="mcp-ext-status">Finish the sign-in in the new window. This page confirms the connection. <button type="button" class="mcp-ext-add-button" onClick={cancelAdd}>Cancel</button></p>
            </Show>
            <Show when={addFlowFailure()}>{(message) => <p role="alert" class="mcp-ext-error">{message()}</p>}</Show>
            <Show when={mcpAddedToast()}>
              {(toast) => <ToastNotification message={toast().message} variant={toast().variant} onClose={() => setMcpAddedToast(undefined)} />}
            </Show>
            <Show when={addOpen() && mcpAvailable()}>
              <div class="mcp-ext-dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !mcpBusy()) setAddOpen(false); }}>
                <div role="dialog" aria-modal="true" aria-labelledby="mcp-add-title" class="mcp-ext-dialog">
                  <form onSubmit={(event) => void addCustomExtension(event)}>
                    <h2 id="mcp-add-title">Add custom extension</h2>
                    <label>MCP server URL<input type="url" required placeholder="https://example.com/mcp" value={mcpUrl()} onInput={(event) => setMcpUrl(event.currentTarget.value)} /></label>
                    {/* Non-admins can only connect for themselves, so no choice is shown. */}
                    <Show when={mcpStatus()?.canConfigureTeam !== false && !singleUser()}>
                      <fieldset>
                        <legend>Connection</legend>
                        <label><input type="radio" name="mcp-scope" checked={mcpScope() === "personal"} disabled={!requester().user} onChange={() => setMcpScope("personal")} /> Just me</label>
                        <label><input type="radio" name="mcp-scope" checked={mcpScope() === "team"} onChange={() => setMcpScope("team")} /> Whole team</label>
                      </fieldset>
                    </Show>
                    <Show when={mcpError()}>{(message) => <p role="alert" class="mcp-ext-error">{message()}</p>}</Show>
                    <Show when={mcpListUnknown()}>
                      <p role="alert" class="mcp-ext-error">The server list could not be read after the error, and the server may exist. Read the list before you add again. <button type="button" disabled={mcpBusy()} onClick={() => void retryListRead()}>Read list</button></p>
                    </Show>
                    <div class="mcp-ext-dialog-actions">
                      <button type="button" disabled={mcpBusy()} onClick={() => setAddOpen(false)}>Cancel</button>
                      <button type="submit" disabled={mcpBusy() || mcpListUnknown()}>{mcpBusy() ? "Adding…" : "Add and connect"}</button>
                    </div>
                  </form>
                </div>
              </div>
            </Show>
            <Show when={!extensionListLoaded()}>
              <div class="edit-agent-ext-loading" role="status"><span class="edit-agent-ext-spinner" aria-hidden="true" />Loading agent extensions</div>
            </Show>
            <Show when={extensionListLoaded() && extensions.error}>
              <div class="edit-agent-ext-empty">
                Failed to load extensions.
              </div>
            </Show>
            <Show
              when={
                extensionListLoaded() && !extensions.error && !mcpServers.error && extensionListItems().length === 0
              }
            >
              <div class="edit-agent-ext-empty">No extensions available.</div>
            </Show>
            <ul class="edit-agent-ext-list">
              <For each={extensionListLoaded() ? extensionListItems() : []}>
                {(item) => (
                  <Show when={item.ext} keyed fallback={
                    <McpExtensionCard
                      server={liveServers()[item.server!.name]?.server ?? item.server!}
                      agentId={dashboardAgentId() ?? params.agentId}
                      system={item.system}
                      checking={liveServers()[item.server!.name]?.checking ?? item.server!.status === "pending"}
                      failed={liveServers()[item.server!.name]?.failed}
                      onRetry={() => void checkServer(item.server!.name)}
                    />
                  }>
                    {(ext) => (
                  <li class="edit-agent-ext-item" data-tour="ext-card" data-tour-ext={ext.id}>
                    <A
                      href={extensionPath(ext)}
                      class="edit-agent-ext-open"
                    >
                      <div class="edit-agent-ext-icon">
                        <Show
                          when={ext.iconDataUri}
                          fallback={
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.6"
                              aria-hidden="true"
                            >
                              <path
                                d="M9 3.5a1.5 1.5 0 0 1 3 0V4h1.5A1.5 1.5 0 0 1 15 5.5V7h-1v2a2 2 0 1 1 0 4v2h1v1.5a1.5 1.5 0 0 1-1.5 1.5H13v-1a2 2 0 1 0-4 0v1H7.5A1.5 1.5 0 0 1 6 16.5V15h1v-2a2 2 0 1 0 0-4V7h1V5.5A1.5 1.5 0 0 1 9.5 4H9v-.5Z"
                                stroke-linejoin="round"
                              />
                            </svg>
                          }
                        >
                          {(src) => (
                            <img src={src()} alt="" class="edit-agent-ext-icon-img" />
                          )}
                        </Show>
                      </div>
                      <div class="edit-agent-ext-body">
                        <div class="edit-agent-ext-main">
                          <span class="edit-agent-ext-name">
                            {ext.displayName}
                            <Show when={item.system}><span class="edit-agent-ext-system">System</span></Show>
                          </span>
                          <span class="edit-agent-ext-desc">
                            {ext.description}
                          </span>
                          <Show when={ext.enabled && ext.configured === false}>
                            <span class="edit-agent-ext-desc">Needs configuration</span>
                          </Show>
                        </div>
                      </div>
                    </A>
                    <Show
                      when={isExtensionSetUp(ext)}
                      fallback={
                        <A
                          href={extensionPath(ext)}
                          class="edit-agent-ext-add"
                          data-tour="ext-add"
                          data-tour-ext={ext.id}
                          aria-label={`Set up ${ext.displayName}`}
                          title={`Set up ${ext.displayName}`}
                        >
                          +
                        </A>
                      }
                    >
                      <span
                        class="edit-agent-ext-check"
                        role="img"
                        aria-label={`${ext.displayName} configured`}
                        title="Configured"
                      >
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                          <path d="M3.5 8.5l3 3 6-7" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </span>
                    </Show>
                  </li>
                    )}
                  </Show>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </div>

      <style>{MCP_EXTENSION_STYLES + `
        .edit-agent {
          padding: 24px;
        }

        .edit-agent-tabs-row {
          display: flex;
          align-items: flex-end;
          margin-top: 28px;
          border-bottom: 1px solid var(--border-default);
        }

        .edit-agent-tabs {
          display: flex;
          flex: 1;
          min-width: 0;
          gap: 16px;
        }

        .edit-agent-tabs button {
          padding: 8px 2px;
          border: 0;
          border-bottom: 2px solid transparent;
          background: none;
          color: var(--text-secondary);
          cursor: pointer;
        }

        .edit-agent-tabs button[aria-selected="true"] {
          border-bottom-color: var(--accent, #3b82f6);
          color: var(--text-primary);
        }

        .edit-agent-private-toggle {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          width: 40px;
          height: 40px;
          padding: 0;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--text-muted);
          font-size: 14px;
          cursor: pointer;
        }
        .edit-agent-private-toggle:hover,
        .edit-agent-private-toggle:active { background: var(--bg-raised); color: var(--text-secondary); }
        .edit-agent-private-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

        .edit-agent-dashboards {
          max-width: 800px;
          color: var(--text-secondary);
        }

        .edit-agent-dashboard-list {
          list-style: none;
          padding: 0;
        }

        .edit-agent-subpages { margin-top: 20px; font-size: 13px; color: var(--text-secondary); }
        .edit-agent-subpages p { margin: 4px 0 8px; font-size: 12px; }
        .edit-agent-subpages ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
        .edit-agent-subpages li { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; }
        .edit-agent-subpage-actions { margin-left: auto; }
        .edit-agent-subpages strong { color: var(--text-primary); }
        .edit-agent-subpages span { font-size: 12px; }

        .edit-agent-back {
          display: inline-block;
          margin-bottom: 20px;
          font-size: 14px;
          color: var(--text-secondary);
          text-decoration: none;
        }

        .edit-agent-back:hover {
          color: var(--text-primary);
        }

        .loading, .error {
          padding: 24px 0;
          color: var(--text-tertiary);
        }

        .error {
          color: #e55;
        }

        .edit-agent-header {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .edit-agent-avatar {
          width: 72px;
          height: 72px;
          border-radius: 14px;
          background: var(--bg-raised);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          flex-shrink: 0;
        }

        .avatar-emoji {
          font-size: 44px;
          line-height: 1;
        }

        .avatar-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .edit-agent-identity {
          min-width: 0;
        }

        .edit-agent-name {
          margin: 0;
          font-size: 24px;
          font-weight: 700;
          color: var(--text-primary);
        }

        .edit-agent-role {
          margin-top: 4px;
          font-size: 14px;
          color: var(--text-tertiary);
        }

        .edit-agent-name-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px 12px;
        }

        .edit-agent-visibility-error {
          flex-basis: 100%;
        }

        .edit-agent-team {
          margin-top: 28px;
          max-width: 520px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .edit-agent-section-title {
          margin: 0 0 4px;
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .edit-agent-team-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
        }

        .edit-agent-team-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .edit-agent-team-pills {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .edit-agent-team-pill {
          padding: 5px 12px;
          border-radius: 999px;
          border: 1px solid var(--border-default);
          background: transparent;
          color: var(--text-tertiary);
          font-size: 13px;
          cursor: pointer;
          transition: color 0.15s ease-out, border-color 0.15s ease-out, background 0.15s ease-out;
        }

        .edit-agent-team-pill:hover:not(:disabled) {
          color: var(--text-primary);
          border-color: var(--text-tertiary);
        }

        .edit-agent-team-pill.selected {
          background: color-mix(in oklab, var(--accent, #3b82f6) 14%, transparent);
          border-color: color-mix(in oklab, var(--accent, #3b82f6) 45%, transparent);
          color: var(--text-primary);
        }

        .edit-agent-team-pill:disabled {
          opacity: 0.45;
          cursor: default;
        }

        .edit-agent-team-pill.selected:disabled {
          opacity: 1;
        }

        .edit-agent-team-cancel {
          border: none;
          background: none;
          padding: 0;
          font-size: 13px;
          color: var(--text-tertiary);
          cursor: pointer;
        }

        .edit-agent-team-cancel:hover {
          color: var(--text-primary);
        }

        .edit-agent-team-select {
          flex: 1 1 200px;
          min-width: 0;
          padding: 8px 10px;
          border-radius: 6px;
          border: 1px solid var(--border-default);
          background: var(--bg-raised);
          color: var(--text-primary);
          font-size: 14px;
        }

        .edit-agent-team-warning {
          font-size: 13px;
          color: #d97706;
          margin: 0;
        }

        .edit-agent-team-button,
        .edit-agent-visibility-toggle {
          padding: 4px 14px;
          border-radius: 999px;
          border: none;
          background: var(--accent, #3b82f6);
          color: #fff;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
        }

        .edit-agent-visibility-toggle {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }

        .edit-agent-visibility-toggle i {
          font-size: 11px;
        }

        .edit-agent-team-button:disabled,
        .edit-agent-visibility-toggle:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .edit-agent-team-error {
          font-size: 13px;
          color: #e55;
          margin: 0;
        }

        .edit-agent-extensions {
          margin-top: 28px;
          max-width: 900px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .edit-agent-ext-empty {
          font-size: 13px;
          color: var(--text-tertiary);
        }

        .edit-agent-ext-loading {
          display: flex;
          align-items: center;
          gap: 10px;
          min-height: 120px;
          justify-content: center;
          font-size: 13px;
          color: var(--text-secondary);
        }

        .edit-agent-ext-spinner {
          width: 18px;
          height: 18px;
          border: 2px solid var(--border-default);
          border-top-color: var(--text-secondary);
          border-radius: 50%;
          animation: edit-agent-ext-spin 0.8s linear infinite;
        }

        @keyframes edit-agent-ext-spin { to { transform: rotate(360deg); } }

        .edit-agent-ext-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .edit-agent-ext-item {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 14px;
          min-height: 120px;
          border-radius: 10px;
          border: 1px solid var(--border-default);
          background: var(--bg-raised);
        }

        .edit-agent-ext-open {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          flex: 1;
          min-width: 0;
          margin: -4px;
          padding: 4px;
          border-radius: 8px;
          color: inherit;
          text-decoration: none;
          cursor: pointer;
          transition: background-color 0.15s ease;
        }

        .edit-agent-ext-open:hover {
          background: var(--bg-hover, rgba(120, 120, 120, 0.08));
        }

        .edit-agent-ext-icon {
          flex-shrink: 0;
          width: 44px;
          height: 44px;
          border-radius: 8px;
          background: #fff;
          padding: 6px;
          border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06));
          color: var(--text-tertiary);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }

        .edit-agent-ext-icon svg {
          width: 24px;
          height: 24px;
        }

        .edit-agent-ext-icon-img {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }

        .edit-agent-ext-body {
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-width: 0;
          flex: 1;
        }

        .edit-agent-ext-main {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }

        .edit-agent-ext-name {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .edit-agent-ext-system { display: inline-block; margin-left: 8px; border: 1px solid var(--border-default); border-radius: 4px; padding: 1px 5px; font-size: 10px; color: var(--text-secondary); }

        .edit-agent-ext-desc {
          font-size: 12px;
          color: var(--text-tertiary);
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
        }

        .edit-agent-ext-add,
        .edit-agent-ext-check {
          align-self: center;
          flex-shrink: 0;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .edit-agent-ext-add {
          border: 1px solid var(--border-default);
          color: var(--text-secondary);
          font-size: 20px;
          line-height: 1;
          text-decoration: none;
          transition: background-color 0.15s ease, color 0.15s ease;
        }

        .edit-agent-ext-add:hover {
          background: var(--bg-hover, rgba(120, 120, 120, 0.08));
          color: var(--text-primary);
        }

        .edit-agent-ext-check {
          background: rgba(22, 163, 74, 0.12);
          color: #16a34a;
        }

        .edit-agent-ext-check svg {
          width: 16px;
          height: 16px;
        }

      `}</style>
    </Show>
  );
}
