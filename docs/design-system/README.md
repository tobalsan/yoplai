Yoplai is a workroom for agents, built as a lit space rather than a flat page. The palette is orange, black and white. Content sits on paper; chrome floats above it as liquid glass; orange light pools on the ground. Depth comes from light and material, not lines.

## Principles

- Simplicity and focus. Show only what is needed.
- Elegance. Clutter is the enemy. Our interfaces are sleek and minimal.
- **One of everything.** Use one accent (`accent`, orange), one radius per job and one type scale. Never write a hex value in a component: every color comes from a token.
- **Say it once.** Don't show the same thing twice. An agent card shows its name and one role line, not "Customer Success" followed by "Customer Success AI Agent".
- **Calm states.** Use a wash ground plus a word for status (`danger-wash` + "Failed"). Never color alone, never a bright fill for a passive state.

## Using tokens

Default colors are orange, black, and white.

But the platform itself can be themed with a `theme.css` file to allow users to tweak the colors to their liking.

- Components read only these tokens as CSS custom properties. A deployment's `/api/theme.css` overrides them (usually `accent`, `accent-ink`, `accent-wash`, `on-accent`), and every screen follows. A component that hardcodes a color breaks theming.
- Use the three planes in Materials and depth: `canvas` ground, `surface` paper, `glass` chrome. Never outline paper with a border.
- Text is `ink` (black), `ink-muted` for descriptions and `ink-faint` for meta on plain grounds. On `selected`, use `ink-muted`, never `ink-faint`.
- Orange is rare and means "act here" or "alive". Use an `accent` fill with `on-accent` (black) text for the one primary action per view, plus the live-run dot and the active tab underline. Use `accent-ink` for links and the MAIN tag, and `accent-wash` for the user's message bubble and info notices. Never put white text on orange.
- Navigation selection is `selected` (neutral), never orange. Hover is `hover`.
- Statuses are `danger`, `warning` and `success`, each with its `-wash` ground and always a word or icon. `danger` sits near orange in hue, so it never appears without its word. Quota bars fill `ink`, then `warning` at 75% and `danger` at 90%.
- Dark mirrors light: `canvas` goes near-black (`#0b0b0b`), `ink` goes off-white, and orange stays the same.

Spacing: always keep in mind the whitespace importance awareness. We strive toward bold, clear, and clean layouts. We make space for a focused, flowing experience.

- The grid is 4px: `space-1` through `space-8`. Elements breathe. Use `space-5` (24px) inside cards and between them, `space-6` (32px) inside dialogs and for page gutters. When in doubt, add space rather than a divider.
- Radii are tight and precise: `radius-xs` 3 for tags · `radius-sm` 5 for controls and rows · `radius-md` 7 for cards and menus · `radius-lg` 10 for dialogs, composer and glass panels · `radius-full` for avatars, dots and the send button. Shape contrast (a tight card next to a round orange send button) is where the personality comes from.
- Controls are `control-h` (36px) with 16px side padding, or `control-h-sm` (30px) with 12px. They're marked by a `field` fill, not a border. The chat column caps at `prose-w`.

## Materials and depth

The screen is a space with light coming from above. Every element lives on one of three planes, and the plane decides its material and its shadow.

| Plane | Material | Used for | Tokens |
|---|---|---|---|
| **Ground** | Lit floor | the page itself | `canvas`, `aura` and `aura-cool` light pools blurred by `blur-aura`; `grid-dot` at 24px for open workspaces (dashboards, boards) |
| **Paper** | Opaque, matte | content: cards, chat column, tables, code | `surface`, `elev-1` at rest, `elev-2` when lifted. No border |
| **Glass** | Translucent, refractive | floating chrome over moving content: sidebar, composer, tab bar, toasts, menus, dialogs | `glass` or `glass-strong`, `backdrop-filter: blur(var(--blur-glass)) saturate(var(--glass-saturate))`, `glass-edge` 1px inset highlight on top, `glass-rim` outer rim, `elev-2`–`elev-4` |

**Liquid glass**
- Glass is for chrome, never for content. If people read it for more than a line, it's paper or `glass-strong`.
- Glass reacts. A soft specular highlight follows the pointer across it (a radial-gradient pseudo-element moved with `transform`). On press, glass squishes like liquid (`scale(1.02, 0.97)` on `spring-pop`).
- Glass bends light. In Chromium, an SVG `feDisplacementMap` in `backdrop-filter: url(#liquid)` refracts the backdrop at the edges. Elsewhere it falls back to blur plus saturate. Never rely on the refraction for meaning.
- Floating never hides the latest content. A glass element docked over a scroll area (the composer) gives that area a trailing spacer equal to what it covers plus `space-7`, measured live. People can always scroll the last turn clear of it, at any draft length. See Composer.
- Text on glass is `ink` on `glass-strong`, which holds 4.5:1 over any backdrop. On plain `glass`, use labels of 13px and up at weight 500, never meta text.

