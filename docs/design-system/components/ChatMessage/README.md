The chat thread: a right-aligned user bubble, an unboxed assistant reply with its activity group above it, a quiet footer, and a thinking indicator, set on a paper sheet.

**When to use**
- Rendering a session's conversation in the chat column (`prose-w` cap), on `yp-paper` with `elev-1`/`elev-2`.

**What you provide**
- `messages: { role: "user" | "agent"; text; time?: string; activity?: Activity }[]`; an agent reply carries its `Activity` group (see Activity) and, once finished, a `time`
- `thinking?: string` for the `yp-thinking` line with a live dot and a light sweep (`--sweep` sets the ground color under it)

**Do**
- Use `yp-msg--user` (`accent-wash`, `radius-lg`, 12/16px padding) for the user's bubble only; the assistant reply is unboxed, left-aligned, max 78ch.
- Put no header on a message: no avatar, name or time above it.
- Under a finished reply, show `yp-msg__foot`: the time ("2:14 PM") and a "Copy reply" icon button. It rests quiet and strengthens on hover or focus.
- Stream replies as `yp-chunk` spans that fade in where they land; new messages rise 6px via `@starting-style`.

**Don't**
- Don't re-flow or slide streaming text.
- Don't bold whole sentences.
- Don't put the thread on glass; it is read, so it is paper.
