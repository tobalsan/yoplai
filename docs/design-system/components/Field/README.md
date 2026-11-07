A labelled text input or textarea with an optional hint and error line.

**When to use**
- Any single-value or multi-line text entry in forms and settings, usually on paper.

**What you provide**
- `label: string`, `value`, `onInput`, `placeholder?`
- `hint?: string`; `error?: string` (adds `yp-input--invalid` and `aria-invalid`)
- `multiline?: boolean` renders a `textarea.yp-input`
- Source: `apps/web/src/components/ui/Field.tsx`

**Do**
- Mark the control with the `field` fill and a barely-there `line` hairline; 36px tall with 12px side padding, `radius-sm`.
- Link the label with `for`/`id` and the error with `aria-describedby`; say how to fix the error in `yp-field__error` (`danger`).
- Rely on the 2px `focus` ring at 2px offset; it is built in.

**Don't**
- Don't use placeholder text as the label.
- Don't signal errors by the danger hairline alone; always add the message.
- Don't add heavy borders back; the fill, label and focus ring carry the affordance.
