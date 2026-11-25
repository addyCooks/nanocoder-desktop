---
version: alpha
name: Nanocoder Desktop
description: Dense, monospace, terminal-native workspace around Nanocoder. Neutral-black chassis, hairline strokes, one blue accent, dark first.
colors:
  primary: "#7aa2f7"
  primary-soft: "#202a3b"
  surface: "#161616"
  surface-panel: "#1d1d1d"
  surface-elevated: "#262626"
  on-surface: "#e6e6e6"
  on-surface-muted: "#a8a8a8"
  stroke: "#e6e6e626"
  stroke-soft: "#e6e6e614"
  success: "#9ece6a"
  error: "#f7768e"
  warning: "#e0af68"
  skill: "#e0af68"
  mention: "#7aa2f7"
  heading: "#7aa2f7"
  diff-add: "#202020"
  diff-del: "#242424"
  primary-light: "#0000ee"
  primary-soft-light: "#e6e9fd"
  surface-light: "#ffffff"
  surface-panel-light: "#fafafa"
  surface-elevated-light: "#f0f0f0"
  on-surface-light: "#0a0a0a"
  on-surface-muted-light: "#525252"
  stroke-light: "#0a0a0a1f"
  stroke-soft-light: "#0a0a0a0f"
  success-light: "#28633d"
  error-light: "#a1284c"
  warning-light: "#76510b"
  skill-light: "#76510b"
  mention-light: "#185b7b"
  heading-light: "#0000ee"
  diff-add-light: "#dfede3"
  diff-del-light: "#f4e0e7"
  logo-tile: "#ffffff"
  logo-tile-light: "#ffffff"
typography:
  body-md:
    fontFamily: Fira Code
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.8
  body-sm:
    fontFamily: Fira Code
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.8
  tab:
    fontFamily: Fira Code
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.8
  code-sm:
    fontFamily: Fira Code
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
  meta:
    fontFamily: Fira Code
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
  caption:
    fontFamily: Fira Code
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
  label-section:
    fontFamily: Fira Code
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0.12em
  label-inline:
    fontFamily: Fira Code
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0.1em
rounded:
  none: 0px
  sm: 4px
  md: 6px
  lg: 8px
  xl: 10px
  full: 9999px
spacing:
  xxs: 2px
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  xxl: 18px
  rail-width: 260px
  inspector-width: 480px
  bottom-panel-height: 360px
  stream-padding: 40px
  width-wide: 1240px
  width-mid: 1020px
  width-narrow: 840px
