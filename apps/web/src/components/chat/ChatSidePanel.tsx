import { createSignal, onCleanup, onMount, type JSX } from "solid-js";

export function ChatSidePanel(props: { children: JSX.Element }) {
  let panel!: HTMLElement;
  const [width, setWidth] = createSignal(0);
  const [overlay, setOverlay] = createSignal(false);
  const [available, setAvailable] = createSignal(0);
  let dragging = false;
  const clamp = (value: number) => Math.max(320, Math.min(value, available() - 406));
  onMount(() => {
    const container = panel.parentElement!;
    function measure() {
      setAvailable(container.getBoundingClientRect().width);
      setOverlay(window.innerWidth <= 768 || available() < 726);
      setWidth(clamp(width() || available() * 0.45));
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    window.addEventListener("resize", measure);
    measure();
    onCleanup(() => { observer.disconnect(); window.removeEventListener("resize", measure); });
  });
  return <aside ref={panel} class="chat-side-panel" classList={{ "chat-side-panel-overlay": overlay() }} style={{ width: `${width()}px` }} aria-label="App view" tabIndex={-1}>
    <div role="separator" aria-label="Resize app view" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={Math.max(320, available() - 406)} aria-valuenow={Math.round(width())} tabIndex={0}
      class="chat-panel-resizer"
      onPointerDown={(event) => { dragging = true; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
      onPointerMove={(event) => { if (dragging) setWidth(clamp(panel.parentElement!.getBoundingClientRect().right - event.clientX)); }}
      onPointerUp={(event) => { dragging = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={() => { dragging = false; }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        setWidth(clamp(width() + (event.key === "ArrowLeft" ? 20 : -20)));
      }} />
    {props.children}
  </aside>;
}
