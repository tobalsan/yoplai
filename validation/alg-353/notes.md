# ALG-353 E2E Validation Notes

- **Issue/branch:** ALG-353 / `alg-353-extension-write` (stacked on `alg-352-extension-catalog`)
- **Temp home:** `.yoplai-e2e/` (isolated, single pool agent `sales`)
- **Gateway:** real gateway launched via `tsx src/cli/index.ts gateway`, `127.0.0.1:4066`
- **UI:** not exercised via browser (see harness gap)

## Test commands
- `pnpm test:shared` → 81 ✓
- `pnpm test:gateway` → 316 ✓ (writer round-trip ×7, PATCH endpoint ×7)
- `pnpm test:web` → 374 ✓ (EditAgent ×12 incl. toggle-persist + error)
- `pnpm typecheck` → clean

## Real-stack e2e (single-user mode → admin guard passes)
Transcript: `validation/e2e-transcript.txt`. All PASS:
1. Initial `agent.yaml` has no `extensions` block.
2. `PATCH /api/agents/sales/extensions/discord {enabled:true}` → 200; response catalog shows discord enabled.
3. `agent.yaml` rewritten with `extensions.discord.enabled: true`.
4. Fresh `GET .../extensions` → discord enabled=True (config reload took effect, not a fake write).
5. `PATCH {enabled:false}` → 200; yaml `enabled: false`; fresh GET enabled=False (round-trip).
6. `PATCH langfuse {enabled:true, secrets:{secretKey:...}}` → 200; yaml holds `secretKey: $env:YOPLAI_SALES_LANGFUSE_SECRETKEY`; real value only in `pool/sales/.env`; **no plaintext secret in agent.yaml** (grep PASS).

## Server-side guard (multiUser enabled)
Transcript step 7: unauthenticated `PATCH` and `GET` both → **401** (auth middleware rejects before the handler). The 403 non-admin (authenticated) path is covered by unit tests exercising the real Hono route with a mocked non-admin auth context.

## Harness gap (documented, not skipped)
A fully authenticated **admin browser** walkthrough (login → `/agents/:id/edit` → click toggle) cannot run here: multiUser requires Google OAuth and the e2e config uses placeholder creds, so no admin session can be minted (same gap noted in ALG-350/352). The admin-200 / non-admin-403 / 404 / invalid-body / toggle-persist / toggle-error UI paths are covered by unit tests over the real Hono route and the real Solid component. The write mechanism itself (PATCH → yaml rewrite → env secret → reload → observed change) is proven end-to-end against the live gateway in single-user mode above.
