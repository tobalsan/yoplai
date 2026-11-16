import { createEffect, createMemo, createSignal, on, onCleanup, Show, useContext } from "solid-js";
import { Button } from "../ui/Button";
import { loadMcpAppData } from "../../api/mcp-apps";
import type { DashboardFrame } from "./appViews";
import { DashboardAnnotationsContext } from "./dashboardAnnotations";
import frameViewStyles from "./FrameView.css?inline";
import { RemoteFrameView } from "./RemoteFrameView";

export type FrameViewProps = {
  target: DashboardFrame;
  mode: "inline" | "panel";
  onExpand?: () => void;
  onCollapse?: () => void;
  /** The frame fills a public route of its own. A remote frame then offers Chat. */
  standalone?: boolean;
  /** A remote dashboard link of the same gateway. Without it, the frame shows the new dashboard itself. */
  onNavigate?: (next: { id: string; query: string }) => void;
};

/** A dashboard with a `gateway` comes from a linked remote gateway and goes through the trusted host. */
export function FrameView(props: FrameViewProps) {
  return (
    <Show when={props.target.gateway} fallback={<LocalFrameView {...props} />}>
      <RemoteFrameView {...props} />
    </Show>
  );
}

function LocalFrameView(props: FrameViewProps) {
  let frame: HTMLIFrameElement | undefined;
  const annotation = useContext(DashboardAnnotationsContext)?.frame(() => frame);
  const url = () => `/d/${encodeURIComponent(props.target.id)}`;
  const title = () => props.target.title || "Dashboard";
  createEffect(
    on(
      () => props.target,
      () => {
        if (frame) frame.src = url();
      },
      { defer: true }
    )
  );
  return (
    <section
      class="frame-view"
      classList={{ "frame-view-panel": props.mode === "panel" }}
    >
      <header class="frame-view-header">
        <i class="fa-solid fa-table-columns" aria-hidden="true" />
        <strong>{title()}</strong>
        <Show when={annotation?.available()}>
          <Button
            variant="ghost"
            icon="fa-solid fa-comment-medical"
            aria-label="Annotate"
            aria-pressed={annotation!.active()}
            title={annotation!.active() ? "Stop annotating (Esc)" : "Annotate: click parts of the dashboard to leave notes for the agent"}
            onClick={() => annotation!.toggle()}
          >
            {null}
          </Button>
        </Show>
        <a
          class="frame-view-open"
          href={url()}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open in browser"
          title="Open in browser"
        >
          <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true" />
        </a>
        <Show when={props.mode === "panel" ? props.onCollapse : props.onExpand}>
          <Button
            variant="ghost"
            icon={
              props.mode === "panel"
                ? "fa-solid fa-down-left-and-up-right-to-center"
                : "fa-solid fa-up-right-and-down-left-from-center"
            }
            aria-label={props.mode === "panel" ? "Collapse" : "Expand"}
            title={props.mode === "panel" ? "Collapse" : "Expand"}
            onClick={() =>
              props.mode === "panel" ? props.onCollapse?.() : props.onExpand?.()
            }
          >
            {null}
          </Button>
        </Show>
      </header>
      <iframe
        ref={frame}
        title={`${title()} dashboard`}
        src={url()}
        sandbox="allow-scripts allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
      />
      <style>{frameViewStyles}</style>
    </section>
  );
}

export function CapturedFrameView(props: {
  kind: DashboardFrame["kind"];
  agentId: string;
  /**
   * The linked gateway of the locally resolved chat agent. It is the only source of the
   * gateway: a captured result and the renderer never choose it, and an ID suffix never implies it.
   */
  gateway?: string;
  /** The chat agent is not resolved yet, so the frame cannot choose between a local and a remote host. */
  gatewayPending?: boolean;
  sessionId: string;
  callId: () => string;
  mode: "inline" | "panel";
  onExpand?: () => void;
  onCollapse?: () => void;
  startCallId?: string;
  onShown?: (callId: string) => void;
}) {
  const [target, setTarget] = createSignal<DashboardFrame>();
  // A moved host starts at the last shown call, then loads the latest, so a failed update keeps it.
  const [primed, setPrimed] = createSignal(!props.startCallId || props.startCallId === props.callId());
  const callId = createMemo(() => (primed() ? props.callId() : props.startCallId!));
  const [failed, setFailed] = createSignal(false);
  let identity = "";
  createEffect(() => {
    const controller = new AbortController();
    const nextIdentity = `${props.agentId}\n${props.sessionId}`;
    if (identity !== nextIdentity) setTarget(undefined);
    identity = nextIdentity;
    setFailed(false);
    const timer = setTimeout(() => {
      if (!primed()) setPrimed(true);
      else setFailed(true);
      controller.abort();
    }, 10000);
    const id = callId();
    void loadMcpAppData(
      props.agentId,
      props.sessionId,
      id,
      controller.signal
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        // Only the dashboard ID and title come from the result. Other fields, such as a gateway or query, never reach the target.
        const content = data.result.structuredContent as { id?: unknown; title?: unknown } | undefined;
        if (typeof content?.id !== "string" || !content.id) throw new Error("View update unavailable");
        setTarget({ kind: props.kind, id: content.id, title: typeof content.title === "string" ? content.title : "" });
        props.onShown?.(id);
        if (!primed()) setPrimed(true);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // A failed seed falls through to the latest call.
        if (!primed()) setPrimed(true);
        else setFailed(true);
      })
      .finally(() => clearTimeout(timer));
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
    });
  });
  const frame = createMemo<DashboardFrame | undefined>(() => {
    const current = target();
    if (!current || props.gatewayPending) return undefined;
    return props.gateway ? { ...current, gateway: props.gateway } : current;
  });
  return (
    <Show
      when={frame()}
      fallback={
        <p role="status">
          {failed() ? "Dashboard unavailable" : "Loading dashboard…"}
        </p>
      }
    >
      {(current) => (
        <>
          <Show when={failed()}>
            <p role="status">Dashboard update unavailable</p>
          </Show>
          <FrameView
            target={current()}
            mode={props.mode}
            onExpand={props.onExpand}
            onCollapse={props.onCollapse}
          />
        </>
      )}
    </Show>
  );
}
