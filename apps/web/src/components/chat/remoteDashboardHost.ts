import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";
import {
  DashboardViewError,
  prepareDashboardView,
  readDashboardView,
  type DashboardViewMeta,
  type PreparedDashboardView,
} from "../../api/dashboard-views";
import {
  DASHBOARD_ID_PATTERN,
  classifyDashboardLink,
  type CheckedRemoteView,
} from "../../lib/remote-dashboard";

/**
 * The trusted host of one remote dashboard. It follows the host contract of
 * docs/relay-configuration.md: prepare an immutable view, show the trusted
 * shell in a new iframe, accept shell messages only from that window, and
 * enable identity controls only after readiness and a checked metadata read.
 * Remote HTML never enters this page. Every state that the host cannot prove
 * fails closed with a visible Reload.
 */
const SHELL_CHANNEL = "yoplai-shell";
/** The gateway waits 30 seconds for the remote page. The host waits a little longer for its answer. */
export const PREPARE_TIMEOUT_MS = 40_000;
/** Time from the shell element to enabled controls. */
export const READY_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_000;

/** A failed view. The code is a typed gateway error or one of the local codes below. */
export type HostError = {
  /** Local codes: `network`, `prepare_timeout`, `readiness_timeout`, `unknown_display`, `ended`, `expired`, `invalid_link`. */
  code: string;
  status?: number;
  reason?: string;
  ownerName?: string;
};

export type ExternalLinkRequest = { href: string; destination: string };

/** The view that the host shows now. Its identity changes with every preparation. */
export type ShellView = { shellUrl: string; instance: string };

