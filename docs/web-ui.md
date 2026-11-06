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

Agent-sent PNG, JPEG, GIF and WebP files show lazy previews up to 400px high,
above their original download cards, both live and after reload. Click a preview
(or use Enter/Space) to open the image fitted to the viewport, with its filename
and Download link. Escape, Close and clicking the backdrop dismiss the viewer;
keyboard focus stays inside while open and returns to the preview on close.
Failed previews fall back to the card. SVG, other formats, inbound uploads and
older files stored with a generic MIME type keep their existing presentation.
All previews and downloads use the existing authenticated media route.

## MCP App views

`send_file` uses the built-in `yoplai` file viewer without requiring `mcp.json`.
It displays HTML, sanitized Markdown, images (including SVG as an image), text
and code, PDF pages, pretty JSON and CSV (first 500 rows). Unsupported formats and files
over 10 MB show name, type and size. An optional `title` accepts up to 200 characters.
HTML runs in a nested opaque sandbox: scripts from jsDelivr, cdnjs and unpkg,
plus Google Fonts are allowed; fetch, XHR and WebSocket connections are blocked.
Anchors scroll inside reports; only HTTP(S) links open externally. A failed
capture or unavailable apps origin preserves the existing file card.

PDFs (including generic-typed `.pdf` files) render at the view width and screen
pixel density, with accessible page names. Only the first 50 pages render; larger
documents show the total and a reminder to download all pages. Invalid, damaged
or password-protected PDFs, missing bytes, and PDF.js load failures (10-second
deadline) fall back to the file card; the header's Download remains available.
PDF search, zoom and text selection are not supported. External fonts, CMaps
and Wasm decoders that require connections are unavailable under the sandbox CSP.

Markdown Mermaid fences render as diagrams; broken blocks keep their source.
PDF.js 5.4.624 and Pele 1.9.0 load from jsDelivr inside the opaque report frame,
which also renders sanitized Markdown with the existing typography, anchors,
links and height bridge. Plain Markdown loads no CDN script and works offline.
Diagrams and PDF pages need CDN access; third-party code never runs in the
bundled viewer frame. File views refuse `ui/message` and
`ui/update-model-context` and advertise neither capability; other MCP Apps
retain their existing message and context support.

File views show the title (or filename), type, size and **Download** for the
original file in their header, inline and in the side panel. Different filenames
get separate views; sending the exact same filename again updates its view and
shows **View updated** on the later row. Filenames are basenames, so files with
the same name in different directories share a view.

Once a file view loads, **Open in browser** opens its currently shown file on
the separate apps origin. HTML opens as a page, PDFs in the browser's PDF viewer,
and PNG, JPEG, GIF, WebP and SVG as images. Text, code, JSON and CSV open as plain
text. Markdown and unsupported formats have no Open button. Download stays
available for every file. If a new tab is blocked, allow pop-ups and try again;
request failures show a short status in the header.
An open request times out after 15 seconds and closes its blank tab; the file
view, Download and chat remain usable while it waits.

An opened HTML report keeps the report's CDN rules and blocked fetch, XHR and
WebSocket connections, in an opaque sandbox without access to apps storage.
Its links and fragment anchors work natively; external links navigate that tab.
Tabs have no opener or referrer. Their bearer URL expires after one hour and
is invalidated when the session is deleted.

An outbound file card hides only after its view delivers that file's data.
Loading, failed capture, unavailable origin and view errors keep the card,
including supported inline image previews. A successful update restores the
older version's card and hides the newer version's card; a failed or timed-out
update keeps the old content, header and Download while the newer card stays
available. Expand/Collapse keeps the shown file's card hidden through remount.
Reload and old sessions show cards first, then hide them as their views load.
Uploaded files keep their existing cards. Production chats require a reachable
HTTPS `apps.origin` on a separate hostname; without it all file cards remain.

MCP App tool calls appear as their own rows in the main chat, in simple and full
mode. The row starts with "Loading view…" and stays visible when surrounding
activity collapses. Non-file headers identify the server and "MCP App". The view's
inline height is clamped to 40–800 px. Ordinary tools keep their existing groups.

Use **Expand** in the view header to open one side panel beside the chat; the
composer stays usable. Drag the panel's left edge to resize the split. The panel
covers the chat at viewport widths of 768 px or less, or when the chat area cannot
fit a 320 px panel, a 400 px chat and the 6 px handle. **Collapse** returns the view
inline. Opening another app replaces the panel; width is not saved. Each expand
or collapse reloads the view once with the latest saved data. Apps may restore
their own saved state, but unsaved iframe state can be lost.

HTML, Markdown and PDF files sent during a live turn automatically open the
panel when the viewport is wider than 768 px and the chat row has at least
726 px for the split. A later document replaces the panel, including a re-send
of the same filename. Reload, history replay, reconnect and narrow layouts never
auto-open; images, text, data and external MCP Apps stay inline. The compact
file-icon card marked "shown in the side panel" is a button that focuses the panel.