**Expressive**
- Orange is allowed to be big in rare moments: the aura on the empty chat, the round send button, the live state of a running agent. Everywhere else it stays a spark.
- Shapes move with intent. The selection pill stretches like a droplet between rows, the send button morphs from a circle to a pill while streaming (`transform`, not width), and checkmarks pop.
- Type contrast is strong: `display` 56 and `title` 32 at weight 600, tight tracking, beside 13–16px body.

**Spatial**
- Focus pushes the world back. When a dialog or sheet opens, the scene behind scales to 0.98 and dims under `scrim`, and the dialog arrives on `elev-4`.
- Paper lifts toward the pointer: hovered cards rise 2px to `elev-2` and tilt at most 3° toward the cursor (`perspective` + `rotateX/Y`).
- Workspaces sit on the `grid-dot` ground. Dashboards and boards may pan; rosters (agents, teams) never do, so no card is cropped out of view (see AgentCard).

## Type

Fonts: modern, elegant. High readability, while being easy on the eyes. Think Apple, Medium.

- **System sans** (`sans`: SF Pro on Apple devices, Instrument Sans elsewhere) for the interface. Titles get their weight from 600 and tight tracking, not from size: `display` (56) for the empty-chat greeting, `title` (32) for page titles, `name` (17) for agent names. Then `body` (14) for UI text, `ui` (13/500) for controls, `small` (12) for meta, and `label` (11, uppercase) for group heads.
- Agent replies stay in `sans` too, at the `prose` size (16/26): one family for the whole conversation, a step larger for reading. User messages use `body`-sized 15px.
- **0xProto Nerd Font Mono** (`mono`) for code, IDs, tool arguments, keys and terminal output (`code`). Its Nerd Font glyphs cover file-type and git icons in tool output.
- Use three weights: 400, 500 and 600. Nothing below 11px. Keep reading lines at 68ch or shorter.

## Content

- Use sentence case everywhere: "Scheduled jobs", "New session". The only uppercase is the `label` style.
- Address the user as "you" and name agents by first name: "Casey is working…", not "The agent is processing your request".
- Buttons are verbs, kept short: Chat, Send, Save, Delete chat. Avoid "Submit", "OK" and "Click here".
- Show time as relative meta in `small`: `23h · casey`. Use absolute dates only for group heads ("July 2026").
- Write empty states as one sentence plus one action: "No sessions yet." + Start a chat.
- No emoji in the UI.

## Using components

The components live in `apps/web/src/components/ui/`: Button, Field, Modal, ConfirmDialog, ProgressBar and Toast. This system adds patterns for the sidebar, agent cards, chat and composer. The class prefix is `yp-`.

- **Button:** one `primary` per view. Everything else is secondary or `ghost`. `danger` is for confirmed destructive acts only, inside a Modal.
- **AgentCard:** the whole card is the link. Don't stack several gray "Chat" pills under each portrait.

## Motion

Every animation should feel like a 120Hz screen: fluid, physical, never stuttering. That smoothness comes from how motion is built, not from how much of it there is. Motion is subtle and appears here and there, always as feedback on something that happened.

**The four rules of buttery motion**

1. **Animate only `transform` and `opacity`.** The browser hands these to the GPU compositor, which draws at the display's full refresh rate (120Hz on ProMotion) even while JavaScript is busy streaming a reply. Never animate `width`, `height`, `top`, `left`, `margin`, `padding` or `box-shadow`: each frame then needs layout or paint, and frames drop. To grow a bar, use `transform: scaleX()`. To move, use `translate`. To reveal, use `opacity` with a few pixels of `translate`. For a shadow, fade in a pseudo-element that already has it.
2. **Move on springs.** Things that move use `spring-smooth`, `spring-snappy` or `spring-pop`, each with its own `dur-spring-*`. They are real damped-spring curves sampled into CSS `linear()`, so they feel physical with no JS. Fades use `ease-out`, and exits use `ease-in` at `dur-quick`: things leave faster than they arrive.
3. **Stay interruptible.** State changes (hover, open, selected) use CSS `transition`, never `@keyframes`, so a reversed action picks up from where it is instead of jumping. Enter animations use `@starting-style`. Exits of `dialog` and `[popover]` use `transition-behavior: allow-discrete`. Moving an element between positions (the selection pill, a reordered list) uses FLIP: measure, invert with `transform`, then release with the Web Animations API.
4. **Small distances, short times.** Travel 4–8px, never across the screen. Scale between 0.96 and 1, never from 0. Nothing that blocks the user runs longer than `dur-spring-smooth`. Stagger lists by `dur-stagger` and cap at 8 items.

**Where motion lives**

