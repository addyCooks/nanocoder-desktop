# Data model

What the desktop stores in SQLite, how it migrates, and what it never stores.

- Status: Draft
- Last updated: 2026-11-24
- Drafted by: @akramcodez

## Principle

The desktop keeps a relational index for navigation and UI state. Nanocoder's session files remain the source of truth for conversation history ([whitepaper, Durable chats][wp-durable], Decided). Losing the desktop database loses navigation, never history.

## Requirements

| ID | Requirement | Status and source |
|---|---|---|
| DATA-01 | One SQLite database in the app's user data directory, opened only by the main process, with one writer. | SQLite recommended ([whitepaper][wp-alt]); acceptance Open (`OQ-04`) |
| DATA-02 | Tables follow the whitepaper's ER diagram, with the columns and keys below. | Decided ([whitepaper][wp-durable]); additions marked |
| DATA-03 | Schema changes are forward-only, numbered migrations, each in a transaction, with a copy of the database taken before the first migration of a new version. | Suggestion (not discussed) |
| DATA-04 | Never store full ACP messages, file contents, tool results or stderr. | Decided ([whitepaper, Sources of truth][wp-truth]) |
| DATA-05 | Store touched files as project-relative paths only. | Suggestion (not discussed) |
| DATA-06 | Browser cookies, storage, cache and history live in an Electron partition, never in SQLite. | Decided ([whitepaper][wp-truth]) |
| DATA-07 | Removing a project or thread from the desktop removes desktop rows only. Deleting the Nanocoder session needs a separate, explicit confirmation (`CHAT-14`). A project's browser profile is kept; clearing it is done in settings (`BRW-08`, `DEC-49`). | Suggestion (not discussed) |
| DATA-08 | On startup, run an integrity check. If the database is unusable, move it aside and start empty; threads can be rediscovered from `session/list` (`ACP-18`). | Suggestion (not discussed) |
| DATA-09 | App settings (public browsing enabled, default mode, editor choice, Nanocoder override path) are stored in a settings table, never secrets. | Suggestion (not discussed) |
| DATA-10 | Window and panel state is stored as opaque UI state, not modelled here. | Decided (desktop owns it, [whitepaper][wp-split]) |

## Tables

Columns in the whitepaper's diagram are Decided. Columns marked "added" are Suggestion (not discussed).

| Table | Column | Type | Notes |
|---|---|---|---|
| `project` | `id` | text, primary key | Desktop-generated UUID. |
| | `canonical_root` | text, unique | Real path used for every security check (`SEC-03`). |
| | `session_cwd` | text | Directory passed to ACP. Equal to the root in v1 (`DEC-30`). |
| | `display_name` | text | |
| | `trusted` | integer (boolean) | Desktop trust flag. Gates Git and watchers; Nanocoder's own store gates Nanocoder, and one prompt sets both (`CHAT-02`, `DEC-30`). |
| | `default_mode` | text: `normal`, `auto-accept`, `plan`, `architect` | Added: the mode new threads start in, changed only on purpose. Never `yolo` (`DEC-31`). |
| | `last_opened_at` | text (ISO 8601) | Indexed for the recent list. |
| | `created_at` | text | Added. |
| `thread` | `id` | text, primary key | |
| | `project_id` | text, foreign key to `project.id`, `ON DELETE CASCADE` | Indexed. |
| | `nanocoder_session_id` | text, unique | Durable join key (`DEC-34`). |
| | `title` | text | Cached from `_nanocoder/sessionTitleChanged` or rename. |
| | `title_manually_set` | integer (boolean) | Added for `CHAT-12`: main-only manual-rename precedence, never exposed through `ThreadInfo` or IPC. |
| | `archive_state` | text: `active`, `archived` | UI metadata, not lifecycle. |
| | `run_state` | text: the seven thread states | Last known state, so a crash is visible on next launch. |
| | `last_activity_at` | text | Indexed with `project_id`. |
| | `session_cwd` | text | Added: the cwd this session was created with, since Nanocoder resumes in the persisted directory. |
| | `mode` | text | Added: the thread's persisted mode, sent again after every resume. Saving `yolo` stores the project default instead (`DEC-31`); the live mode stays in memory. |
| | `view_only_reason` | text, nullable | Added: why the thread is view-only. |
| `turn_summary` | `id` | text, primary key | |
| | `thread_id` | text, foreign key, cascade | Indexed. |
| | `status` | text: `completed`, `cancelled`, `failed` | |
| | `touched_files` | JSON array of relative paths | `DATA-05`. |
| | `started_at`, `ended_at` | text | Added. Used to find commits made during a turn (`GIT-12`). |
| | `head_before`, `head_after` | text, nullable | Added: Git `HEAD` before and after the turn. |
| `agent_run` | `id` | text, primary key | |
| | `thread_id` | text, foreign key, cascade | Indexed. |
| | `parent_run_id` | text, nullable, foreign key to `agent_run.id` | |
| | `nanocoder_child_id` | text, nullable | Empty until Nanocoder exposes child IDs (`OQ-03`). |
| | `role` | text | Subagent name, for example `explore`. |
| | `status` | text | |
| `thread_history` | `thread_id`, `session_id`, `revision`, `generation`, `sequence`, `complete` | text / integers | Added for phase 1.8: current scoped structural-ledger version, never a transcript. |
| `thread_turn_identity` | `id`, `thread_id`, `session_id`, `ordinal`, `outcome` | text / integer | Added: desktop UUID and immutable order, with only justified structural outcome metadata. |
| `thread_execution_identity` | `id`, `thread_id`, `session_id`, `turn_id`, `tool_call_id`, `ordinal`, `outcome` | text / integer | Added: exact bounded opaque tool-call ID within a stable desktop turn; no tool input or result. |
| `terminal_session` | `id`, `project_id`, `cwd`, `state` | | No scrollback (`TERM-09`). |
| `browser_tab` | `id`, `project_id`, `url`, `title` | | v1 has one tab. URLs can be sensitive; cleared with browser data (`BRW-08`). |
| `setting` | `key` text primary key, `value` JSON | | Added (`DATA-09`). |
| `schema_migration` | `version` integer primary key, `applied_at` | | Added (`DATA-03`). |
| `ui_state` | `id` integer primary key (always 1), `value` JSON | | Added: one bounded, allowlisted UI-state object (`DATA-10`), not drafts or conversation data. |

