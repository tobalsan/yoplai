Two ways to switch peer views: an underlined tab row on paper, and a glass segmented control for chrome.

**When to use**
- `yp-tabs` for an agent's Overview and Settings inside a page.
- `yp-seg` for a few views in a page header over the ground (Chat / Dashboards / Jobs), or `yp-seg--field` inside other glass (the theme switch).

**What you provide**
- `tabs: { id: string; label: string; href?: string }[]`
- `selected: string`, `onSelect(id)`
- Each tab carries `role="tab"` and `aria-selected` (segmented radios use `aria-checked`)

**Do**
- Slide the orange underline (`yp-tabs__ink`, `translateX` + `scaleX`) and the segmented `yp-seg__thumb` (`translate` on `spring-snappy`, plus a WAAPI `scale` droplet stretch).
- Keep segments equal width; the thumb is a lit lens: `surface-raised` (`selected` in dark), `glass-edge` highlight, `elev-1`.
- Use sentence case labels and five tabs or fewer.

**Don't**
- Don't use tabs for navigation between pages (use `yp-nav`).
- Don't fill the selected tab or segment with `accent`.
- Don't wrap labels onto two lines.
