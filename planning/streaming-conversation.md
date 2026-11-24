# Streaming conversation

- Last updated: 2026-11-24

Phase 1.6 and U.4 implement `CHAT-05`, `ACP-12`, `CHAT-19`, `CHAT-20` and `PERF-04`. `DEC-39` remains proposed.

## Update boundary

`toTurnEvent` covers the installed SDK's 19 `session/update` discriminants. Agent text and reasoning stay separate. Replayed user chunks become user messages; live user echoes are ignored because sending already inserts the local user message. Distinct reported message IDs do not merge. Unsupported images, audio and resources become truthful text placeholders, never resource loads.

Tool updates merge by the exact opaque tool call ID. A title-only update preserves omitted classification, status, input/output, locations and content. Supplied content and location arrays replace previous arrays, including explicit empty arrays. A `subagent:` prefix has no routing meaning.

Plans replace by ID and can be removed. Compaction summary chunks append in receive order; patch omissions retain data and explicit null clears it. Inter-session messages preserve sender/recipient identity, replace or clear complete content, and append streamed chunks. Subagent updates are bounded plain rows only, with no child actions or inferred attribution. Session-info titles are deliberately ignored here: ThreadService owns them.

## Metadata and reported usage

`turn-metadata.ts` projects only `nanocoder/usage`, `nanocoder/response-usage`, `nanocoder/durationMs`, `nanocoder/outcome` and `nanocoder/artifacts`. Unknown keys are ignored. Malformed known namespaces are dropped atomically and warnings contain fixed field names only, never values or parser errors. Counts and amounts must be finite and non-negative; artefacts are bounded descriptors, not file access.

At `fc01e239`, live token counts are on the prompt response's `usage`, with cost under `nanocoder/usage`. The main-only `NanocoderTurnResult` retains validated metadata. Replay may put usage, duration and outcome on an empty assistant chunk, which becomes a metadata-only turn event. Token chips never invent totals; reported cost is shown without assuming an unreported currency. The context gauge appears only for actual `usage_update` context figures, never per-turn token totals.

Usage stays within its turn's user-message boundary. It attaches to the latest answer in that turn, or to a separate turn-details row when no answer exists. Further metadata updates that turn-details row even if an answer arrives later. A later turn never changes an earlier turn's reported usage or outcome.

The temporary technical gate publishes prompt metadata through its existing event channel, after checking the captured project and session still match. Its renderer listener accepts metadata only, preventing duplicate text/tool events. ThreadService must replace both pieces with its mapped per-thread event path when the technical gate retires.

## Message times

Nanocoder reports no time for any message, so the desktop shows only times it saw live. The renderer records when the user sends a prompt and when the first reply chunk of an agent message arrives. Both values stay in memory for the open session. Nothing is written to disk or logs, and no time is estimated.

Replayed history and restarted sessions show no time. The day label takes its time from the first timed item. Untimed history shows no time, with the title "times are not saved in Nanocoder history" (`DEC-41`).

## Ordered rendering

`createStreamBatcher` accepts a thread ID and ordered event arrays, schedules a cancellable 16ms delivery and exposes `flush`, `remove` and `dispose`. Contiguous events are batched without reordering interleaved thread queues. The owner flushes before terminal state, replay replacement, approval display/answer and thread changes. Cleanup cancels pending callbacks.

`applyEvents` makes one transcript update per delivery. Untouched settled rows keep object identity. Rows and agent Markdown are memoised. `ConversationStream` accepts plain transcript/running props and an optional child slot; it does not own a desktop capability. In the `DEC-40` workspace, `App` mounts `ApprovalRequests` in AppShell's separate shelf above the composer, so a waiting decision cannot disappear into transcript scrollback. Request identity, shortcut checks and focus-return ownership are unchanged.

Finished reasoning uses a native keyboard disclosure; live reasoning remains expanded. Routine completed tool details fold, while failed/cancelled results start expanded. No events are grouped, removed or reordered. Larger reading rows and dense detail use the approved tokens. Model/mode controls precede send in both visual and keyboard order. Project-default and alwaysAllow detail remains inspectable in a disclosure; refusal reasons and pending mode stay visible. Disabled controls retain full-opacity readable ink.

## Follow and copy

`AppShell` owns follow state separately from stream batching. It starts each project/thread scope at the end and follows transcript changes only while the reader is within two CSS pixels of the bottom. Resize observation keeps follow through viewport, content and footer size changes without treating them as reader intent. Scrolling away releases follow without changing the reader's position and exposes a named `latest` button outside the scrolling content. Activating it returns to the end and resumes following. Pointer activation does not take focus from the composer; keyboard activation and End return focus to the conversation region. Returning to the bottom by any route also resumes following.

`transcriptRowId` prefers reported tool, plan and message IDs. Id-less live messages keep a renderer-only fallback identity across chunks. Snapshot reconstruction carries that identity only at the same structural position with matching kind, reported ID and full text, including repeated identical messages at distinct positions. Different content receives a new content-sensitive fallback. `ConversationStream` still remounts for a different project/thread. These identities and follow positions stay in memory and are not new persisted message metadata.

User and assistant `copy text` actions write the original `TranscriptItem.text`, not rendered HTML, attachment summaries or announcement previews. A fenced-code action writes its source text, preserving line endings and excluding fence markers and language labels. Inline, indented and empty code has no copy action. Empty text does not change the clipboard; oversized text gets a bounded-limit notice before IPC. A successful action emits one `copied` toast through the existing queue, and a later copy replaces the operating system clipboard. Failures show a generic refusal with no copied content. Native Tab order includes the copy buttons before the approval shelf and composer.

