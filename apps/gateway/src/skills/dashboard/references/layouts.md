# Layout archetypes

Pick the shape from what the reader will do with the page, not from the nearest template. Mixing is fine (a Brief with a Worklist at the end). All pieces below are real Kit components; keep the `header.dk-header` and formatting rules from [kit.md](kit.md). Custom `<style>` is allowed by CSP: use `--dk-*` tokens (`--dk-surface`, `--dk-border`, `--dk-muted`, `--dk-accent`, `--dk-radius`), never hex.

## Monitor

- **Use when:** recurring "how are we doing, what needs action" views (health, pipeline, PTO).
- **Structure:** header → `callout` → optional `segmented` → one `kpis` strip → question sections with a chart or table.
- **Summary first.** A `callout` of 1–4 short lines with a tone and count, linked to sections (`href: "#section-id"`), lets the reader see what matters without scrolling. Use it when there is something to flag; otherwise skip it or pass `empty: "Nothing needs attention"`.
- **KPI strip** when there are real headline numbers: one `kpis` strip of 3–6 items (loose `kpi` cards leave holes), exactly one `emphasis: true`. Add `delta`, `note`, or `trend` only with data to back them.

```html
<main>
  <header class="dk-header">
    <h1>Customer health</h1>
    <p class="dk-subtitle">
      Renewals, risk, and support load for your accounts.
    </p>
    <p class="dk-meta"><span id="as-of"></span><span id="count"></span></p>
  </header>
  <div id="attention"></div>
  <div id="kpis"></div>
  <section class="dk-section" id="at-risk">
    <h2>Which accounts are at risk?</h2>
    <p class="dk-note">Health below 60, largest ARR first.</p>
    <div id="risk-table"></div>
  </section>
  <div class="dk-cols">
    <!-- optional: two sections side by side -->
    <section class="dk-section">
      <h2>…</h2>
      <div id="a" class="dk-chart"></div>
    </section>
    <section class="dk-section">
      <h2>…</h2>
      <div id="b" class="dk-chart"></div>
    </section>
  </div>
</main>
```

## Brief / report

- **Use when:** someone reads it once, top to bottom: exec summary, QBR, pre-call brief. Often printed.
- **Structure:** header → `md` lead paragraph with the conclusion → short sections, each a sentence of prose plus one small chart or table that backs it → closing `md` with next steps.
- **Kit:** `md`, `chart` (small, `style="height:220px"`), `table` with `search: false`, `dk-cols` for chart beside text.
- **Skip:** attention callout, filters, big KPI strip (put 2–3 numbers in the prose instead; numbers must come from queries).

```html
<section class="dk-section"><div id="summary"></div></section>
<div class="dk-cols">
  <section class="dk-section">
    <h2>How has usage moved?</h2>
    <div id="usage" class="dk-chart" style="height:220px"></div>
  </section>
  <section class="dk-section"><div id="usage-text"></div></section>
</div>
```

```js
const r = YOPLAI.data.account[0];
K.md(
  "#summary",
  `**${r.name}** renews ${K.format(r.renewal, "date")}; ARR ${K.format(r.arr, "compact:EUR")}.`
);
```

## Worklist

- **Use when:** the reader has to act on items: chase, approve, review.
- **Structure:** header with one-line scope → table or grouped sections, most urgent first. Group by owner or status with one `dk-section` per group, or one table with an owner column and `segmented` to filter.
- **Kit:** `table` (pills for status, `rowTone`, `href` to the item, `limit` per group), `segmented`.
- **Skip:** KPI strip, charts, callout. The count belongs in the `h2` or `dk-meta`.

```js
const groups = new Map();
for (const r of YOPLAI.data.renewals) {
  const owner = r.owner || "Unassigned";
  groups.set(owner, [...(groups.get(owner) ?? []), r]);
}
for (const [owner, rows] of groups) {
  const sec = document.createElement("section");
  sec.className = "dk-section";
  const h = document.createElement("h2");
  h.textContent = `${owner} (${rows.length})`;
  const slot = document.createElement("div");
  sec.append(h, slot);
  document.querySelector("main").append(sec);
  K.table(slot, { search: false, limit: 10, columns, rows });
}
```

## Profile

- **Use when:** one entity (account, candidate, person) looked up by URL parameter.
- **Structure:** header with name + status pill → `dk-grid` of `dk-card` fact blocks (owner, dates, amounts) → timeline or related items as `table`/`list`, with links onward.
- **Kit:** `dk-grid`, `dk-card` (`dk-emphasis` on one), `pill`, `list`, `table`.
- **Skip:** KPI strip unless the entity has genuine headline metrics; declare `yoplai:params` in the head.

```html
<div class="dk-grid" id="facts"></div>
```

```js
for (const [label, value] of facts) {
  const card = document.createElement("div");
  card.className = "dk-card";
  const l = document.createElement("p");
  l.className = "dk-note";
  l.textContent = label;
  const v = document.createElement("strong");
  v.textContent = value;
  card.append(l, v);
  document.querySelector("#facts").append(card);
}
```

## Compare

- **Use when:** two or more entities or periods side by side (Q2 vs Q3, account vs account).
- **Structure:** header naming what is compared → either `dk-cols`/`dk-grid` of cards, one per side with the same fields in the same order, or a matrix `table` (rows = entities, columns = periods plus a delta column) → one grouped bar chart if shape matters.
- **Kit:** `dk-cols`, `dk-card`, `table` with `format`, `chart` with `legend: {}`, `kpis` `delta` for change.
- **Skip:** callout; decoration that favours one side. Show the change as a number, not only a color.

```js
K.table("#matrix", {
  search: false,
  columns: [
    { key: "account", label: "Account" },
    { key: "q2", label: "Q2", format: "compact:EUR" },
    { key: "q3", label: "Q3", format: "compact:EUR" },
    { key: "change", label: "Change", format: "percent" },
  ],
  rows: YOPLAI.data.by_account,
});
```

## Guide / explore

- **Use when:** a hub that tells people where to start, or one open-ended exploration.
- **Structure (guide):** header → short `md` intro → `dk-grid` of `dk-card`s, each a capability with one line and a link (`YOPLAI.link("page.html", {…})` for dashboards) → optional `list` of links.
- **Structure (explore):** `filters` or `segmented` above one large chart (`style="height:480px"`) and a table underneath.
- **Kit:** `dk-grid`, `dk-card`, `md`, `list` (`label`, `href`, `value`), `filters`, `chart`.
- **Skip:** KPI strip, attention callout, numbers that are not queried.

```js
K.list("#start", {
  items: pages.map((p) => ({ label: p.title, href: YOPLAI.link(p.file) })),
});
```