## Indexes

| Table | Index | Serves |
|---|---|---|
| `project` | `last_opened_at` | Recent projects list |
| `thread` | `(project_id, archive_state, last_activity_at)` | Thread list per project |
| `thread` | `nanocoder_session_id` (unique) | Resume and discovery joins |
| `turn_summary` | `(thread_id, ended_at)` | Latest turn's touched files |
| `agent_run` | `(thread_id, parent_run_id)` | Run tree |

## Retention of desktop rows

Suggestion (not discussed):

- Threads stay until the user removes them, even when their Nanocoder session is gone (they become view-only).
- `turn_summary` keeps the most recent 200 turns per thread; older rows are deleted at startup.
- `agent_run` rows are deleted with their thread.
- `browser_tab` rows are deleted when browser data is cleared (`BRW-08`).

## Privacy review of stored columns

| Column | Could it hold sensitive data? | Mitigation |
|---|---|---|
| `thread.title` | Yes: generated from the first prompt, or sent by Nanocoder, redacted, with control, zero-width and bidi characters removed | Stored locally only; removed with the thread. |
| `thread.title_manually_set` | No: one boolean | No title history or conversation data. Removed with the thread. |
| `turn_summary.touched_files` | Paths can reveal project structure | Relative paths only (`DATA-05`). |
| `browser_tab.url` | Yes: query strings can hold tokens | Cleared with browser data; Suggestion: strip query strings before storing. |
| `project.canonical_root` | Reveals local folder names | Local only; never sent anywhere. |
| `setting` | Must never hold secrets | Schema check refuses keys that look like credentials. |

## What is never stored

Decided (`DATA-04`): transcripts and message text, file contents, tool inputs and results, stderr. Also not stored, Suggestion (not discussed): terminal output, page content and screenshots, permission request payloads, and titles of Nanocoder sessions from projects the user has not added.

## Migrations

Suggestion (not discussed): migrations live as numbered files in the source tree, run at startup before any window opens, and refuse to run against a database from a newer app version (the user is told to update instead).

Phase 1.1 implements this in [`source/main/store/`](../source/main/store/), behind the library-independent `SqlDriver` contract (`DEC-04`). Main takes Electron's single-instance lock for the profile before opening `desktop.sqlite` under `userData`, registering workspace handlers or opening a window. A second instance quits and asks the owner to focus its window. The SQLite adapter uses WAL, foreign keys and parameterised statements. It turns database failures into fixed error messages, without logging SQL or values.