| Moment | Motion |
|---|---|
| Button press | `scale(0.97)` at `dur-instant`, released on `spring-pop` |
| Hover | background at `dur-quick` `ease-out`, no movement |
| Nav or session selection | the `selected` pill slides to the new row (FLIP, `spring-snappy`) |
| Tab change | the orange underline slides and stretches (`translate` + `scaleX`, `spring-snappy`) |
| Menus, popovers | `opacity` 0→1 and `scale(0.96)`→1 from the trigger's corner, `spring-snappy` |
| Modal | the scene recedes (`scale(0.98)`) as the scrim fades at `dur-base`; the glass panel rises 8px and scales from 0.97 on `spring-smooth` |
| Glass press | squishes like liquid, `scale(1.02, 0.97)`, and springs back on `spring-pop` |
| Glass highlight | a specular spot follows the pointer (`translate` on a pseudo-element, `dur-base` lag) |
| Card hover | lifts 2px to `elev-2` (opacity crossfade of a pre-shadowed layer) and tilts ≤3° toward the pointer |
| Toast | slides up 12px from the bottom edge on `spring-snappy`, exits down at `dur-quick` |
| Streaming reply | each new chunk fades from 0 and 2px down at `dur-base`; the text never re-flows in an animation |
| Thinking | a soft light band sweeps across the label (`translateX` on a masked pseudo-element, 1.6s loop) |
| Live run dot | breathes with `scale` 1→0.7 and `opacity` 1→0.5, 1.6s `ease-in-out` loop |
| Send | the button pops (`spring-pop`); the sent message rises 6px into place |
| Progress, quota | the fill is `scaleX` from the left on `spring-smooth`, never `width` |
| Success | an SVG check draws itself (`stroke-dashoffset`, 16px icon only) on `spring-pop` |
| Lists, cards appearing | fade and rise 6px, staggered by `dur-stagger` |
| Route change | View Transitions API crossfade at `dur-base`; agent avatar morphs card → chat header with a shared `view-transition-name` |

**Do**
- Animate SVG through CSS on its elements (`transform`, `opacity`, `stroke-dashoffset`) or with WAAPI. Never use GIFs, Lottie or SMIL `<animate>`.
- Set `will-change: transform` only during a gesture or a long-running loop, then remove it.
- Test on a 120Hz display with DevTools → Rendering → Frame rendering stats: zero dropped frames.

**Don't**
- Don't animate on page load for decoration, or loop anything except the live dot and the thinking sweep.
- Don't animate layout properties, `filter: blur()` on large areas, or the blur radius of `backdrop-filter`. Glass may move by `transform`; keep it small.
- Don't bounce anything large. `spring-pop` is for elements under 48px.

**Reduced motion:** under `prefers-reduced-motion: reduce`, movement becomes an opacity fade at `dur-quick`, and loops stop.

## Iconography

- Use line icons at `icon` (16px) with a 1.5px stroke, in `currentColor`, inheriting `ink-muted`. Use Lucide.
- The app currently loads Font Awesome 6.5.2 (solid and brands). Its heavy fills fight the light, precise look, so replace it screen by screen. Keep brand glyphs (GitHub, Slack) from Font Awesome until Lucide covers them.
- An icon without a label needs an `aria-label` and a tooltip.

## Logo and imagery

- There is no logo mark. Set "Yoplai" in `sans` 600, tracked tight, in `ink`. Deployments override the icon via `/api/branding/icon`; the wordmark stays typeset.
- Agent portraits are the screen's color. Show them at 4:5 in `radius-md` inside `radius-lg` cards, and as 24px `radius-full` avatars in lists. Never tint, frame or overlay them.

## Accessibility

- Every text token's usage note names the grounds it holds 4.5:1 on, in both themes. `ink-faint` is the one exception: it fails on `selected`.
- Focus is a 2px solid `focus` ring with a 2px offset on every focusable element, at 3:1 or better on every surface. Never remove it.
- Control edges (`line-control`) are deliberately light and fall below 3:1 on their own. Controls stay identifiable through their `field` fill, label and focus ring.
- Under `prefers-reduced-transparency: reduce`, glass becomes `surface-raised` (opaque), and the aura and refraction turn off.
- Orange fills take black text (`on-accent`, 6.8:1). White on orange fails.
- Status never relies on color alone: every status carries a word or an icon.

## Taste rules (what to stop doing)

- Hardcoded `#dc2626`, `#3b82f6`, `#6366f1` and `#1a73e8` → use `danger`, and `accent` or `ink`.
- Blue "MAIN" text → a `Badge` in `accent-ink` on `accent-wash`.
- Purple subagent tint (`--subagent-*`) → a `line` rule plus an `ink-muted` label.
- Ten radii (4–18px) → the five radius tokens.
- Twelve font sizes (10–24px) → the type styles.
- Inter everywhere → system sans (SF Pro).