components:
  window:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
  title-bar:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.tab}"
  session-tab:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.tab}"
    rounded: "{rounded.md}"
  session-tab-active:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.on-surface}"
  status-badge:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
  status-badge-running:
    textColor: "{colors.primary}"
  status-badge-approval:
    textColor: "{colors.warning}"
  status-badge-failed:
    textColor: "{colors.error}"
  project-rail:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.on-surface-muted}"
    width: "{spacing.rail-width}"
  rail-heading:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.label-section}"
  rail-item-active:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.on-surface}"
  message-user:
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
  message-agent:
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
  message-author:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.label-inline}"
  reasoning:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
  tool-row:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
  subagent-card:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
  approval-card:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
  approval-card-title:
    textColor: "{colors.on-surface}"
    typography: "{typography.label-inline}"
  failure-banner:
    textColor: "{colors.error}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
  view-only-notice:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
  composer:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.xl}"
    padding: 10px
  composer-pill:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
  composer-pill-mode:
    textColor: "{colors.primary}"
  context-gauge:
    backgroundColor: "{colors.primary}"
    height: 2px
  button:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.on-surface}"
    typography: "{typography.meta}"
    rounded: "{rounded.md}"
  button-allow:
    textColor: "{colors.on-surface}"
  button-reject:
    textColor: "{colors.on-surface}"
  inspector:
    backgroundColor: "{colors.surface-panel}"
    width: "{spacing.inspector-width}"
  inspector-tab:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.label-inline}"
    rounded: "{rounded.md}"
  inspector-tab-active:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.on-surface}"
  touched-chip:
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
  diff:
    typography: "{typography.code-sm}"
    rounded: "{rounded.lg}"
  diff-line-add:
    backgroundColor: "{colors.diff-add}"
    textColor: "{colors.success}"
  diff-line-del:
    backgroundColor: "{colors.diff-del}"
    textColor: "{colors.error}"
  diff-hunk:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.mention}"
  bottom-panel:
    backgroundColor: "{colors.surface-elevated}"
    height: "{spacing.bottom-panel-height}"
  terminal:
    textColor: "{colors.on-surface}"
    typography: "{typography.body-sm}"
  browser-address:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
  browser-viewport:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  command-palette:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.xl}"
    width: 520px
  palette-row-selected:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.on-surface}"
  toast:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.on-surface}"
    typography: "{typography.tab}"
    rounded: "{rounded.lg}"
  divider:
    backgroundColor: "{colors.stroke}"
    height: 1px
  divider-soft:
    backgroundColor: "{colors.stroke-soft}"
    height: 1px
  skill-name:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.skill}"
  markdown-heading:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.heading}"
  window-light:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.on-surface-light}"
  panel-light:
    backgroundColor: "{colors.surface-panel-light}"
    textColor: "{colors.on-surface-muted-light}"
  elevated-light:
    backgroundColor: "{colors.surface-elevated-light}"
    textColor: "{colors.on-surface-muted-light}"
  divider-light:
    backgroundColor: "{colors.stroke-light}"
    height: 1px
  divider-soft-light:
    backgroundColor: "{colors.stroke-soft-light}"
    height: 1px
  rail-item-active-light:
    backgroundColor: "{colors.primary-soft-light}"
    textColor: "{colors.on-surface-light}"
  composer-pill-mode-light:
    backgroundColor: "{colors.surface-panel-light}"
    textColor: "{colors.primary-light}"
  status-badge-running-light:
    backgroundColor: "{colors.surface-panel-light}"
    textColor: "{colors.primary-light}"
  status-badge-failed-light:
    backgroundColor: "{colors.surface-panel-light}"
    textColor: "{colors.error-light}"
  approval-card-title-light:
    backgroundColor: "{colors.surface-elevated-light}"
    textColor: "{colors.on-surface-light}"
  skill-name-light:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.skill-light}"
  mention-light:
    backgroundColor: "{colors.surface-panel-light}"
    textColor: "{colors.mention-light}"
  markdown-heading-light:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.heading-light}"
  diff-line-add-light:
    backgroundColor: "{colors.diff-add-light}"
    textColor: "{colors.success-light}"
  diff-line-del-light:
    backgroundColor: "{colors.diff-del-light}"
    textColor: "{colors.error-light}"
---

# Nanocoder Desktop design

How Nanocoder Desktop looks. Behaviour, authority and accessibility requirements remain in [`planning/`](planning/index.md).

- Status: Approved by the user as designer, 31 October 2026 (`DEC-40`). Where the approved mockup and this file disagreed, the mockup won and this file was updated (`DEC-41`).
- Last updated: 2026-11-24
- Source: [UI exploration][mockup], revision 4, main direction only. Alternatives and anything labelled new idea or later are not implementation scope.
- Format: [DESIGN.md alpha][spec]. Front-matter tokens are normative; generated CSS is never edited by hand.

## Overview

One quiet project workspace, with the conversation at its centre. The official coloured Nano Collective logo is bundled locally, unchanged. Fira Code is the only UI typeface; the logo is artwork, not a recreated wordmark.

Navigation is compact, reading is comfortable, and secondary work surfaces open only when useful. Nanocoder owns messages, tools, modes and approval options. The desktop never invents activity, context use or capabilities to fill a design.

## Colors

Dark surfaces, ink and strokes are neutral black and grey, with equal RGB channels. The light palette is white with near-black ink and neutral greys. Blue is the single interactive accent, not a decorative second status colour.

