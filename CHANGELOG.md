# Yoplai Release Notes

All notable changes to Yoplai are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0:
the minor slot carries breaking changes, the patch slot carries compatible ones).

Breaking changes are marked **⚠ BREAKING**.

## [Unreleased]

### Added

- Mattermost bot channel with threaded conversations, direct messages, files, proactive tools and scheduler delivery.
- Slack downloads full Markdown, text, CSV, JSON and code snippets as attachments, and accepts PowerPoint files. Web and gateway uploads now also accept JSON, legacy PowerPoint and `.markdown` files.
- Add the `reflect` agent option. It adds a self-improvement prompt so the agent saves lessons to skills and `memory.md` in the same turn. Off by default.

### Fixed

- Gateway restarts reclaim stale same-repo Vite previews, preserve foreign UI port listeners, and report early web UI exits with structured startup errors.
- Allow failed Threadit items to run again after a board Retry without restarting the gateway.
- Keep extension and MCP server details readable on phones, with clear back navigation, stacked headers and scope tabs that fit the screen.
- Mattermost threads retain their session owner across replies, resets and restarts; reconnect recovery honors username allowlists and covers silent disconnects. REST deadlines and tool cancellation bound stalled calls, while reaction and typing failures no longer delay answers.
- Show MCP cards and connection settings before live discovery completes, keep their initial Top/name order during status refreshes, and retry unreachable servers individually without treating outages as lost OAuth grants.
- Connect OAuth extensions from settings in the same tab, return with an immediate result, and load only the selected MCP server on its details page; chat connect prompts keep popups.
- Refresh Google profile photos on every sign-in without replacing local names or emails, and show photos across user lists and sharing with initials for missing or broken images.
- Cap scheduler waits for distant jobs, log successful primary model attempts at info, and warn only once per unknown agent-extension pair per process.
- Pause sidebar chat and project refreshes while the tab is hidden, and refresh both lists when it becomes visible or focused again.
- Reduce gateway log noise: log agent env key names once per content change, emit one access completion line, and quiet fast successful GETs for chat projects, skills and static assets while retaining errors, redirects and slow requests.
- Emit structured scheduler and channel failures with job/session context, preserve full scheduler diagnostics on disk, and classify upstream tool 4xx and explicitly marked input errors as warnings.

### Added

- Unread chat dots, a turn-finished chime across browser tabs, and a persistent sound toggle beside the chat avatar.
- MCP server instructions from the initialize handshake now reach the agent as namespace instructions. A deferred MCP group without a description uses the first instructions line as its summary.
- `yoplai gateway idle` tells you if any agent turn, subagent, or orchestrator worker is running. It exits 1 and lists them when busy.
- `yoplai gateway restart` now refuses while work is running. Use `--force` to restart anyway.

### Changed

- Sandbox and Harbor eval images now run on Node 24 LTS instead of Node 22, which only receives security fixes. Rebuild custom images that start `FROM yoplai-agent:latest`. The gateway still supports Node 22.19+.
- Sidebar chats now fit on one line, with full titles and chat details available on hover or keyboard focus.

## v0.26.0 — Chat projects, Skills directory + owned dashboards

Chat gets personal projects with shared instructions, files, references and notes, plus pinned and archived chats, full-text search, a personal main agent, and copy buttons for replies and code blocks. A new **Skills** page lets each user upload, share, import and roll back skills, and superadmins can promote skills to defaults. Dashboards now have owners: new pages are private, owners share them with selected users or the whole platform, and users can pin them. Agents get opt-in codemode, deferred tool loading, structured tool results, per-conversation writable files, a `session_history` tool, and browser previews in sandboxes. Scheduled jobs gain opt-in run history with live traces. A new Threadit extension connects agents to a Threadit board, and Slack agents can add reactions. Agents have Public/Private visibility, separate from team ownership.

### Upgrade notes

- **Agent visibility replaces "All teams".** Agents assigned to All teams migrate once to Public agents with no team. Public agents are open to every approved user. Private agents need a shared team. API writes with team mode `all` now return 400.
- **Sign-up no longer adds users to teams.** `extensions.multiUser.autoJoinPublicTeams` is ignored, and the team Private field has no effect. Use **Teams → No team** to put new users in teams.
- **New dashboards are private to their creator.** Dashboards that existed before the upgrade keep the old agent access checks until an owner claims them on the **Dashboards** page.
- **The orchestration Projects navigation is now named Board.** **Projects** now means personal chat projects.

### Added

#### Chat and sessions

- Copy complete agent replies as formatted HTML and clean text, or copy individual code blocks, from the main web chat in simple and full views, with accessible mobile controls and clipboard feedback.
- Search your chat titles and full user/assistant transcripts from the sidebar or Cmd/Ctrl+K, with highlighted snippets and keyboard navigation. Replaces the inline session filter, Board project palette and embedded-chat Cmd+K reset.
- A personal main agent: a character-select picker on home, fresh chats on return, and quick changes from a star in the chat header or on Agents page cards (with confirmation; main agent listed first and highlighted), plus a settings cog in the chat header whose Back link returns to that chat. A click anywhere on an Agents card opens a chat with that agent. Available in single-user and multi-user installs; blank home visits do not create saved sessions.
- Archive sessions: put chats away with reversible archive from the sidebar row menu (hidden for MAIN session). Archived chats disappear from the sidebar, reachable from the new `/archive` page (link in sidebar footer in single-user, account menu in multi-user) with Open, Restore, and Delete actions. Archiving preserves pin and project membership so restoring returns the chat where it was. Opening an archived session shows a clear banner "This chat is archived. Sending a message will restore it." with a Restore button; sending a message automatically unarchives. Archive, restore, and delete actions now show success toasts ("Chat archived", "Chat restored", "Chat deleted"). Sidebar session and project row menus now close on outside click and Escape key, and opening one menu closes any other open menu. `PATCH /api/agents/:agentId/sessions/:sessionId` accepts `archived: boolean` (rejects MAIN with 400); `GET /api/agents/sessions` excludes archived by default, pass `?includeArchived=1` to include them. Persisted as append-only `meta` entry (`key: "archived"`, value: timestamp or `null`).
- Multi-user account menu: clicking the avatar/name/email row in the sidebar footer opens a popover menu with Account connections, Archive, and Logout (with icons and separator before Logout). Menu closes on outside click, Escape, route change, or item selection. Single-user mode has no account panel; the `/archive` link appears in the sidebar footer (below theme toggle) in single-user mode, while multi-user accesses it via the account menu.
- Sidebar row menu now shows icons (Pin `fa-thumbtack`, Move to project `fa-folder`, Remove from project `fa-folder-minus`, Rename `fa-pen`, Archive `fa-box-archive`, Delete `fa-trash`) and a separator before Delete to visually distinguish the destructive action.
- Pin sessions from the sidebar row menu; pinned chats stay above Recent, remain searchable, and persist across reloads.
- Show a safe, localized, persisted assistant notice when a run fails; optionally notify a configured admin channel for provider quota exhaustion, throttled per provider/model to once per hour.

#### Chat projects

- Project create/rename/delete and chat rename/delete now use in-app dialogs instead of native prompts; project page redesigned with chats list and context cards (Instructions, Files, References, Notes) in a right rail. Instructions and Notes render as markdown and are edited in a modal (Edit button; Esc cancels, ⌘/Ctrl+Enter saves). In project chats, the header shows the project as a pill next to the agent name and the back button returns to the project.
- `session_history` now also reads other agents' sessions in the current chat Project (listed as `agent/session`), and the project prompt tells the agent so. Same-user only; follows `sessionHistory.enabled`.
- Agents now receive saved project reference paths alongside title/description so they can read referenced wiki files directly; the reference API and UI still hide paths.
- Create project modal asks for the project's purpose and drafts starting instructions from it via a separate `POST /chat-projects/:id/instructions/draft` call (maintenance model, falls back to the raw text; retries never duplicate the project), and accepts optional files to upload on creation.
- Share memory across agents in a personal chat project: agent-added wiki references with private paths, removable references, and editable dated project notes refreshed each turn.
- Personal chat project files: upload, list, and delete documents/images, with bounded extracted context and read-only sandbox access.
- Set instructions for a chat project and start a new chat with your chosen agent; project chats receive the latest instructions and a prompt to suggest useful wiki references on every turn.
- Create personal chat projects, move chats between them, and browse project chats above Pinned and Recent; deleting a project keeps its chats. The orchestration Projects navigation is now labelled Board.

#### Skills

- Superadmins can mark an agent workspace skill as System on **Admin → Skills** in multi-user mode. System agent skills are hidden from the **Skills** page. Agents still load them.
- Superadmins can transfer a user skill to another user on **Admin → Skills**. This restores a skill whose owner is banned, rejected or removed. The list shows an **Owner inactive** label.
- Superadmins can move an agent workspace skill to the default skills with **Make default** on **Admin → Skills**. All agents and users get it, always on. A name that another skill already uses is blocked. The dialog lists the paths outside the skill folder that the skill refers to, and asks you to confirm.
- Skills directory with private uploads, per-user enablement across Pi agents, named read/write and platform-wide read sharing, import tokens, ten-version rollback, and chat-driven creation with `skill_save`; host and sandbox runs resolve the same managed skills each turn.

#### Dashboards

- Pin owned or shared dashboards to a personal Pinned section on the Dashboards page; pins persist across reloads and restarts.
- Private-by-default owned dashboards, selected-user/platform-wide read/write sharing, a Dashboards home, private legacy claiming, and durable published HTML separate from live drafts/history. Viewing/management is independent of agent access; publication still requires agent execution. Create/update publish explicitly; `dashboard_link` only returns readable links.
- Add preinstalled Chromium and `playwright-cli` to sandbox agents, with authenticated dashboard previews and a visual-check recipe for themes, mobile layouts, and drill-downs.

#### Agent runtime and tools

- Optional tool output schemas for structured codemode results in host and container runs, including full large results and Slack history/replies; connection refusals and declared tool errors retain their data and signal errors.
- Deferred tool loading for Pi host and container runs: searchable extension/MCP tools, bounded capability summaries, per-agent always-on overrides, and branch-aware restoration of loaded tools.
- Per-agent Pi codemode for host and container runs, with nested tool calls grouped in chat and parented tracing spans.
- Per-conversation writable files for extension downloads and edits, available at `/workspace/files` in sandboxes, with local Pi `send_file` support and requester-private output downloads.
- `sandbox.gatewayTransport: "socket"` lets sandboxed runs reach the gateway through a read-only mounted Unix socket that serves only `/internal`, instead of `host.docker.internal`. Fixes every gateway tool (`dashboard_link`, scheduler tools, `extract_document`, extension and MCP tools) and OAuth renewal failing with `fetch failed` whenever containers have no route to the host, as under rootless Docker.
- Add a core `session_history` agent tool to list, search, and read the agent's own past sessions as condensed text (tool calls merged, thinking dropped, long text truncated with drill-down). Enabled by default; disable with `sessionHistory.enabled: false`.

#### Scheduler

- With cron monitoring enabled, Scheduled jobs refresh every two seconds and show a pulsing Running badge with elapsed time until execution finishes.
- Scheduled run history refreshes automatically, and running traces show live thinking, tool results, and output while following the bottom until you scroll up.
- Scheduled run traces show the prompt, thinking, tool calls and results, and final output, preserving the run's original storage identity after sharing a job.
- Opt-in cron monitoring (`enableCronMonitoring: true`) records scheduler run history and links scheduled job titles to status, duration, script output, and error details.
- The `create_job` and `update_job` agent tools accept a per-job model override.

#### Channels and extensions

