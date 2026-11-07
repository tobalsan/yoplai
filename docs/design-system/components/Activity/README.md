The agent's turn as one live line above an assistant reply: it shows the latest action while working, a summary when done, and opens to the full history.

**When to use**
- In an assistant turn, above the reply text, from the first step until the turn ends. Hide it in Simple mode; show it in Full.

**What you provide**
- A stream of steps: `thinking { label, thought }` and `tool { label, name, arg, input, output, status: "running" | "done" | "error", children?: Tool[], retry? }`.
- `label`: the present-tense action for the line ("Reading pto_2026.xlsx…", "Retrying #hr-ops…"). Every new step, nested call or retry replaces it.
- On finish: total duration. The summary is derived: "Worked for 7.4s · 5 tool calls", plus " · 1 retry" when there was one (the count includes nested calls).

**Do**
- Build it on one native `<details class="yp-activity">`: the `<summary class="yp-activity__line">` holds `yp-activity__glyph` (spinner for tools, live dot for thinking, check when done) and `yp-activity__label`; `yp-activity__history` holds the rail.
- Swap the label by adding a new `<span>` and marking the old one `is-out` (slides 6px left and fades while the new one enters from 6px right, then remove it). While running, put `yp-thinking__text` on the new span for the sweep; drop it on the summary.
- Keep it clickable at any time and keep appending to the history while it is open. Leave it collapsed when the turn ends unless the person opened it.
- In the history, one `yp-activity__step` per step: `yp-activity__node` on the rail, `yp-activity__tool` (a `<details>`) opening to a `yp-activity__io` well with Input and Output, `yp-activity__kid` for nested calls, `yp-activity__elbow` and `yp-activity__retry` for a retry.
- Say "Failed" in `yp-activity__fail` and use the `!` node (`yp-activity__bad`) on an error step.

**Don't**
- Don't stack lines: there is one line, whatever the number of steps.
- Don't show raw JSON until a step is opened.
- Don't signal an error by color alone; the word "Failed" stays.
- Don't use the line for the reply itself; the answer is the unboxed text below it.

**Motion**
- Label swaps and glyph swaps use `transform` and `opacity` only (`spring-snappy`, `spring-pop`). The sweep is `yp-thinking__text`; `--sweep` is the ground color.
- Open and close animate `::details-content` (block size on `spring-smooth`, plus fade and a 4px slide). Browsers without it (non-Chromium today) toggle instantly.
- Under `prefers-reduced-motion` there is no sweep, spin or pulse, and swaps are instant.