| Role | Dark | Light | Used for |
|---|---|---|---|
| `surface` | `#161616` | `#ffffff` | Window and conversation. |
| `surface-panel` | `#1d1d1d` | `#fafafa` | Sidebar, composer, cards and workbench. |
| `surface-elevated` | `#262626` | `#f0f0f0` | Dialogs, menus and raised controls. |
| `on-surface` | `#e6e6e6` | `#0a0a0a` | Primary text. |
| `on-surface-muted` | `#a8a8a8` | `#525252` | Secondary text and labels. |
| `stroke` / `stroke-soft` | `#e6e6e626` / `#e6e6e614` | `#0a0a0a1f` / `#0a0a0a0f` | Hairline edges and row dividers. |
| `primary` | `#7aa2f7` | `#0000ee` | Selection, focus, mode, links, ready send and the running dot. |
| `primary-soft` | `#202a3b` | `#e6e9fd` | Selected rows. |
| `success` | `#9ece6a` | `#28633d` | Reported success, ready markers and allow borders. |
| `error` | `#f7768e` | `#a1284c` | Failure, stop and reject borders. |
| `warning` | `#e0af68` | `#76510b` | Approval markers and borders. |
| `skill` | `#e0af68` | `#76510b` | Skill labels. |
| `mention` | `#7aa2f7` | `#185b7b` | Reported resource references. Dark links use the same blue accent. |
| `heading` | `#7aa2f7` | `#0000ee` | Heading accent, sparingly. |
| `diff-add` / `diff-del` | `#202020` / `#242424` | `#dfede3` / `#f4e0e7` | Later read-only review surfaces. |

Every state has a glyph and word. Success, warning and error are reserved for results, not decoration. Selected text uses primary ink; muted text is never faded through opacity. Allow and reject actions keep their semantic colour on the border and marker, while their label uses on-surface ink, which passes contrast on every panel.

### Known contrast gaps

| Pairing | Theme | Ratio |
|---|---|---|
| None in the approved pairing inventory | both | All at least 4.5:1 |

The twelve previous exceptions are retired. Tests check semantic colours on window, panel and elevated backgrounds, selected text, reading text and rendered controls. The 55% key-hint style is retired: key hints use muted ink at full opacity. Disabled controls keep readable ink and explain the refusal locally. Future rendered pairings must pass AA, rather than inheriting an exception from the old palette.

## Typography

Only locally bundled Fira Code 400, with Consolas, Menlo and monospace fallbacks. Hierarchy comes from size, spacing and colour, never bold. Code disables ligatures.

| Token | Size and line height | Used for |
|---|---|---|
| `body-md` | 15px / 1.8 | Agent/user reading text and composer input. |
| `body-sm` | 13px / 1.8 | Tool detail, reasoning, cards and notices. |
| `tab` | 13px / 1.8 | Chrome, menu rows and toasts. |
| `code-sm` | 13px / 1.6 | Reported code and tool output. |
| `meta` | 12px / 1.6 | Actions and supporting copy. |
| `caption` | 12px / 1.6 | Sidebar rows, badges and composer controls. |
| `label-section` | 11px / 1.6 | Compact sidebar group labels. |
| `label-inline` | 12px / 1.6 | Authors and small section labels. |

Chat headings may step up to 18px. The centred first action uses a 29px heading. Product copy is lowercase except Nanocoder, paths, commands and model names, which retain their real spelling. Use a middle dot to separate facts. British spelling applies.

## Layout

A compact full-height sidebar beside the conversation canvas. The title bar belongs to the canvas, not above the sidebar. No static session tabs, empty inspector or unfinished-feature placeholders.

- Sidebar: official logo, compact project switcher, new-thread action, then today/earlier threads in last-activity order. Archived threads stay separate. One glyph, compact age and selected-thread state copy, without attention reordering. The project switcher and new-thread action open their dialogs (see Overlays and dialogs).
- Header: project/thread identity, the turn state, command palette and purposeful available actions. The ACP state sits in the sidebar footer.
- Conversation: constrained to 740px, centred in spare space. Transcript scrolls independently. The approval shelf sits above the composer within that same column, not in scrollback.
- Empty workspace: a centred useful first action, choose a folder. After opening a new thread, centre the draft composer until there is conversation content. Never invent prompt starters.
- Workbench: an optional right slot for later files/review/browser tools. It is absent when unused. At 840px and below an open workbench owns the conversation canvas and has an explicit back-to-chat action, while project navigation remains reachable.
- Bottom area: optional terminal slot, absent when unused. No Milestone 2 or 3 controls ship as part of this overhaul.

