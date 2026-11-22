# Main agent home

Source: Threadit #36 "Simpler interface with default agent" (area Cloudi-Fi AI). The thread holds the drill-specs result and a sketch of the picker.

## Problem Statement

Session data shows that most users talk to one agent almost all the time. The home page still shows the full agent catalog on every visit. A daily user sees a choice that is noise. The user must click a card before the first message, every time.

## Solution

Each user makes one memorable choice of a **main agent**. After that choice, the home page is a fresh chat with that agent. The user comes back every day and types at once. The user can change the main agent from the Agents page and from the home chat. The `Agents` sidebar item still opens the catalog.

The choice step is a prompt that looks like a character select screen. It is playful and branded. It states that the choice is a preference and that all other agents stay available. The user can close it only with a deliberate click. It returns on each home visit until the user picks.

## User Stories

 1. As a daily user, I want the home page to open a fresh chat with my main agent, so that I type my first message without a click.
 2. As a daily user, I want to pick my main agent once in a clear and playful screen, so that the choice feels like mine and I remember it.
 3. As an existing user, I want the picker to start with the agent from my most recent chat in focus, so that the pick takes one click.
 4. As a user, I want the picker to tell me that this is a preference, so that I know I keep access to every other agent.
 5. As a user, I want the picker to close only when I click `x` or "I will decide later", so that a stray click or `Esc` does not skip my choice.
 6. As a user who closed the picker, I want it back on my next home visit, so that I do not forget to pick.
 7. As a user who closed the picker, I want the catalog home behind it to work as before, so that I can still browse and chat.
 8. As a user, I want to see which agent is my main agent in the home chat, so that I know who I talk to.
 9. As a user, I want to change my main agent from the home chat in one click, so that a wrong pick is easy to fix.
10. As a user, I want a star on each card of the Agents page, so that I can change my main agent while I browse.
11. As a user who changes the main agent, I want a short confirmation, so that I know the change took effect.
12. As a user with access to one agent only, I want no picker, so that I land in the chat at once.
13. As a user whose main agent was removed or unshared, I want the picker to return, so that I pick a new one instead of landing on an error.
14. As a user on a local single-user install, I want the same home behaviour, so that Yoplai feels the same everywhere.
15. As a user, I want my main agent choice to survive a logout, a new browser, and a gateway restart, so that I pick only once.
16. As a user, I want the `Agents` sidebar item to open the full catalog, so that other agents stay one click away.
17. As a user, I want the picker to show each agent's name, avatar, and short description, so that I pick with enough context.
18. As a user, I want the picker to work with a keyboard and on a narrow screen, so that I can pick on any device.
19. As an admin, I want the main agent to be a per-user preference with no effect on agent config, so that one user's pick changes nothing for others.
20. As a product owner, I want sessions that start from the home chat to count only after the first user message, so that the sessions-per-user metric stays honest.

## Implementation Decisions

### MainAgentPreference (gateway store)

* Per-user record: `{ mainAgentId: string | null, pickerDismissedAt: string | null, updatedAt: string }`.
* Stored as a JSON file in the user session area, the same pattern as chat projects: config root in single-user mode, the user folder under `sessions/users` in multi-user mode. No `auth.db` migration.
* Writes are atomic. A missing file reads as an empty record.
* The store does not validate agent access. The route does.
* Storage scope: single-user mode uses an absent user ID, which selects the config root. Multi-user mode uses the authenticated requester ID. The route never requires a user object.

### `/api/me/main-agent` (gateway route)

* Every agent in the requester’s agent list is eligible. The saved ID is the selected agent’s ID.
* `GET` returns `{ mainAgentId, accessible: boolean, pickerDismissedAt }`. `accessible` is true only when the saved agent is in the eligible list.
* `PUT { mainAgentId }` returns 403 when the agent is not eligible. On success it clears `pickerDismissedAt`.
* `PUT { pickerDismissedAt: now }` records a dismissal without a pick. The server sets the timestamp.
* `DELETE` clears the record.
* The route works in single-user and multi-user mode. It never reports `supported: false`.
* Audit: none. This is a personal preference.

### HomeRoute (web)

