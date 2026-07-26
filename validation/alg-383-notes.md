# ALG-383 validation

- Isolated home: `.yoplai-e2e`; gateway/UI: `4101` / `3101`.
- `YOPLAI_HOME=$(pwd)/.yoplai-e2e pnpm dev` served the real gateway and UI.
- Evidence: `e2e-agents.json`, `e2e-capabilities.json`, `e2e-web.html`.
- Focused Slack tests and `pnpm test:gateway` passed.
- A real Slack Socket Mode DM could not run: the isolated harness has no Slack app credentials or recipient. The public tool-to-inbound-DM test covers store reopen, one-time consumption, top-level-only injection, and channel discrimination.
