# Terminal implementation

- Status: Draft
- Last updated: 2026-11-03

## Part A: host and bridge

Phases 3.1 and 3.2 provide a main-owned terminal service and typed
`window.desktop.terminal` bridge. Part B composes its user-facing bottom
dock. No terminal capability is advertised to Nanocoder (`TERM-08`).

- `node-pty` runs only in an Electron utility process. Its native failure
  cannot crash main. Main retains ownership of the shell PID and teardown.
- An explicit terminal start requires the active, trusted stored project,
  its unchanged canonical root and an available shell outside every
  stored project root (`TERM-01`, `SEC-03`, `SEC-05`, `SEC-17`).
- Project opening waits for the previous terminal to stop. Renderer
  detachment and orderly app quit also stop it. A stale pending start
  cannot publish or remain alive after a switch.
- Input is bounded to 65,536 UTF-16 code units per request, with malformed
  surrogate pairs refused. Dimensions are integers from 2 to 500. Input
  and resize return no snapshot, so a keystroke never copies the
  scrollback over IPC; output reaches the renderer through terminal
  events, and a resize to the current size changes nothing.
- Scrollback retains at most 10,000 lines and 1,048,576 UTF-16 code units,
  with a truncation flag. Clear and stop discard it. Output uses
  acknowledgement-gated 16 ms utility-process batches, capped at 64 KiB
  of code units. Neither output nor input enters desktop storage or logs.
- POSIX ownership records PID, start time and PTY before publishing ready.
  Main refreshes captured identities before output and every 250 ms.
  Newly discovered jobs need an identity-verified owned parent chain and
  the original PTY. A tty name or numeric PID alone grants no authority.
  Captured matching identities survive reparenting or hangup clearing
  their tty, but cannot widen ownership to another real tty.
  Stop freezes owned parents, then repeats indexed discovery and freezing
  until membership is stable and frozen. Only then does it force termination.
  Every STOP, KILL and failure CONT receives a fresh PID/start-time/tty
  probe. KILL also requires a still-frozen target. No group broadcasts or
  preliminary HUP can erase parent ancestry before late jobs are captured.
  Indexing and traversal are linear, yield every 64 entries and enforce
  a monotonic two-second deadline within the work. Live survivors and
  unreadable/partial snapshots fail closed. Failure only attempts fresh
  identity-checked CONT for processes this stop froze, with a separate
  two-second cleanup bound. It never kills an unfrozen parent on failure.
  Zombie identities are non-live, not signal targets.
  The native worker reaps the matching shell before main kills the worker.
  Shell reaping and utility exit each have a one-second bound.
  Jobs detaching or reparenting before any ownership snapshot remain a
  limitation and are not adopted through reused tty names. Portable `ps`
  start times are not atomic kernel process handles. Timestamp granularity
  and the final probe/signal race remain platform limitations.
  Windows uses the absolute system `taskkill.exe` with `/T /F`. System
  utilities never use a shell or project executable. The native module and
  spawn helper are unpacked from asar and rebuilt from source for Electron's ABI.

## Part B: terminal dock and access

The optional dock uses `@xterm/xterm` with locally bundled Fira Code and
generated theme tokens. Code ligatures and cursor blinking are off.
Opening or hiding the panel does not start or stop a shell. Start,
restart, clear and stop are explicit actions. Hiding a running terminal
keeps it running until stopped, the project changes, the renderer detaches,
or the app quits. After renderer detachment, reopen the project before
using its terminal again.

The renderer holds bounded, project-scoped display data and uses only the
typed bridge. Late responses and out-of-order events cannot restore old
project output or undo a clear. Data after stopped or exited is refused.
xterm writes are serialised across reset so queued old output cannot
reappear after clear or stop. Reset cycles the supported screen-reader
option to dispose stale announcement queues and live-region text while
restoring the mounted preference. Links, including OSC 8
links, remain inert until phase 3.6. No remote resources or CSP changes
are needed.

