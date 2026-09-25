# ALG-436 validation

- Branch: `ALG-436-dashboard-kit`
- Isolated home: `.yoplai-e2e`
- Real stack: gateway `http://127.0.0.1:4001`, UI `http://127.0.0.1:3001`
- Automated checks: `pnpm exec vitest run apps/gateway/src/canvas/canvas.test.ts` (32 passed), `pnpm test:gateway` (645 passed), `pnpm build`, `pnpm typecheck`, `pnpm lint` (0 errors), `git diff --check`
- Browser: Chrome loaded `/d/alg-436-sample` through the real gateway with the Canvas CSP; all seven ECharts SVGs, every kit component, and sanitized Markdown rendered; console had 0 errors/warnings.
- Interactions: table search/sort, tab switch, select and range filters passed. Playwright observed and saved the `sample.csv` download successfully.
- Themes/print: light and dark screenshots are `validation/01-light.png` and `validation/02-dark.png`; DOM evidence is `validation/01-dashboard.dom.txt`. Chrome printed `validation/03-print.pdf` with `--print-to-pdf-page-size=A4`; `pdfinfo` reports 3 pages at 594.96 x 841.92 pt, and visual inspection confirmed chart headings stay with their charts.
- Public assets: unauthenticated `kit.js` and `echarts.js` returned 200 with `public, max-age=31536000, immutable`, correct JavaScript MIME, and `nosniff`.
