# Accessibility review (phase 4.9)

- Status: Draft
- Last updated: 2026-11-24
- Drafted by: @akramcodez

The keyboard and assistive technology review of chat, files, review, terminal and browser: what is proved by an automated test, what only a person with a screen reader can prove, and what the review found. The rules are `A11Y-01` to `A11Y-06` in [`testing-strategy.md`](testing-strategy.md#accessibility-targets), with `CHAT-18`, `FILE-11` and `TERM-11` for the areas.

## What is proved, by area

Test paths start with `e2e/` unless they are under `source/`. The new sweep is `e2e/accessibility.e2e.ts`, with its logic and failing examples in `e2e/qa/accessibility.ts` and `accessibility.spec.ts`.

| Area | `A11Y-01` keyboard, no trap | `A11Y-02` focus order and return | `A11Y-03` name, role and state |
|---|---|---|---|
| Chat | The sweep tabs forward and back 40 times with no trap. `milestone-exit-checks.e2e.ts` runs the project, palette and approval journey by keyboard | No positive tab index anywhere (the sweep). Approvals take focus and return it (`milestone-exit-checks`, `subagents.e2e.ts`, `approval-requests.spec.ts`) | The sweep reads Chromium's accessibility tree and fails on any unnamed control. `milestone-exit-checks` checks states |
| Files | `files.e2e.ts` ("SP-07 FILE-11 the tree is fully operable from the keyboard with tree semantics"), the sweep | The sweep, `files.e2e.ts` | The sweep, tree roles and expanded state in `files.e2e.ts` |
| Review | The sweep; the diff keyboard and virtual-window models are unit tested (`diff-parse.spec.ts`, `diff-virtual.spec.ts`, `review-controller.spec.ts`). `files.e2e.ts` drives file-list arrows, Home/End and the capped last row | The sweep; virtual rows keep stable full-model positions and a selected offscreen row remains mounted | The sweep (filters, file entries and the comment form are named); the 5,000-row built-app test checks `aria-posinset`, `aria-setsize` and added/removed names |
| Terminal | "TERM-02/04/06/11 mounted terminal types, escapes, restarts, clears and stops without trapping focus" (`terminal.e2e.ts`). The sweep uses the documented key whenever focus enters the terminal | Focus returns to the "focus your terminal" button after the escape key | The sweep. The new `TERM-11` test checks the escape key is shown on screen and in `aria-keyshortcuts` |
| Browser | The sweep. The address bar, back, forward, reload and the profile picker are native controls | The sweep | The sweep (address, go, profile picker, the two settings checkboxes) |
| Dialogs | Escape closes each | Palette, shortcuts, projects and thread actions return focus to their opener (`accessibility.e2e.ts`, `cross-dialog-focus.e2e.ts`, `palette-focus-editing.e2e.ts`) | Each dialog is swept |

`A11Y-04` and `A11Y-05` (announcements, and streaming at a polite rate) are proved for chat by `stream-announcements.e2e.ts` and `stream-announcements.spec.ts`: a clock-injected live region, one persistent polite node, no focus move, failure and cancellation distinct. They are not proved for what a real screen reader says, which is the manual protocol below.

Each check was shown to fail when it should. The sweep has failing examples (an unnamed button and text field, a positive tab index, an empty area) and the live-page tests inject those violations and require them to be reported. A pass therefore means the areas were reached and inspected.

## What the review found

| Finding | Result |
|---|---|
| The chat composer, the form around the main input, was exposed as a landmark with no name. It is the most used control in the app | Fixed: it is named "composer", and not "message composer", because the text box is labelled "message" and a second label containing that word makes label lookups by "Message" ambiguous |
| The form for adding a browser profile had no name | Fixed: "new browser profile" |
| Everything else the sweep covers already had a name, a role and a working keyboard path, with no keyboard trap and no forced tab order | No change |

## What only a person can prove

- **`A11Y-04` and `A11Y-05` as heard.** The tests prove what is sent to the live region and when, not that VoiceOver, NVDA or Orca read it at a sensible pace.
- **`A11Y-06`.** The screen reader on each platform completing `SP-03`, `SP-04`, `SP-07` and `SP-08`, including reading a file or a diff past the first screen, since CodeMirror renders only the visible part. The protocol is in [`screen-reader-protocol.md`](screen-reader-protocol.md).
- **Linux virtualised review: automated Orca capture only, manual `SP-08` still unverified.** On 19 November 2026, Orca 48.1 with AT-SPI2 2.56.2 on Debian 13 x64 emitted the changed-file state, `removed line 6`, capped `added line 2490`, and the comment form. Native X11 input in sticky focus mode moved through the file list and diff, jumped beyond the first screen with End, added a single-line comment, preserved it through the narrow-workbench back-to-chat action, and sent it. The transcript contained `review comment: large.ts:2490-2490`. Speech Dispatcher used eSpeak NG and a null PulseAudio sink; speech audio and announcement logs were captured with fake fixtures. No human listening pass was performed, so this does not complete the manual protocol. Orca dropped some characters from the separate prompt body, but the short prompt and complete review attachment were sent.
- **Still unrun.** `SP-03`, `SP-04` and `SP-07` on Linux, and every protocol item with VoiceOver on macOS and NVDA on Windows. The Linux review result does not prove those paths or platforms.

## Not covered

- Colour contrast is covered by the contrast tests in `e2e/qa/ui-contrast.ts`, not this review.
- Zoom and reflow at large text sizes, and high contrast modes of the operating system, were not tested.
- The sweep reads Chromium's accessibility tree. Other platforms' accessibility APIs build on it, but a tree that is right in Chromium is not proof for each of them.