xterm writes its colour, cursor, selection and scrollbar rules into three
`<style>` elements inside the terminal, which the strict `style-src 'self'`
policy refuses to apply (`TERM-13`). Without help, ANSI colours render in the
default colour. The renderer mirrors each of those elements into an adopted
constructable sheet, which the policy allows, and removes the sheets on
teardown. The mirror looks again only when a change involves a style element,
skips re-parsing a sheet whose text is unchanged, and reassigns the document's
sheet list only when the set changes, so ordinary output writes neither re-parse
CSS nor restyle the document.
The policy is unchanged. The browser still logs a blocked inline style message
each time xterm writes one of those elements, which is more than once per
element: about a dozen when the terminal opens, more when the shell starts, the
theme or window size changes or the terminal is cleared, and none for ordinary
output. They are expected and not a sign of a fault. Without the mirror the
cursor is not shown at all. The end-to-end test checks that ANSI red, the green
background and the cursor use their design tokens in both themes, that no
`<style>` element lives outside the terminal, and that the selection and
scrollbar rules are among the mirrored sheets.

`TERM-11` specifics are bounded local choices, not an upstream status change:

- `ctrl+shift+tab` leaves terminal input and returns focus to the terminal
  header control. Normal Tab, Escape and shell control keys remain terminal
  input. The key is shown beside the output and on the input's accessible
  description and keyboard-shortcut metadata.
- The header control explicitly returns focus to input. Closing the panel
  returns focus to its opener. Start/restart return focus only when the
  user has not moved elsewhere while the request completes.
- A visible toggle enables xterm's supported screen-reader mode and
  accessible output tree. This preference lasts only for the mounted
  panel. It changes display and announcements, never permissions or PTY
  ownership.
- xterm 6 intentionally ignores `insertText`-only input events in
  screen-reader mode. Tests use real key events in that mode, and retain
  an `insertText` path with the mode off. Dictation, IME and assistive
  input in screen-reader mode have not been checked with real assistive
  technology. VoiceOver, NVDA and native-focus QA remain manual gaps.

The terminal panel no longer shows an agent strip. Main still keeps the
bounded last-command projection (`TERM-12`), and Nanocoder's commands and
approvals appear in the chat, never as input into the user's terminal.

## Bounded local details, not upstream policy changes

`TERM-10` remains Suggestion (not discussed). The local implementation uses
the account shell, then absolute `SHELL`, then fixed platform fallbacks.
Known POSIX shells receive `-l`. Windows uses absolute ComSpec or fixed
PowerShell locations with fixed argument arrays. No PATH lookup occurs.
Loader injection and inherited Nanocoder trust variables are removed.

`TERM-12` remains Proposed (awaiting @will-lamerton). Its display-only
metadata observes already mapped main-process tool and permission events.
Only explicit `execute_bash: ...` labels populate it. Accepted answers are
matched to the same thread's main-owned offered option, after the existing
permission service accepts that answer. A closed request without a known
accepted answer reports unknown, never approved. The projection ignores
replay, caps commands at 4,096 code units and cannot read, write or execute
in the user's terminal. Missing upstream command data leaves it empty.

`TERM-05` URL handling lives in the renderer, not this host: phase 3.6 finds localhost addresses in the output and opens them in the browser (see [`features/browser.md`](features/browser.md)). The host never sees or acts on an address.

## Verification and limits

AVA fake-host tests cover lifecycle, stale event refusal, canonical roots,
trust, sender frames, strict IPC schemas, input bounds, shell exclusion,
environment filtering and memory limits. Hidden built-main macOS tests
start real nested Node servers which ignore HUP and TERM. They prove
stop, project switch, quit and a killed utility process leave neither
parent nor child alive. Main survives the utility crash and permits
explicit restart. A restarted terminal accepts UTF-8 text.

Part A local macOS arm64 checks on 2026-10-31:

- `pnpm test:all`: format, types, lint, AVA, Knip and audit pass.
- `pnpm test:ava:coverage`: 96.50% aggregate configured lines, above 80%.
  This is plain-Node unit coverage, not native-worker branch coverage.
- `pnpm package:dir`: source rebuild and unsigned packaging pass.
- `pnpm exec playwright test e2e/terminal.e2e.ts`: seven hidden tests pass.
  The packaged-worker test loads the actual asar worker and unpacked native
  addon/spawn helper inside a hidden test app's utility process. It does
  not launch a visible packaged app or claim signing acceptance.

