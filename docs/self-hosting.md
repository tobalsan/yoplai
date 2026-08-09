# Self-hosting

Start with foreground loopback setup in root [README](../README.md). Expose or daemonize Yoplai only after health, agent discovery, and one model response work locally.

## Build and run

```bash
pnpm install
pnpm build
pnpm build:web
pnpm yoplai gateway
```

Default endpoints are UI `http://127.0.0.1:3000`, API/WS `http://127.0.0.1:4000`, and health `/health`.

## macOS background service

Yoplai can install a launchd user agent that starts on login and restarts after crashes:

```bash
pnpm yoplai gateway install
pnpm yoplai gateway status
pnpm yoplai gateway stop
pnpm yoplai gateway start
pnpm yoplai gateway uninstall
```

- plist: `~/Library/LaunchAgents/com.yoplai.gateway.plist`
- logs: `$YOPLAI_HOME/logs/gateway.out.log` and `gateway.err.log`
- install is idempotent
- Linux/systemd service management is not built in

Service install captures current config directory. Export intended `YOPLAI_HOME` before installation.

## Network exposure

`gateway.bind` and `ui.bind` support:

- `loopback`: local machine only; safest default
- `lan`: all interfaces; secure with firewall/reverse proxy/auth
- `tailnet`: detected Tailscale address

Do not expose unauthenticated single-user mode directly to public internet. Prefer Tailscale, authenticated reverse proxy, or Yoplai multi-user extension. See [configuration](configuration.md) and [multi-user extension](../packages/extensions/multi-user/README.md).

### Tailscale Serve

Set `ui.tailscale.mode: "serve"` with gateway/UI bind left as loopback. Tailscale must be installed and logged in. Remote clients use tailnet HTTPS URL; local clients can still use loopback ports.

## Server deployment

For remote host:

1. Install Node 22.19+, pnpm 11, Git, and optional Docker.
2. Clone, install, build, and configure under dedicated OS user.
3. Keep `$YOPLAI_HOME` outside repository.
4. Restrict permissions on `.env`, `auth.json`, OAuth data, and bot tokens.
5. Verify foreground startup before creating service definition.
6. Put public access behind TLS and authentication.
7. Persist and back up `$YOPLAI_HOME` plus project roots.

## Upgrades

```bash
git pull --ff-only
pnpm install
pnpm build
pnpm build:web
```

Then restart gateway. Review `CHANGELOG.md` before upgrade and back up data/config first. Run documented migration commands only when release notes require them.

## Backups

Back up:

- `$YOPLAI_HOME/yoplai.json`, `.env`, agent workspaces, auth/OAuth stores
- canonical `history/` and session maps
- media and scheduler outputs if needed
- project and board content roots
- `auth.db` when multi-user mode is enabled

Protect backups as secrets. Stop gateway or use filesystem/database-consistent snapshot tooling when exact consistency matters.

## Container isolation

Docker is optional. Use it for untrusted tools, multi-tenant filesystem boundaries, or controlled egress. See [Container isolation](container-isolation.md).

## Operational checks

```bash
curl -fsS http://127.0.0.1:4000/health
curl -fsS http://127.0.0.1:4000/api/agents
pnpm yoplai auth status
pnpm yoplai gateway status # macOS service only
```

Gateway stderr and service logs are first troubleshooting source. Confirm configured ports, `YOPLAI_HOME`, agent folder/id match, credentials, and extension prerequisites.