type ActiveView = {
  prepared: PreparedDashboardView;
  gateway: string;
  iframe?: HTMLIFrameElement;
  loaded: boolean;
  ready: boolean;
  read?: AbortController;
  timers: ReturnType<typeof setTimeout>[];
  heldAnnotationReady?: Record<string, unknown>;
  shell: ShellView;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hostError(error: unknown): HostError {
  if (error instanceof DashboardViewError) {
    return { code: error.code, status: error.status, reason: error.reason, ownerName: error.ownerName };
  }
  return { code: "network" };
}

export type RemoteDashboardHostOptions = {
  gateway: Accessor<string>;
  id: Accessor<string>;
  /** A query string without `?`. */
  query: Accessor<string>;
  theme: Accessor<"light" | "dark">;
  /** A dashboard link of the same gateway. The owner prepares a new view. */
  onNavigate: (next: { id: string; query: string }) => void;
  /** An annotation message of the renderer. Called only when the checked metadata allows annotation. */
  onAnnotation?: (message: Record<string, unknown>) => void;
  /** The instance ended or was replaced. Clear everything that came from it. */
  onEnd?: () => void;
};

export function createRemoteDashboardHost(options: RemoteDashboardHostOptions) {
  const [shell, setShell] = createSignal<ShellView>();
  const [checked, setChecked] = createSignal<CheckedRemoteView>();
  const [error, setError] = createSignal<HostError>();
  const [preparing, setPreparing] = createSignal(false);
  const [pendingLink, setPendingLink] = createSignal<ExternalLinkRequest>();
  const [notice, setNotice] = createSignal<string>();

  let generation = 0;
  let active: ActiveView | undefined;
  let preparation: AbortController | undefined;

  /** Drops the current view or preparation. Work of an older generation stops at its next check. */
  const discard = () => {
    generation += 1;
    preparation?.abort();
    preparation = undefined;
    const view = active;
    active = undefined;
    if (view) {
      for (const timer of view.timers) clearTimeout(timer);
      view.read?.abort();
      try {
        view.iframe?.contentWindow?.postMessage({ channel: SHELL_CHANNEL, instance: view.prepared.instance, event: "end" }, window.location.origin);
      } catch {
        // The shell can be gone already.
      }
    }
    setShell(undefined);
    setChecked(undefined);
    setPreparing(false);
    setPendingLink(undefined);
    setNotice(undefined);
    options.onEnd?.();
  };

  const fail = (next: HostError) => {
    discard();
    setError(next);
  };

  const schedule = (view: ActiveView, run: () => void, ms: number) => {
    view.timers.push(setTimeout(run, Math.max(0, Math.min(ms, MAX_TIMER_MS))));
  };

  const start = () => {
    discard();
    setError(undefined);
    const request = { gateway: options.gateway(), id: options.id(), query: options.query(), theme: options.theme() };
    if (!request.gateway || !DASHBOARD_ID_PATTERN.test(request.id)) {
      setError({ code: "invalid_link" });
      return;
    }
    const mine = generation;
    const controller = new AbortController();
    preparation = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PREPARE_TIMEOUT_MS);
    setPreparing(true);
    prepareDashboardView(
      { gateway: request.gateway, dashboardId: request.id, query: request.query, theme: request.theme },
      controller.signal
    ).then(
      (prepared) => {
        clearTimeout(timer);
        if (mine !== generation) return;
        preparation = undefined;
        const view: ActiveView = {
          prepared,
          gateway: request.gateway,
          loaded: false,
          ready: false,
          timers: [],
          shell: { shellUrl: prepared.shellUrl, instance: prepared.instance },
        };
        active = view;
        setPreparing(false);
        setShell(view.shell);
        schedule(view, () => { if (active === view) fail({ code: "expired" }); }, prepared.expiresAt - Date.now());
        schedule(view, () => { if (active === view && !checked()) fail({ code: "readiness_timeout" }); }, READY_TIMEOUT_MS);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        // A late failure of an older generation changes nothing.
        if (mine !== generation) return;
        preparation = undefined;
        fail(timedOut ? { code: "prepare_timeout" } : hostError(cause));
      }
    );
  };

  /** Reads the checked metadata once the renderer is ready. The result enables the controls. */
  const readMetadata = (view: ActiveView) => {
    const controller = new AbortController();
    view.read = controller;
    readDashboardView(view.prepared.handle, controller.signal).then(
      (result) => {
        if (active !== view || controller.signal.aborted) return;
        const { prepared } = view;
        if (
          result.state !== "delivered" ||
          result.gateway !== view.gateway || result.dashboardId !== prepared.dashboardId ||
          result.meta.dashboardId !== prepared.dashboardId ||
          result.expiresAt <= Date.now()
        ) {
          fail({ code: "unknown_display" });
          return;
        }
        enable(view, result.meta, result.expiresAt);
      },
      (cause: unknown) => {
        if (active !== view || controller.signal.aborted) return;
        fail(cause instanceof DashboardViewError && cause.status === 410 ? { code: "expired", status: 410 } : { code: "unknown_display", ...(cause instanceof DashboardViewError ? { status: cause.status } : {}) });
      }
    );
  };

  const enable = (view: ActiveView, meta: DashboardViewMeta, expiresAt: number) => {
    view.timers.forEach(clearTimeout);
    view.timers = [];
    schedule(view, () => { if (active === view) fail({ code: "expired" }); }, expiresAt - Date.now());
    setChecked({
      gateway: view.gateway,
      dashboardId: meta.dashboardId,
      agentId: `${meta.agentId}@${view.gateway}`,
      canWrite: meta.canWrite,
      canEdit: meta.canEdit,
      chat: meta.chat,
      annotation: meta.annotation,
    });
    const held = view.heldAnnotationReady;
    view.heldAnnotationReady = undefined;
    if (held && meta.annotation) options.onAnnotation?.(held);
  };

  const requestLink = (view: ActiveView, href: unknown) => {
    const decision = classifyDashboardLink(href, { origin: window.location.origin, dashboardId: view.prepared.dashboardId });
    setNotice(undefined);
    if (decision.kind === "dashboard") {
      setPendingLink(undefined);
      options.onNavigate({ id: decision.id, query: decision.query });
    } else if (decision.kind === "external") {
      setPendingLink({ href: decision.href, destination: decision.destination });
    } else if (decision.kind === "blocked") {
      setPendingLink(undefined);
      setNotice(decision.reason === "credentials" ? "A link with a user name or password was blocked." : "A link to an address on this machine or network was blocked.");
    }
  };

  const onMessage = (event: MessageEvent) => {
    const view = active;
    const source = view?.iframe?.contentWindow;
    if (!view || !source || event.source !== source || event.origin !== window.location.origin) return;
    const data: unknown = event.data;
    if (!isRecord(data) || data.channel !== SHELL_CHANNEL || data.instance !== view.prepared.instance) return;
    switch (data.event) {
      case "renderer-loaded":
        if (view.loaded) fail({ code: "unknown_display" });
        else view.loaded = true;
        break;
      case "renderer-ready":
        if (!view.loaded) fail({ code: "unknown_display" });
        else if (!view.ready) {
          view.ready = true;
          readMetadata(view);
        }
        break;
      case "ended":
        fail({ code: "ended" });
        break;
      case "link-request":
        if (checked()) requestLink(view, data.href);
        break;
      case "annotation": {
        const message = data.message;
        if (!isRecord(message) || message.channel !== "yoplai-annotate") break;
        const current = checked();
        if (current?.annotation) options.onAnnotation?.(message);
        // The shell forwards the page announcement right after readiness, before the metadata read ends.
        else if (!current && view.ready && message.type === "ready") view.heldAnnotationReady = message;
        break;
      }
      default:
        break;
    }
  };

  /** Sends an annotation command to the renderer through the shell. Only a ready, checked view takes it. */
  const sendAnnotation = (message: Record<string, unknown>) => {
    const view = active;
    if (!view?.ready || !checked()) return;
    view.iframe?.contentWindow?.postMessage({ channel: SHELL_CHANNEL, instance: view.prepared.instance, event: "annotation", message }, window.location.origin);
  };

  const onPageHide = () => discard();
  const onPageShow = (event: PageTransitionEvent) => {
    // A restored page never keeps its old shell or its old authority.
    if (event.persisted) start();
  };
  window.addEventListener("message", onMessage);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  onCleanup(() => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    discard();
  });

  // Reload, history, query, gateway, and theme changes all prepare a fresh view.
  const requestKey = createMemo(() => JSON.stringify([options.gateway(), options.id(), options.query(), options.theme()]));
  createEffect(on(requestKey, start));

  return {
    /** The shell of the current preparation. A keyed render makes one new iframe for each. */
    shell,
    /** Facts for Chat, agent selection, and annotation. Set only while the view is proven. */
    checked,
    error,
    /** True while a preparation or a readiness wait runs. */
    busy: () => !error() && !checked(),
    preparing,
    pendingLink,
    notice,
    /** The renderer window of the current view. Tests and the iframe ref use it. */
    bindShell(view: ShellView, element: HTMLIFrameElement) {
      if (active && active.shell === view) active.iframe = element;
    },
    reload: start,
    sendAnnotation,
    annotationTarget: createMemo(() => {
      const current = checked();
      return current?.annotation ? { id: current.dashboardId, agentId: current.agentId } : undefined;
    }),
    openLink() {
      const link = pendingLink();
      setPendingLink(undefined);
      if (link) window.open(link.href, "_blank", "noopener,noreferrer");
    },
    dismissLink: () => setPendingLink(undefined),
  };
}

