# Dashboard Kit and ECharts

Load only platform assets; remote scripts and styles are blocked by Canvas CSP.

```html
<link rel="stylesheet" href="/d-assets/v1/kit.css" />
<script src="/d-assets/v1/echarts.js"></script>
<script src="/d-assets/v1/marked.js"></script>
<script src="/d-assets/v1/purify.js"></script>
<script src="/d-assets/v1/kit.js"></script>
```

`DashboardKit` components: `kpi`, searchable/sortable `table` with CSV export, ranked `list`, `tabs`, `filters`, sanitized `md`, and `chart`. ECharts-supported examples: bar, line, donut/pie, gauge, heatmap, funnel, and tree. Charts render as SVG and must use a `.dk-chart` target. The theme follows OS light/dark mode; `data-theme="light|dark"` overrides it. Print styles are A4 and hide filters/search/buttons.

Use DOM APIs or Kit helpers for dynamic content; use `textContent`, never interpolate untrusted values into `innerHTML`. The CSP permits platform `/d-assets/`, inline page script/style, data/blob images, and no network connections.