Reference sidebar widths are 260px wide, 232px at 1050 and 212px at 840. The sidebar, the right workbench and the bottom terminal can each be resized by dragging their inner edge or with the arrow keys on that edge (a labelled separator); double-click or Enter restores the default, and the chosen sizes are kept on this device only. The sidebar stays between 180px and 420px, the workbench opens at 42% of the space beside the sidebar (720px at most) and leaves at least 420px for the conversation, and the bottom panel stays between 160px and three quarters of the window. A saved size outside these limits is brought back inside them. Reading-region horizontal padding is 40px, 30px and 24px. Do not squeeze three reading surfaces together at narrow widths. The window cannot be made narrower than 640px, because below about 560px the header actions leave it. A long project name is cut with an ellipsis in the header.

Browser placement in the right workbench is the approved visual direction only. Browser capabilities and any upstream whitepaper placement change remain with Milestone 3; this change builds no browser.

## Elevation & Depth

Flat tonal surfaces and hairlines. Cards use panel; dialogs use elevated. Only overlays cast shadows. Dialog scrims use the window surface at 80%. Avoid colour transitions on theme changes so text and its background change together.

## Shapes

Small control radii, comfortable message and composer radii. User messages have a panel fill, a 12px rounded shape and a small lower-right corner, inset from the left. The selected thread uses a primary-soft fill with no side rule; other rows show an elevated fill on hover. View-only notices have dashed borders. Overlay corners are 15px.

## Components

### Sidebar and header

Project switcher shows the selected project and a compact root label. Activating it opens the projects dialog: recent roots with the selected one marked, locate for a missing folder, and add project folder. No persistent visible-project list. Thread actions remain scoped to the project and explain busy refusals. Full titles and roots remain accessible even when visually truncated.

The header shows actual thread identity, not pretend tabs. The turn state is one dot and word: running uses the primary blue dot, approval required uses the warning dot, and ready uses a neutral dot. ACP readiness comes only from supervisor state, independently from turn state. It sits in the sidebar footer, and its ready marker is success green. Version/runtime details are secondary, not the first-launch content.

### Conversation

User messages are inset panel bubbles. Agent text is unboxed with a quiet author label. Finished reasoning is folded but inspectable. Routine completed tool calls keep their ordered summary and fold details. Running reasoning stays visible; failed tools stay open with their reported result. Do not invent elapsed time, depth or usage.

Message times are live only. A user message shows the moment it was sent, and an agent message shows the moment its first reply chunk arrived, both held in memory for the open session. Replayed history and restarted sessions show no time, because Nanocoder does not report one and the desktop never saves message times. The day label takes its time from the first timed item. Untimed history shows no time, with the title "times are not saved in Nanocoder history".

Subagents use flat panel cards with reported task/state and truthful unknown values. The only stop action stops the whole owning turn, with its refusal and busy states unchanged. No child transcript tree or per-child cancellation.

### Approval shelf

A warning-bordered panel immediately above the composer. Its title, "approval required", uses on-surface ink beside the warning marker. Show the full offered action, source and effect, with only Nanocoder's own choices and request-scoped shortcuts. Allow and reject buttons use on-surface labels, with success and error borders. Keep request focus, assertive announcement and fallback focus return. Failures remain visible.

A question offers only provided choices, no invented free-text reply. The desktop recognises a question from the exact shape Nanocoder uses for `ask_user`: the same tool call announced this turn, matching question and option names, and `answer-N` option ids. It shows that question in the question dialog, titled "Nanocoder needs a choice", with each offered option as a numbered button. Closing that dialog does not answer it. The question collapses to the approval shelf above the composer and stays pending until the user chooses an offered option there or the turn is cancelled. A request that does not match that shape keeps the approval shelf.

### Composer

Panel fill, 15px reading input, 13px corners, blue focus border. That border is the only focus mark while typing: the input draws no inner ring. Send is a round button with an arrow icon, filled primary when ready. Compact model/mode controls below the input, with send aligned right. Model, mode and browser profile choices use one custom dropdown: a combobox button with a listbox that opens above the composer, keyboard-driven (arrows, Home, End, Enter, Space, Escape), with the active option on a primary-soft fill and the selected one in primary ink. Model applies to the whole project; mode changes only between turns; yolo needs native consent and is never restored or a default. State refusals appear beside the locked control. Drafts remain editable and unqueued where allowed.

Only reported context use can produce the context pill/gauge. No token estimate or context figure is fabricated. Helper text uses readable muted ink. Disabled input is not faded to unreadable opacity.

### First launch and recovery