export type RemoteDashboardHost = ReturnType<typeof createRemoteDashboardHost>;

/** Visible text for each failure. The text never includes a remote value except an owner name. */
export function hostErrorText(error: HostError): string {
  switch (error.code) {
    case "remote_unauthorized": return "The linked gateway did not accept its saved link. Link it again.";
    case "forbidden": return error.ownerName ? `You have no access to this dashboard. Owner: ${error.ownerName}.` : "You have no access to this dashboard.";
    case "not_found": return "This dashboard does not exist on the linked gateway.";
    case "canvas_disabled": return "Dashboards are off on the linked gateway.";
    case "remote_update_required": return "The linked gateway is too old to show dashboards here. Update it.";
    case "invalid_remote_response":
    case "invalid_response": return "The linked gateway sent an answer that failed the checks.";
    case "remote_response_too_large": return "The dashboard is larger than the size limit.";
    case "remote_timeout":
    case "prepare_timeout": return "The linked gateway did not answer in time.";
    case "gateway_offline": return "The linked gateway is offline.";
    case "too_many_dashboard_views":
    case "dashboard_view_storage_full":
    case "too_many_dashboard_view_requests": return "Too many dashboards are open. Close one and reload.";
    case "dashboard_view_expired":
    case "expired": return "This view expired. Reload to see the dashboard.";
    case "readiness_timeout": return "The dashboard did not finish loading.";
    case "unknown_display":
    case "ended": return "The dashboard display is in an unknown state. Reload to see it again.";
    case "relay_unavailable": return "The relay to linked gateways is off, or this page is not local.";
    case "untrusted_origin":
    case "same_origin_required": return "The gateway refused this page origin.";
    case "invalid_link":
    case "invalid_dashboard_id": return "This dashboard link is not valid.";
    case "unknown_gateway": return "No linked gateway has this name.";
    case "network": return "The local gateway did not answer.";
    case "query_too_large": return "The dashboard query is too large.";
    default: return "The dashboard failed to load.";
  }
}
