A quota bar with a label, a value line and a track that shifts tone by level.

**When to use**
- Usage limits and quotas: 5h window, weekly, per-model.

**What you provide**
- `label: string`, `percent: number`, `detail?: string` (e.g. "resets 3:40 PM")
- `stale?: boolean` when the reading is old
- Tone derives from percent: default below 75, `yp-progress--warning` from 75, `yp-progress--critical` from 90
- Source: `apps/web/src/components/ui/ProgressBar.tsx`

**Do**
- Show the number in text beside the bar.
- Fill `ink` → `warning` at 75% → `danger` at 90%, on a `field` track.
- Move the fill with `transform` only (`--value` drives a translate on `spring-smooth`).

**Don't**
- Don't rely on bar color alone to convey level.
- Don't animate `width`.
- Don't hardcode fill colors.