* Extension-owned home routes keep priority, unchanged.
* Load `/api/me/main-agent` and the eligible agent list together. While they load, show nothing or a light loading state. On a load failure, render the catalog home without the picker and show the usual error.
* Zero eligible agents: render the catalog home as today. No picker.
* Exactly one eligible agent: save it as the main agent, then go to the home chat. No picker. If the save fails, show the catalog with the error and a Retry button. Do not redirect.
* Main agent set and accessible: start a fresh session and redirect to `/chat/<mainAgentId>`. The URL shows the agent. The sidebar marks Agents, as it does for any chat. No new home marker.
* Otherwise: render the catalog home with the picker overlay on top.
* Every visit to `/` starts a fresh session, including a click on the logo while already in the home chat. The home uses the same fresh-session mechanism as the existing "New chat" action for that agent, called before the redirect. Session keys live in browser storage per agent, so a fresh visit in a second tab resets a blank chat in the first tab. This is the existing "New chat" behaviour and stays out of scope. Existing sessions stay in the sidebar as today.

### MainAgentPicker (web)

* Overlay over the catalog home. One agent in focus, large, with name, avatar, and description. Other agents to the sides, smaller. Arrows and keyboard left/right move the focus. Click on a side card brings it to focus. A primary button confirms the focused agent.
* Initial focus: the agent with the most recent session for this user, from the existing sessions list. Fallback: the first agent in catalog order.
* Copy states: this is your preference, you keep access to every agent, you can change it later. Keep the copy short.
* Close controls: an `x` in the corner and a quiet "I will decide later" link. Click outside and `Esc` do nothing. When no main agent is set, or the saved main agent is not accessible, close records `pickerDismissedAt` and shows the catalog home. The picker returns on the next home visit. When the picker was reopened from the home chat star, close records nothing and returns to the chat.
* After a first pick: save, then go to the home chat with a short confirmation that names the agent. On a save failure, stay in the picker and show the error.
* Reopen from the home chat star: the same component opens with the current main agent in focus. A new pick saves, then starts a fresh home chat with the new agent.
* The picker must feel playful and branded. A plain list or a plain modal is a failure. The worker agents use the design skills under `~/dotagents/skills/design`: `frontend-design`, `impeccable`, and `interface-design`. They read those skills before they build the picker and the home chat changes. The sketch on Threadit #36 shows the intended feel, not the layout.
* Works on narrow screens: the side cards stack or scroll, the focus card stays visible, the confirm button stays reachable.

### Change entry points (web)

