Interactive showcase of the three planes and how they react: the lit ground, opaque paper and liquid glass.

- **Glass over moving light**: aura blobs drift by `transform` only (`will-change: transform` while they loop) and a feed of paper rows scrolls underneath, so `blur-glass`, `glass-saturate` and the `glass-edge` rim read. Shows `yp-glass` next to `yp-glass--strong`.
- **Specular highlight**: every glass element carries a radial `::after` that follows the pointer by `transform`. Pages write `--mx`/`--my` (px) from one rAF-batched pointermove; a `spring-snappy` transition smooths it.
- **Press squish**: `yp-squish` scales to `1.02, 0.97` at `dur-instant` and springs back on `spring-pop`.
- **Refraction**: `yp-glass--refract` uses `backdrop-filter: url(#yp-liquid)` (an SVG `feTurbulence` + `feDisplacementMap` the page defines) inside `@supports`, Chromium only; elsewhere it stays blur + saturate. The toggle compares both.
- **Elevation**: `elev-1` to `elev-4` on paper. Each step up is lighter, softer and farther.
- **Lift and tilt**: `yp-agent` (or any `yp-lift`) inside a `yp-scene` rises 2px and tilts ≤3°; the `elev-2` shadow is a pre-shadowed `::after` that fades in.
- **Recede**: the page root is `yp-recede`; with `data-receded` it scales to 0.98 on `spring-smooth` while the native `dialog.yp-modal` rises over the `scrim`.

Respects `prefers-reduced-motion` (no drift, no tilt, fades only) and `prefers-reduced-transparency` (glass turns `surface-raised`, aura off).

Source: components/bundle.css (planes, glass, motion)
