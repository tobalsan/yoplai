import { A } from "@solidjs/router";
import { createSignal, Show, useContext } from "solid-js";
import { Button } from "../ui/Button";
import { theme } from "../../theme";
import { withBase } from "../../lib/path";
import { cleanDashboardQuery, remoteDashboardChatPath, remoteDashboardPath } from "../../lib/remote-dashboard";
import { DashboardAnnotationsContext, type DashboardAnnotations, type DashboardFrameAnnotation } from "./dashboardAnnotations";
import frameViewStyles from "./FrameView.css?inline";
import type { FrameViewProps } from "./FrameView";
import { createRemoteDashboardHost, hostErrorText } from "./remoteDashboardHost";

/**
 * A dashboard of a linked remote gateway. The trusted host prepares an
 * immutable view and shows only the local shell in its iframe. Chat, agent
 * selection, and annotation come from checked metadata. Remote HTML never
 * enters this component.
 */
export function RemoteFrameView(props: FrameViewProps) {
  const gateway = () => props.target.gateway!;
  // A link of the same gateway replaces the view until the target itself changes.
  const [visited, setVisited] = createSignal<{ base: FrameViewProps["target"]; id: string; query: string }>();
  const current = () => {
    const visit = visited();
    return visit && visit.base === props.target
      ? { id: visit.id, query: visit.query }
      : { id: props.target.id, query: cleanDashboardQuery(props.target.query) };
  };
  const title = () => props.target.title || "Dashboard";

  const annotations = useContext(DashboardAnnotationsContext);
  // The annotation entry needs the host accessors, and the host needs the entry for its callbacks.
  const bridge: { annotation?: ReturnType<DashboardAnnotations["remoteFrame"]> } = {};
  const host = createRemoteDashboardHost({
    gateway,
    id: () => current().id,
    query: () => current().query,
    theme,
    onNavigate: (next) => {
      if (props.onNavigate) props.onNavigate(next);
      else setVisited({ base: props.target, ...next });
    },
    onAnnotation: (message) => bridge.annotation?.receive(message),
    onEnd: () => bridge.annotation?.endInstance(),
  });
  bridge.annotation = annotations?.remoteFrame({ target: host.annotationTarget, send: host.sendAnnotation });
  const annotate: DashboardFrameAnnotation | undefined = bridge.annotation;

  const publicPath = () => withBase(remoteDashboardPath(gateway(), current().id, current().query));
  const chatPath = () => {
    const view = host.checked();
    return view ? remoteDashboardChatPath(view) : undefined;
  };
  const [copyResult, setCopyResult] = createSignal<string>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${publicPath()}`);
      setCopyResult("Link copied");
    } catch {
      setCopyResult("Could not copy the link");
    }
  };

  return (
    <section class="frame-view" classList={{ "frame-view-panel": props.mode === "panel" }}>
      <header class="frame-view-header">
        <i class="fa-solid fa-table-columns" aria-hidden="true" />
        <strong>{title()}</strong>
        <Show when={annotate?.available()}>
          <Button
            variant="ghost"
            icon="fa-solid fa-comment-medical"
            aria-label="Annotate"
            aria-pressed={annotate!.active()}
            title={annotate!.active() ? "Stop annotating (Esc)" : "Annotate: click parts of the dashboard to leave notes for the agent"}
            onClick={() => annotate!.toggle()}
          >
            {null}
          </Button>
        </Show>
        <Show when={props.standalone}>
          <Show
            when={chatPath()}
            fallback={
              // Without proof of agent access, Chat stays off. While the view is unproven it shows disabled.
              <Show when={!host.checked()}>
                <Button variant="ghost" icon="fa-solid fa-comments" aria-label="Chat" title="Chat" disabled>
                  {null}
                </Button>
              </Show>
            }
          >
            {(path) => (
              <A class="frame-view-open" href={path()} aria-label="Chat" title="Chat">
                <i class="fa-solid fa-comments" aria-hidden="true" />
              </A>
            )}
          </Show>
        </Show>
        <Button variant="ghost" icon="fa-regular fa-copy" aria-label="Copy link" title="Copy link" onClick={() => void copy()}>
          {null}
        </Button>
        <Show when={!props.standalone}>
          <a
            class="frame-view-open"
            href={publicPath()}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in browser"
            title="Open in browser"
          >
            <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true" />
          </a>
        </Show>
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
            onClick={() => (props.mode === "panel" ? props.onCollapse?.() : props.onExpand?.())}
          >
            {null}
          </Button>
        </Show>
      </header>
      <Show when={copyResult()}>
        <p class="frame-view-notice" role="status">{copyResult()}</p>
      </Show>
      <Show when={host.notice()}>
        <p class="frame-view-notice" role="status">{host.notice()}</p>
      </Show>
      <Show when={host.pendingLink()}>
        {(link) => (
          <div class="frame-view-notice" role="group" aria-label="External link">
            <p>The dashboard asks to open {link().destination}</p>
            <Button onClick={() => host.openLink()}>Open link</Button>
            <Button variant="ghost" onClick={() => host.dismissLink()}>Dismiss</Button>
          </div>
        )}
      </Show>
      <Show when={host.error()}>
        {(failure) => (
          <div class="frame-view-error" role="alert">
            <p>{hostErrorText(failure())}</p>
            <Button icon="fa-solid fa-rotate-right" onClick={() => host.reload()}>Reload</Button>
          </div>
        )}
      </Show>
      <Show when={host.busy() && !host.error()}>
        <p class="frame-view-notice" role="status">Loading dashboard…</p>
      </Show>
      {/* A keyed render makes a new iframe for each prepared view, so no shell or window is ever reused. */}
      <Show when={host.shell()} keyed>
        {(shell) => (
          <iframe
            ref={(element) => host.bindShell(shell, element)}
            title={`${title()} dashboard`}
            src={shell.shellUrl}
            referrerpolicy="no-referrer"
          />
        )}
      </Show>
      <style>{frameViewStyles}</style>
    </section>
  );
}
