import { createSignal, onCleanup, onMount } from "solid-js";

export function ContextUsageRing(props: { inputTokens: number; maxTokens: number }) {
  const [dismissed, setDismissed] = createSignal(false);
  const percent = () => Math.max(0, Math.min(100, props.inputTokens / props.maxTokens * 100));
  const label = () => `${props.inputTokens.toLocaleString()} / ${props.maxTokens.toLocaleString()} tokens, ${Math.round(percent())}%`;

  onMount(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDismissed(true);
    };
    window.addEventListener("keydown", dismiss);
    onCleanup(() => window.removeEventListener("keydown", dismiss));
  });

  return (
    <div class="context-ring-wrap" onMouseEnter={() => setDismissed(false)}>
      <button
        class="context-ring"
        classList={{ warning: percent() >= 70 && percent() < 90, danger: percent() >= 90 }}
        type="button"
        aria-label={label()}
        onFocus={() => setDismissed(false)}
        onClick={() => setDismissed(false)}
      >
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke-width="2.5" aria-hidden="true">
          <circle class="context-ring-track" cx="16" cy="16" r="14" />
          <circle class="context-ring-fill" cx="16" cy="16" r="14" pathLength="100" stroke-dasharray={`${percent()} 100`} />
        </svg>
        <span class="context-ring-percent" aria-hidden="true">{Math.round(percent())}%</span>
      </button>
      <span class="context-ring-tooltip" role="tooltip" hidden={dismissed()}>{label()}</span>
    </div>
  );
}
