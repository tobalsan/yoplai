import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { Button } from "../ui/Button";
import { loadMcpAppData } from "../../api/mcp-apps";
import type { DashboardFrame } from "./appViews";
import frameViewStyles from "./FrameView.css?inline";

export function FrameView(props: {
  target: DashboardFrame;
  mode: "inline" | "panel";
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  let frame: HTMLIFrameElement | undefined;
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
        sandbox="allow-scripts allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
      />
      <style>{frameViewStyles}</style>
    </section>
  );
}

export function CapturedFrameView(props: {
  kind: DashboardFrame["kind"];
  agentId: string;
  sessionId: string;
  callId: () => string;
  mode: "inline" | "panel";
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const [target, setTarget] = createSignal<DashboardFrame>();
  const callId = createMemo(() => props.callId());
  const [failed, setFailed] = createSignal(false);
  let identity = "";
  createEffect(() => {
    const controller = new AbortController();
    const nextIdentity = `${props.agentId}\n${props.sessionId}`;
    if (identity !== nextIdentity) setTarget(undefined);
    identity = nextIdentity;
    setFailed(false);
    const timer = setTimeout(() => {
      setFailed(true);
      controller.abort();
    }, 10000);
    void loadMcpAppData(
      props.agentId,
      props.sessionId,
      callId(),
      controller.signal
    )
      .then((data) => {
        if (!controller.signal.aborted)
          setTarget({
            ...(data.result.structuredContent as Omit<DashboardFrame, "kind">),
            kind: props.kind,
          });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => clearTimeout(timer));
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
    });
  });
  return (
    <Show
      when={target()}
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
