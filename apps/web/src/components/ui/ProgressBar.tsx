type ProgressBarProps = {
  percent: number;
  tone?: "normal" | "warning" | "critical";
  label: string;
  dimmed?: boolean;
};

export function ProgressBar(props: ProgressBarProps) {
  const value = () => Math.max(0, Math.min(100, Math.round(props.percent)));
  return <>
    <div
      class="ui-progress"
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value()}
      data-tone={props.tone ?? "normal"}
      data-dimmed={props.dimmed ? "true" : undefined}
    >
      <div class="ui-progress__fill" style={{ width: `${value()}%` }} />
    </div>
    <style>{`
      .ui-progress { height: 8px; overflow: hidden; border-radius: 4px; background: var(--border-default); }
      .ui-progress__fill { height: 100%; border-radius: inherit; background: var(--accent, #3b82f6); }
      .ui-progress[data-tone="warning"] .ui-progress__fill { background: var(--tone-warning, #b7791f); }
      .ui-progress[data-tone="critical"] .ui-progress__fill { background: var(--color-danger, #dc2626); }
      .ui-progress[data-dimmed="true"] .ui-progress__fill { opacity: 0.45; }
    `}</style>
  </>;
}
