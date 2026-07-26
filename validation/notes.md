# ALG-355 — Schema-driven auto-form renderer (exa tracer) — E2E validation

- **Issue/branch:** ALG-355 / `alg-355-auto-form-renderer` (stacked on `alg-354-config-surface-contract`)
- **Temp home:** `.yoplai-e2e/` (isolated; multiUser enabled, one pool agent `sales`, exa seeded as an external extension mirroring the real `exa` — single `apiKey` secret)
- **Gateway/UI ports:** 4001 / 3001 (auto-picked; 4000/3000 owned by the harness `hermes_cli gateway run --replace` supervisor)

## Tests run (all PASS)

- `pnpm test:shared` → 87 ✓
- `pnpm test:gateway` → 317 ✓
- `pnpm test:web` → 393 ✓ (15 new: 8 `auto-form-schema` unit + 7 `ExtensionConfigForm` component)
- `pnpm typecheck` clean (after building `@yoplai/extension-scheduler`, a pre-existing stale-build artifact unrelated to this change)
- `eslint` clean on all changed files

## Real-stack E2E — PASS (per acceptance criterion)

### A. In-process real code path (`validation/exa-e2e.mjs`, output `exa-e2e-output.txt`)
Drives the exact modules the API endpoint uses: `buildExtensionCatalog` (catalog.ts), `updateAgentExtensionConfig` (agent-config-writer.ts), `resolveAgentEnv` + `reloadConfig` (config/index.ts), and the tool-extension `getAgentTools` runtime path.

- **exa exposes its schema, appears as auto-form tier:** catalog BEFORE → `tier: "auto-form"`, `requiredSecrets: ["apiKey"]`, `enabled: false`. ✓
- **Submit persists via write path:** after the write, `agent.yaml` has `apiKey: $env:YOPLAI_SALES_EXA_APIKEY` (no plaintext), agent `.env` has `YOPLAI_SALES_EXA_APIKEY=sk-exa-e2e-TRACER-123`, extension enabled. ✓
- **Non-secret fields persist as plain values:** covered by unit test (`persists non-secret fields as plain config values`) — `config.baseUrl` written verbatim, `apiKey` routed to `secrets`. ✓
- **Takes effect on next run:** after layering the agent's resolved `.env` (what the gateway does before a run builds tools), `getAgentTools` returns `["exa_search"]`; an agent without the config gets `[]` (negative control). ✓

### B. Real running gateway over HTTP (temp home, port 4001, admin bearer token)
An approved admin user was seeded directly into `auth.db` (auth is not this slice's responsibility) and a bearer token minted via `yoplai user token create`.

- `GET /api/agents/sales/extensions` (admin) → exa entry: `tier:"auto-form"`, `configJsonSchema` present, `requiredSecrets:["apiKey"]`, `configRoutePath:null` — exactly what the renderer consumes. ✓
- `PATCH /api/agents/sales/extensions/exa` with `{enabled:true, config:{}, secrets:{apiKey:"sk-exa-HTTP-FORM-999"}}` (the auto-form's submit shape) → response returns refreshed catalog (exa enabled); on disk `agent.yaml` → `apiKey: $env:YOPLAI_SALES_EXA_APIKEY`, `.env` → `YOPLAI_SALES_EXA_APIKEY=sk-exa-HTTP-FORM-999`. ✓
- **Admin guard:** unauth `GET` and `PATCH` both → `401`. ✓
- Config-form route `/agents/sales/extensions/exa/config` served by the web UI → `200`. ✓

## Renderer / masked-secret behavior (component tests, jsdom)
`ExtensionConfigForm.test.tsx` renders the real page against a mocked catalog:
- `requiredSecrets` field (`apiKey`) renders as a **`type="password"`** masked input. ✓
- Submit calls `patchAgentExtension(agent, ext, {enabled:true, config:{}, secrets:{apiKey}})` and shows "Saved ✓". ✓
- Blank required field blocks submit with a warning. ✓
- Non-secret field renders as `type="text"` and persists under `config`. ✓
- Save failure surfaces an inline error; unknown extension → "Extension not found"; non-admin → redirect to `/`. ✓

## Harness gap (documented, not skipped)
An independent **browser** walkthrough of the logged-in admin form could not be run: (1) the harness `hermes_cli gateway run --replace` supervisor owns port 4000 and the e2e stack must use auto-picked ports; (2) admin login needs Google OAuth with placeholder creds, so a real browser sign-in cannot complete. Mitigation: the entire admin path was exercised against the **real running gateway** via an admin bearer token (catalog read + config write + guard), the write/runtime behavior was proven against the **real code paths** in-process, and the rendered form DOM (masked input, submit payload, guards) is covered by component tests. This matches the OAuth/port gap flagged in ALG-352/353/354.