* Home chat header: after the New chat button, a settings cog (links to the agent's edit page) and a star button. The star is filled when the chat agent is the main agent; click opens the picker. A new pick replaces the home chat with a fresh chat with the new agent.
* Agents page: the main agent card is listed first with an accent glow. Each eligible card has a star at its top-left: filled on the main card, outline elsewhere. Clicking an outline star opens a confirmation ("Make <name> your main agent?"); confirming saves, shows a short toast, and stays on the Agents page. Cancel saves nothing. On a save failure, the error shows in the dialog, which stays open. The change takes effect on the next home visit.

### Sidebar

* The `Agents` item stays. It links to `/agents`, the full catalog.
* The logo link stays on `/`.

### Metric

* A home visit without a message must persist no session file. A test proves this rule. The sessions-per-user metric then counts persisted sessions only.

## Testing Decisions

* A good test asserts user-visible behaviour through public seams: HTTP responses, rendered text, roles, labels, and hrefs. No CSS class or DOM path selectors. No checks on store internals.
* `/api/me/main-agent` routes: GET empty, PUT valid, PUT ineligible agent returns 403, PUT dismissal, DELETE, GET reports `accessible: false` after the agent disappears, two users keep separate records, single-user mode works. Prior art: the onboarding and connect-prompt route tests in the gateway agent-access REST tests.
* HomeRoute branching: zero eligible agents shows the catalog, one agent auto-picks, set and accessible redirects to the chat, set and inaccessible shows the picker, dismissed shows the catalog with the picker again, a load failure shows the catalog without the picker. Prior art: `AgentCatalog.test.tsx` and other page tests under the web `pages` folder.
* MainAgentPicker: `Esc` and outside click keep it open, `x` and "I will decide later" close it and record a dismissal, arrows move focus, confirm saves and shows the chat with the agent name, initial focus lands on the most recent agent. Prior art: component tests under the web `components` folder.
* MainAgentPreference store and change entry points: no dedicated unit tests. The route tests and the e2e section cover them.
* E2E validation: add an `## E2E Validation` section to this spec with the `add-validation` skill. It must prove: first visit shows the picker, pick lands in the chat, next visit skips the picker, change from the Agents page, change from the home chat, dismissal returns on the next visit, single-agent user skips the picker, a home visit without a message persists no session.

## Out of Scope

* Admin-set org-wide default agent.
* Change the main agent from inside a chat message or a slash command.
* Extensions that own the home route. They keep priority over this feature. Board and Projects declare homes, so test with those extensions off.
* Resume the last chat on the home. The home is always a fresh chat.
* Changes to the onboarding tour.
* Agent artwork. Use the existing avatar field.
* Analytics dashboards for the success metric.

## Further Notes

* Goal check from the drill: three engineers can build this three ways, as long as the user makes one memorable choice, lands in a blank chat after it, and can reverse it from the Agents page and the home chat.
* Failure, even if shipped: users pick the wrong agent and never change it, or users do not notice a difference. A pre-picked default with no ritual counts as the second failure.
* Success signal, 30 days: unique users per day, and unique sessions per user with at least one user message.
* Update `docs/llms.md`, `README.md`, and `CHANGELOG.md` with the change.

## E2E Validation

Follow `docs/validation_e2e.md` with an isolated `.yoplai-e2e` home inside the issue worktree, email/password dummy accounts, two plain agents. Disable Board and Projects so neither owns home. Start only with `YOPLAI_HOME=$(pwd)/.yoplai-e2e pnpm dev` and record the actual gateway/UI ports. Never use a production home or restart the production gateway.

Run the exact changed gateway and web test files serially with `YOPLAI_HOME` unset before the browser scenarios. Keep cookies and authentication artifacts in the ignored temporary home, outside `validation/`.

| Scenario | Browser action and expected result | Evidence |
| --- | --- | --- |
| First visit | Sign in with two eligible agents and no preference; visit `/`. Character-select overlay shows name, existing avatar, description and preference copy over the working catalog. Arrow keys/buttons and side cards move focus. Escape and outside clicks keep it open. | `01-picker.png`, `01-picker.dom.txt` |
| Pick | Confirm the focused agent. The URL becomes `/chat/<chatAgentId>`, an empty composer is available, a confirmation names the agent, and the header star is filled for that agent. GET `/api/me/main-agent` reports the saved runnable ID and `accessible: true`. | `02-picked.png`, `02-picked.dom.txt`, redacted API transcript |
| Return | Click the logo from chat, then revisit `/` in a fresh browser context after signing in. Both visits skip the picker and start fresh chats; the earlier session is not resumed. Verify the preference again after restarting only the isolated dev stack. | `03-return.png`, `03-return.dom.txt`, persistence transcript |
| Agents change | Open the sidebar's Agents link (`/agents`). Click the star on another eligible card and confirm. The main card moves first, the star fills, a toast appears, the URL stays `/agents`, and the next home visit opens that agent. On a failed save the dialog shows the error and the old main card remains. | `04-agents.png`, `04-agents.dom.txt` |
| Home chat change | Click the header star. Current agent starts in focus; closing writes no dismissal. Reopen, select another agent, and confirm; a fresh chat opens with its name. A failed save keeps the picker and error visible. | `05-change.png`, `05-change.dom.txt` |
| Dismissal | Clear the preference through DELETE, visit `/`, dismiss with x or I will decide later. The catalog works and GET has a server-generated dismissal timestamp; the next `/` visit shows the picker again. | `06-dismissed.png`, `06-dismissed.dom.txt` |
| One agent | Sign in as a user with exactly one eligible agent. Visiting `/` saves that agent and opens chat without a picker. Repeat in an isolated single-user home. A forced save failure shows the catalog, error and Retry, and retry succeeds after recovery. | `07-single.png`, `07-single.dom.txt` |
| No blank sessions | Before sending any message, record session files and GET `/api/agents/sessions`. Visit home, pick, return, and switch main agents. No history/runtime `.jsonl` or logical `sessions.json` file is created, and the session list stays empty. Then send a first message to prove normal session persistence begins only then. | `08-sessions.json`, filesystem transcript |
| Removed access | Remove a selected Private agent's team link for a normal user. GET reports `accessible: false`; home shows the picker with only eligible agents. An inaccessible agent PUT returns 403. | redacted access transcript |
| Failure and responsive behavior | At desktop and 390px widths in light/dark themes, confirm focused avatar and action stay visible, keyboard focus is trapped/restored, and all controls remain reachable. Fail preference/eligible-list loads and hold a request until its finite timeout: catalog stays usable with error and Retry, then recovery works. | `09-mobile.png`, `09-mobile.dom.txt`, failure transcript |

Capture screenshots, matching role-based DOM snapshots, exact commands, ports, implementation revision, and PASS/FAIL/NOT RUN per scenario in `validation/notes.md`. Check browser console errors. A screenshot does not prove server authorization or persistence: re-fetch state and inspect the isolated session files. Record any unavailable provider-dependent first-message run as a harness gap.
