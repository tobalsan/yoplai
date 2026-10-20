import { createSignal, onCleanup, Show } from "solid-js";

export function CopyButton(props: {
  label: string;
  copy: () => Promise<boolean>;
}) {
  const [feedback, setFeedback] = createSignal("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  return (
    <button
      type="button"
      class="copy-button"
      aria-label={props.label}
      title={props.label}
      onClick={() => {
        const result = props.copy();
        void result.then((success) => {
          setFeedback(success ? "Copied" : "Copy failed");
          clearTimeout(timer);
          timer = setTimeout(() => setFeedback(""), 2000);
        });
      }}
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
      >
        <rect x="8" y="8" width="12" height="13" rx="2" />
        <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
      </svg>
      <Show when={feedback()}>
        <span role="status">{feedback()}</span>
      </Show>
    </button>
  );
}
