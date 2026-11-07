A centered glass-strong dialog with a head, body and a footer of actions. While it is open the scene behind recedes.

**When to use**
- Confirming destructive or irreversible actions, or short blocking forms.

**What you provide**
- `open: boolean`, `onClose()`, `title: string`, `children` (body)
- `actions`: footer buttons, Cancel (secondary) then the confirm
- Confirm variant: `ConfirmDialog` wraps this with `confirmLabel` and `danger?: boolean`
- Source: `apps/web/src/components/ui/Modal.tsx` (and `ConfirmDialog.tsx`)

**Do**
- Prefer native `<dialog class="yp-modal">` + `showModal()`: the bundle animates it (rise 8px and scale from 0.97 on `spring-smooth`, exit at `dur-quick`) and fades the `scrim` backdrop.
- Mark the app root `yp-recede` and set `data-receded` while open: it scales to 0.98 behind the scrim.
- Use `glass-strong` on `elev-4` with `space-6` (32px) padding; set `aria-labelledby` to the head.

**Don't**
- Don't use "OK" or "Yes" as labels; name the action: "Delete chat".
- Don't open a modal from a modal.
- Don't skip the focus trap and Escape (native `dialog` gives both).