- Slack agents can add emoji reactions with `slack.add_reaction`, targeting the current inbound message or an explicit message.
- Threadit masking now hides JSON secret values with escaped quotes whole; tool names that are raw commands (Codex style) are labelled `Running: …` and masked.
- Threadit `activity: "safe" | "detailed"` setting (root or per agent). `detailed` is the default: it posts `task.checkpoint` labels and tool targets to the activity pane of the board. Labels show the full first bash command line, file paths, or one identifying argument, with light secret masking. Set `activity: "safe"` to post no tool targets.
- Threadit agent tools (`threadit.*`). Agents use the board through the gateway, so the sandbox needs no token. `threadit.register` makes an agent account and saves the token. It never shows the token. The poller starts with a new token and waits for approval of a new account. Threadit works with only a `baseUrl`.
- Extensions can save their own per-agent config and secrets through `ctx.updateAgentExtensionConfig`.
- Threadit extension (`threadit`): an agent signs in to a Threadit board with an agent account token (`extensions.threadit.token`), answers mentions and replies, shows tool progress as board activities, honors stop requests, and resumes or safely finishes in-flight items after a restart.
- Slack `threadUnlock` can now be set at the top level of the Slack config (`extensions.slack.threadUnlock` or `agent.slack.threadUnlock`) as a default for all channels; a per-channel `threadUnlock` value still overrides it.

#### Admin and multi-user

- Set `branding.icon` to a square PNG in `$YOPLAI_HOME` to give the instance its own favicon and app icon. Safari "Add to Dock", iOS "Add to Home Screen", and the web app manifest use it.
- Superadmins can mark global system extensions and HTTP MCP servers in Admin Extensions, hiding them from users and admins on agent configuration pages while preserving runtime behavior. System flags remove Top stars in multi-user mode and appear in the settings audit log.
- Public/Private agent visibility separates chat access from team ownership, with team-scoped management, scheduler access checks, and a staff No team view for placing newcomers; sign-up no longer joins teams and legacy All teams agents migrate to Public.

### Changed

- The skill menu on **Skills** now lists Share, Update, Versions and Delete, each with an icon. Share was Manage access, and Update was Replace. Your own skills no longer show the "You" owner line.
- The Import, Version history and Update dialogs on **Skills** have a clearer layout. Import shows numbered steps and puts Copy prompt first. The import prompt now tells the other assistant to ask which skills to import before it sends any. Lists show as rows, and an empty history shows a short note.
- The agent Dashboards tab and the Dashboards page use one aligned row layout: title, an access pill (Private, Can view, Can edit, people count or Everyone) and fixed icon actions. "Manage access" opens a new Share dialog with "People with access" and "General access". Superadmins see "Owned by" for dashboards that nobody shared with them.
- The user picker in the dashboard Share dialog and on the Teams page is now a search box. Type part of a name or email, then pick a user with the mouse or the arrow keys and Enter. Enter adds the picked user at once, with no click on Add.
- The team Members dialog uses the same layout as the dashboard Share dialog: a search box to add members (faded, with the hint "All users are already in this team" when nobody is left to add), rows with initials and email, an "All users" checkbox in its own "General membership" section, and agent avatars with Public/Private icons. Member changes save from the dialog footer, and closing with unsaved changes asks to discard them first.
- Admins can add a Public agent to their own teams from the agent settings page, also when they are not in its teams. Private agents still need a shared team.
- Removing an agent from a team, in the team Members dialog or with the team buttons on the agent settings page, now asks for confirmation. If a Private agent has no team left, the message says that only a superadmin can assign it again. For a Public agent, it says that any admin can.
- The Agents page no longer shows admins the agents that they cannot chat, for example a Private agent of another team. Admins still see unforked agents so that they can assign them. Superadmins still see every agent.
- The Dashboards page shows each agent group with the agent avatar and puts the dashboard rows in a bordered panel. More space separates the sections.
- The Pi SDK packages are now at 1.3.0 in the gateway and the sandbox agent runner.

### Fixed

- You can now attach `.pptx` files in the web chat. The gateway still refuses a `.pptx` name with a wrong MIME type.
- Non-allowlisted proactive Slack DM replies and reactions now use a separate session per DM conversation, preserving requester ownership and thread delivery.
- Multi-user instances without an agent pool let approved users and admins use plain agents, including chat, avatars and capability self-enable. Existing fork restrictions also apply to agent lists.
- Agents no longer name other users' private dashboards when they list dashboards. Every run now gets a short rule: `dashboard_link` is the only source for the user's dashboards, and the agent does not mention or hint at others. Also, `dashboard_link` with no slug returns `{ dashboards, note }`.
- A Pi run now switches to `fallback_model` when the primary provider is unreachable ("Connection error.").
- With codemode on, a script call with wrong arguments now adds the tool's signature to the codemode result. The model then uses the correct parameter names on the next try. A call to a deferred tool that is not loaded now tells the model to use `tool_search`.
- Langfuse traces now show the system prompt that the model got, including the `deferred-tools` section and later changes from loaded tools.
- Preserve the original message before follow-ups during Pi startup, and honor early cancellation on host and sandbox runs without starting the cancelled prompt.
- Pi startup cancellation remains an aborted run after the SDK 1.3 upgrade instead of becoming an agent error, on host and sandbox agents.
- Gateway API forwarding works with Node.js 24's request validation, and fresh read-only sandbox workspaces create the conversation-files and IPC mount targets before launch.
- Maintenance-model calls (session auto-titles, tool labels, project instruction drafts) no longer send `temperature`, which reasoning models such as `openai-codex` reject with "Unsupported parameter: temperature".
- Threadit: a download cannot write outside the workspace through a symlink. Sandbox uploads read `/workspace/data` and `/workspace/uploads`. A disabled agent drops its token. An agent that enables Threadit later gets a poller without a restart.
- Slack's default `threadPolicy: always` keeps each opener and all thread replies in one persisted session owned by the opener, retaining attachments while each sender uses their own credentials; different senders wait for separate turns.
- Container `send_file` now waits for gateway media registration and file-card emission before reporting success, returns registration failures to the agent, and logs failed outbound file requests.
- Preserve the complete chat transcript after Pi compaction, show expandable summaries and the compaction status in both history views, and load older messages on demand without counting archived usage toward active context.
- Give gateway tools per-call timeouts and cooperative cancellation so a hung tool returns an error without losing the turn.
- Preserve gateway tool deadlines and cancellation over Unix-socket transport, including dashboard tools.
- Honor each sandbox tool call's timeout without false idle kills, clamp Bash to the remaining turn budget, and verify stop-to-kill shutdown enforcement.
- Keep sessions usable after `/compact` when retained messages include attachments: the reseeded Pi session now references files as text instead of dataless images that made Anthropic reject every later turn (`image.source.base64.data: Field required`).
- Preserve assistant text replay signatures in persisted Pi sessions so subsequent OpenAI Responses turns do not fail with an invalid message ID, while continuing to redact credentials.
- Preserve Pi OAuth credentials during initial authentication, per-run model overrides, and fallback model selection instead of converting access tokens into API-key overrides that break OAuth-only providers such as `openai-codex`.
- Canvas dashboards no longer show "This dashboard hit an error" for errors thrown by browser extensions injected into the page (e.g. an extension reading `sessionStorage`, which the sandboxed dashboard document forbids). Errors whose source is a `chrome-extension://`, `moz-extension://` or `safari-web-extension://` script are ignored; the page's own errors still surface.

## v0.25.0 — Canvas dashboards, personal credentials + team-scoped admin

Agents can now publish live Canvas dashboards: self-contained HTML pages behind stable, team-authorized links, backed by read-only SQLite queries, a versioned Dashboard Kit, a built-in dashboard skill with templates, version history, and a Dashboards tab per agent. Credentials become personal: Google OAuth, MCP servers, and extension tokens each support **Just me** and **Whole team** connections, personal ones follow you across agents, Slack users can pair their Slack identity with their Yoplai account, and scheduled jobs pick whose credentials they use. Extension and MCP setup gets a full UI overhaul (MCP servers as first-class cards, credential tabs with status pills, a connect prompt, Top extensions, shared MCP servers), extensions now ship their own OAuth providers (Zendesk moves to OAuth). Multi-user mode adds email/password sign-in, auto-approval, private teams, an onboarding tour, a settings audit log, and scopes admins to their teams. Web chat folds thinking and tool calls into lean groups with friendly labels; Slack agents gain thread, Canvas, List, and channel tools plus proactive-DM replies; Discord bots can talk to each other; the scheduler gains one-shot jobs plus pause/delete; Langfuse moves to SDK v5; and sandboxes protect operator files and support rootless Docker.

### Upgrade notes

- **Admins are scoped to their teams.** Only superadmins see every agent and create or delete teams; make sure each admin is a member of the teams they manage.
- **New users are auto-approved** unless `extensions.multiUser.autoApprove: false` is set, and join public teams at sign-up unless `extensions.multiUser.autoJoinPublicTeams: false`. Existing teams become private once on upgrade; new teams default to public.
- **Slack threads need a mention** in `requireMention` channels; set `threadUnlock: true` to keep the old "one mention unlocks the thread" behavior.
- **OAuth providers come from extensions.** Google and Zendesk descriptors are no longer built in; upgrade the external Gmail/Google Drive/Zendesk extensions together with the platform.
- **Zendesk defaults to OAuth.** Configure `oauth.providers.zendesk` (with `subdomain`), or set `mode: api_key` on the extension to keep API-token auth.
- **Sandboxed agents can no longer write `AGENTS.md` or `agent.yaml`**, and `SOUL.md`/`USER.md` templates are no longer re-seeded into existing workspaces.

### Added

#### Canvas dashboards

- Agents can publish self-contained HTML files from their `data/dashboards/` directory through stable, team-authorized, CSP-sandboxed Canvas links using the `dashboard_link` tool.
- Canvas dashboards can run confined read-only SQLite queries on every load with bound viewer/URL parameters, capped results, drill-down links, and visible query diagnostics. `data-db` paths are relative to the agent workspace root (e.g. `data/app.db`); sandboxed agents can only query databases under `data/`.
- Canvas dashboards have a versioned public Dashboard Kit with light/dark and A4 print themes (dark follows the OS `prefers-color-scheme`, overridable with `data-theme="light"`/`"dark"`), common interactive components, sanitized Markdown, CSV export, and vendored ECharts charting.
- Dashboard Kit v2 (`/d-assets/v2/`): "needs attention" callouts, KPI strips with number/currency/percent formatting, deltas and sparklines, status pills, segmented filters, table column formatters, pills, links, severity dots and a show-all row cap, a `format` helper, and calmer chart theming (faint grids, area fills, readable heatmaps for skewed data). The dashboard skill now ships design rules agents follow. Existing `/d-assets/v1/` pages keep working and pick up the refreshed styles.
- Agents discover a built-in dashboard skill with cloneable HR, OKR, and customer-success Canvas templates, seeded SQLite schemas, and a rebuildable CS wiki workflow. OKR starters form their own shareable template family.
- `dashboard_link` lints each dashboard page without running its code and returns a `problems` list: script syntax errors, top-level names that collide with browser globals (`top`, `window`, `document`, `location`) or other scripts, echarts.js/kit.js load order, `/d-assets/v1/` use, undeclared `YOPLAI.data` names, inline `on*=` handlers next to module scripts, queries returning 0 rows, and `YOPLAI.link` targets that do not exist in `data/dashboards/`. Dashboard Kit also shows a banner when a page throws at runtime, and the skill and templates put page code in `<script type="module">`.
- Canvas keeps the latest 20 observed copies of dashboards outside Git workspaces and provides a `dashboard_versions` tool to list or restore them without changing their links.
- Agents can fully remove Canvas dashboards with `dashboard_delete`, clearing the HTML file, stable link registration, and saved versions while preserving shared databases.
- Each accessible agent has a Dashboards tab with dashboard titles, last updates, and Open/Copy link actions. Dashboards declaring required URL arguments (`yoplai:params`) nest beneath their linking parents without Open/Copy actions; unlinked ones appear under **Needs parameters**.

#### Credentials and connections

