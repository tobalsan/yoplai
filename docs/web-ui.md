# Web UI

Gateway starts Solid.js UI by default. UI discovers enabled features from `/api/capabilities`; optional routes are lazy and capability-gated.

## Core routes

- `/` — configured home capability (board when enabled, otherwise agent list)
- `/agents` — agent catalog/list
- `/chat/:agentId` — direct agent chat
- `/projects` — project lifecycle when projects/board enabled
- `/teams` and `/admin/users` — multi-user administration when enabled
- `/admin/extensions` — the Admin page's superadmin **Top extensions** tab (beside **User management**): starred extensions/MCP servers sort first and are suggested in the chat **Connect <agent> to your tools** prompt (shown once per agent, never over a tour step; reopen via **Connect tools** in the sidebar)

Persistent left navigation adapts to capabilities and role. Branding comes from capability config when set.

Search is the first navigation item, including in the collapsed sidebar. Click it
or press Cmd+K (Ctrl+K on Windows/Linux) on any page except login to search your
chat titles and user/assistant message text across accessible agents and chat
Projects. All whitespace-separated words must occur, in any order, ignoring
case. Archived chats and other users' chats are excluded.

The palette opens with a focused input and no recent-session list. Results show
the chat label, agent, relative date and a highlighted content snippet. Title
matches come first, newest first within each group, with at most 50 results.
Use Up/Down and Enter, or click a result, to open the chat. Escape or clicking
outside closes search.

## Chat

Core chat supports:

- WebSocket streaming and background subscriptions
- simple and full structured history views
- Copy reply after the last agent bubble's timestamp copies all text in a completed turn, excluding tools, thinking, files and failure notices. Rich paste preserves structure while using the destination's font and colors; plain paste removes markdown formatting. Incomplete turns from paginated history cannot be copied until their beginning is loaded.
- Copy code on each agent code block copies its raw text, including indentation and newlines. Both copy controls support keyboard/touch, remain visible on narrow screens, and show Copied or Copy failed. Clipboard access requires HTTPS or localhost; browsers without rich clipboard support fall back to plain text. These controls are limited to the main chat.
- thinking/tool/file blocks where authorized
- file picker and drag-and-drop uploads
- stop/abort with partial response preservation
- explicit sessions and session history
- empty chats open on a centered hero: avatar, random one-liner, composer, and prompt suggestions (or a note when none are configured); the composer animates to the docked position on first send
- clicking "Chat" in the Agents catalog always starts a fresh session (new logical session key per click; never the agent's "main" session)
- `/new`, `/reset`, and `/compact`
- context usage warning and automatic compaction near limit

Full tool/thinking/model view is restricted in multi-user mode. Canonical transcript lives in gateway history store; Pi runtime session files are not UI source of truth.

## Projects and board

Projects provide lifecycle views, editable pitch/spec documents, slice kanban, threads, activity, subagent runs, and Space integration. Board home provides a full-width canvas with local Scratchpad and Project lifecycle tabs, project projections, and worktree status.

Project detail:

- Pitch uses `PITCH.md`; legacy README body may be fallback.
- Slice specs use `SPECS.md`; tasks, validation, and thread stay separate.
- Agent tab shows scoped subagent runs, their logs, and follow-up messages.
- Changes tab displays Space queue, diffs, commits, rebase/conflict, and integration actions.

See [Projects](projects.md).

## Optional routes

Optional route bundles register under `apps/web/src/extensions/*/routes.tsx`. Core `App.tsx` must not import board/projects modules directly. New extension UI should declare capability/config routes and remain buildable when package is absent.

## Remote web development

Vite can proxy UI on one machine to gateway on another. See [Development](development.md). For end-user remote access, use secure self-hosting path instead of dev proxy; see [Self-hosting](self-hosting.md).