The welcome screen shows the official logo as a square tile with 3px corners on its own white ground, with no frame, shadow or caption on the tile. The first action is choose a project, not runtime paths. Recents show exact project identity and missing-folder locate. Trust stays native and cancel-default, with the bounded launch summary. Saved-session import remains explicit metadata only, with no selection, resume or draft side effect.

Failure keeps draft and thread identity, with retry and reviewed diagnostics. View-only shows metadata and why history is missing, with new-thread/remove actions and no composer or invented transcript. Diagnostics uses the exact main-captured redacted snapshot, a native destination and no upload.

### Overlays and dialogs

One shared elevated shell with readable target and consequence. Trap keyboard focus; Escape/dismiss returns to the original opener even when another dialog replaces it. Rename supports Enter and Escape. Native trust, yolo, history deletion and diagnostics review retain their existing safe defaults and main-process authority.

Renderer dialogs, all in the shared shell:

- New thread: "new thread in" the project, with a draft field and the note that the session is created on the first send. Cancel and "keep as new thread draft" close it. An empty thread then centres the draft composer.
- Projects: "your projects", with recent roots, the selected one marked, locate for a missing folder, and "add project folder". It opens from the project switcher.
- Archive: "archive this thread?", with the thread title and root. It says the desktop row moves to archived threads, can be unarchived, and does not change Nanocoder history. Cancel holds initial focus, and Escape cancels.
- Remove from desktop: "remove this thread from desktop?", with the thread title and root. It says only desktop metadata is removed and Nanocoder's chat history stays where it is. Cancel holds initial focus, and Escape cancels.
- Question: described under Approval shelf.

Archive and remove return focus to the opener when they close. Delete chat history keeps its separate native confirmation and its existing safe default.

Palette: 520px, one search, one pointer/keyboard active result, scrolling list and explicit no-results state. Empty results do not expose a misleading expanded listbox. Shortcuts use the same shell. Toasts are quiet local feedback, never focus-taking, and sit near the lower centre of the conversation.

### Later slots

Files/review/browser and the user terminal are not implemented by the overhaul. Preserve their layout seams without empty placeholders. Later diff text uses primary ink on add/delete fills, with semantic markers. The user's terminal must remain distinct from agent tool output.

## Iconography

Words first. Where an icon earns its place (send, new thread, archived, import, runtime details, shortcuts, dialog close, browser back, forward and reload, file tree chevrons), it is a Lucide line icon at 1.75 stroke, bundled locally as inline SVG, in current text colour, never an icon font, and always beside a word or behind an accessible name. Decorative text glyphs are retired; coloured state dots stay. Header actions (files, browser, terminal) are plain muted words with an elevated fill on hover and while their panel is open. Focus is one 2px primary ring, 1px from the control, shown for keyboard focus only; a control never draws a second ring inside a focused container. Disabled controls keep a solid border. The untouched official coloured logo is the only image in the M1 chrome, served locally under the existing CSP.

## Motion

Only live activity moves: spinner 1.1s, cursor 1s, approval pulse 2.2s. Reduced motion stops them. Theme changes are instant. Toasts never take focus.

## Do's and Don'ts

- Keep one blue interactive accent, neutral dark surfaces and semantic result colours.
- Keep reading text larger than navigation.
- Keep the outstanding decision and composer together.
- Fold routine finished detail, never failures.
- Explain unavailable actions without inventing capabilities.
- Never load fonts, images or styles remotely.
- Never build alternatives, new ideas, or later features as part of M1.

## Open design questions

Forced colours and native screen-reader acceptance still require platform QA. The designer-approved palette, logo and main layout are settled for this implementation. No claim of native-dialog capture or full production accessibility certification follows from static mockup evidence.

## Sources

- [UI exploration][mockup], revision 4, approved by the user as designer on 31 October 2026.
- [Brand guidelines][brand]. The coloured logo is the original Nano Collective GitHub avatar, bundled unchanged.
- [`planning/decisions.md`](planning/decisions.md), `DEC-36`, `DEC-40` and `DEC-41`.

[mockup]: https://bubbles.adityalogs.xyz/o/nanocoder-desktop-ui-explore/
[spec]: https://github.com/google-labs-code/design.md/blob/main/docs/spec.md
[brand]: https://docs.nanocollective.org/collective/organisation/brand
