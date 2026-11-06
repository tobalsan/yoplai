import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { Button } from "../ui/Button";
import { loadMcpAppData } from "../../api/mcp-apps";
import frameViewStyles from "./FrameView.css?inline";

export type PreviewTarget = {
  kind: "preview";
  url: string;
  finalUrl: string;
  title?: string;
  frameable: boolean;
  reason: null | "x-frame-options" | "frame-ancestors" | "unreachable";
};

export function frameBlock(
  finalUrl: string,
  location: Pick<Location, "origin" | "hostname">
): null | "loopback" | "own-origin" | "scheme" {
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    return "scheme";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "scheme";
  if (url.origin === location.origin) return "own-origin";
  const loopback = (hostname: string) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  return loopback(url.hostname) && !loopback(location.hostname)
    ? "loopback"
    : null;
}

export function FrameView(props: {
  target: PreviewTarget;
  mode: "inline" | "panel";
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  let frame: HTMLIFrameElement | undefined;
  const title = () => props.target.title || new URL(props.target.finalUrl).host;
  const block = () => frameBlock(props.target.finalUrl, location);
  const reason = () => {
    switch (block()) {
      case "loopback":
        return "This page is on the agent's machine. Ask for a URL your browser can reach (tailnet or HTTPS).";
      case "own-origin":
        return "This page cannot be shown inside this chat.";
      case "scheme":
        return "This URL cannot be shown in a frame.";
      default:
        return props.target.reason === "unreachable"
          ? "The page did not answer."
          : "This page does not allow being shown in a frame.";
    }
  };
  createEffect(
    on(
      () => props.target,
      (target) => {
        if (frame && target.frameable && frameBlock(target.finalUrl, location) === null) frame.src = target.finalUrl;
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
        <i class="fa-solid fa-globe" aria-hidden="true" />
        <strong>{title()}</strong>
        <Show when={block() !== "scheme"}>
          <a
            class="frame-view-open"
            href={props.target.finalUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open
          </a>
        </Show>
        <Show when={props.mode === "panel" ? props.onCollapse : props.onExpand}>
          <Button
            variant="ghost"
            onClick={() =>
              props.mode === "panel" ? props.onCollapse?.() : props.onExpand?.()
            }
          >
            {props.mode === "panel" ? "Collapse" : "Expand"}
          </Button>
        </Show>
      </header>
      <div class="frame-view-toolbar">
        <span class="frame-view-url">{props.target.finalUrl}</span>
        <Show when={props.target.frameable && block() === null}>
          <Button
            variant="ghost"
            onClick={() => {
              if (frame) frame.src = props.target.finalUrl;
            }}
            icon="fa-solid fa-rotate-right"
          >
            Reload
          </Button>
        </Show>
      </div>
      <Show
        when={props.target.frameable && block() === null}
        fallback={
          <div class="frame-view-card">
            <p>{reason()}</p>
          </div>
        }
      >
        <iframe
          ref={frame}
          title={`${title()} web preview`}
          src={props.target.finalUrl}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerpolicy="no-referrer"
        />
      </Show>
      <style>{frameViewStyles}</style>
    </section>
  );
}

export function PreviewView(props: {
  agentId: string;
  sessionId: string;
  callId: () => string;
  mode: "inline" | "panel";
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const [target, setTarget] = createSignal<PreviewTarget>();
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
      props.callId(),
      controller.signal
    )
      .then((data) => {
        if (!controller.signal.aborted)
          setTarget({
            ...(data.result.structuredContent as Omit<PreviewTarget, "kind">),
            kind: "preview",
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
          {failed() ? "Preview unavailable" : "Loading preview…"}
        </p>
      }
    >
      {(current) => (
        <>
          <Show when={failed()}>
            <p role="status">Preview update unavailable</p>
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