Part B adds renderer controller/refusal and inert-display tests, a hidden
real-PTY UI lifecycle/focus test, accessible-tree checks, and both themes
at 1240, 1020 and 840. Fake-fixture screenshots are generated in
`.qa/terminal-ui/terminal-{dark,light}-{1240,1020,840}.png`, with rendered
text contrast and editable, unobscured composer checks.

A small-window regression keeps the original pointer-start action with
no selected conversation. At 800 by 568, the non-shrinking composer footer
previously covered the dock toolbar. The footer now shrinks and scrolls
inside the clipped conversation canvas. The test checks the start button's
centre hit target and footer/dock bounds before clicking. Approval shelf
edge-containment checks also remain required.

Initial Part B macOS arm64 checks, before supplemental remediation:

- `pnpm test:all`: format, types, lint, 1,394 AVA tests, Knip and audit pass.
- `pnpm test:ava:coverage`: 96.85% aggregate configured line coverage.
- `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package:dir`: native source
  rebuild and unsigned packaging pass. Signing is not tested.
- The standalone hidden terminal suite passes eight tests, including the
  original pointer, keyboard, clear/restart and stop assertions.
- The loaded combined terminal/approvals/shell/projects/supervisor run
  passes 45 of 46. All 16 approval tests, all six screenshot cases,
  composer bounds/editability, rendered contrast and native server-tree
  stop/switch/quit/crash checks pass. The UI stop case remains open below.
- Fake screenshots use a temporary shell HOME and fixture prompt, not
  the user's shell startup files. Native-focus and assistive-technology
  acceptance are not claimed.

### Supplemental teardown and output remediation

The supplemental security review found retained-PID reuse, a late-job
discovery race and superlinear main-process work. The identity-checked
freeze/discovery implementation above replaces that teardown. Deterministic
regressions cover all three without signalling unrelated real processes.
Large synthetic 500/4000 and 1200/6000 process tables finish within the
two-second bound and yield cooperatively. No guardian or new IPC was added.

The separate stale renderer finding is covered by queued-write,
announcement-queue and higher-sequence post-stop data regressions.
The original mounted lifecycle assertions remain unchanged, with no
skip, fixed sleep, retry or timeout increase.

Current validation logs are under `.qa/terminal-ui/`:

- `identity-final-gate.log`: full gate passes, including 1,403 AVA tests.
- `identity-final-coverage.log`: 96.47% aggregate configured line coverage,
  11,669 of 12,095 lines. Renderer and native-worker coverage are not claimed.
- `identity-standalone-2.log`: eight hidden terminal tests pass, including
  the complete mounted lifecycle and six screenshot cases. The first
  rewritten run passed five of eight; replacement-PTY attachment timing
  required retaining the first probed start identity while waiting for
  its expected tty within the existing finite readiness bound.
- `identity-loaded.log`: the single combined run, concurrent with the full
  gate and coverage, passes 45 of 46. The complete mounted terminal
  lifecycle, including stopped status and absence of stale restarted
  output, and all native stop/switch/quit/crash/restart cases pass.
  The failure is `TERM-12` at its first “open project” button lookup,
  before any PTY action. Its captured page has no recent projects despite
  a new thread. The initial project/recents ordering cause is not established.

The earlier backend stop failure remains historically unclassified.
The review's separate successful-backend/stale-view observation is not
evidence that the earlier backend failure was renderer-only. Those old
logs remain in `loaded-e2e.log`, `final-loaded-e2e.log` and `stage-e2e.log`.
Focused independent security re-review, the loaded initial-project
failure and manual accessibility gaps still block full phase acceptance.

All-platform acceptance is not established by local macOS checks. A
process that deliberately leaves its terminal session, for example through
`setsid` or a double fork, can escape portable PTY membership discovery.
Such an independently daemonised process may keep running after the
terminal says stopped; the terminal does not claim to sandbox it.
`node-pty` 1.1 has no public Windows Job Object or kill-on-close option.
Windows therefore uses a forced process-tree kill, not a claim that
breakaway processes are contained in a job.
PID reuse, filesystem replacement races and abrupt OS termination remain
limitations, not claims of process sandboxing. User-selected shells may
also independently write their own history or application files; the
desktop itself does not persist terminal content.
