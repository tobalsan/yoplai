# Web UI

Gateway starts Solid.js UI by default. UI discovers enabled features from `/api/capabilities`; optional routes are lazy and capability-gated.

## Core routes

- `/` — configured home capability (board when enabled, otherwise agent list)
- `/agents` — agent catalog/list
- `/chat/:agentId` — direct agent chat
- `/projects` — project lifecycle when projects/board enabled
- `/teams` and `/admin/users` — multi-user administration when enabled

Persistent left navigation adapts to capabilities and role. Branding comes from capability config when set.

## Chat

Core chat supports:

- WebSocket streaming and background subscriptions
- simple and full structured history views
- thinking/tool/file blocks where authorized
- file picker and drag-and-drop uploads
- stop/abort with partial response preservation
- explicit sessions and session history
- `/new`, `/reset`, and `/compact`
- context usage warning and automatic compaction near limit

Full tool/thinking/model view is restricted in multi-user mode. Canonical transcript lives in gateway history store; Pi runtime session files are not UI source of truth.

## Projects and board

Projects provide lifecycle views, editable pitch/spec documents, slice kanban, threads, activity, subagent runs, and Space integration. Board may provide split shell, lead-agent chat, scratchpad, project projections, and worktree status.

Project detail:

- Pitch uses `PITCH.md`; legacy README body may be fallback.
- Slice specs use `SPECS.md`; tasks, validation, and thread stay separate.
- Agent tab combines scoped lead sessions and subagent runs.
- Changes tab displays Space queue, diffs, commits, rebase/conflict, and integration actions.

See [Projects](projects.md).

## Optional routes

Optional route bundles register under `apps/web/src/extensions/*/routes.tsx`. Core `App.tsx` must not import board/projects modules directly. New extension UI should declare capability/config routes and remain buildable when package is absent.

## Remote web development

Vite can proxy UI on one machine to gateway on another. See [Development](development.md). For end-user remote access, use secure self-hosting path instead of dev proxy; see [Self-hosting](self-hosting.md).
