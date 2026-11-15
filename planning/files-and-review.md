# Files and review: local implementation

How Milestone 2 is built and where it stops. The requirements are in [`features/file-browser.md`](features/file-browser.md) and [`features/git-review.md`](features/git-review.md); the path rules are in [`security.md`](security.md#path-canonicalisation).

- Status: Implemented, awaiting Windows and Linux CI evidence
- Last updated: 2026-11-03

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
| Diff rows drawn | 5,000 | The rest is left to an editor |
| Attachments per message | 20 | The renderer ignores further ones and the prompt schema in `source/main/ipc/workspace.ts` refuses more |

## Browsing and preview

- A listing is one folder: folders first, then names compared with a fixed `en` collator that ignores case, so the order is the same on every platform.
- Entries carry their state: normal, link inside, link outside, unreadable, ignored. Git marks (`M`, `A`, `D`, `R`, `U`, `!`) are shown with words for assistive technology, and a folder shows `M` when something inside it changed.
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
- A comment is made by selecting rows with the pointer (click, Shift+click) or the keyboard (arrows, Shift+arrows, Escape), then adding text. Only lines of change and context can be selected.

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

`PERF-07` and `PERF-08` build a repository of 100,001 files, so they run on request: `NANOCODER_DESKTOP_PERF=1 pnpm exec ava source/main/git/perf.spec.ts --timeout=15m`.

## Known limits

- Windows and Linux were not run locally. Their results are the CI jobs on the pull request.
- Windows and Linux editor launches are not exercised for real: the path and arguments are tested on every platform, but no editor was started on Windows or Linux.
- A repository file name that is not valid UTF-8 is shown with replacement characters and its diff cannot be read.
- The review list is capped at 5,000 files and a diff view at 5,000 rows.
- CodeMirror virtualises long documents, so a screen reader reads only the visible part (`A11Y-06`).
- On narrow windows the panel replaces the conversation, as the shell already does for any workbench; attachments stay until the message is sent.
- The agent changes view is not part of this milestone (`DEC-44`); phase 2.9 adds it later.
