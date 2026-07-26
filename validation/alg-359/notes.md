# ALG-359 validation notes

- Issue: ALG-359 — Hardening: encrypt tokens at rest + operator OAuth setup docs
- Branch: alg-359-encrypt-tokens (worktree, based on origin/teams)
- Temp home: .yoplai-e2e (isolated YOPLAI_HOME, removed after run)

## Fail-closed hardening (reviewer follow-up, attempt 2)
Reviewer flagged that a missing oauth.encryptionKey silently persisted plaintext.
Fixed: OAuthConnectionStore now FAILS CLOSED — #encryptTokens() throws instead of
writing plaintext when no cipher is configured. Reads still tolerate legacy
plaintext rows (re-encrypted on next save). Operator doc updated ("key required
to connect", not "no key = plaintext").

## Unit / scoped tests
- pnpm exec vitest run apps/gateway/src/oauth/   -> 31 passed
  (store.test 10: TokenCipher + store-at-rest + NEW fail-closed test;
   service.test 14, routes.test 7 — updated to inject a TokenCipher)
- pnpm test:gateway  -> all passed (no regressions)
- pnpm test:shared   -> all passed

## E2E (real runtime path, isolated YOPLAI_HOME)
Script: validation/alg-359/e2e-token-encryption.mts
Seeded yoplai.json: oauth.providers.google ($env: refs) + oauth.encryptionKey ($env:YOPLAI_OAUTH_ENCRYPTION_KEY),
seeded $YOPLAI_HOME/.env with the key + client id/secret.
Drove the REAL OAuthService (real loadConfig, real file-backed store, real config-sourced
resolveTokenCipher): startAuthorization -> handleCallback -> store.save -> on-disk file.
Only Google's HTTP token/userinfo endpoints were faked (network boundary), same strategy as ALG-357.

Asserted on the on-disk row ($YOPLAI_HOME/oauth/main__google.json, captured as 01-token-row-on-disk.json):
- accessToken + refreshToken are `enc:v2:...` AES-256-GCM ciphertext
- NO plaintext token substring appears anywhere in the file
- file mode 0600
- read-back through the real service transparently decrypts to the original tokens
RESULT: E2E PASS.

Command:
  YOPLAI_HOME="$(pwd)/.yoplai-e2e" pnpm exec tsx validation/alg-359/e2e-token-encryption.mts

## E2E fail-closed (real runtime path, isolated YOPLAI_HOME, NO key seeded)
Script: validation/alg-359/e2e-fail-closed.mts
Seeded yoplai.json WITHOUT oauth.encryptionKey. Drove the REAL OAuthService
startAuthorization -> handleCallback (fake Google token/userinfo). The store
refused to persist: handleCallback threw with a message naming oauth.encryptionKey,
and NO $YOPLAI_HOME/oauth/main__google.json file was written.
RESULT: E2E PASS — plaintext token row is never created without a key.

Command:
  YOPLAI_HOME="$(pwd)/.yoplai-e2e-nokey" pnpm exec tsx validation/alg-359/e2e-fail-closed.mts

## Known gap
Full browser consent round-trip against real Google is not exercised (needs real Google
credentials + human consent the harness cannot provide). The token-at-rest behavior — the
subject of this issue — is fully exercised end-to-end through the real gateway store/config path.
