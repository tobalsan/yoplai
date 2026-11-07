The command-K palette that searches titles and messages across your chats and opens the one you pick.

**When to use**
- Jumping to a past session from anywhere: ⌘K / Ctrl+K or the sidebar Search item. Search is for finding chats only, not running commands.

**What you provide**
- `query: string`, `onQuery(q)` (debounce ~200ms; search runs on the server)
- `items: { sessionId, agentId, avatar?, title, snippet?, lastActivity }[]`, `loading: boolean`
- `onOpen(item)`, `onClose()`
- Markup: a `<dialog class="yp-modal yp-search">`; add `is-receded` on the app root (`yp-recede`) while open. The active row is a single `yp-pill` placed with `--y`, width and height from the row.

**Do**
- Highlight matched words with `<mark>` (accent-wash, never bold or orange text).
- Keep focus in the input; arrows move `aria-selected` (wrapping), Enter opens, hover sets the active row, Esc or a scrim click closes.
- Show a thin `yp-search__load` sweep while a request is in flight, then "No matches for “x”" when empty.
- Keep rows quiet: avatar, title, one-line snippet, and faint `agent · age` at the right.

**Don't**
- Don't add filters, groups or commands; main only searches sessions.
- Don't show timestamps or agent names inline beyond the faint meta.
- Don't animate anything but transform and opacity; the pill moves with `translate`.