The built Linux Electron probe did not complete `navigator.clipboard.writeText` under `app://`. The write therefore uses only `clipboard:write-text`: a trusted-main-frame, strict-object IPC request bounded to 1,000,000 code units, answered by main through Electron's clipboard API. There is no clipboard-read bridge, and main returns a generic failure without logging the text or underlying error. Scroll offsets, row identities and copied text are never written to desktop storage or logs. User gestures belong to the UI interaction, not the IPC sender or schema validation.

## Polite stream announcements

`stream-announcements.tsx` implements `A11Y-04` and `A11Y-05` outside the transcript list. Its polite, atomic live node announces started, waiting for approval, completed, failed, cancelled and interrupted states. Completed agent messages get a plain-text preview of at most 160 Unicode characters, including an ellipsis when needed. Preview work reads at most 4,000 input code units and omits code fences, inline code, Markdown link targets and HTML tags. Reasoning, tool rows, permission details and token chunks are never announcement inputs.

An injected clock limits new speech to one message per second, starting only after the live-node write is acknowledged. A bounded eight-message queue survives modal changes and disposal cancels pending timers and frame callbacks. An authoritative outcome replaces a still-queued implicit interruption. A message finishes when another row follows it or the turn completes; replayed idle history stays silent.

One persistent node moves between the normal stream host and the open native dialog. Its text and identity survive the move, with no rewrite of delivered speech. New nonempty text waits for two settled animation frames after the last move. The existing modal approval-count region owns approval speech while the palette or shortcut sheet is open, so the stream suppresses queued waiting announcements and clears withdrawn waiting text before moving its node into the dialog. Announcements never move focus or animate; reduced motion does not turn speech off.

## Markdown and commands

Only `AgentMarkdown` imports exactly pinned `react-markdown` 10.1.0 and `remark-gfm` 4.0.1, the only plugin; there are no rehype plugins. CommonMark headings, lists, blockquotes and code render, with GFM tables, strikethrough and task checkboxes. Task checkboxes are disabled, unsupported footnote text is kept as plain text, raw HTML is skipped, all images are text placeholders and all links, including autolinks, are inert spans with their targets removed. There is no external-link IPC or automatic navigation. This small module can be replaced without changing the stream contract.

The resolved dependency graph contains 83 package versions, 78 newly locked. All have lockfile integrity; licences are MIT except `@ungap/structured-clone` (ISC). None has an install lifecycle script. Full upstream copyright/licence texts are in `THIRD-PARTY-NOTICES.txt`. This does not complete the later whole-application release-notices work.

Slash suggestions come only from `available_commands_update`. Selecting one inserts a draft and focuses the message input; it never submits. There is no fabricated desktop `/help`. Running disables sending, not drafting, as specified in [chats and sessions](features/chats-and-sessions.md#composer-by-thread-state). Drafts stay in renderer memory only (`DATA-10`).

## Verification and remaining scope

Unit tests cover mapping, patch semantics, metadata projection/refusal, project/thread usage ownership, batching cancellation and Markdown resource/navigation refusal. The retired legacy event channel is absent from preload; built-app tests prove literal legacy events cannot change the transcript. Built-app tests use fake content and a fresh `--user-data-dir`, never a real provider or conversation.

`e2e/streaming.e2e.ts` drives a monotonic fake stream, asserts the achieved rate is at least 100 updates/sec and measures maximum input-to-frame, scroll-to-frame, frame gap and MessageChannel event-loop delay against 100ms. It checks ordered content, memory-only drafts, native disclosure keyboard focus, reduced-motion cursor/spinner, both themes and 1240/1020/840 widths. Condition/event waits replace fixed sleeps.

Issue #67's Linux Instabox run on 19 November 2026 passed all three `streaming.e2e.ts` tests. `PERF-04` measured 105.09 updates/sec over 300 updates, with 184 frame samples and 20 input and scroll samples. Median/p95 frame gaps were 16.7/16.8ms, input-to-frame 10.5/18.5ms and scroll-to-frame 7.8/15.7ms; maximum event-loop delay was 8.2ms. Every gate remained below 100ms. The same run proved bottom-only following, pointer and keyboard `latest`, stable rows across appends and thread switches, exact user/assistant/fence clipboard replacement and one success toast per action.

The 24 November 2026 Linux Instabox review-fix run passed 96 affected built-app tests, with the macOS-only close/reopen test skipped. The four streaming tests include viewport resizing, terminal opening, composer growth, approval-shelf appearance, End focus return and long fenced code scrolled horizontally at 1240/840px. Automated clipboard writes are stubbed in Electron main; the separate visible built-app run used the real clipboard and native Ctrl+V with fake text only. `PERF-04` measured 104.89 updates/sec over 300 updates, 163 frame samples and 20 input and scroll samples. Input median/p95 was 6.3/16.4ms, scroll 4.0/16.9ms and frame gap 16.7/16.8ms; maximum event-loop delay was 13.1ms. All gates stayed below 100ms. These Linux results do not prove macOS/Windows native focus or manual screen-reader acceptance.

The stream-announcement unit tests use injected time and frame callbacks, without sleeps. The dedicated built-app tests check native-dialog moves in Chromium's accessibility tree, focus retention, approval-count ownership and terminal outcomes. The `PERF-04` stream probe also limits announcement writes during its 300 updates. Full platform screen-reader acceptance, including VoiceOver's handling of native-dialog moves, still needs the manual protocol.

The UI uses the designer-approved `DEC-40` tokens and passes the updated contrast inventory without the retired exceptions. Full platform screen-reader acceptance, advanced subagent controls and main-owned external-link navigation remain later work. No transcript, tool output or resource body is persisted by the desktop.
