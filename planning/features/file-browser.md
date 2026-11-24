# File browser

The read-oriented project tree and file preview.

- Status: Draft
- Last updated: 2026-11-24
- Drafted by: @akramcodez

## Purpose

Help the user understand and reference the project without turning the desktop into an editor ([whitepaper, File browser][wp-files]). Visual design: see [`DESIGN.md`](../../DESIGN.md).

## v1 requirements

| ID | Requirement | Status and source |
|---|---|---|
| FILE-01 | Lazy tree rooted at the canonical project root, loading one directory at a time with a per-directory entry limit. | Decided ([whitepaper][wp-files]) |
| FILE-02 | Mark entries ignored by Git as ignored, and never list the `.git` directory's contents. | Suggestion (not discussed) |
| FILE-03 | Show each entry's Git status from the Git service. | Decided ([whitepaper][wp-files]) |
| FILE-04 | Preview text and code with syntax highlighting up to a size limit; show metadata only for binary, unsupported or oversized files. | Decided ([whitepaper][wp-files]) |
| FILE-05 | Refresh from file watching with debouncing, plus a manual refresh that reconciles the whole open tree. | Decided ([whitepaper][wp-files]) |
| FILE-06 | "Open in editor" launches the user's chosen editor with an argument array. | Decided ([whitepaper][wp-files]); editors decided in `DEC-43` |
| FILE-07 | "Reveal in file manager". | Decided ([whitepaper][wp-files]) |
| FILE-08 | Insert the selected file into the composer as an ACP resource. | Decided ([whitepaper][wp-files]) |
| FILE-09 | All privileged file operations run in the main process; the renderer receives data only. | Decided ([whitepaper][wp-files]) |
| FILE-10 | Links that resolve outside the root are listed but never followed (`SEC-03`). | Decided ([whitepaper][wp-files]) |
| FILE-11 | The tree is keyboard operable with tree semantics for assistive technology (`A11Y-01` to `A11Y-03`). | Decided as a v1 goal ([whitepaper, Milestone 4][wp-next]) |

## Behaviour

### Limits

Suggestion (not discussed). Defaults, each configurable in code and covered by `PERF-05` and `PERF-06`:

| Limit | Default | When hit |
|---|---|---|
| Entries per directory listing | 2,000 | The listing ends with "N more not shown" and the count; the user can open the folder externally. |
| Preview size | 1 MiB | Metadata only (size, modified time, type), with "Open in editor". |
| Highlighting size | 256 KiB | Plain text preview without highlighting. |
| Binary detection | A NUL byte in the first 8 KiB, the same rule Git uses | Metadata only. |
| ACP read size (`fs/read_text_file`) | 1 MiB, or the line range asked for | `LIMIT` error returned to Nanocoder. |

### Listing order

Directories first, then files, each sorted by name with a locale-aware, case-insensitive comparison, so the order is the same on all three platforms.

### Entry states

| State | Meaning | Actions offered |
|---|---|---|
| Normal | A file or directory inside the root | Preview or expand, insert into chat, open in editor, reveal |
| Ignored | Matched by Git ignore rules | Same as normal, marked ignored |
| Link inside root | A link whose target is inside the root | Followed like its target |
| Link outside root | A link whose target is outside the root | None except reveal; marked "outside project" |
| Unreadable | Permission denied, locked by another program, or (on Windows) a name the system cannot open, such as `CON` or a trailing dot | Retry; the error is shown |
| Gone | Deleted since it was listed | Removed on the next refresh |

### Watching

- One recursive watch per open project where the platform supports it, otherwise a watch per expanded directory.
- Events are coalesced for 300 ms before the tree and Git status refresh (Suggestion (not discussed)).
- Changes inside `.git` are ignored by the tree, but changes to `.git/HEAD` and `.git/index` trigger a Git status refresh (`GIT-06`).
- Manual refresh re-lists every expanded directory and drops entries that no longer exist.

### Keyboard model

Up and down move between visible entries, right expands or moves to the first child, left collapses or moves to the parent, Enter previews or toggles, and a documented shortcut inserts the entry into the composer. The tree exposes tree, group and tree item roles with expanded and selected states (`A11Y-03`).

### Data flow

The renderer asks for `files.list(projectId, relativePath)` and `files.preview(projectId, relativePath)`. The main process canonicalises (`SEC-03`), applies limits (`SEC-04`) and returns rows or text. The same canonicalisation answers ACP reads (`SEC-20`).

## Explicit deferrals

Editing, rename and delete, project-wide content search, rich documents, multiple workspace roots ([whitepaper][wp-files]).

## Edge cases and failure modes

- Huge directories (for example `node_modules`): entry limit with "N more not shown".
- Files changing while previewed: refresh on watcher event; if the file disappears, say so.
- Unreadable files (permissions, locks held by other programs on Windows): show the error, not an empty preview.
- Encodings other than UTF-8: detect and label; never rewrite.
- `.nanocoder/` written by Nanocoder inside the project (timeline snapshots and its own `.gitignore`, [source][nc-gitignore]): listed like any other folder.
- The project root deleted or unmounted while open: the project becomes "missing" (`CHAT-01`) and listings stop.

## Platform notes

- **Linux.** inotify watch limits can be exhausted on large trees; fall back to manual refresh with a notice.
- **Windows.** Junctions, case-insensitive names, reserved names and alternate data streams (`SEC-03`). Files open in other programs may be locked.
- **macOS.** Unicode normalisation differences in file names; volumes may be case-sensitive or not.

## Security notes

`SEC-03`, `SEC-04`, `SEC-05` (editor launch), `SEC-20` (the same checks for ACP reads). See [`security.md`](../security.md).

## Dependencies on Nanocoder changes

None.

## Open questions

`OQ-07` (editors). Highlighting is decided: CodeMirror 6, read-only (`DEC-28`).

## Acceptance criteria

| Criterion | Success item |
|---|---|
| A large real repository's tree opens lazily within `PERF-05` and previews text files within `PERF-06`. | `SP-07` |
| A symlink or junction pointing outside the root cannot be previewed or served over ACP. | `SP-07` |
| A file inserted into the composer reaches Nanocoder as a resource. | `SP-09` |
| The tree can be used with the keyboard alone (`A11Y-01`). | `SP-07` |

[wp-files]: https://github.com/Nano-Collective/docs/blob/3ec3b1c6a21277556a9df3000f4e0f244e35e3bb/content/collective/whitepapers/nanocoder-desktop.md?plain=1#L400-L422
[wp-next]: https://github.com/Nano-Collective/docs/blob/3ec3b1c6a21277556a9df3000f4e0f244e35e3bb/content/collective/whitepapers/nanocoder-desktop.md?plain=1#L650-L696
[nc-gitignore]: https://github.com/Nano-Collective/nanocoder/blob/8a5f4d46317d93128c531f39b80b5ac6fd2da25b/source/utils/ensure-nanocoder-gitignore.ts
