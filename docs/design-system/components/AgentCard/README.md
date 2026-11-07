A paper card that presents one agent: a 4:5 portrait, the name and one role line. The whole card is the link.

**When to use**
- Agent directories and team pages, laid out in a `yp-roster` on a `yp-ground` (`yp-grid` adds the dot grid).

**What you provide**
- `agent: { id: string; name: string; role: string; portraitUrl?: string; live?: boolean }`
- `href: string` (the card is the link; no extra Chat button)
- With no `portraitUrl`, use `yp-agent__portrait--blank` with `yp-agent__initial` (64px, `ink-faint`); `--lx`/`--ly` move the light pooled on it
- `live` adds a `yp-badge--accent` "Running" badge beside the name

**Roster layout**
- Use a fixed, centered layout, never a pannable canvas: a canvas crops cards out of view. The view scrolls vertically when rows overflow.
- Columns come from the count. Up to 5 agents share one row. Above 5, prefer an exact fit, then a last row of K−1, then the smallest gap, with ties going to more columns (max 5).
- Examples: 6 → 3+3, 7 → 4+3, 8 → 4+4, 9 → 3+3+3, 10 → 5+5, 11 → 4+4+3, 12 → 4+4+4, 13 → 5+5+3.
- Cards shrink to fit their columns (216px max) instead of wrapping, and the last row centers itself.

```js
function agentColumns(n, max = 5) {
  if (n <= max) return Math.max(n, 1);
  let best = null;
  for (let k = max; k >= 3; k--) {
    const rem = n % k, score = rem === 0 ? 0 : rem === k - 1 ? 1 : 2 + (k - rem);
    if (!best || score < best.score) best = { k, score };
  }
  return best.k;
}
roster.style.setProperty("--cols", agentColumns(agents.length));
```

**Do**
- Sit on `surface` with `elev-1`; on hover it lifts 2px to `elev-2` (a pre-shadowed `::after` crossfades) and tilts ≤3° toward the pointer. Put cards inside `yp-scene` (one `perspective` for the group) and write `--px`/`--py` (-1..1) from a rAF-batched pointermove.
- Show the name in `yp-agent__name` and one role line only.
- Show portraits at 4:5 in `radius-md` inside the `radius-lg` card, untinted.

**Don't**
- Don't outline the card with a border; depth comes from elevation.
- Don't repeat the role as "Customer Success AI Agent".
- Don't stack Chat buttons under portraits.
