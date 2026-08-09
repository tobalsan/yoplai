# Development

## Commands

```bash
pnpm install
pnpm dev          # gateway + web, dev isolation and port discovery
pnpm dev:gateway  # production-mode gateway/shared/web hot reload
pnpm dev:web      # Vite UI only
pnpm build
pnpm build:web
pnpm typecheck
pnpm lint
```

Dev entrypoints use `NODE_OPTIONS=--conditions=development` so workspace extension/shared imports resolve source without rebuilding dist.

## Dev mode

`pnpm dev`:

- finds free gateway/UI ports when defaults are occupied
- disables messaging transports, scheduler, and heartbeat
- skips Tailscale Serve changes
- shows dev banner/title/badge

Use `pnpm yoplai gateway` after build for production-like local testing with all configured services.

`pnpm init-dev-config` creates fixture-oriented repo-local `.yoplai`; it is for repository development, not beginner self-host deployment. If used, export:

```bash
export YOPLAI_HOME="$PWD/.yoplai"
pnpm init-dev-config
```

Review generated config before running because it may include development fixtures.

## Tests

Run scoped suites serially:

```bash
pnpm test:gateway
pnpm test:web
pnpm test:shared
pnpm test:cli
pnpm exec vitest run path/to/exact.test.ts
```

Do not use `pnpm test -- <path>` for one file. Run `pnpm install` when `node_modules` is missing. User-facing changes should follow [end-to-end validation](validation_e2e.md).

## Remote web development

When UI runs on machine A and gateway/projects on machine B:

Machine B `yoplai.json`:

```json
{
  "gateway": { "bind": "lan", "port": 4000 }
}
```

Machine A config used by Vite:

```json
{
  "gateway": { "host": "machine-b-host", "port": 4000 }
}
```

Run only `pnpm dev:web` on machine A. Vite proxies relative `/api` and `/ws` to configured gateway host/port.

Do not run gateway commands on machine A with remote `gateway.host`; local process may try binding remote address and fail `EADDRNOTAVAIL`.

`apiUrl`/`YOPLAI_API_URL` controls HTTP CLI target. `gateway.host`/`gateway.port` control server bind and are reused by Vite proxy; they are not equivalent.

## Repository ownership

```text
apps/gateway/              gateway, CLI, runtime, APIs
apps/web/                  Solid.js UI
container/agent-runner/    Docker sandbox entrypoint
packages/extensions/       optional feature packages
packages/shared/           schemas/types/protocols
docs/                      human and LLM guides
```

Architecture invariants and change-placement rules: [LLM repository map](llms.md).