- `001-metadata.ts` creates the eight planned tables and their indexes; `002-ui-state.ts` adds the singleton UI-state table. Each migration takes `BEGIN IMMEDIATE`, rechecks the schema marker and ledger, skips already applied work and commits its schema, record and `user_version` together.
- `003-manual-thread-titles.ts` adds the boolean `title_manually_set` (`CHAT-12`). It marks existing titles manual because their origin is unknown; new rows default to automatic. Project-scoped title updates validate an allowlisted title and boolean together. An automatic title cannot overwrite a manual title or clear its flag, including after a crash. No title history is added.
- `004-thread-execution-identities.ts` adds the three structural identity tables above. Thread/project removal cascades them. It does not change migrations 001 to 003 or store conversation content.
- `005-browser-profiles.ts` rebuilds the `setting` table with the two browser profile keys added to its allowed list and copies every existing row across.
- `006-browser-agent-settings.ts` rebuilds the `setting` table the same way to allow `nanocoderBrowserEnabled`, the phase 3.10 switch for Nanocoder's own browser tool, and `browserAllowedSites`, the main-only list of at most 200 web origins the user always allows the agent to use (`DEC-50`). A database without them reads the switch as off and the list as empty (`DEC-48`).
- An existing database gets an online SQLite backup before the first pending migration, including committed WAL changes. Backups are named `desktop.sqlite.backup-<uuid>`. A backup failure stops the upgrade. `STORE_TOO_NEW` refuses a newer version without replacing or upgrading it.
- Startup checks schema compatibility before `PRAGMA integrity_check`, in one read transaction. An identifiable newer marker or ledger is always refused, even when integrity fails. Recoverable corruption or an invalid supported migration record closes the connection, then moves the database into `desktop.sqlite.corrupt-<uuid>/` and starts fresh. Closing SQLite can checkpoint committed WAL data into the database and remove WAL/SHM files; quarantine preserves committed data, not a byte-for-byte forensic snapshot. Files still present after close are moved too. Quarantines and backups are not automatically deleted. After a quarantine the store reports the folder, `getAppInfo` carries it as `recoveredDatabase`, and the welcome page tells the user that the saved data was set aside and where, and that the threads can be imported again from the project's saved sessions (`ACP-18`). A later start with a healthy database shows no notice.
- The database directory is canonicalised. Existing database and sidecar symlinks, hard links and non-files are refused. New database and backup files are created with owner-only permissions where the platform supports them.
- Settings and UI patches read, merge and write under `BEGIN IMMEDIATE`, using strict allowlists at IPC and store boundaries. Main alone may set a canonical existing runtime override file; the renderer cannot supply it. An unchanged stale override does not block other preferences and main can clear it. Persistence does not yet apply settings to the technical-gate UI or restore window geometry.
- Project availability is derived on read, not persisted. Repositories check new or changed session paths, and refuse cross-project thread moves. Metadata-only updates to unchanged saved paths still work when a folder is missing. Granting trust rechecks the project root; execution services must always re-check roots before use. Saved timestamps use fixed millisecond precision; list ordering also handles older rows with mixed ISO precision. Repositories remove desktop rows only.

Evidence: [`store.spec.ts`](../source/main/store/store.spec.ts) introspects every migrated table for prohibited content columns and covers migrations, backups, rollback, refusal, recovery and metadata round trips. [`store.e2e.ts`](../e2e/store.e2e.ts) exercises the built main process, persistence across restart and corrupt-file startup; [`connect.e2e.ts`](../e2e/connect.e2e.ts) scans SQLite after a fake conversation and tool call.

### Structural replay foundation

`DesktopStore.threadHistory` and `DesktopStore.agentRuns` are main-only repositories, not IPC capabilities. A structural patch is a bounded upsert, not permission to replace or reassign an earlier identity. It checks the exact current project/thread/session, expected revision and increasing counters, rejects duplicate IDs or slots, and keeps at most 10,000 turns and executions per thread. A changed saved session cannot inherit the old ledger.

One main-owned session-ID schema protects thread metadata, structural scopes, new/resumed acknowledgements and the existing import IPC boundary. It rejects unpaired UTF-16 surrogates, control/format characters and IDs over 200 UTF-8 bytes instead of allowing SQLite to change an opaque ID. Valid Unicode remains exact. A resumed acknowledgement must also match the saved ID before mode metadata, hooks or replay change. Discovery/import composition is still pending; listed IDs must pass this same schema before caching, publication or persistence.

