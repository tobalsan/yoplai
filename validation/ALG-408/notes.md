# ALG-408 validation

- Branch: `ALG-408-all-users-team-membership`
- Isolated home: `.yoplai-e2e`
- Real stack: gateway `http://127.0.0.1:4001`, UI `http://127.0.0.1:3001`
- Gateway started with `YOPLAI_HOME="$PWD/.yoplai-e2e" pnpm dev`.
- Confirmed the real multi-user gateway started and created the expected SQLite tables, including `teams` and `team_members`. `capabilities.json` and `web.html` capture the unauthenticated gateway/UI responses.

Gap: browser automation is unavailable in this environment, and the temporary Google OAuth configuration cannot mint two authenticated browser sessions. The required authenticated All-users UI/access scenarios were therefore not exercised end-to-end. Focused integration tests cover the authenticated API/access behavior.
