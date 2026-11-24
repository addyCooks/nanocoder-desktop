# Files and review: local implementation

How Milestone 2 is built and where it stops. The requirements are in [`features/file-browser.md`](features/file-browser.md) and [`features/git-review.md`](features/git-review.md); the path rules are in [`security.md`](security.md#path-canonicalisation).

- Status: Implemented, awaiting Windows and Linux CI evidence
- Last updated: 2026-11-24

Everything here is read-only. The desktop never edits, stages, discards or commits (`GIT-14`, `DEC-24`).

## Paths

One validator and one resolver serve the browser, attachments, the editor handoff and ACP reads (`SEC-03`).

1. A request carries a path relative to the canonical project root, written with `/`. The empty string is the root. Absolute paths, empty segments, `.`, `..` and NUL bytes are refused. Paths over 4,096 bytes and names over 255 bytes are refused with `LIMIT`.
2. On Windows the validator also refuses drive-relative, UNC and `\\?\` forms, alternate data streams (`name:stream`), reserved device names (`CON`, `NUL`, `COM1` and the rest, with or without an extension), and names ending in a dot or space. It runs with the Windows rules on every platform in tests.
3. The path is joined to the root and resolved with the native real path, then checked to stay inside the root. Both sides come from the real path, which settles case on case-insensitive volumes. Unicode is compared in NFC.
4. A link that resolves outside the root is listed as `outside project` and is never followed, previewed, served over ACP or attached.
5. Every project must be stored, trusted, available and still at the folder that was trusted before any listing, read or Git call runs.
6. A file is opened with `O_NOFOLLOW` and its device and inode are compared with the file that was checked. Where a platform reports no inode the real-path check stands alone; on Windows this is a residual risk, the same one `security.md` records for an attacker who can already rewrite the project.
7. Git's own folder is never browsable: `.git` is not listed, not previewed, not attachable and not readable through ACP.

## Limits

Each is one constant in `source/main/files/limits.ts` or `source/main/git/git-service.ts`.

| Limit | Value | When hit |
|---|---|---|
| Entries listed per folder | 2,000 | The rest are counted and shown as `N more not shown` |
| Names scanned in one folder | 100,000 | The scan stops; the count is a lower bound and is marked `+` |
| Time to list a folder | 2 seconds | `LIMIT` |
| Preview size | 1 MiB | Metadata only |
| Highlighting size | 256 KiB | Plain text |
| Binary sniff | NUL in the first 8 KiB | Metadata only |
| ACP read | 1 MiB, or a line range | `LIMIT` for a whole file over 1 MiB with no range |
| Changed files listed | 5,000 | `N more changed files not shown` |
| Status time | 5 seconds | `LIMIT` with a retry |
| Diff size | 1 MiB | `too-large` with `open in editor` |
| Diff rows addressable | 5,000 | Parsing still covers the bounded 1 MiB diff to count omitted rows. Only the capped model is selectable; the viewport, eight rows of overscan per side and at most two keyboard pins are mounted |
| Attachments per message | 20 | The renderer ignores further ones and the prompt schema in `source/main/ipc/workspace.ts` refuses more |

## Browsing and preview

- A listing is one folder: folders first, then names compared with a fixed `en` collator that ignores case, so the order is the same on every platform.
- Entries carry their state: normal, link inside, link outside, unreadable, ignored. On Windows a name the system cannot open (a device name such as `CON`, or a trailing dot or space) is listed as unreadable, and opening it says why. Git marks (`M`, `A`, `D`, `R`, `U`, `!`) are shown with words for assistive technology, and a folder shows `M` when something inside it changed.
- Text is detected as UTF-8, UTF-8 with a byte order mark, or UTF-16 with a byte order mark. Anything else is reported as an unsupported encoding and left untouched on disk. Names that can reorder or hide text (control and bidirectional characters) are shown with visible escapes.
- The tree is a WAI-ARIA tree: one row in the tab order, arrow keys move and expand, Enter opens, Shift+Enter attaches.
- CodeMirror 6 is loaded only when a file opens, one chunk per language, chosen by extension alone. It is mounted in a shadow root, so it adopts its stylesheet instead of injecting a `<style>` element and the strict Content Security Policy stays unchanged.

## Watching

One recursive `fs.watch` per browsed project, closed when the project changes, is removed or loses trust, and on quit. Events are collected for 300 ms. `.git` and `node_modules` never refresh the tree, except `.git/HEAD`, `index`, `ORIG_HEAD`, `MERGE_HEAD` and `refs/`, which refresh the review. More than 200 changed folders, or an event with no name, asks for a full refresh. If the platform cannot watch (for example the Linux inotify limit), the panel says so and manual refresh keeps working. Without a working watch, Git status expires after 3 seconds.

## ACP reads and attachments

`fs/read_text_file` is answered for the project root only, with the same path rules, limits and refusals as the browser (`ACP-11`, `SEC-20`). The client still offers no write and no terminal.

An attached file is checked through the file service. If Nanocoder advertises embedded context the text travels in the prompt; otherwise the prompt carries a `file://` resource link and Nanocoder reads it back through the checked handler. A review comment is sent as quoted text. Attachments live in the renderer's memory and in one prompt call. They are never written to the store, and an end-to-end test searches the database files for them.

[`files.acp.ts`](../source/main/files/files.acp.ts) runs the attachment and `autoCommit` paths against the pinned real Nanocoder with a scripted model:

- The pinned Nanocoder does not advertise embedded context, so in practice the desktop sends a resource link and Nanocoder reads it back through `fs/read_text_file`. A UTF-16 file proves it: only the desktop's checked read decodes it, and the model request shows the real text.
- Nanocoder also accepts an embedded resource and a quoted review comment, and both reach the model.
- When the desktop refuses a read, Nanocoder falls back to reading the linked file from disk itself. `SEC-20` therefore bounds what the desktop answers, not what the agent can read. The desktop never builds a link to an outside path, because attachments are made only from files the file service has checked.
- With `autoCommit` on, Nanocoder commits the file it edited during the turn. The turn tracker records `HEAD` before and after, lists that commit and labels the file as touched.

## Git

`source/main/git/run.ts` is the only place Git starts.

- An absolute program found in known install locations or on `PATH`, never one inside a stored project folder, and never Apple's stub before the developer tools exist. Version 2.15 or newer.
- An argument array, no shell, `--no-pager`, `core.fsmonitor=false`, `core.pager=cat`, no colour, literal pathspecs, no prompts, optional locks off, and no inherited `GIT_*` variable.
- Only `rev-parse`, `status`, `diff` and `log` can run. Every `diff` must carry `--no-ext-diff` and `--no-textconv`. `status` and `diff` also switch off every filter driver (`clean`, `smudge` and `process`) that any configuration file defines, because Git runs them to compare a file with the index. A filter-backed file such as one tracked with Git LFS can therefore show as changed. Git cannot be told to switch off a driver whose name holds an `=`, so a repository that defines one is refused with an explicit reason instead of being read. A test proves that a repository configured with `core.fsmonitor`, an external diff driver, a text conversion filter and a clean filter runs none of them, and a control run in the same repository shows that plain Git would.
- Status is `--porcelain=v2 -z --branch --untracked-files=all --ignored=matching`. A project inside a larger repository shows only its own paths.
- An untracked file has no Git diff, so it is shown as an all-added diff built from the checked preview.
- A repository that Git refuses for ownership reasons, a folder that is not a repository, or a missing Git gives review an explicit reason. The file browser keeps working.

## Review

- A turn is bracketed by `HEAD` before and after, taken in main around each prompt. Commits made meanwhile (Nanocoder's `autoCommit`) are listed.
- A file is labelled touched only when a tool call of kind `edit`, `delete` or `move` reports it. Reads and searches are not labels. Files changed by a shell command appear in Git's list but are not labelled, and the panel says so. Where user and agent edited the same file only the full diff is shown (`RISK-08`, `DEC-44`).
- A prompt that is refused before it starts leaves the earlier labels in place.
- A sole visible change opens when Review opens, not when Files first reads status. With multiple changes, refresh and filtering preserve a selection that is still visible and clear one that is not. Staged and unstaged filters open their own side, including when Git reports a staged deletion and an untracked replacement at the same path.
- The file list keeps a bounded share of the panel and the selected diff stays visible beside or below it. Arrow keys, Home and End move through the file list and change the diff without moving DOM focus out of the list.
- The parser reads all rows of the bounded diff. The first 5,000 are addressable; remaining rows only contribute to the omitted count. `source/renderer/diff-virtual.ts` mounts the viewport, eight rows of overscan on each side and keyboard pins in full-model DOM order, with stable keys, `aria-posinset` and `aria-setsize`. Keyboard navigation and future scroll-to-row callers share one minimal-scroll function. Long lines remain unwrapped and their horizontal extent remains available when the row unmounts.
- A comment is made by selecting rows with the pointer (click, Shift+click) or the keyboard (arrows, Shift+arrows, Home, End, Escape), then adding text. Only lines of change and context can be selected. Selection and comment coordinates always refer to the capped full model, not the mounted window.
- `source/renderer/review-interaction.ts` keeps each draft and range by project, canonical path, staged side and agent/all view in the app-owned review hook, so workbench tab unmounts do not discard them. A range also belongs to the exact diff text; an edit while a file is offscreen invalidates its range but preserves its draft. Selected excerpts are memoised rather than rebuilt on scroll.
- Comment admission uses the same limits as IPC: a maximum end-minus-start line span of 2,000 and 20,000 excerpt characters. Larger selections show guidance and cannot attach. The composer chips, not a saved review-panel success message, show what still belongs to the next message.

## Open in editor

The system default goes through the operating system. Visual Studio Code, Cursor and Zed start from known install paths (`DEC-43`):

| Platform | Locations tried |
|---|---|
| macOS | `/usr/local/bin`, `/opt/homebrew/bin`, then the application bundle |
| Linux | `/usr/bin`, `/usr/local/bin`, `/snap/bin` (and `~/.local/bin` for Zed) |
| Windows | `%LOCALAPPDATA%\Programs\...` executables (no `.cmd` shims, which need a shell) |

A line number uses `--goto file:line` (Zed: `file:line`). A missing editor gives a message that names the setting.

## Measurements

Local, macOS arm64, Node 22, generated fixtures.

| Item | Target | Measured |
|---|---|---|
| `PERF-05` list 20,000 entries | 300 ms | 54 ms |
| `PERF-06` preview 1 MiB | 500 ms | under 5 ms |
| `PERF-07` status, 100,001 tracked files | 5 seconds | 170 ms |
| `PERF-08` diff of about 1 MiB | 1 second | 149 ms |

The review-renderer comparison uses `e2e/review-performance.e2e.ts`, five fresh built-app runs per version on Instabox Linux x64 with 4 vCPUs and 8 GiB RAM. The fake fixture has 2,505 replaced lines, producing 5,015 parsed rows before the 5,000-row cap. Both versions explicitly select the same file, then focus its first removed row and press End.

| Version, median of 5 | First render | Keyboard scroll to capped last row | Mounted rows |
|---|---:|---:|---:|
| `main` | 527.1 ms | 347.9 ms | 5,001 |
| Virtualised review, retained five-run artefact | 142.5 ms | 35.3 ms | 24 |

An earlier warm five-run comparison measured 74.4 ms and 15.7 ms. These are distinct runs, not the medians of the retained artefact. The table uses the [retained output at `7618c37`](https://github.com/Nano-Collective/nanocoder-desktop/blob/7618c3770d435a2009d55b1718bed3f7ab7396ca/evidence/issue-68/performance.log); its [fake-fixture screenshot](https://raw.githubusercontent.com/Nano-Collective/nanocoder-desktop/7618c3770d435a2009d55b1718bed3f7ab7396ca/evidence/issue-68/review-selected-linux.png) remains accessible after removing the tracked scratch files. These historical timings are not a controlled benchmark of the later review fixes.

The 24 November review fixes were rechecked in built Electron on the same Instabox Linux configuration: five fresh runs mounted 23 initial rows, with median first render of 110.3 ms and keyboard scroll to the cap of 30.7 ms. The [fake-fixture evidence gallery](https://bubbles.adityalogs.xyz/o/nanocoder-desktop-issue-68-review-followup/) contains the raw measurement and gate logs, both themes at 1240px, 1020px and 840px, and the visible keyboard/large-diff recording. It also records the Linux-only and manual screen-reader limitations. These runs did not overlap another test suite, but the shared sandbox is not a dedicated performance runner.

`PERF-07` and `PERF-08` build a repository of 100,001 files, so they run on request: `NANOCODER_DESKTOP_PERF=1 pnpm exec ava source/main/git/perf.spec.ts --timeout=15m`.

## Known limits

- Windows and Linux were not run locally. Their results are the CI jobs on the pull request.
- Windows and Linux editor launches are not exercised for real: the path and arguments are tested on every platform, but no editor was started on Windows or Linux.
- A repository file name that is not valid UTF-8 is shown with replacement characters and its diff cannot be read.
- The review list is capped at 5,000 files and the addressable diff model at 5,000 rows. Parsing still reads the whole bounded diff. Rows beyond the cap are unavailable for selection or future search in the panel and require the editor.
- CodeMirror virtualises long documents, so a screen reader reads only the visible part (`A11Y-06`). Review rows use the same visible-window approach with explicit keyboard scrolling; the Linux SP-08 result is recorded in [`accessibility-review.md`](accessibility-review.md).
- On narrow windows the panel replaces the conversation, as the shell already does for any workbench; attachments stay until the message is sent.
- The agent changes view is not part of this milestone (`DEC-44`); phase 2.9 adds it later.
