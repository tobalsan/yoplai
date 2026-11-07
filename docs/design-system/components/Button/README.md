A pressable control for actions, in four variants and two sizes, plus the round Send button.

**When to use**
- Any action the user triggers: send, save, cancel, delete.
- One `yp-btn--primary` per view; everything else is secondary or ghost.

**What you provide**
- `variant: "primary" | "secondary" | "ghost" | "danger"` (default secondary)
- `size?: "md" | "sm"` (`control-h` 36px with 16px sides, `control-h-sm` 30px with 12px); `icon?: JSX.Element` with `aria-label` when there is no text
- `disabled?: boolean`, `onClick`, `children` (a short verb)
- Send: `yp-send` with `data-state="idle" | "stop"`; it morphs from a circle to a "Stop" pill while a reply streams (caps translate, the bar scales; never a width animation)
- Source: `apps/web/src/components/ui/Button.tsx`

**Do**
- Use verbs: Send, Save, Delete chat.
- Mark secondary buttons with the `field` fill, not a border. Hover and press are a `currentColor` state layer that fades by opacity.
- Keep `yp-btn--danger` for destructive confirms only. Give icon-only buttons an `aria-label`.

**Don't**
- Don't place two `accent` fills in one view (the Send button counts as one).
- Don't use "Submit", "OK" or "Click here".
- Don't put white text on orange: primary and Send use `on-accent` (black).
