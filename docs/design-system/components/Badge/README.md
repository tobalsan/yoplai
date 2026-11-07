A small tag that states a status or label in a wash ground plus a word.

**When to use**
- Pinned state, connection state, quota warnings, run state, tool failures. Sits on paper or glass-strong.

**What you provide**
- `tone?: "neutral" | "accent" | "success" | "warning" | "danger"` (neutral uses the translucent `field` fill)
- `live?: boolean` prepends `yp-dot yp-dot--live`
- `children`: one or two words, sentence case

**Do**
- Pair `danger-wash` with a word such as "Failed".
- Use `yp-badge--accent` for Pinned and live runs.
- Keep `radius-xs`, 20px tall with 8px side padding.

**Don't**
- Don't convey status by color alone.
- Don't use a bright fill for passive states.
- Don't set text below 11px.
- Don't tag sessions in the sidebar; a session row is avatar and title only.