- Google OAuth connections can be personal ("Just me") or shared ("Whole team"); tool calls use the requester's personal account, then the team account, otherwise a connect link. Existing connections remain shared.
- Remote MCP OAuth connections support personal and shared credentials, with requester-specific reconnect links and existing grants retained as team.
- Extension API tokens support **Just me** credentials encrypted per requester, with existing team credentials as fallback and a configuration link when missing. The **Just me** tab lets you set every field, not only the token (e.g. your own Jira email, subdomain or project keys); fields left at the team value keep following it.
- Extension settings forms can unset credentials: **Remove my credentials** on Just me, and **Remove team credentials** on Whole team for admins (`DELETE /api/agents/:id/extensions/:extensionId/credentials`). Non-secret settings are kept.
- Agent **My connections** tab lists your personal OAuth, MCP, and extension token connections with a **Just me** and a **Whole team** status column per service; **Disconnect** removes only your personal credentials. Account settings list your Slack pairings and let you unpair.
- Slack users can link existing Yoplai accounts with private, single-use, ten-minute `!pair` links; each paired sender's requests use their own personal credentials, with team-only credentials for unpaired users. Agents are told when a Slack sender is unpaired and can call the new `slack.pair` tool to share a pairing link, so users never need to type `!pair`. The pairing page uses the platform theme and `branding.name`/logo.
- Slack credential refusals provide one personal connection link that pairs an unpaired sender and connects Google OAuth, an extension token, or extension-owned OAuth for a specific resource, with reconnect links and a confirmation in the original thread. Forwarded links are refused before the form is shown.
- External extensions can request Slack connection links and register OAuth completion hooks through the host context; connector registration is restricted to the extension's own ID.
- Extensions declare their own OAuth providers (`oauthProviders` descriptors), registered by the gateway at load (equivalent duplicates are fine, conflicting ones fail the load). Descriptors support `tokenAuth: "basic"` (HTTP Basic client credentials), `accountFromTokenResponse` (account label from the token response), and `tokenRequestFormat: "json"` (JSON token/refresh/revoke bodies, e.g. Notion).
- Extensions can choose OAuth scopes from merged root/agent settings; missing grants return a reconnect link requesting those scopes. OAuth extensions sharing one provider account (e.g. Gmail and Google Drive) each get a Connect card requesting their own scopes.
- Extensions can offer OAuth instead of API keys: in OAuth mode the agent page shows only the Connect button. Zendesk connects via OAuth (provider URLs take `{subdomain}` from `oauth.providers.zendesk`; rotating refresh tokens are refreshed single-flight).
- Google Drive's write setting is separate for Just me and Whole team, sits inside the connect card, saves as soon as you toggle it, and Connect requests the matching scopes.
- Scheduled jobs record their creator and let chat and web users choose **Mine** (owner) or **Team** credentials. Mine jobs also use personal connections made on another agent, ahead of the team connection; unusable personal connections produce a delivered reconnect error.

#### Extensions and MCP servers

- Remote MCP servers appear as individual extension cards. Members can add HTTP servers with immediate OAuth, disconnect credentials, and (admins) remove shared servers with confirmation.
- MCP servers look and behave like normal extensions: sorted alphabetically with them, the whole card links to a config page (`/agents/:agentId/mcp-servers/:serverName`) with Just me / Whole team connect for OAuth servers (showing the connected account), a JSON config editor (secrets masked) for non-OAuth HTTP servers, and Remove.
- Servers added from the UI get a readable key from their site (`mcp.linear.app` → `linear`, then `linear_2`), and cards show the server-reported name and description once connected, saved as `displayName`/`description` on UI-added `mcp.json` entries. Any server entry, stdio included, may set optional `displayName` and `description`. Servers without an icon show the official MCP logo; HTTP servers show their website icon (cached in `$YOPLAI_HOME/mcp/icons.json`).
- Adding a custom extension shows a confirmation toast with the server name, and a warning toast when the server is already added.
- Superadmins have an **MCP servers** admin tab (`/admin/mcp-servers`) to add a shared MCP server for all agents, shown as a card grid; agent pages get Enable/Disable for shared servers and a superadmin-only form to edit their name and description.
- Superadmins can star "top" extensions and MCP servers (including shared ones) on the **Top extensions** admin tab; starred items sort first in every agent's extension list and feed the connect prompt.
- "Connect <agent> to your tools" prompt: the first time you open each agent's chat, a dialog lists recommended extensions and MCP servers with descriptions, shows which are connected, and lets you connect, enable, grant missing permissions, or set up the rest — API-key extensions (Notion, Jira, …) are set up inside the dialog. It waits while an onboarding tour step is shown. Reopen it with **Connect tools** next to **Restart tour**.

#### Multi-user and admin

- Email/password sign-in (`extensions.multiUser.emailAndPassword.enabled`), with a sign-in / create-account form on the login page. `oauth.google` is no longer required; `/api/capabilities` reports `authMethods`.
- **⚠ BREAKING** Multi-user `autoApprove` setting (default `true`) controls whether new sign-ups are approved immediately or wait for admin approval.
- Private teams with creation controls, list badges, and a one-click Private/Public toggle. New users join public teams as removable members at sign-up by default (`extensions.multiUser.autoJoinPublicTeams: false` for manual membership). Existing teams become private once on upgrade; new teams default to public.
- First-run onboarding tour (driver.js) for multi-user logins: walks through the agent grid, agent settings, extensions, connections, dashboards, and a first chat. Skippable at every step; status is saved per user via `GET/PUT/DELETE /api/me/onboarding`, and existing users see it once on next login. A "Restart tour" link sits in the sidebar footer.
- Append-only settings audit in gateway-owned `audit.db`, with redacted secret changes and an admin-only `/api/audit/settings` API.

#### Chat

- Web chat shows friendly tool-call lines (e.g. "Listed Claap workspaces"). Labels come instantly from the tool name and key arguments, refined by per-tool templates the maintenance model generates once and stores in `tool-labels.json`. Consecutive tool calls collapse into a "Ran commands" / "Called tools" sub-section; bash commands render in monospace and full-view bash output as a terminal-style block.
- Agents can return exactly `NO_REPLY` to keep a turn in history without delivering text on any channel; web chat hides it in simple view and shows the raw token in full view.

#### Slack

- Slack agents can read thread parents and replies with `slack.get_thread_replies`, including cursor paging and time windows.
- Slack agents can list, create, read, find sections in, edit, share, and delete Slack Canvases, and find, read, create, update, and delete Slack List items, with dedicated agent tools.
- Slack agent tools `slack.join_channel` and `slack.leave_channel` (require `channels:join`, `channels:manage`/`groups:write` scopes and app reinstall).
- Slack DMs support `dm.proactiveReplies` (`enabled`, `maxReplies`): users outside `dm.allowFrom` can reply in the thread of a DM the agent sent them, e.g. an HR agent reaching out to employees. `dm.reactionNotifications` lets DM reactions reach the agent; reaction turns include the reacted message text and post replies in its thread, and channel context exposes `conversation_id`.
- Slack channel option `threadUnlock` (default `false`): with `requireMention: true`, one mention unlocks a thread so later replies there need no mention.

#### Discord

- Discord can allow all or selected bot users to trigger agents with explicit mentions through `extensions.discord.allowBots`, with self/webhook protection, history capture, and gateway loop guarding.
- Discord agents can @-mention other bots: `discord.list_users` includes bot accounts (flagged `bot: true`), and sender, history, and thread starter show each author as `name (<@id>)`, with `, bot` for bots. Replies to other bots are posted once, complete, instead of streamed.

#### Scheduler, agents and runtime

- Scheduler jobs support one-shot `runAt` times through the API, CLI, and agent tools. Missed jobs fire after restart, then disable themselves while retaining output and history.
- Agents can trigger a manual run of their own scheduler jobs with the `scheduler.run_job` tool.
- Scheduled jobs tab: on/off switch to pause or resume a job, and a delete button with a confirmation dialog. Team jobs can only be paused, resumed, or deleted by admins and superadmins (also enforced for the API and chat tool).
- Agent-authored runs support configurable consecutive-turn and hop-count loop guards through global or per-agent `agentLoop` settings.
- Sandboxed agents can run under rootless Docker: `YOPLAI_CONTAINER_USER` sets the container `uid:gid` (default: the gateway process uid, correct for a rootful daemon).
- Langfuse generations show the provider/model.

### Changed

