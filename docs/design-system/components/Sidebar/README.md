The app's left column as a floating pane of glass: wordmark with collapse, primary navigation, pinned and recent sessions, and the account footer.

**When to use**
- Persistent app chrome on every page, inset 12px from the window edge over the `yp-ground` aura.

**What you provide**
- `nav: { label: string; icon: JSX.Element; href: string; hint?: string }[]` (Search with a `⌘K` hint, Agents, Skills, Dashboards, Teams, Admin), the current one marked `aria-current="page"`
- `sessions: { id; title; agent; pinned?: boolean; unread?: boolean; current?: boolean; group: string }[]`, split into a Pinned section (only when any are pinned) and a Recent section, each under date groups: Today, Yesterday, Earlier this week, Earlier this month, then a month name ("June 2026")
- `account: { name; role }` and the theme toggle for the footer
- A row is avatar and title only, plus an optional unread dot. Its tooltip shows the title, then "2m · henry", then "Pinned" if pinned.

**Do**
- Use `glass-strong`, `radius-lg` and `elev-2`; the `glass-edge` rim and pointer highlight come from the bundle.
- Mark the current item with `aria-current="page"`. In the app, add a `yp-pill` to each list: the lit `selected` droplet slides between rows (FLIP, `spring-snappy`) and stretches while it travels.
- Use `yp-label` for Pinned and Recent, `yp-group` for date heads and Lucide icons at 16px in `currentColor`.
- Reveal the "…" session menu (`yp-session__more`) on hover or focus. Show a `yp-tip` beside the row after a 450ms hover, or at once on focus: fade plus a 4px slide on `spring-snappy`. Place it outside the sidebar, which clips.

**Don't**
- Don't add a timestamp, agent name or badge to the row; the tooltip carries them.
- Don't color the selected row with `accent`.
- Don't add a logo mark or a border-right; the brand is typeset in `font-sans` 600.
