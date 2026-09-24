# ALG-439 validation

- Branch: `ALG-439-return-after-login`
- Isolated home: `.yoplai-e2e`
- Gateway/UI: `http://127.0.0.1:4010`, `http://127.0.0.1:3010`
- Tests: `pnpm exec vitest run apps/web/src/auth/return-to.test.ts` (10 passed); `pnpm test:web` (437 passed); `pnpm typecheck` (passed); `pnpm lint` (0 errors, 121 warnings outside changed files).
- Chat deep link: opening `/chat/henry?session=new` while logged out redirected to `/login?returnTo=%2Fchat%2Fhenry%3Fsession%3Dnew`; the real Better Auth endpoint returned 200 and received `callbackURL: http://127.0.0.1:3010/chat/henry?session=new`.
- Dashboard link: the real gateway returned 302 from `/d/ALG439dashboard000000000000000000` to `http://localhost:3010/login?returnTo=%2Fd%2FALG439dashboard000000000000000000` (`03-dashboard-redirect.headers.txt`).
- Invalid return target: `//evil.com` produced `callbackURL: http://127.0.0.1:3001/`; unit coverage also verifies `https://evil.com` is rejected.
- Evidence: `01-chat-deep-link-login.png`, `01-chat-deep-link-login.dom.txt`, `02-invalid-return-to.png`, `02-invalid-return-to.dom.txt`, `03-dashboard-redirect.headers.txt`.
- Harness gap: fake Google credentials reach Google's `invalid_client` page, so the external OAuth completion and authenticated landing could not be exercised. The pre-OAuth callback payloads and gateway redirect were exercised against the real stack.