- **⚠ BREAKING** Admins are scoped to their teams: they only see, chat with, and configure agents of teams they belong to, and only add/remove members of those teams. Only superadmins see everything and create or delete teams.
- **⚠ BREAKING** OAuth providers ship with extensions: Google and Zendesk descriptors are no longer built into the platform.
- **⚠ BREAKING** Zendesk defaults to OAuth; set `mode: api_key` with `subdomain`, `email`, and `apiKey` to keep the API-token setup.
- **⚠ BREAKING** Slack channels with `requireMention` no longer auto-unlock threads after a mention; every thread message needs a mention unless the channel sets `threadUnlock: true`.
- **⚠ BREAKING** Sandboxed agents mount `AGENTS.md` and `agent.yaml` read-only (including on a fresh workspace's first run), so agents can't rewrite their operator instructions or sandbox/tool config; a missing `AGENTS.md` is restored. `SOUL.md`/`USER.md` templates are no longer re-seeded into existing workspaces, so operators can remove them.
- Whole-team extension setup (shared credentials, team OAuth connections, shared MCP server config) is admin-only; other users see it read-only and set up their own connection (adding a custom extension no longer offers them a team choice).
- Personal Google connections and personal extension tokens/settings (e.g. Zendesk, Notion, Pipedrive) follow you across agents: set them once and they apply on every agent where the extension is enabled, with no reconnecting per agent. Team values stay per agent, and reconnecting keeps scopes already granted.
- Agent edit page: extension cards use two columns and the on/off toggle is gone. A card shows a checkmark once credentials exist for Just me or Whole team (secrets or an OAuth connection), otherwise a "+" linking to its config page. Saving personal credentials or connecting OAuth turns the extension on for the agent; extensions without settings are enabled/disabled from their details page. Removing credentials turns a credentialed extension off. The list renders once in final order instead of reshuffling as MCP cards and stars load.
- Clicking an extension card opens one page with the extension details and its settings form; the separate **Configure** step is gone (old `/agents/<id>/extensions/<ext>/config` links still work).
- Extension, Google OAuth, and MCP connection pages show credentials in **Just me** / **Whole team** tabs ("Only used by you" / "Can be used by the whole team") instead of a dropdown. Each tab shows a status pill (green connected/configured, red needs reconnecting or missing access, gray not set up), admin-managed tabs show a lock icon, and pages open on the tab in use (Just me, else Whole team, else Just me). Usernames and emails show in clear.
- Extension settings without Just me/Whole team tabs render in a bordered panel; checkbox settings align their description under the label.
- Agent **Scheduled jobs** tab is a list: recurrence reads in plain language ("Monday and Thursday at 07:30") with the time zone, a prompt preview, a paused marker, and a Mine/Team switch. The create-job form is removed; ask the agent in chat to create jobs.
- Team scheduled jobs are shared with everyone on the agent; Mine jobs stay private. Switching modes updates ownership, Team cards show the original creator, and scheduler guidance explains when to choose each mode.
- Agent catalog hides agents a non-admin can't chat (e.g. private-team agents) instead of showing an inert card, and `/pool-actions` no longer returns team names for agents the user can't access.
- Web chat folds consecutive thinking and tool calls into one muted, collapsible "Working / Worked for Ns" group (expanded while streaming, collapsed once done) in both views. Thinking lines show a live excerpt, then "Thought for Ns"; bubbles and timestamps on thinking and tool lines are gone.
- The chat thinking-level selector is shown to superadmins only.
- Dashboard skill separates a strict technical contract from design guidance and offers layout archetypes (monitor, brief, worklist, profile, compare, guide), so dashboards vary in shape. Agents sharing drill-down dashboards include the query string in the link.
- Dashboard assets are cached for a week instead of a year.
- Slack: when a long run completes, the progress bubble is deleted instead of left as "Completed."; failed and interrupted runs keep their status line.
- Slack agents are told their final text is delivered to the thread automatically, so they no longer reply through `slack.send_message`.
- Langfuse tracing uses the Langfuse JS SDK v5 (OpenTelemetry) instead of v3, so traces keep flowing once the server moves to `events_only` ingestion. Session IDs, environment, metadata, and the trace tree are unchanged; session/user/tags are stamped on every observation. Missing keys now disable tracing instead of failing.
- Upgraded the Pi SDK packages to 0.87.1 so Anthropic OAuth requests for Claude Opus 5.5 report the required Claude Code version; gateway retries and interrupted tool-call repair update Pi's canonical session context.
- Model context-size data updated for new models (incl. Claude Sonnet 5.5).

### Fixed

- Gateway no longer crashes at startup when one agent's extension config is invalid (e.g. a missing credential); it logs a structured error and skips that extension for that agent.
- `/internal/tools` returns the upstream error's 4xx/5xx status (e.g. Google 404) instead of masking every failure as 500, so agents diagnose causes correctly.
- Sessions no longer fail on every prompt after `/compact` with `Cannot read properties of undefined (reading 'input')`.
- Pi sessions (host and sandboxed) no longer break permanently with `tools.N.custom.input_schema: JSON schema is invalid` when an MCP tool schema has a field such as `assignee`: session redaction keeps tool declarations verbatim.
- Scheduler tool params use `anyOf` for nullable fields, so models such as opencode-go MiMo no longer leak tool calls as text.
- Subagent reasoning effort reaches the CLI: codex uses `model_reasoning_effort` (was ignored) and pi gets `--thinking` (was dropped); orchestrator and `subagents start` fall back to profile reasoning.
- Sessions whose first turn was aborted now get an automatic title on a later turn instead of staying untitled.
- Messages sent mid-turn appear after the agent's already-streamed thinking, text, and tool calls instead of jumping above them, and follow-ups sent before the first prompt starts run behind the user's message instead of ahead of it. Pi history keeps each assistant message with its own tool calls, so reloaded chats keep that order.
- Live web-chat streams stay scoped to their originating conversation when switching sessions.
- The "Context compacted." notice stays where compaction happened instead of pinning to the bottom.
- Thinking and activity durations survive page reloads and stopped runs (start/end times stored on thinking blocks).
- Removed the blinking text cursor on streaming messages, which sometimes showed mid-turn before later thinking or tool traces.
- Generic "Progress updated." status lines no longer appear in web chat or the Slack progress bubble.
- Blank UI after a gateway restart: shutdown stops the Vite preview process tree, and Tailscale-served UIs bind to loopback even with LAN UI configuration.
- Users return to their requested dashboard or app deep link after Google sign-in, and Canvas drill-down links keep their query string through login.
- Canvas dashboards follow the web UI's light/dark choice (via a `yoplai-theme` cookie, falling back to `prefers-color-scheme`) and inherit deployment colours from `$YOPLAI_HOME/theme.css`.
- Canvas charts: a missing ECharts or invalid option shows a short message instead of blanking the dashboard; re-rendering replaces the chart cleanly; legends sit at the bottom without overlapping titles; headings stay with their charts across printed page breaks.
- No-argument `dashboard_link` calls discover dashboard files before they are registered, and a file vanishing mid-listing no longer hides the others.
- CS `client`/`qbr` templates show a "No client selected" link back to Clients instead of a blank page when opened without parameters.
- Sandboxed Pi agents load the built-in skills (such as `dashboard`), and headless eval runs start Canvas so dashboard evals work.
- Langfuse records the system prompt again for new Pi sessions after the Pi 0.87 upgrade, and queued messages are traced as user input instead of creating input-less traces or closing the active run's trace early.
- Slack `get_channel_history`/`get_thread_replies` include text from message blocks and attachments, so bot posts (e.g. Zendesk) no longer appear empty.
- Slack pairing no longer fails the origin check (browsers sent `Origin: null` under `no-referrer`), and paired users in user-scoped sessions now receive connect links.
- Connecting an account (e.g. Gmail) on an extension page turns the extension on for any member who connects, not only admins.
- OAuth extensions sharing one provider account (e.g. Gmail and Google Drive) no longer show as set up until their own scopes are granted; the connect prompt shows "Grant permissions" for them and a spinner while enabling.
- Adding a custom extension "Just me" no longer flashes an OAuth popup when you are already connected to that server from another agent.
- Non-admins no longer see "Remove server" on MCP server pages; a rejected removal says only admins can remove the server.
- Returning to the agent extensions tab, or moving between the extension list and MCP server pages, no longer blanks the page while MCP status loads.
- Top extensions shows MCP display names instead of config keys.
- Onboarding tour stays on its target as late-loading cards re-render, and adapts its Gmail steps when Gmail is already connected or only needs a grant.
- Extension pages open almost instantly: the credential encryption key is derived once instead of per extension (~600 ms → ~20 ms per catalog request).
- OAuth descriptors are registered before extensions activate on runtime reload, so providers are present during start.

## v0.24.0 — Capability discovery, auto-titled sessions + resilient model runs

Agents that hit a dead end can now discover platform extensions and MCP servers, redirect to a better-equipped colleague, or self-enable no-secret capabilities after confirmation. Web chat gets a centered new-chat hero, a "New chat" button, auto-generated session titles, and a sidebar redesign. Model runs are far more resilient: transient provider errors retry in place, agents can declare a `fallback_model`, sandboxed agents can use OAuth-only providers, and `yoplai models refresh` picks up newly released models without an upgrade. Langfuse sessions become filterable, and the gateway tightens CORS and bumps better-auth for security advisories.

### Added

- Core sessions now receive a short automatic sidebar title after their first successful Pi response. Configure the optional root `maintenance: { provider, model }` to select one shared model for gateway-owned LLM work; it uses the model runtime's OAuth, stored-key, or host-environment credential resolution.
- Sidebar session rows now use the full row width for titles: rename/delete icons overlay the row only on hover, an overflowing title slides horizontally on hover or focus so it can be read in full, and the list scrollbar stays hidden until you scroll.
- Agents can now discover platform extensions and MCP servers when their enabled tools reach a dead end, redirect to agents that already have a match, and self-enable no-secret capabilities after chat confirmation.
- Slack agents can now retrieve newest-first channel history with the `slack.get_channel_history` tool, including bounded time windows and pagination metadata.
- Chat header now has a "New chat" button (top right, after the Simple/Full toggle) that starts a fresh chat for the agent, showing the empty-chat hero like the Agents page "Chat" action.
- Web chat now opens on a centered "new chat" hero: agent avatar, a randomly-picked greeting one-liner (from a pool of 30), the composer, and prompt suggestions when configured (or a subtle note when none exist). Sending the first message slides the composer down to its docked position with a smooth ~0.4s animation. The transcript and composer now share one 720px content rail, and attach/send buttons live inside the input pill.
- Sandboxed agents can now use OAuth-only providers (e.g. `openai-codex`): when an agent has `auth.mode: oauth`, the gateway pre-refreshes the provider's OAuth credential on the host and passes only a short-lived access token into the container, and the runner renews it through a new `POST /internal/oauth-token` gateway endpoint before expiry. Refresh tokens never enter the sandbox. Note: do not configure a OneCLI secret mapping for an OAuth provider's API host — it would overwrite the injected Authorization header.
- Agents can opt into a single `fallback_model` in `agent.yaml`; after transient primary-model retries are exhausted, a silent, tool-free failed Pi turn retries once with that model.
- Added `yoplai models refresh` to fetch Pi's latest provider model catalogs into `$YOPLAI_HOME/models-store.json`, allowing newly released models to be used without upgrading Yoplai.
- Scheduler jobs in `cron/jobs.json` accept an optional `reasoning` field to override the agent's reasoning level per job.
- Agents and scheduler jobs now accept `max` as a Pi reasoning level.
- Langfuse sessions are now filterable: session IDs are formatted as `yoplai:<surface>:<agent>:<id>` and stamped with `userId` plus channel/place tags, so sessions can be filtered by agent, user, and channel like traces. Traces also record the resolved `thinkingLevel` in metadata.

### Changed

- Sidebar navigation now pairs each destination with an icon and shows icons instead of text abbreviations when collapsed.
- Raised muted-text contrast to WCAG AA across the web UI: `--text-muted` is now `#8a8a8a` (dark) and `#6b6b6b` (light), and user-message text in chat is `#a8c4ff` (dark) / `#1d4ed8` (light) instead of a low-contrast accent mix.
- Clicking "Chat" on an agent in the web Agents catalog now always starts a fresh chat session instead of resuming the agent's default "main" session. Each click mints a new logical session key; the gateway creates the new session lazily on the first message. Previous sessions remain available from the sidebar session list.
- Upgraded the pi SDK packages (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`) from 0.80.6 to 0.84.4 across the gateway, agent-runner container, and projects extension. Model and credential resolution now goes through pi's `ModelRuntime`; `yoplai auth login/status/logout` keep the same behavior on the new provider-owned login flow.
- `ui.tailscale.resetOnExit` now defaults to `false`. The previous default ran `tailscale serve reset` on gateway shutdown/restart, which wipes the machine's entire Tailscale serve config — including entries Yoplai didn't create. Set it to `true` explicitly to opt back in.
- **Security:** better-auth bumped to 1.6.30 across web and multi-user (covers the 1.6.11 advisories, including the OAuth implicit-linking account takeover), and the gateway now reflects only the configured server/web base URL origins plus loopback dev origins in CORS instead of a wildcard.
- Toolchain now targets pnpm 12.

### Fixed

- Sandboxed Pi agents now use the same Yoplai base system prompt as host Pi agents, while retaining container-specific instructions.
- Manual scheduler runs (`yoplai scheduler run`) are now detached, so long jobs no longer trip CLI fetch timeouts while they keep running.
- Scheduler model overrides can now use an OAuth provider independently of the agent's configured provider and auth mode, including inside sandboxed runs; OAuth renewal remains scoped to the provider selected for that run.
- Agent-level Slack config (`slack:` in `agent.yaml`) no longer requires an `agent` field on each `channels` entry; the agent is implied. Previously the agent config failed validation with `slack.channels.<id>.agent: Required`.
- A chat message is no longer lost when the model run fails before the model starts (unknown model/provider, missing credentials): the message is persisted to session history before the run begins, so it survives reloads and the session stays visible in the sidebar. Also fixes a latent duplicate user entry on thinking-level fallback retries.
- Extension and MCP tool schemas no longer send regex `pattern` keywords to the model provider. Providers such as opencode-go rejected whole runs with `Invalid JSON schema: regex lookaround is not supported` when an MCP server (e.g. Claap) exposed a Zod v4 `email` pattern. Tools still validate their own inputs.
- Sandboxed agent runs now see the refreshed model catalog: the container mounts `$YOPLAI_HOME/models-store.json` (written by `yoplai models refresh`) alongside `models.json`. Previously only host agents picked up refreshed models; sandboxed runs fell back to the Pi SDK's baked-in list and failed with `Model not found` for newly released models.
- Pi agent turns (host and sandboxed) now retry transient provider failures (rate limits, 5xx responses, queue/backpressure hints, and connection resets) instead of failing the run. Host and container classify and delay retries through one shared contract. The failed turn is dropped and the conversation resumes from where it broke, so a late failure after many tool calls no longer loses the work and the user prompt is never re-sent. Configure `retryMaxAttempts` and `retryBaseDelay` per agent when the defaults of three attempts and a two-second initial delay do not fit the provider.
- `pnpm update-models` now discovers models like the gateway does: it falls back to `$YOPLAI_HOME/agents/*` when `agents` is unset in `yoplai.json`, scans `pool` agent directories, and collects top-level `subagents` models. Previously it required an explicit `agents` list and missed pool/subagent models.
- Pi CLI subagent runs now surface the assistant's final answer in `latestOutput` (`yoplai subagents list`/`status`) instead of the raw `{"type":"agent_settled"}` event, and the logs view no longer shows raw token-delta noise.
- Session persistence no longer redacts Anthropic thinking-block signatures (`thinkingSignature`), which bricked pi-adapter sessions on the next turn with API 400 `Invalid signature in thinking block`. Sessions already redacted need a fresh session.
- `yoplai user token create` no longer fails when unrelated extensions reference env vars absent from the current shell (e.g. `DISCORD_TOKEN`); only multi-user secrets are resolved.
- `yoplai subagent` and `yoplai subagents` CLI calls now authenticate to the gateway with a bearer token (`YOPLAI_TOKEN` env var, falling back to the cached `yoplai user token create` token), so they work when the multi-user extension is enabled instead of failing with `unauthorized`.

## v0.23.0 — Slack live progress, document understanding + agent dreams

Agent runs now report durable, sanitized live progress in Slack, backed by new
session-scoped task lifecycle tools. Text-only models can understand images
through generated descriptions, PDF uploads gain bounded OCR extraction, and
opt-in nightly dreams consolidate recent sessions into workspace memory.
Scheduler jobs can run scripts and deliver results straight to chat surfaces,
and teams gain a standing All users membership rule.

### Added

- Durable, session-scoped lifecycle tools for agents to adopt, checkpoint, pause, resume, and complete work.
- Agents running text-only models now receive generated descriptions for attached images and can re-query them with `describe_image`.
- PDF uploads now fall back to bounded English/French OCR, and sandboxed agents can extract PDFs from their approved workspace paths with `extract_document`.
- Agent workspaces can provide curated starting suggestions for new web chats.
- Teams can now use a standing All users membership rule, granting their agents to every current and future user.
- Forked pool agents can now serve multiple teams or use a standing All teams assignment.
- Opt-in nightly agent dreams consolidate recent sessions into durable workspace memory, with `yoplai dream <agent-id>` for manual and dry runs. The default prompt directs agents to skim repetitive scheduler-run transcripts instead of consolidating every occurrence.
- Scheduler jobs can now run a script instead of (or before) an LLM turn: `payload.script` + `noAgent: true` runs a script-only job whose exit code — never a model's self-report — decides success or failure, and `payload.script` + `payload.message` gates the agent behind the script's final stdout line (`{"wakeAgent": false}` silences the tick with no tokens spent). Opt-in `payload.quietOutput: true` skips the output file for uneventful runs. Configure both shapes via `cron/jobs.json` or the scheduler HTTP API; see `packages/extensions/scheduler/README.md`.
- Scheduler jobs can now push their result to Discord, Slack, and Telegram via a job-level `deliver` list, at the runtime level rather than through an agent tool call: agent-job responses and non-empty script stdout are delivered, silent ticks and empty script output stay silent, and any errored run always delivers an alert. A missing or failing target is recorded as a warning on the run and never blocks the other targets. See `packages/extensions/scheduler/README.md`.

### Changed

- The agent edit page's team assignment is now a compact toggle-pill row; Save and Cancel appear only when the selection has unsaved changes.
- The team detail modal's membership editing (All users toggle, Add, Remove) now stages changes locally with Save/Cancel, instead of applying each interaction to the server instantly.
- Chat suggestion cards now sit under a "What would you like to do?" lead line and carry a subtle arrow icon, making them read as tappable prompts.

### Fixed

- Slack progress message now only appears for runs longer than 30s, and follows the same thread/reply policy as the final response (was: posted on every message, always in a thread).
- Show Slack follow-ups queued behind active work as waiting, rather than interrupted.
- Slack now keeps one in-thread progress message updated with sanitized, descriptive checkpoint milestones, heartbeats, and a clear completed, failed, or interrupted outcome for each agent run.
- Sandboxed agents now deliver lifecycle checkpoints to that same safe progress message.
- Preserve active durable tasks when explicit `/stop` or `/abort` interrupts a run, and queue ordinary follow-ups instead of interrupting them.
- Sandbox agent images are rebuilt when their baked runner output drifts after a gateway upgrade, and dev-mode image rebuilds no longer fail from a wrong relative Dockerfile path.
- An agent extension with incomplete configuration no longer stops that agent's runs; the UI routes unconfigured extensions to their setup flow and rejects invalid enables instead of writing partial config.
- Google sign-in now returns users to the configured web base path instead of the server root.
- Container callback identities sent as empty strings are now rejected instead of bypassing the run-bound identity guard, and malformed container/history protocol payloads are rejected at the seam.
- The web chat compaction action now prevents duplicate in-flight requests, shows progress, times out stalled requests, and permits retry after failure.
- Gateway observability and Pi runtime session files now redact credentials and signed URL authorization after authorized execution.
- Follow-up messages and stop requests now reach only the run they were sent to: each container run gets its own IPC namespace and every queued message carries its target agent, session, and run, so a second chat with the same agent can no longer swallow another chat's follow-up or be interrupted by another chat's stop.
- A follow-up sent in the moment a run is finishing is now held for the next run instead of being silently dropped, and the reply says "queued for next run" when that happens.
- Slack no longer answers the same message twice: a Slack retry, or the overlapping message and mention deliveries of one @-mention, now produce a single agent turn. Duplicate suppression is per bot, so two Slack apps in the same channel each still receive the message, and a message the bot ignores no longer silences the mention that would have been answered.
- A Slack message whose handling fails without the failure ever reaching the user no longer suppresses Slack's own retry, so the retry can still serve it.
- Queued follow-ups now carry their source surface, and Slack channel, thread, and message identity, so a misrouted delivery can be traced without reading message content.
- Chat composer no longer sends a half-typed message when Enter confirms an IME composition (Japanese, Chinese, Korean input).
- Simultaneous compaction requests for the same session now share one compaction run instead of racing two rewrites of the same history.
- Container IPC directories left behind by a failed launch or a crashed gateway are now reclaimed instead of accumulating on disk.
- Switching a team to All users no longer erases its explicit member roster; unchecking All users restores the saved members instead of leaving the roster empty.
- Team deletion warnings now name users who would become teamless, including when the team uses the All users rule.
- Changing a fork's team assignment no longer restores its retired pre-migration team after a service restart.
- Agent chat markdown now renders raw HTML literally, preventing malformed tags from truncating messages or injecting markup.
- Scheduled job runs are now traced as `yoplai:scheduler:<agent>` in observability platforms instead of being mislabelled as chat runs.
- `yoplai scheduler update` now merges payload flags onto the job's existing payload, so changing the message no longer silently drops the job's session id or script.
- A scheduler `cron/jobs.json` entry that fails validation is now skipped on its own instead of disabling every other job of that agent.
- Agent extension settings now show root-configured Slack, Discord, Telegram, IRC, and webhooks integrations as enabled and lock their toggles so the UI cannot contradict the live configuration.
- Slack reactions are now off by default and require per-channel opt-in before they can start an agent turn.
- External extension API routes now respect the extension enabled state after hot reload.
- Browser tab titles now include configured branding, agent names, and page sections.
- The Harbor eval base image now builds the complete gateway workspace with the repository-supported Node 22 and pnpm 11 toolchain.
- Agent extension updates now keep secret references on disk while installing resolved values into the live runtime config.
- Fast agent runs no longer duplicate user history rows, and concurrent session mapping updates no longer lose newer entries.
- Board activity lookups now reject path-like project identifiers instead of scanning directories outside the configured projects root.
- Concurrent project-agnostic subagent starts now reserve labels atomically, so two requests cannot create duplicate labels under the same parent.
- Concurrent scheduler updates for one agent no longer overwrite newer job snapshots, and scheduler/heartbeat timers no longer restart themselves after extension shutdown.
- A failed Slack Socket Mode startup no longer leaves a live gateway event subscription behind while other bots continue running.
- Failed multi-user pool-agent forks now remove their partial workspace so the assignment can be retried after correcting the pool definition.
- Orchestrator claims are now scoped by configured project, so unrelated tracker issues with the same opaque provider ID can run concurrently.
- Concurrent lead-session creates, renames, archive changes, and auto-title updates no longer overwrite one another in a project's session index.
- Concurrent project Space updates are now serialized and written atomically, preventing simultaneous worker deliveries or queue actions from dropping each other's state.
- Failed project subagent workspace setup no longer leaves a phantom run record that blocks retrying the same slug.
- Concurrent project creation now allocates distinct IDs, and a stale `projects.json` counter heals from existing project directories instead of reusing an ID.
- Web chat history refreshes no longer let an older response overwrite newer history for the same agent and session.
- Sandboxed agents no longer lose container follow-up messages queued in the same millisecond or redeliver a message while its IPC handler is still pending.
- `yoplai eval run --config` now loads the exact requested file, and `--model` now applies the requested model to the agent run instead of changing output metadata only.
- Multi-user OAuth connect, status, and disconnect routes now enforce agent access, preventing users from reading or changing another team's agent connection.
- Gateway signal handling no longer exits before extension shutdown hooks finish.

## v0.22.0 — Yoplai rename + Slack session threads

The project is now Yoplai: config lives in `~/.yoplai/yoplai.json`, env vars are
`YOPLAI_*`, and the CLI is `yoplai` — with legacy AIHub names kept working behind
deprecation warnings. Slack gains session-bound threads so proactive follow-ups
keep their context, and MCP remote servers are now connectable from the UI.

### Added

- MCP extension settings now list each remote server and provide OAuth connect, reconnect, and disconnect actions per agent.
- Slack agents can create session-bound thread parents with `slack.create_thread` for proactive follow-ups that preserve context.
- Replies in Slack session-bound threads now resume the creating session and stay in that thread.
- Slack proactive DMs now leave persistent one-time visibility notes for the main agent session when the recipient replies.

### Fixed

- Gateway access logs now suppress successful fast UI polling and health checks, while retaining errors and useful request logs without ANSI status codes.
- Streamed container stderr is logged at info instead of error — agent runners write normal startup chatter there, so every chunk surfaced as `level:error` in observability. Real failures still log as errors via the container exit path.
- Project scanning no longer fails when the scan root disappears mid-scan, which raised an unhandled rejection.
- Pool globs ignore Git metadata, so repository `.git` directories no longer fail strict pool discovery; hidden agent directories stay discoverable.

### Changed

- **Project renamed AIHub → Yoplai.** The config home is now `~/.yoplai/yoplai.json` and env vars are `YOPLAI_*`. The legacy `~/.aihub`, `aihub.json`, and `AIHUB_*` names still work but log a deprecation warning. The CLI binary is now `yoplai`, with `aihub` kept as a compatibility alias (the orchestrator extension's `aihub-claude-rpc-shim` bin alias is likewise retained alongside the new `yoplai-claude-rpc-shim`). `$AIHUB_HOME` inside config values (e.g. `agents` globs) still expands, alongside the new `$YOPLAI_HOME`.
- **⚠ BREAKING (home resolution):** the default home directory is now chosen by which of `~/.yoplai` / `~/.aihub` contains a config file, not by which directory exists. A legacy `~/.aihub` holding only state (`.env`, `auth.json`, `sessions/`) but no `aihub.json` now resolves to `~/.yoplai` silently — set `YOPLAI_HOME` to pin it if that's not what you want. This replaces a bug where an empty `~/.yoplai` (e.g. created by a stray write) would silently sever a legacy install from its config.
- **⚠ BREAKING (unversioned, no legacy fallback):** `yoplai projects start --json` and `yoplai projects status --json` now emit `"type": "native"` where they previously emitted `"type": "aihub"`. Scripts matching `type === "aihub"` will silently stop matching.
- IndexedDB: the browser-side attachment staging database is renamed from `aihub` to `yoplai`, with no read-fallback to the old database. This only affects transient staged uploads that were never submitted (an in-progress project-create form, or a not-yet-submitted attachment on a project detail page) — any already-submitted/persisted project content is unaffected. Anyone with such a draft in flight at upgrade time needs to re-attach the file(s).
- The gateway's docker agent network is renamed `aihub-agents` → `yoplai-agents`, with no lookup fallback. `ensureNetwork` auto-creates it on first run, so this is low impact, but a pre-existing `aihub-agents` network is left orphaned and can be removed manually.
- The tailscale serve path for the UI moved from `/aihub` to `/yoplai` (Vite's `base` moved with it). Existing `https://<host>.ts.net/aihub` bookmarks and shared links break and must be updated — there is no redirect. The stale `/aihub` mapping in tailscaled's persistent serve config is cleared automatically the first time the gateway refreshes its serve paths after upgrade.
- The workspace's internal npm package scope changed from `@aihub/*` to `@yoplai/*`. Nothing in this repo is published, so this only affects consuming this repo as a pnpm workspace, not any published-package consumer.

Migrated automatically, nothing to do:

- The macOS launchd service label and plist filename are renamed `com.aihub.gateway` → `com.yoplai.gateway`. A pre-rename install stays fully controllable: `status`/`start`/`stop`/`restart`/`uninstall` fall back to the legacy label with a one-time deprecation warning, and `yoplai gateway install` migrates it in place (the legacy job is booted out before the new one is bootstrapped, and its plist is deleted only after the new bootstrap succeeds; a failed bootstrap rolls back to the legacy service). `uninstall` removes both when both are present.
- `yoplai-theme` localStorage key, migrated from `aihub-theme` on first read; a shared `readMigratedLocal` helper does the same move-on-read for every other renamed `yoplai:*` key, covering board, context-panel, projects, chat-session, and layout state.
- Container stdout protocol markers accept both `---YOPLAI_*---` and legacy `---AIHUB_*---` spellings; a legacy sandbox image logs one deprecation warning and still works, but should be rebuilt.
- The `x-yoplai-auth-context` header (multi-user forwarded auth) still accepts `x-aihub-auth-context`.
- The `yoplai:<agentId>` project `runAgent:` prefix still accepts the legacy `aihub:` prefix.
- Orchestrator worker session transcripts: a pre-rename `<workspace>/.aihub/{claude,pi}-sessions/` directory is renamed (moved, not copied) into `<workspace>/.yoplai/{claude,pi}-sessions/` the first time a worker resolves it, logging one `[worker-runner] Migrated legacy session dir ...` warning; after that, `.aihub` no longer exists under that workspace.
- Orchestrator project-local event logs still read rows pointing at the legacy `<project>/.aihub/codex` directory; new logs are written under `.yoplai/codex`.
- The `${aihubCli}` prompt-template variable (for custom Shaper templates under `<homeDir>/prompts/`) still resolves to the CLI path, logging one `[prompt-factory]` deprecation warning; use `${cli}` instead.

Frozen, do not touch:

- The OAuth token-at-rest encryption salt keeps its literal `aihub-oauth-token-at-rest-v2` spelling — existing `enc:v2:` ciphertext was derived from it. A new salt requires a new `enc:v3:` prefix, never an edit to the v2 salt.

### Upgrade notes

- Nothing is required. If you want to fully move off the legacy names: rename `~/.aihub` to `~/.yoplai` and `aihub.json` to `yoplai.json`, rewrite `AIHUB_*` env vars to `YOPLAI_*`, and rebuild any container image pinned as `aihub-agent:*`.

## v0.21.0 — Native IRC extension + Discord streaming

Agents can now join IRC: a native IRC channel extension with per-agent connections, DM controls, and loop protection. Discord replies stream live with acknowledgement reactions and inbound attachment support.

### Added

- Native IRC channel extension: agents participate in shared IRC rooms with bounded context, DM controls, and loop protection, providing the native gateway lifecycle and normal IRC interoperability needed for human and agent collaboration.
- IRC agent-owned connections: each agent can own its IRC credentials, routes, and DM policy, while shared gateway routing stays compatible during migration.
- IRC acknowledgement and batching: accepted messages get an immediate persistent 👀 acknowledgement (agent runs can take a while, so users know the message landed), and a per-sender `debounceMs` batches one-line-per-message IRC bursts into a single agent run — previously each line triggered its own run and unmentioned follow-ups were dropped in mention-only channels.
- Discord replies stream live into an editable message, acknowledged messages receive a configurable 👀 reaction, and supported image/PDF/Office attachments are forwarded to the agent.
- IRC supports agent-owned connections alongside the shared transport, persistent acceptance acknowledgements, per-sender channel/DM debounce, and newline- and word-aware reply splitting.

### Fixed

- Gateway tool failures now emit one-line JSON logs with extension error metadata.
- IRC debounce batches count as one A2A turn, stale batches do not dispatch to inactive agents, and application replies wait for server registration before sending.
- Discord streaming failures no longer leak timer promise rejections, and acknowledgement reactions are cleaned up for non-streamed and tool-owned forum replies.

### Fixed

- IRC replies now split on word boundaries with one message per line; they were hard-cut every 400 bytes with newlines collapsed, breaking sentences mid-word.
- IRC transport routing hardened: disabled DMs, stale lifecycle callbacks, unbounded offline output, and control-byte payloads can no longer create unsafe IRC behavior.
- A failed initial Discord message post no longer leaves the acknowledgement reaction active or surfaces as an unhandled rejection.
- Scheduler output lookup now guides agents to the list-to-output flow instead of letting them retry output reads without a job ID.
- Single-user installs stay usable without pool config; team/fork UI is hidden unless pool-backed agents are enabled.
- Routed web pages (Edit-Agent, Teams) can scroll past the viewport again; the left-nav main pane clipped overflow, hiding content below the fold.

### Changed

- All pi SDK packages aligned on ^0.80.6 (gateway, agent-runner, projects extension), removing runtime drift between in-process and sandboxed agent runs and picking up new model definitions (Sonnet 5, Fable 5, "max" thinking level).

## v0.20.0 — Teams, per-agent extensions & OAuth connections

The largest release to date: role- and team-based multi-user access control, an admin Edit-Agent hub for per-agent extension configuration, and per-agent OAuth connections (Google Drive) with tokens encrypted at rest — plus a Plane tracker for the orchestrator and scheduler/Telegram hardening.

### Fixed

- Agent chat sidebar SESSIONS list is now independently scrollable (ALG-264). The nested flex scroll chain in `AgentSidebar.tsx` was broken so the sessions list overflowed past the viewport and older sessions were unreachable; `.sidebar-content` now has `min-height: 0`, `.sidebar-sessions` has `flex: 1`, and `.sessions-list` has `flex: 1` + `min-height: 0`, so the list scrolls while the Orchestrator/Agents nav and SESSIONS header stay fixed.
- `/compact` no longer creates a duplicate sidebar thread (ALG-266). Compaction summarizes the conversation in place under the same session, but the internal summarization run used an ephemeral `compact:<sessionId>:<uuid>` session whose history file leaked into `GET /api/agents/sessions` and surfaced as a standalone thread titled "Summarize the conversat…". The sidebar listing filter (`sessionIdIsInteractive`) now excludes `compact:`/`compact-` prefixed sessions alongside the existing scheduler/slack/webhook/bench exclusions, so only the original thread remains.
- Team chat access is now enforced on every agent run/write/read surface, not just the visible agent list. Direct REST run dispatch (`/api/agents/:id/messages`, `/compact`), agent read surfaces (`/api/agents/:id`, status, history, session resume/delete/rename), WebSocket `subscribe`/`send`/status fan-out, agent-bound media upload and download, and bearer/API-token access all reject a user who lacks team access to the target agent and allow one who has it, with admin/superadmin staff bypass preserved. This closes a gap where a determined caller could bypass list-level filtering via a direct API/WS/token call. As part of this, the aggregate `GET /api/agents/status` and `GET /api/agents/sessions` endpoints (which are already filtered per user) are no longer mis-treated as single-agent addresses and wrongly rejected for non-staff users.
- Telegram `/new` now correctly starts a fresh conversation (ALG-308).

### Changed

- Team assignment now lives on the Edit-Agent page. The `/agents/:agentId/edit` page has an admin-only **Team assignment** section that assigns a never-forked pool agent to a team (via `assignPoolToTeam`) or moves an already-forked agent between teams (via `reassignFork`), showing the current team and a "will move from previous team" warning before a move. The equivalent inline Move/Assign-to-team controls have been removed from the pool catalog cards, so team assignment happens in one place. Both actions still call the existing admin-guarded fork APIs and persist; the controls remain admin/superadmin-gated.
- Scheduler jobs now default to a 30-minute timeout with an optional per-job override, so a hung job can no longer wedge the scheduler loop.
- Extension secret env-var names are now unscoped (the raw name, no agent/extension prefix), so `$env:` refs resolve against the agent's `.env` directly.
- Web navigation is unified and power/admin surfaces are gated to `superadmin`.

### Added

- OAuth token encryption at rest + operator setup docs (ALG-359): OAuth access and refresh tokens are now encrypted with AES-256-GCM before being persisted to the connection store under `$AIHUB_HOME/oauth/` — a leaked token row is ciphertext (`enc:v2:...`), not a live Google grant. The AES key is derived (scrypt, once per cipher instance) from a new `oauth.encryptionKey` instance-config secret (`$env:` refs supported, e.g. `$env:AIHUB_OAUTH_ENCRYPTION_KEY`). The store **fails closed**: when the key is unset it refuses to persist tokens (connecting a new account errors and logs a startup warning) so a plaintext token row is never created; existing legacy plaintext rows still read and are re-encrypted on next save. A new operator setup guide (`docs/oauth-google-drive-setup.md`) documents enabling the Google Drive API, configuring the OAuth consent screen with the Drive read-only scope, registering the per-deployment callback URL in the operator's own Google OAuth client, and setting the client ID/secret and encryption key in config.
- OAuth connection reliability (ALG-360): connections never silently break. Access tokens now refresh silently while the refresh token is valid (`resolveToken` refreshes within 60s of expiry against the provider token endpoint), so agents never see an expired token. A connection has a first-class three-state lifecycle — `connected` / `needs_reconnect` / `disconnected` — exposed via the service state machine and the `/api/oauth/:provider/status` `state` field. An unrecoverable refresh failure (provider `invalid_grant`, or an expired token with no refresh token) transitions the connection to `needs_reconnect` (retained, not deleted) and `resolveToken` returns a clean `reason: "needs_reconnect"` signal instead of a cryptic error; transient failures (network/5xx) keep the still-valid grant. Disconnect best-effort revokes the grant at the provider (RFC 7009 revocation endpoint) before clearing the stored connection. The `/connections` web page renders `needs_reconnect` as a distinct badge with a one-click **Reconnect** action alongside **Disconnect**.
- Per-agent OAuth connect framework (ALG-357 tracer bullet): provider registry with a Google descriptor (`packages/shared/src/oauth`), a pluggable BYO credential source, host authorize/callback routes (`/api/oauth/:provider/authorize` + `/callback`, PKCE + state), and a file-backed connection store scoped to a single (agent, provider) pair under `$AIHUB_HOME/oauth/`.
- `defineToolExtension` now supports declaring an `oauth: { provider, scopes }` requirement; at tool-build time `createTools` receives `config.oauth` with a fresh access token when connected, or a structured not-connected signal (never a raw secret, never a thrown 401).
- Web `Connections` page (`/connections`): per-agent Connect Google Drive button and a Connected state showing the connected Google account.
- Enabling an `auto-form` tier extension on the Edit-Agent page now opens a **generic, schema-driven config form** at `/agents/:agentId/extensions/:extensionId/config`. The renderer turns any extension's config JSON-schema into form fields (text/number/boolean), renders each `requiredSecrets` field as a masked/secret input, and on submit persists through the existing write path — secrets are written as `$env:` refs in `agent.yaml` with the value stored in the agent's `.env`, non-secret fields persist as plain values in `agent.yaml`, and the extension is enabled — so the configured extension takes effect on the agent's next run. The `exa` web-search extension (single `apiKey` secret) is the first auto-form extension proven end-to-end: an admin can set its API key from the form. The page is admin/superadmin-gated like the rest of the Edit-Agent hub.
- The Edit-Agent extension hub now routes each extension to one of three config surfaces when an admin enables it — the config-surface contract. **Bespoke-route** extensions self-register an optional agent-keyed config route (`configRoute: { path: "/agents/:agentId/extensions/<id>" }`, mirroring the existing `:projectId` param as `:agentId`) on the `Extension` shape or via `defineToolExtension`, and the web route registry's `WebRouteExtension` self-registration shape gained a matching optional `configRoute` so the extension mounts the client route; enabling one redirects to that page so the extension owns its custom config UI (the escape hatch for file-based config like `mcp`). **Auto-form** extensions (a meaningful config JSON-schema, no bespoke route) surface a schema-driven form path `/agents/:agentId/extensions/:extensionId/config` on enable (the generic renderer itself lands in a follow-up). **Toggle-only** extensions (no meaningful schema) flip inline with no redirect. The tier is decided from catalog metadata: a declared `configRoute` wins over a schema, which wins over toggle-only; backend API route prefixes no longer imply a config surface. Disabling any extension is always an inline flip regardless of tier. A new extension self-registers a config surface with a single optional field.
- Extensions can now be enabled and disabled per agent from the Edit-Agent page — the write path that makes the toggle real. A new admin-only `PATCH /api/agents/:agentId/extensions/:extensionId` endpoint updates an agent's `config.extensions`: it reads the agent's `agent.yaml`, merges the change (enable/disable, config fields, and/or secrets), re-validates the result against the agent schema, writes it back atomically, and invalidates the config cache so the change takes effect on the agent's next run (agent config was read-only at runtime before this — no write path existed). Secret values are never written as plaintext into `agent.yaml`: they are written as `$env:NAME` sentinels there, with the concrete value stored in the agent's `.env` file, matching the runtime `resolveEnvRefs` resolver. On the Edit-Agent page, the extension list's on/off indicator is now a clickable toggle that flips and persists an extension's enabled state (with an inline error if the write fails). The endpoint is server-side admin-guarded (staff-only in multi-user mode), not just hidden in the UI.
- Added an admin-only extension catalog endpoint for the Edit-Agent page. `GET /api/agents/:agentId/extensions` returns, for one agent, every available extension — the built-in static registry plus a runtime scan of `$AIHUB_HOME/extensions` — with that agent's current enabled/disabled state, the extension's config JSON-schema (when it exposes one, via `zod-to-json-schema`), its `requiredSecrets` (fields a UI must mask), and a config-surface **tier** (`auto-form` for schema-driven config, `bespoke-route` for extensions that self-register their own admin route, `toggle-only` otherwise). Discovery is accurate: built-in packages that cannot load are omitted (no ghosts) and every loadable one appears exactly once. The endpoint is admin-guarded (staff-only in multi-user mode). The Edit-Agent page now lists these extensions read-only with their on/off state. Tool extensions defined via `defineToolExtension` now surface their real config schema and required secrets through new optional `configJsonSchema`/`requiredSecrets` fields on the extension metadata.
- Added an admin-only Edit-Agent entry point. Hovering (or focusing) a pool catalog card now shows a subtle highlight and a small edit icon overlaid top-right; clicking it opens a new `/agents/:agentId/edit` page that identifies the target agent (name, role, avatar). Both the icon and the page are gated to admins/superadmins — non-admins never see the icon and are redirected away from the route. The page reads the pool catalog (`/api/pool`), which requires authentication but, like the rest of the catalog, exposes the same name/role/avatar to every authenticated user by design (only per-card actions are gated); the admin gate here is a UI-affordance gate, not a data gate.
- The pool catalog now resolves each agent card to the single action the current user can take. A card shows **Chat** when a fork exists, the user may chat it (a member of the fork's team, or staff), and the fork's agent is actually discoverable/runnable by the gateway config loader, **Assign to team** for admins/superadmins when no fork exists yet, and is otherwise visible-but-not-chattable (the fork is teamless, the user shares no team with it and is not staff, or the fork's agent folder is no longer discoverable on disk, e.g. renamed/removed — this closes a gap where an orphaned fork row kept showing a dead Chat button). Everyone still browses the full pool — only the action is gated. The action is resolved server-side per user via a new `GET /api/pool-actions` endpoint, and staff (admin/superadmin) always get a usable Chat action for existing forks. The Chat action routes to the fork agent, not the raw pool definition.
- Chat access now resolves from team membership instead of the direct agent allowlist. A user may chat a fork agent only if they share at least one team with it; admins and superadmins may chat any agent; a user with no team can chat no one, and a fork with no team is chattable by no one (except staff). The agent list and chat surfaces now reflect this team-gated visibility. Existing installs are migrated automatically at startup: each legacy agent assignment is converted once into a team (with its assigned users as members) linked to that agent, so prior access is preserved without further action.
- Added pool agent → team assignment via a copy-on-assign fork. Admins can assign a read-only pool agent to a team from the pool catalog; the first assignment copies the pool workspace into `$AIHUB_HOME/agents/<forkId>` (alongside functional agents, so the standard `agents` glob discovers it and it's runnable through the unchanged runtime) and records a `sourcePoolId → forkAgentId → teamId` link. A pool definition forks at most once and its single fork belongs to at most one team: re-assigning moves the fork between teams (with a "will move from previous team" warning) and unassigning clears the team link while the fork folder persists (teamless/inert). The team detail view lists a team's assigned agents, and deleting a team now reports the real set of agents that would be left teamless.
- Added user↔team membership. Admins can add and remove users from a team; a user may belong to many teams at once. The Teams page now has a per-team members view with admin-only add/remove controls, and any authenticated user can see which users belong to each team. Deleting a team now reports the real set of users who would be left teamless (those with no other team). Chat access does not yet resolve from membership — that lands in a later slice.
- Added Teams as a first-class entity. Admins can create, edit, and delete teams (name, description, optional color and icon) from a new Teams page; team names are unique and unset color/icon fall back to grey and a generic team icon. Any authenticated user can view all teams. Deleting a team shows a confirmation that reports how many users and agents would be left teamless (always zero until membership and agent↔team assignment land in later slices).
- Introduced a `superadmin` role above `admin`. The first user of a fresh instance now bootstraps as `superadmin`. Superadmins can promote/demote admins and other superadmins from the User access page; admins and regular users cannot change roles. Both `admin` and `superadmin` count as staff for approval and agent-assignment bypass.
- Orchestrator tracker seam with **Plane** support: `aihub orchestrator init-project --tracker plane` scaffolds a Plane-backed project, tracker secrets are scrubbed from worker environments, and Plane tracker setup is documented.

### Upgrade notes

- **Access control (breaking):** chat access now resolves from team membership, not the legacy agent allowlist. Legacy assignments auto-migrate to teams on first startup, preserving prior access; after upgrade, an agent with no team is chattable only by staff (admin/superadmin).
- The first user of a fresh instance now bootstraps as **superadmin**.
- **OAuth:** set `oauth.encryptionKey` (e.g. `$env:AIHUB_OAUTH_ENCRYPTION_KEY`) before connecting any account — the token store fails closed without it. Operators must register their own Google OAuth client with the Drive read-only scope and per-deployment callback URL; see `docs/oauth-google-drive-setup.md`.
- Extension secrets persist as `$env:` refs in the agent's `.env`, never as plaintext in `agent.yaml`. Secret env-var names are now unscoped — verify custom extension secret refs.
- Scheduler jobs now time out after 30 minutes by default; set a per-job override for jobs that legitimately run longer.

### Known limitations

- OAuth ships with Google Drive (read-only) as the only provider.
- The schema-driven auto-form supports text, number, and boolean fields only; richer config uses a bespoke route.

## v0.19.0 — Chat/session reliability + orchestrator run logs

Hardened interactive chat and Discord runs, added JSONL run-event logging to the orchestrator, and made the scheduler resilient to hung jobs.

### Highlights

- Store orchestrator run events as JSONL under each project path (ALG-203).
- Fixed Discord agent runs silently failing on complex/queued requests: per-invocation `onEvent` reply isolation, decoupled `runAgent` from the Carbon listener, and `replyHandled` on the queued path (ALG-205).
- Synthesize a run-level done via quiescence for the Codex runner (ALG-204).
- Sessions poll now stops and redirects to login on 401 instead of looping (ALG-255).
- Scheduler no longer wedges on hung jobs; added `jobTimeoutMs` to the config schema (ALG-189).
- Fixed stale chat "thinking" state after hung/aborted runs; show the issue identifier on active orchestrator runs.
- Made `curl` available to sandboxed agents; avoid stale Linear updates; chat links always open in a new tab.

### Upgrade notes

- New scheduler `jobTimeoutMs` config option; leaving it unset preserves prior behavior.

## v0.18.0 — Orchestrator worker-runner seam + multi-runtime workers

Introduced a pluggable orchestrator worker-runner seam with Codex, Pi, and Claude runtimes, cut the subagents runtime dependency, and enforced real per-turn timeouts.

### Highlights

- Defined an orchestrator worker-runner seam and added Codex (app-server), Pi RPC, and Claude RPC worker runners; the default runner is now `pi`.
- Cut the orchestrator's runtime dependency on the subagents package.
- Enforced `turn_timeout_ms` as a real per-turn deadline across all protocol runners.
- Added run-history pagination; lowered default `max_active_runs` to 3; capped consecutive completed runs on still-active issues; reset the run streak when parking.
- Added per-agent gateway env aliases and honored agent-local env refs.
- Added a justfile with release/deploy recipes; hardened the media metadata store for `send_file`.

### Upgrade notes

- The default orchestrator worker runner is now `pi`; set the runner explicitly if you relied on another default.
- `max_active_runs` default lowered to 3.

### Known limitations

- Worker runtimes (Codex/Pi/Claude) must be installed and on PATH for their respective runners.

## v0.17.0 — Proactive messaging + scheduler ops

Outbound agent messaging on Discord, agent-scoped notification tokens, on-demand scheduler runs, and orchestrator dashboard polish.

### Highlights

- Added Discord proactive agent tools so agents can initiate messages, not just reply.
- Added a scheduler `run` command to trigger a configured job on demand.
- Added a monitored-projects popover to the orchestrator dashboard.
- Resolved notification bot tokens per agent scope.
- Preserved the `session` param when toggling Simple/Full chat view.

### Upgrade notes

- Discord proactive tools require the bot to have send permissions in target channels.
- Notification tokens now resolve per agent; multi-agent setups should confirm each agent's bot token configuration.

### Known limitations

- Manual scheduler runs reuse the job's configured payload/session semantics.

## v0.16.0 — Orchestrator: Linear runtime + Symphony realignment

Largest cluster: the orchestrator extension gains a first-class Linear runtime, realigns to the Symphony multi-project supervisor model, and ships a redesigned dashboard.

### Highlights

- Added a Linear runtime: polling filtered by Linear project `slugId`, rate-header parsing, and workflow-owned tracker/endpoint/auth/states config.
- Realigned config to `extensions.orchestrator.projects[]` with global + per-project supervisor concurrency and validation settings.
- Each configured project must contain an uppercase `WORKFLOW.md`.
- Added `aihub orchestrator init-project` to scaffold a project end-to-end, with an expanded generated workflow template.
- Stop workers when an issue moves to "Needs Human".
- Redesigned the `/orchestrator` dashboard: live health data, logs rendered as agent turns, filtered/bounded recent runs, pinned/opaque log drawer.
- Hardened live dispatch, parked failed workers, and unblocked Node 26 sandbox validation.

### Upgrade notes

- Orchestrator config moved from dispatch-scope to `projects[]`; existing configs must migrate.
- Each project directory must contain uppercase `WORKFLOW.md`; workflow config now owns Linear `tracker.project_slug`, endpoint/auth, states, workspace root, hooks, and prompt.
- Gateway-owned worker lifetime: startup marks open runs `interrupted_gateway_restart` instead of reattaching live sessions; restart-recovery integrations should adjust.
- Repo-label routing and git/worktree behavior were removed from orchestrator runtime (directory-only workspace layout per issue).

### Known limitations

- SQLite state is observability/history only, not authority.

## v0.15.0 — Slack agent messaging

Agents can send Slack messages as a first-class tool, backed by per-agent bot configuration.

### Highlights

- Added Slack agent tools for sending messages.
- Documented Slack bots, agent tools, and required scopes.
- Resolved secrets correctly on gateway hot reload.

### Upgrade notes

- Slack send tools require bot tokens with the documented scopes.

### Known limitations

- Outbound only; richer Slack interactivity not yet covered.

## v0.14.0 — Lead-agent session resume + chat history hardening

Past agent sessions are now listable and resumable from canonical history, with session-id validation hardening.

### Highlights

- Added `GET /api/agents/sessions` listing visible past sessions from canonical history JSONL (single- and multi-user paths).
- Added session delete/rename via `DELETE`/`PATCH /api/agents/:agentId/sessions/:sessionId`.
- WebSocket `subscribe` accepts an explicit `sessionId` for active-turn replay and stream matching.
- Added a searchable, recency-grouped Sessions sidebar with rename/delete; polls every 3s and on focus.
- Compact resumed sessions and handle legacy session edits while keeping a canonical history path.

### Upgrade notes

- **Security:** session ids are validated and `..`/dot-dot ids are rejected; clients passing arbitrary session ids must conform.
- History fetch with explicit `?sessionId=` skips `sessions.json` pointer resolution.
- New chats come from chat flows (`/new`, idle rotation); the sidebar `+ New` affordance was removed.

### Known limitations

- Sidebar session list refreshes on a 3s poll/focus rather than live push.

## v0.13.0 — Scheduler model overrides + cron agent tools

Per-job model selection for scheduled runs, agent-facing cron tools, plus auth and chat-stream fixes.

### Highlights

- Added optional scheduler job `model: { provider, model }` overrides, threaded through run contract, Pi adapter, container input, and recorded in cron output.
- Added `--provider`/`--model` to scheduler CLI add/update.
- Added agent cron tools for managing schedules from within agent runs.
- Respect manual scroll during streaming instead of force-scrolling.
- Refreshed multi-user pending-approval state and moved the user-sessions storage path.

### Upgrade notes

- Scheduler job `model` requires both `provider` and `model` when set; otherwise the agent default applies.
- User-session storage path moved; multi-user deployments should verify session persistence after upgrade.

### Known limitations

- Cron job-file edits may still require a gateway restart to take effect.

## v0.12.0 — Context compaction + boot resilience

Context-window compaction, clearer context-usage visibility, and more resilient gateway boot/model-source handling.

### Highlights

- Added context compaction support for long-running chats.
- Surfaced context usage (including cache tokens) in the web UI.
- Refreshed and added fallback model context sources; preserved model data across updates.
- Improved gateway boot resilience and dev-extension loading.
- `/new` and `/reset` bypass the auto-compact pre-send guard even above 80% estimated usage.

### Upgrade notes

- Model context sources changed; custom model definitions should be re-verified after upgrade.

### Known limitations

- Compaction thresholds/heuristics are fixed, not yet user-configurable.

## v0.11.0 — Current reliability + admin/media polish

Current snapshot adds agent-run reliability work, admin impersonation, document upload support, and chat/streaming polish.

### Highlights

- Improved reliability for concurrent, queued, and long-running agent runs.
- Added admin read-only impersonation for multi-user mode.
- Added document upload support for media handling.
- Hid private agent metadata from responses/UI paths.
- Improved sidebar header visibility and streaming/chat flicker behavior.
- Added simple thinking traces in chat.

### Upgrade notes

- Private metadata is less visible; integrations reading private agent meta from API responses may need adjustment.
- Admin impersonation is read-only for writes by design.

### Known limitations

- Latest moving target; future in-app changelog should treat this as current snapshot until next release.

## v0.10.0 — Decentralized agent + scheduler config

Configuration ownership moved out of monolithic `aihub.json`: agents live in per-agent `agent.yaml`, schedules live under agent workspaces in `cron/jobs.json`.

### Highlights

- Added config v3 with agent discovery via root `aihub.json` `agents` globs/paths.
- Added root-only per-agent `agent.yaml` definitions with folder/name validation.
- Added `aihub agents migrate` to split legacy centralized config into agent workspaces.
- Moved scheduler jobs to per-agent `cron/jobs.json` with cron/tz/startAt shape.
- Standardized scheduler output under `<workspace>/cron/output/<jobId>/...`.
- Updated heartbeat to reuse scheduler-style output/routing helpers.
- Simplified agent workspace loading and deferred subagent config loading.
- Decoupled extension routes further from core runtime.

### Upgrade notes

- Legacy centralized `aihub.json` agent definitions must migrate to config v3.
- Agent IDs must match workspace folder/root `agent.yaml` expectations.
- Legacy `interval`/`daily` scheduler shapes migrate to cron-style jobs.
- Scheduler API/storage ownership moved per agent; direct global schedule-file assumptions should be updated.

### Known limitations

- `cron/jobs.json` edits may require gateway restart; no full live watcher yet.
- Malformed per-agent scheduler files are isolated with warnings and ignored for that agent.

## v0.9.0 — Scheduler/auth polish after refactor

Post-refactor release focused on UX polish, opt-in runtime behavior, bearer-token auth, and safer scheduler runs.

### Highlights

- Added lead-agent reasoning config parity and project repo edit affordance.
- Polished project lifecycle UI, project editors, inline project titles, and Agent FAB gating.
- Made scheduler and heartbeat opt-in extensions.
- Added bearer-token API auth for multi-user mode.
- Added scheduler CLI.
- Isolated scheduled job runs into unique scheduler sessions unless `payload.sessionId` is explicitly provided.

### Upgrade notes

- Scheduler/heartbeat must be enabled explicitly via extension config.
- Scheduler jobs no longer share one transcript by default; set `payload.sessionId` to preserve continuity.

### Known limitations

- Scheduler storage still mostly centralized at this point; deeper per-agent config lands in v0.10.0.

## v0.8.0 — Architecture refactor stabilization

Large internal architecture refactor split runtime seams while preserving product behavior, then stabilized board navigation and slice editing.

### Highlights

- Refactored gateway, web, container, projects, subagents, orchestrator, and realtime internals into clearer seams.
- Upgraded Pi SDK and made HITL channel optional.
- Fixed slice thread editing and board canvas/back navigation after refresh.

### Upgrade notes

- Private imports into gateway/web internals may break due to module moves.
- Custom integrations should verify Pi SDK/tool compatibility.

### Known limitations

- Mostly internal; regressions most likely in custom/private integration paths.

## v0.7.0 — Slices + orchestrator reliability

Project work moved to slice-first execution with Worker/Reviewer/Merger orchestration, blockers, HITL notifications, and board lifecycle UX.

### Highlights

- Added slice storage, `aihub slices` CLI, migration helpers, scope map generation, and lifecycle status model.
- Re-keyed orchestrator dispatch from project IDs to slice IDs.
- Added Worker/Reviewer/Merger flow, integration branches, stale-run interrupts, spawn backoff, stall detection, conflict parking, and done-slice pings.
- Added slice blockers, repo overrides/invariants, pitch/specs doc surfaces, and durable reviewer feedback.
- Added board lifecycle views, embedded project/slice navigation, inline doc editing, thread markdown, live slice kanban refresh, activity feed, and run timeline.
- Added `aihub notify` for HITL notifications.

### Upgrade notes

- Orchestrator state and concurrency became slice-keyed, not project-keyed.
- Project-level docs shifted toward `PITCH.md`; slice specs shifted toward `SPECS.md`.
- Automation must account for slice statuses and blocker resolution.

### Known limitations

- Missing/stale blockers can intentionally block dispatch.
- Human intervention still required for some merge/conflict paths.

## v0.6.0 — Board, scratchpad, runtime subagents

Board became the central home: lead chat, scratchpad, runtime subagents, projects/worktrees overview, and extension tools.

### Highlights

- Added Board extension home route, persistent board chat, stop/queue controls, and full-history renderer.
- Added scratchpad API, internal tools, prompt contribution, editor UI, and line tools.
- Added project-agnostic subagents runtime and CLI/API surface.
- Added extension prompt/tool model, sanitized tool names, and large tool-result spooling.
- Added `/board/projects` scanning, project panels, worktree discovery, Space cache, and worktree/run state enrichment.
- Added webhooks extension and Slack/thread improvements.

### Upgrade notes

- Board/subagents flows depend on extensions being configured.
- Some legacy internal subagent tool wiring was removed in favor of extension tools.

### Known limitations

- Board project scan/perf behavior was still actively tuned.

## v0.5.0 — Extension extraction

Core gateway features were extracted into first-party extensions, making optional surfaces explicit and reducing core coupling.

### Highlights

- Moved optional capabilities out of core and into first-party extensions.
- Extracted heartbeat, scheduler, Langfuse, multi-user, Discord, Slack, and projects into extension packages.
- Added shared extension contracts and extension loading.

### Upgrade notes

- Built-ins became extension-shaped; deployments need explicit extension config where applicable.
- Custom integrations importing private component paths likely need updates.

### Known limitations

- Extension ecosystem still young; follow-up build/runtime fixes landed after this cut.

## v0.4.0 — Components, auth, containers, media

Runtime platform matured: modular components, connectors, multi-user auth, Langfuse, sandbox containers, evals, and file exchange.

### Highlights

- Added modular component foundation and extracted simple gateway components.
- Added connector framework, OneCLI integration, `$AIHUB_HOME`, env resolution, and skill/tool filtering.
- Added multi-user auth startup flow and protected web/API paths.
- Added Langfuse tracing over history/stream events.
- Added Docker-backed agent runner, container adapter, internal tool dispatch, OneCLI proxy wiring, and sandbox mounts.
- Added media/file upload/download foundation and agent file output support.
- Added eval runner and Harbor eval scaffolding.

### Upgrade notes

- Config/runtime paths changed around `$AIHUB_HOME`, connectors, and component enablement.
- `--template` usage moved toward `--subagent`.
- Containerized agents changed attachment/tool/file-output expectations.

### Known limitations

- Component extraction not yet full extension packaging.

## v0.3.0 — Project UI, Space, and worktree workflow

Yoplai grew into a project operating surface: UI v2/v3, project agent panels, Space/worktree workflow, and richer realtime state.

### Highlights

- Added kanban homepage, agents sidebar, context panel, project detail tabs, mobile polish, and command/search flows.
- Added project agent panel/chat, spawn templates, role prompts, and run-mode controls.
- Added Space-first workspace core, branch diffs, integration controls, and worktree-aware prompts.
- Added realtime project file refresh, activity/comment separation, status indicators, and context usage warnings.
- Added areas, SPECS task parsing, checklist support, and repo validation.

### Upgrade notes

- Project documents moved beyond README-only assumptions toward SPECS/tasks/structured metadata.
- CLI/template flows changed; automation should align with newer project spawn/start semantics.

### Known limitations

- Slice/orchestrator model not yet present.

## v0.2.0 — Projects + subagent loop

Projects and subagents became usable together: create work, spawn agents, monitor logs, resume/kill runs.

### Highlights

- Added Projects API, CLI, kanban UI, project detail surfaces, and project creation flows.
- Added subagent list/logs/spawn/interrupt/resume/kill APIs and CLI commands.
- Added project-aware prompts, repo-path handling, worktree mode, and live monitoring panel.
- Added heartbeat runner/CLI and richer web run controls.

### Upgrade notes

- Project/subagent command behavior changed from ad hoc runs toward project IDs and resolved repo/worktree paths.
- Scripts should prefer explicit project IDs and run metadata.

### Known limitations

- Orchestration still manual; recovery from conflicts/stalls remained best-effort.

## v0.1.0 — Initial gateway foundation

First usable Yoplai shape: gateway, web chat, sessions, WebSocket streaming, and early multi-SDK preparation.

### Highlights

- Added gateway/web baseline with WebSocket streaming and session persistence.
- Added full-history chat view, thinking indicators, markdown rendering, and live subscription plumbing.
- Added AMSG/Discord basics and workspace bootstrap/session key support.
- Prepared multi-SDK architecture and config surfaces.

### Upgrade notes

- Early internal config/runtime paths changed quickly; no stable migration contract yet.

### Known limitations

- Pre-projects, pre-board, pre-extensions.
