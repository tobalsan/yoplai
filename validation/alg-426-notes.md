# ALG-426 validation

- Branch: `ALG-426-capability-discovery`
- Isolated home: `.yoplai/alg426`
- Gateway/UI: `http://127.0.0.1:43126` / `http://127.0.0.1:43127`
- Passed: real gateway loaded the always-on meta-extension and the external `sheets` fixture appeared disabled in `alg-426-extension-catalog.json`; UI HTML loaded into `alg-426-web.html`.
- Passed: `pnpm build`, `pnpm typecheck`, `pnpm exec vitest run --dir apps/gateway/src --no-file-parallelism` (86 files / 577 tests), focused capability tests, and changed-file lint.
- Harness gap: this repository has no deterministic model/tool-call endpoint, so the chat-only `capabilities.list`/`capabilities.enable` flow cannot be invoked through a real conversation without provider credentials. Tool-level tests cover list logging, secret refusal, live extension reload, and MCP merge.
- Regression validation: isolated `support` and `casey` agents (with Casey's `sheets` MCP server) ran on ports `43126` / `43127`; the real gateway served both agents and the browser evidence is `alg-426-regression-ui.png` and `alg-426-regression-ui.dom.yml`. The confirmed attach remains covered at the public tool surface because the real chat flow has the harness gap above.
