# Workspace overlays

- Status: implemented for U.12 in issue #17
- Last updated: 2026-11-24

Visual design: see [`DESIGN.md`](../DESIGN.md).

## Behaviour

The renderer owns the command palette, keyboard shortcut sheet and notification
queue. They add no IPC channels or preload capabilities.

- `⌘K` on macOS, or `Ctrl+K` elsewhere, opens the palette. Query words filter
  labels and keywords, with exact labels before prefixes, label words and
  keywords. Equal matches keep their original order.
- With an empty query, the palette lists only existing actions. Unavailable
  actions remain visible with their reason and cannot run. Arrow keys include
  unavailable rows so their reasons can be read. Enter runs the selected
  available action.
- With a non-empty query, the renderer also searches the current project's
  thread titles by case-insensitive substring. Results are grouped as active
  threads, archived threads and matching actions, in that order. The selected
  thread is marked as current; opening it changes selection only and does not
  rename, archive or create anything. A single flattened result order drives
  arrow-key movement, pointer highlighting and Enter, including across group
  boundaries. Archived results appear only for a non-empty matching query.
  The highlighted result follows its identity through live title, order and
  archive changes; if it disappears, selection returns to the first result.
  Greek final and medial sigma are equivalent when matching titles.
- Opening an active thread closes the palette and focuses the editable composer
  after selection settles. Opening an archived thread keeps it archived and
  focuses the conversation region instead. Escape still closes the palette and
  returns focus to its opener. Thread metadata actions keep their own command
  keywords and do not inherit the selected title.
  Focus waits for the open request to settle, yields to pending approvals and
  is cancelled by subsequent keyboard or pointer navigation. At narrow widths,
  selecting a thread closes the workbench so the conversation is visible.
  If opening a thread needs the running-turn notice, it replaces the palette
  inside the same native modal rather than closing and reopening it.
  With long project lists, selection scrolls into view while the search input
  and close control stay above the scrolling results.
- `?` opens the shortcut sheet outside text fields. Typing `?` in a message,
  command search or editable field does not open it.
- Keys used during IME composition, including composing Escape and legacy
  key-code 229, do not close an overlay or execute a command.
- Native modal dialogs keep the background inert. Escape closes from every
  control, including an empty search. The close button and backdrop also close.
  Focus returns to the original control, or the palette button if that control
  was removed or disabled (`A11Y-01`, `A11Y-03`). Return waits for the native
  close event and respects focus already recovered by a pending approval.
  Editable fields release premature native focus until that event; their
  draft, caret selection and slash suggestions are preserved.
- Theme actions save through the existing settings method before changing the
  renderer. Success is announced only after the setting is saved.
- Notifications never take focus. A persistent polite, atomic live region
  announces one queued notification at a time. Each has 2400ms to read before
  its 180ms exit. An injected clock tests time without sleeps. Reduced motion
  disables the transition.
- Notification regions remain mounted outside and inside the native dialog.
  Only the non-inert layer is active. While an overlay is open, its region
  announces the waiting approval count without request content, and focus
  stays in the overlay. Closing it lets the pending approval recover focus.
  Browser tests prove region identity before and after the text change;
  VoiceOver delivery remains part of the manual accessibility checklist.
- Theme-save failures use that same active polite region, without a separate
  alert in the inert background. Deferred-save tests cover a closed overlay
  and either reopened modal, with one message, the original region and no
  focus change.

The action set adds a project folder, opens a recent project, locates a moved
project, opens the existing technical-session folder flow, switches to dark or
light theme, and opens the keyboard shortcut sheet. Project commands use
`useProjects` callbacks (`CHAT-01`, `CHAT-02`). Missing or replaced folders keep
their open command visible with a locate-first reason. A pending project request
disables every project command. Canonical roots distinguish projects with the
same name and are searchable, without passing any new paths to main.

## Verification

`source/renderer/overlay-model.spec.ts` covers matching, ranking, grouped
thread results, empty projects, one flattened keyboard-selection order,
disabled refusal, focus return and notification timing.
`e2e/overlays.e2e.ts` covers built-app keyboard actions, settings persistence,
native picker cancellation, unavailable-runtime refusal, all three widths in
both themes, reduced motion and notification focus/live-region behaviour.
`e2e/palette-threads.e2e.ts` covers current-project title search, active and
archived groups, pointer/arrow selection, Enter, Escape, composer or
conversation focus, empty-query action behaviour and command keywords.
The same suite covers the modal running-turn notice, approval shortcut ownership,
delayed-open focus cancellation, live selection identity, unavailable-result
semantics, labelled groups and long unbroken titles in both themes.

This supports the overlay portions of `A11Y-01` and `A11Y-03`; it does not claim
screen-reader acceptance or completion of whole-app accessibility requirements.

## Approved overlay presentation (DEC-40)

The 520px elevated shell is vertically centred within 40px viewport margins, with 15px corners and an 80% surface scrim. Palette rows keep one active pointer/keyboard selection. Empty results collapse the combobox popup semantics and expose the no-results status. The shortcut sheet names implemented bindings only, including multiline input and request-scoped offered approval options. Quiet notifications sit near the lower centre of the conversation and retain the persistent non-focusing polite regions and clock-driven timing. Renderer rename uses the same shell; all destructive/trust/history/diagnostics confirmations remain native and main-owned.
