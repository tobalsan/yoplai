# Dashboard Kit and ECharts

Load only platform assets; remote scripts and styles are blocked by Canvas CSP.

```html
<link rel="stylesheet" href="/d-assets/v2/kit.css" />
<script src="/d-assets/v2/echarts.js"></script>
<script src="/d-assets/v2/marked.js"></script>
<script src="/d-assets/v2/purify.js"></script>
<script src="/d-assets/v2/kit.js"></script>
```

Put all page code in one `<script type="module">` after the markup (never a classic `<script>`: top-level `const top`, `window`, `document`, or `location` throw and blank the page). Module code has its own scope, so never use inline `on*=` handlers; attach them with `addEventListener`. Every snippet below goes inside that module.

`DashboardKit` components: `callout`, `kpis`/`kpi`, `table`, `pill`, `segmented`, `filters`, `tabs`, ranked `list`, sanitized `md`, `chart`, and `format`. `/d-assets/v2/sample.html` shows every one. Pages that still load `/d-assets/v1/` keep working; use `v2` for new pages.

The theme follows the viewer's light/dark mode (`data-theme="light|dark"` overrides it) and inherits deployment colors from `$YOPLAI_HOME/theme.css`. Print styles are A4 and hide filters, search, and buttons. Use DOM APIs or Kit helpers for dynamic content; use `textContent`, never interpolate untrusted values into `innerHTML`. The CSP permits platform `/d-assets/`, inline page script/style, data/blob images, and no network connections.

## Design guidance

**Always on** (visual consistency; this is what makes pages feel finished):

- **Format every number** with a `format` (`number`, `currency:EUR`, `compact:EUR`, `percent`, `date`); raw `1234567` or ISO dates look broken. `percent` expects a ratio (0.12 → 12.0%).
- **States are pills.** Map each status to a tone: `critical` (bad, act now), `warn` (needs attention), `good` (healthy), `info` (neutral fact), `neutral` (inactive/other). Keep one mapping across the page so colors keep their meaning.
- **Color means state.** Charts use the default palette; use tone colors (`"var(--dk-negative)"` etc.) only when the series _is_ a state. Use theme tokens only: no custom hex, gradients, or emoji, so dark mode and deployment themes keep working.
- **Cap long tables** with `limit: 10` ("Show all" expands), `search: false` under ~15 rows, and link the name column to its drill-down with `href`.
- **No ECharts `title`**; put an `h2` above the chart.
- **Safe DOM:** `textContent` or Kit helpers for dynamic text, never untrusted `innerHTML`.

**Defaults** (good starting points; drop or swap them when the page has a different job). Page shapes, including when to use a `callout` or `kpis` strip, are in [layouts.md](layouts.md).

- **Sections that answer a question.** `section.dk-section` > `h2` phrased as the question ("Which accounts are at risk?"), optional `p.dk-note` with scope, then one chart or table. About 3–5 sections keeps a page scannable; drop blocks nobody will act on.
- **Chart choice:** ranked or compared values → horizontal bar (sorted, top 10); trends → line; share of a whole with ≤5 parts → donut; heatmap only when both dimensions matter.

## Layout helpers

Use `.dk-card` for a free-form bordered box and add `.dk-emphasis` to highlight one.

## Components

```js
const K = DashboardKit;

// Needs attention: tone per line, optional value and link
K.callout("#attention", {
  title: "Needs attention",
  items: [
    {
      tone: "critical",
      text: "3 renewals this month have no owner",
      href: "#at-risk",
    },
    {
      tone: "warn",
      text: "12 accounts silent for 60+ days",
      value: K.format(98000, "compact:EUR"),
    },
  ],
  empty: "Nothing needs attention",
});

// KPI strip: numbers are formatted; last tile stretches so rows have no holes
K.kpis("#kpis", {
  items: [
    {
      label: "ARR",
      value: 1243500,
      format: "compact:EUR",
      emphasis: true,
      note: "across 84 accounts",
    },
    {
      label: "Customers",
      value: 1842,
      format: "number",
      delta: 36,
      trend: [1702, 1750, 1790, 1842],
    },
    {
      label: "Churn",
      value: 0.021,
      format: "percent",
      delta: -0.004,
      deltaFormat: "percent",
      good: "down",
    },
  ],
});
// delta: number (signed + colored) or string with direction: "up"|"down". good: "down" when lower is better.

// Table with formatters, pills, links, severity dots, and a row cap
const HEALTH = { Healthy: "good", "At risk": "warn", Critical: "critical" };
K.table("#risk-table", {
  filename: "at-risk.csv",
  limit: 10,
  rowTone: (row) => HEALTH[row.health], // optional leading severity dot
  columns: [
    {
      key: "name",
      label: "Account",
      href: (row) => YOPLAI.link("client.html", { id: row.id }),
    },
    { key: "health", label: "Health", pill: HEALTH }, // arrays of values render several pills
    { key: "arr", label: "ARR", format: "currency:EUR" },
    { key: "renewal", label: "Renewal", format: "date" },
    {
      key: "owner",
      label: "Owner",
      render: (value, row) => value || "Unassigned",
    },
  ],
  rows: YOPLAI.data.accounts,
});
// Options: search: false, csv: false, empty: "No accounts at risk". Numeric columns right-align automatically.

// Pill anywhere
el.append(K.pill("At risk", "warn"));

// Segmented filter: re-render sections in onChange
K.segmented("#segment", {
  options: [
    { value: "all", label: "All" },
    { value: "ent", label: "Enterprise" },
  ],
  value: "all",
  onChange: (value) => render(value),
});

// Formatting helper for text you build yourself
K.format(4507354, "compact:EUR"); // "€4.5M"
K.format(0.125, "percent"); // "12.5%"
K.format("2026-03-06", "date"); // "Mar 6, 2026"
```

`filters`, `tabs`, `list`, and `md` keep their existing options (see `sample.html`).

## Charts

Charts render as SVG and must use a `.dk-chart` target (320px tall by default; set `style="height:…"` for long bar lists). `DashboardKit.chart(target, option)` takes a plain ECharts option and applies the theme: palette from the page tokens, faint dashed grids, tooltips, rounded bars, soft area fills on single lines, a square-root color ramp on heatmaps so one outlier does not wash out the rest, and readable cell labels. Calling it again on the same target replaces the chart. Series colors may be CSS tokens such as `"var(--dk-negative)"`.

```js
// Ranked horizontal bars: top 10, largest at the top
const top = rows.slice(0, 10).reverse();
K.chart("#owners", {
  xAxis: { type: "value" },
  yAxis: { type: "category", data: top.map((r) => r.owner) },
  series: [{ type: "bar", data: top.map((r) => r.leads) }],
});

// Stacked states: color only because the series are states
K.chart("#by-state", {
  legend: {},
  xAxis: { type: "value" },
  yAxis: { type: "category", data: names },
  series: [
    {
      name: "Critical",
      type: "bar",
      stack: "s",
      color: "var(--dk-negative)",
      data: critical,
    },
    {
      name: "At risk",
      type: "bar",
      stack: "s",
      color: "var(--dk-warning)",
      data: atRisk,
    },
  ],
});

// Trend line
K.chart("#trend", {
  xAxis: { type: "category", data: months },
  yAxis: {},
  series: [{ name: "Revenue", type: "line", data: revenue }],
});
```

Other supported types: donut/pie (`radius: ["45%", "65%"]`), gauge, heatmap (with `visualMap: { min, max }`), funnel, and tree. With multiple series, add `legend: {}`; the theme places it at the bottom. If ECharts fails to load or an option is invalid, the chart area shows a short message instead of breaking the rest of the page.
