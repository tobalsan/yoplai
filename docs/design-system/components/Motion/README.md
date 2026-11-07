Interactive showcase of the design-system motion layer: ten small demos you can click, hover and replay, all on the compositor (transform and opacity only). Paper cards sit on a `yp-ground`.

- **Press**: `yp-btn` `:active` scale, `dur-instant` in, `spring-pop` out. Hover is a state layer (`::before` opacity), not a color animation.
- **Selection pill**: `yp-pill`, JS sets `--y`; CSS transitions `translate` on `spring-snappy`. During travel a WAAPI animation of the independent `scale` property stretches it like a droplet (up to `1 + 0.085 × rows`), then settles. First placement skips the transition.
- **Tabs underline**: `yp-tabs__ink`, JS sets `--x` and `--sx` (tab width / 100); `translateX` + `scaleX` on `spring-snappy`.
- **Streaming reply**: `yp-thinking` for 900ms, then 2-4 word `yp-chunk` spans every 45ms; `dur-base` `ease-out` fade.
- **List stagger**: `yp-stagger` + `--i`, `@starting-style` rise; replay removes and re-inserts nodes.
- **Progress**: `--value` on `yp-progress__fill`; `translateX` on `spring-smooth` inside a clipped track; warning at 0.75, critical at 0.9.
- **Toast**: glass `yp-toast` + `yp-check` (stroke-dashoffset on `spring-pop`); exits via `data-leaving` at `dur-quick`; siblings slide with FLIP (WAAPI, `dur-spring-snappy` and `spring-snappy` read at runtime).
- **Menu**: native `popover`, glass-strong `yp-menu` with `yp-menu__item` rows; `allow-discrete` display and overlay so the exit animates.
- **Modal**: native `<dialog class="yp-modal">` in glass-strong on `elev-4`; the page (`yp-recede`) scales to 0.98 behind the scrim; panel on `spring-smooth` in, `dur-quick` `ease-in` out. The dialog styles live in bundle.css.
- **Spring curves**: `spring-smooth`, `spring-snappy`, `spring-pop` with their `dur-spring-*` on a 240px track.

Respects `prefers-reduced-motion`: streaming, stretch and FLIP are skipped, final state shown.

Source: design-system motion layer in components/bundle.css