Replay retains previously justified outcomes; a synthetic completed tool is otherwise `unknown`, never evidence of success. The identity repository commits structural IDs and safe `agent_run` metadata in one data-only transaction. The disposable replay observer stages through a bounded, scoped repository, validates every observation against its execution, generation and replay epoch, and activates only after SQL commits. A failed commit leaves both SQL and the previous observer's sequence/generation memory unchanged.

Tests cover real commit failure, malformed staged prefixes, stale callbacks, removal/disposal, ordinary non-delegation tools and a successful commit followed by an actual `SIGKILL` and reopen. This is a storage/staging foundation only. ThreadService mapping and replay publication, renderer replay gates and `SUB-05` application acceptance remain pending.

## Browser partition

Decided (`DEC-49`, `OQ-06`): profiles, not one shared partition. A persistent Default profile, named profiles the user creates and an in-memory Incognito profile. Each project uses one, and a new project gets its own persistent profile.

| Choice | For | Against |
|---|---|---|
| Own profile per project (the starting default) | Isolation between clients' projects, which matters because the browser is agent-controlled; clearing one profile is precise. | More partitions on disk; repeated sign-ins. |
| Shared Default or a named profile (the user's choice) | One sign-in for a staging site works across projects. | A page in one project can see cookies set while previewing another, and so can an agent working there. |
| Incognito | Nothing is kept. | Nothing is kept. |

Every persistent profile is separate from the user's normal browser and is cleared from settings (`BRW-05`, `BRW-08`). Removing a project leaves its profile alone. Phase 3.5 stores the named profiles and the project-to-profile choice as two main-only settings keys, `browserProfiles` (at most 20, with unique names) and `browserAssignments` (at most 500 projects), not as new tables; migration `005-browser-profiles.ts` only widens the allowed keys of the `setting` table. A project with no assignment uses its own profile. The renderer cannot patch either key, and the browsing data itself lives in Chromium partitions, never in SQLite.

## SQLite library

Decided in [#3](https://github.com/Nano-Collective/nanocoder-desktop/issues/3) (`DEC-04`): `node:sqlite`, with `better-sqlite3` as the fallback behind the same interface. In the check posted on #3, `node:sqlite` opened an in-memory database and a WAL file in Electron 45.0.0 on Windows. It is a release candidate on Node 24.15 and later and still active development on Node 22, so store specs run on Node 24 as well. The candidates considered:

Checked again on macOS arm64 for phase 1.1: Electron 45.1.0 embeds Node 24.22.1. The built main process opens the real store, migrates it, backs it up and recovers corruption without a SQLite flag ([`store.e2e.ts`](../e2e/store.e2e.ts)). An Electron Node-mode check also passed with warning suppression removed and emitted no warning. The local Node 25 Playwright runner emits an SQLite `ExperimentalWarning`; it does not affect the tests or require an app flag.

| Candidate | Notes |
|---|---|
| `better-sqlite3` (13.0.3, MIT, fallback) | Synchronous API, widely used with Electron. Native module: needs a rebuild against Electron's ABI on every Electron upgrade. |
| Node's built-in `node:sqlite` (chosen) | No native dependency. Electron 45.0.0 embeds Node 24.22.0 ([releases][el-releases]). Release candidate on Node 24.15 and later. |
| SQLite compiled to WebAssembly | No native rebuild. Slower, and persistence needs care. |

[wp-alt]: https://github.com/Nano-Collective/docs/blob/3ec3b1c6a21277556a9df3000f4e0f244e35e3bb/content/collective/whitepapers/nanocoder-desktop.md?plain=1#L517-L531
[wp-durable]: https://github.com/Nano-Collective/docs/blob/3ec3b1c6a21277556a9df3000f4e0f244e35e3bb/content/collective/whitepapers/nanocoder-desktop.md?plain=1#L286-L342
[wp-truth]: https://github.com/Nano-Collective/docs/blob/3ec3b1c6a21277556a9df3000f4e0f244e35e3bb/content/collective/whitepapers/nanocoder-desktop.md?plain=1#L344-L355
[wp-split]: https://github.com/Nano-Collective/docs/blob/3ec3b1c6a21277556a9df3000f4e0f244e35e3bb/content/collective/whitepapers/nanocoder-desktop.md?plain=1#L248-L265
[el-releases]: https://releases.electronjs.org/release/v45.0.0