Views initialize with their saved arguments and raw result, including returned
error results. Reloading, reopening a session or restarting the gateway replays
the saved data without running the tool again. Within a session, calls sharing
the same server and resource URI reuse one live view (file views also match the
exact filename). The earliest loaded call
with a captured view hosts it; later calls show "Updating view…" while pending,
then **View updated**, which takes you to the inline view or focuses its panel.
Successful captures deliver the newest input and raw result to the same iframe.
A later failed capture shows its text and "View unavailable" without replacing
the live view. Reload shows one view per app with the latest captured data.

The panel host lives outside the transcript and stays loaded through turn
completion, reconnects, simple/full switches and history reloads. It retains its
last valid latest call while history is temporarily empty or stale. Switching
session, starting a new chat or leaving the page closes it. Inline views may
reinitialize during those transcript transitions or when loading earlier history
moves the host row to an older call.

The host advertises `inline` and `fullscreen`; a view's own fullscreen request
opens the side panel. If the app declares display modes, only modes it declares
and the host supports are allowed. A view that disallows its initial mode shows
"View unavailable"; it does not automatically open the panel. Mode and size
changes send `ui/notifications/host-context-changed`. Inline dimensions include
width and an 800 px maximum height; panel dimensions include its actual width
and height, and the view fills that space. `pip` is unsupported.

Views may call their own server's app-visible tools and read its resources as the
signed-in viewer. HTTP(S) links open in a new tab; other schemes are refused.
Initialization has a 15-second deadline, including the view request. A relayed
request with no response within 32 seconds removes the view. Loading failures,
unavailable resources/origins and timeouts show the text result and "View
unavailable"; view work does not block Stop or sending another message. A normal
JSON-RPC error, such as a model-only tool refusal, stays inside the view. Fetching
new data for a reused view has a 32-second deadline: failure or timeout logs a
warning and keeps the last delivered data. Newer updates cancel older fetches,
and late responses cannot replace newer data.

Views can send text-only `ui/message` requests directly as normal user messages
of the signed-in viewer. Text blocks are joined with a blank line. Messages must
be nonempty after trimming, at most 4000 characters, and cannot start with `/`.
Each app view may reserve one send every 2 seconds and at most 10 in 10 minutes.
The limit survives expand/collapse and transcript remounts, resets on session
change, and is not shared across tabs or persisted across reloads. Refusals return
`-32000` with a short reason; malformed or non-text content returns `-32602`.
Hosts without a message callback omit the capability and return `-32601`.

A view message queues while the agent streams in queue mode; other busy modes
refuse it without interrupting the run. History loading, uploads, impersonation,
or another send preparing also refuse it. The host checks again after restoring
an archived chat or compacting context, including whether the session changed.
Success means local send handoff; a later transport failure uses the chat's usual
error display. Audit logs record outcome and length, never message text.

`ui/update-model-context` replaces the latest context of that session's app view.
Text blocks and optional structured JSON are supported; other valid content
blocks are ignored. Empty context clears the selection. Each update is limited
to 16 KiB of UTF-8 text and JSON; an invalid or oversized replacement keeps the
previous value. The gateway keeps at most 8 views per session and 1000 entries
overall, evicting the least recently updated. Context is memory-only and lost on
gateway restart or session deletion. Audit logs record size and outcome only.

The next newly started Pi or container run receives one marked context block per
view as model input, outside the transcript and canonical stored user message.
It is consumed only after the initial run succeeds without an abort; failures
keep it for a later run. Updates arriving during that run survive consumption.
Messages joining an active run do not inject or consume context. Thinking-level
retries reuse the same snapshot, and reviewer rewrites do not receive a new
context nudge. OpenClaw does not consume this context. Model SDK session files
may retain the injected prompt, and the agent may quote it: consuming context
does not make the model forget it.

No device permissions are granted. The apps origin must have a different hostname from the
chat; a different port alone is insufficient. All servers' views share one apps
origin and its storage, separate from chat storage/cookies. CSP uses approved
origin lists and drops wildcards; see [configuration](configuration.md#mcp-apps).

The bootstrap uses a private ticket variant: the host sends
`ui/notifications/sandbox-resource-ready` with empty HTML and the bootstrap loads
the saved resource through its ticket. That bootstrap message is not literal MCP
Apps specification conformance. Two further deliberate extensions of the stable
spec are that `fullscreen` uses a side panel instead of the full window, and
reuse repeats `tool-input`/`tool-result` during one view lifetime (the stable spec
sends `tool-input` once; see [ext-apps #430](https://github.com/modelcontextprotocol/ext-apps/issues/430)).
Payload shapes follow SDK 1.7.5. Apps must handle repeated input and result events
to support reuse; the host currently has no per-server opt-out.

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
