import * as React from 'react';
import {
	type DiffRow,
	diffKey,
	parseDiff,
	selectLines,
} from '@/renderer/diff-parse';
import {
	DIFF_ROW_HEIGHT,
	diffRowKey,
	diffWindow,
	MAX_DIFF_ROWS,
	mountedDiffRows,
	scrollTopForRow,
} from '@/renderer/diff-virtual';
import {keyHint} from '@/renderer/overlay-model';
import {
	defaultSide,
	describeEntry,
	type ReviewFilter,
	type ReviewState,
	type ReviewView,
	visibleEntries,
} from '@/renderer/review-controller';
import {
	interactionFor,
	interactionKey,
	type ReviewInteraction,
	type ReviewInteractions,
	reviewSelectionReason,
} from '@/renderer/review-interaction';
import {Button} from '@/renderer/ui';
import {displayName} from '@/shared/files';
import type {PromptAttachment} from '@/shared/ipc';
import type {ReviewDiff, ReviewEntry} from '@/shared/review';

const FILTERS: Array<{id: ReviewFilter; label: string}> = [
	{id: 'all', label: 'all changes'},
	{id: 'staged', label: 'staged'},
	{id: 'unstaged', label: 'unstaged'},
	{id: 'touched', label: 'touched this turn'},
];

const KIND_WORDS: Record<DiffRow['kind'], string> = {
	add: 'added',
	remove: 'removed',
	context: 'unchanged',
	file: 'header',
	hunk: 'section',
	note: 'note',
};

type CommentAttachment = Extract<PromptAttachment, {kind: 'review-comment'}>;

function DiffView({
	diff,
	agent,
	commentReason,
	interaction,
	onInteraction,
	onComment,
	onOpenEditor,
}: {
	diff: Extract<ReviewDiff, {kind: 'text'}>;
	agent: boolean;
	commentReason: string | null;
	interaction: ReviewInteraction;
	onInteraction(next: ReviewInteraction): void;
	onComment(comment: CommentAttachment): void;
	onOpenEditor(path: string, line?: number): void;
}): React.ReactElement {
	const rows = React.useMemo(() => parseDiff(diff.diff), [diff.diff]);
	const shown = React.useMemo(() => rows.slice(0, MAX_DIFF_ROWS), [rows]);
	const fingerprint = diff.diff;
	const {cursor, comment} = interaction;
	const scroller = React.useRef<HTMLDivElement | null>(null);
	const [window, setWindow] = React.useState(() =>
		diffWindow(shown.length, 0, 0),
	);
	const [contentWidth, setContentWidth] = React.useState(0);
	const nodes = React.useRef(new Map<number, HTMLElement>());
	const pending = React.useRef<number | null>(null);
	const updateWindow = React.useCallback(
		(top: number, height: number) => {
			setWindow(diffWindow(shown.length, top, height));
		},
		[shown.length],
	);
	React.useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const measure = () => updateWindow(element.scrollTop, element.clientHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [updateWindow]);
	React.useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		let disposed = false;
		const measure = () => {
			if (disposed) return;
			const style = getComputedStyle(element);
			const context = document.createElement('canvas').getContext('2d');
			if (!context) return;
			context.font = `${style.fontSize} ${style.fontFamily}`;
			const gutter = context.measureText('0'.repeat(12)).width + 36;
			let width = 0;
			for (const row of shown)
				width = Math.max(
					width,
					context.measureText(row.text.replace(/\t/gu, '        ')).width,
				);
			setContentWidth(Math.ceil(width + gutter));
		};
		measure();
		void document.fonts.ready.then(measure);
		return () => {
			disposed = true;
		};
	}, [shown]);
	const activeCursor =
		cursor && interaction.cursorFingerprint === fingerprint ? cursor : null;
	const [focusedIndex, setFocusedIndex] = React.useState<number | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: row coordinates belong to this exact diff
	React.useEffect(() => {
		setFocusedIndex(null);
	}, [fingerprint]);
	React.useLayoutEffect(() => {
		if (pending.current === null) return;
		nodes.current.get(pending.current)?.focus();
		pending.current = null;
	});
	const anchor = activeCursor?.anchor;
	const cursorIndex = activeCursor?.cursor;
	const selection = React.useMemo(
		() =>
			anchor !== undefined && cursorIndex !== undefined
				? selectLines(shown, anchor, cursorIndex)
				: null,
		[shown, anchor, cursorIndex],
	);
	const selectionReason = selection ? reviewSelectionReason(selection) : null;
	const low = activeCursor
		? Math.min(activeCursor.anchor, activeCursor.cursor)
		: -1;
	const high = activeCursor
		? Math.max(activeCursor.anchor, activeCursor.cursor)
		: -1;
	const first = shown.findIndex(row => row.selectable);
	const tabbable = activeCursor?.cursor ?? focusedIndex ?? first;
	const side = diff.staged ? 'staged' : 'unstaged';
	const label = agent ? 'agent changes' : side;
	const described = agent ? 'agent changes' : `${side} changes`;
	const focusRow = (index: number) => {
		pending.current = index;
		const element = scroller.current;
		if (!element) return;
		const top = scrollTopForRow(
			index,
			element.scrollTop,
			element.clientHeight,
			shown.length,
		);
		if (top !== element.scrollTop) element.scrollTop = top;
		updateWindow(top, element.clientHeight);
	};
	const orderedMounted = mountedDiffRows(
		window,
		activeCursor?.cursor,
		focusedIndex,
		tabbable,
	);
	return (
		<div className="diff-view">
			<header className="diff-header">
				<p className="diff-title">
					{displayName(diff.path)} <span className="diff-side">({label})</span>
					<span className="diff-counts">
						<span className="diff-count diff-count--add">+{diff.added}</span>{' '}
						<span className="diff-count diff-count--remove">
							−{diff.removed}
						</span>
					</span>
				</p>
				<Button
					onClick={() => onOpenEditor(diff.path, selection?.startLine)}
					title="open this file in your editor"
				>
					open in editor
				</Button>
			</header>
			<p className="files-hint">
				{keyHint(
					'↑↓ move · ⇧↑↓ extend · click and shift-click select · esc clears',
				)}
			</p>
			<div
				ref={scroller}
				className="diff-lines"
				role="listbox"
				aria-label={`${described} in ${displayName(diff.path)}. select lines to comment on them`}
				aria-multiselectable="true"
				onScroll={event =>
					updateWindow(
						event.currentTarget.scrollTop,
						event.currentTarget.clientHeight,
					)
				}
				onKeyDown={event => {
					if (event.altKey || event.ctrlKey || event.metaKey) return;
					if (event.key === 'Escape' && activeCursor) {
						event.preventDefault();
						event.stopPropagation();
						onInteraction({
							...interaction,
							cursor: null,
							cursorFingerprint: null,
						});
						return;
					}
					const next = diffKey(
						shown,
						activeCursor ??
							(tabbable >= 0 ? {anchor: tabbable, cursor: tabbable} : null),
						event.key,
						event.shiftKey,
					);
					if (!next) return;
					event.preventDefault();
					focusRow(next.cursor);
					onInteraction({
						...interaction,
						cursor: next,
						cursorFingerprint: fingerprint,
					});
				}}
			>
				<div
					className="diff-spacer"
					style={{height: window.totalHeight, minWidth: contentWidth}}
				>
					{orderedMounted.map(index => {
						const row = shown[index];
						if (!row) return null;
						return (
							<div
								key={diffRowKey(index)}
								ref={node => {
									if (node) nodes.current.set(index, node);
									else nodes.current.delete(index);
								}}
								onFocus={() => setFocusedIndex(index)}
								role="option"
								aria-selected={
									row.selectable ? index >= low && index <= high : undefined
								}
								aria-disabled={row.selectable ? undefined : true}
								aria-posinset={index + 1}
								aria-setsize={shown.length}
								tabIndex={index === tabbable ? 0 : -1}
								className={`diff-row diff-row--${row.kind}${
									row.selectable && index >= low && index <= high
										? ' diff-row--selected'
										: ''
								}`}
								style={{
									transform: `translateY(${index * DIFF_ROW_HEIGHT}px)`,
									height: DIFF_ROW_HEIGHT,
									lineHeight: `${DIFF_ROW_HEIGHT}px`,
								}}
								onClick={event => {
									if (!row.selectable) return;
									onInteraction({
										...interaction,
										cursor:
											event.shiftKey && activeCursor
												? {anchor: activeCursor.anchor, cursor: index}
												: {anchor: index, cursor: index},
										cursorFingerprint: fingerprint,
									});
								}}
							>
								<span className="diff-no" aria-hidden="true">
									{row.oldLine ?? ''}
								</span>
								<span className="diff-no" aria-hidden="true">
									{row.newLine ?? ''}
								</span>
								<span className="diff-sign" aria-hidden="true">
									{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ''}
								</span>
								<span className="sr-only">
									{KIND_WORDS[row.kind]}
									{row.selectable ? ` line ${row.newLine ?? row.oldLine}` : ''}:{' '}
								</span>
								<span className="diff-text">{row.text}</span>
							</div>
						);
					})}
				</div>
			</div>
			{rows.length > MAX_DIFF_ROWS && (
				<p className="diff-more" role="status">
					{(rows.length - MAX_DIFF_ROWS).toLocaleString('en')} more lines not
					shown. open the file in an editor to review them.
				</p>
			)}
			{selection && (
				<form
					className="review-comment"
					aria-label="review comment"
					onSubmit={event => {
						event.preventDefault();
						const text = comment.trim();
						if (!text || commentReason || selectionReason) return;
						onComment({
							kind: 'review-comment',
							path: diff.path,
							startLine: selection.startLine,
							endLine: selection.endLine,
							side,
							comment: text,
							excerpt: selection.excerpt,
						});
						onInteraction({
							comment: '',
							cursor: null,
							cursorFingerprint: null,
						});
					}}
				>
					<label>
						<span className="review-comment-label">
							comment on {displayName(diff.path)}, line
							{selection.startLine === selection.endLine
								? ` ${selection.startLine}`
								: `s ${selection.startLine} to ${selection.endLine}`}
						</span>
						<textarea
							value={comment}
							rows={3}
							maxLength={4000}
							onChange={event =>
								onInteraction({...interaction, comment: event.target.value})
							}
							onKeyDown={event => event.stopPropagation()}
						/>
					</label>
					{commentReason && <p className="files-hint">{commentReason}</p>}
					{selectionReason && (
						<p className="files-hint" role="alert">
							{selectionReason}
						</p>
					)}
					<div className="review-comment-actions">
						<Button
							type="submit"
							disabled={
								!comment.trim() ||
								commentReason !== null ||
								selectionReason !== null
							}
						>
							add to next message
						</Button>
						<Button
							onClick={() =>
								onInteraction({
									...interaction,
									cursor: null,
									cursorFingerprint: null,
								})
							}
						>
							clear selection
						</Button>
					</div>
				</form>
			)}
		</div>
	);
}

export function ReviewPanel({
	state,
	commentReason,
	onFilter,
	onView,
	onShow,
	onClear,
	onRefresh,
	onComment,
	onOpenEditor,
	interactions,
	onInteraction,
}: {
	state: ReviewState;
	commentReason: string | null;
	onFilter(filter: ReviewFilter): void;
	onView(view: ReviewView): void;
	onShow(path: string, staged: boolean): void;
	onClear(): void;
	onRefresh(): void;
	onComment(comment: CommentAttachment): void;
	onOpenEditor(path: string, line?: number): void;
	interactions: ReviewInteractions;
	onInteraction(
		identity: Parameters<typeof interactionKey>[0],
		next: ReviewInteraction,
	): void;
}): React.ReactElement {
	const {value} = state;
	if (!value)
		return state.status === 'error' ? (
			<p role="alert">{state.error}</p>
		) : (
			<p role="status">reading the repository…</p>
		);
	if (!value.available)
		return (
			<div className="review-unavailable" role="status">
				<p>review is unavailable</p>
				<p className="files-hint">{value.reason}</p>
				<p className="files-hint">the file browser still works.</p>
			</div>
		);
	const entries = visibleEntries(value, state.filter);
	const selected = state.selected;
	const current: ReviewEntry | undefined = selected
		? visibleEntries(value, 'all').find(entry => entry.path === selected.path)
		: undefined;
	const agentView = state.diff?.source === 'agent';
	const interactionIdentity =
		state.diff?.value?.kind === 'text'
			? {
					projectId: state.projectId,
					path: state.diff.value.path,
					staged: state.diff.value.staged,
					agent: agentView,
				}
			: null;
	const offerView =
		!selected?.staged &&
		current?.touched === true &&
		value.agentChanges.enabled;
	const both =
		!agentView &&
		state.filter !== 'staged' &&
		state.filter !== 'unstaged' &&
		current !== undefined &&
		current.staged !== 'none' &&
		(current.unstaged !== 'none' || current.untracked);
	const turn = value.turn;
	return (
		<div className="review-panel">
			<p className="review-meta">
				{value.branch ?? 'detached HEAD'}
				{value.head ? ` · ${value.head.slice(0, 7)}` : ' · no commits yet'} ·
				git {value.git.version}
			</p>
			{state.status === 'error' && <p role="alert">{state.error}</p>}
			<div className="review-filters" role="group" aria-label="filter changes">
				{FILTERS.map(filter => (
					<Button
						key={filter.id}
						aria-pressed={state.filter === filter.id}
						onClick={() => onFilter(filter.id)}
					>
						{filter.label}
					</Button>
				))}
				<Button onClick={onRefresh}>refresh</Button>
			</div>
			{turn && (
				<p className="files-hint review-turn">
					{turn.running
						? 'a turn is running. files it edits are labelled when it finishes editing them.'
						: turn.touched.length
							? `the last turn edited ${turn.touched.length} file${turn.touched.length === 1 ? '' : 's'}. changes made by shell commands are shown by Git but not labelled.`
							: 'the last turn did not edit files through a tool call. changes made by shell commands are shown by Git but not labelled.'}
				</p>
			)}
			{turn && turn.commits.length > 0 && (
				<section
					className="review-commits"
					aria-label="commits made during the last turn"
				>
					<h3>commits made during the last turn</h3>
					<ul>
						{turn.commits.map(commit => (
							<li key={commit.hash}>
								<code>{commit.hash.slice(0, 7)}</code>{' '}
								{displayName(commit.subject)}
							</li>
						))}
					</ul>
				</section>
			)}
			{entries.length === 0 ? (
				<p role="status" className="files-hint">
					{value.entries.length === 0
						? 'the work tree is clean.'
						: 'no files match this filter.'}
				</p>
			) : (
				<ul className="review-list" aria-label="changed files">
					{entries.map((entry, index) => (
						<li key={entry.path}>
							<button
								type="button"
								className="review-entry"
								aria-pressed={selected?.path === entry.path}
								tabIndex={
									selected
										? selected.path === entry.path
											? 0
											: -1
										: index === 0
											? 0
											: -1
								}
								onKeyDown={event => {
									if (event.altKey || event.ctrlKey || event.metaKey) return;
									const next =
										event.key === 'ArrowDown'
											? Math.min(entries.length - 1, index + 1)
											: event.key === 'ArrowUp'
												? Math.max(0, index - 1)
												: event.key === 'Home'
													? 0
													: event.key === 'End'
														? entries.length - 1
														: -1;
									if (next < 0) return;
									event.preventDefault();
									if (next === index) return;
									const target = entries[next];
									const buttons =
										event.currentTarget.parentElement?.parentElement?.querySelectorAll<HTMLButtonElement>(
											'.review-entry',
										);
									buttons?.[next]?.focus();
									onShow(target.path, defaultSide(target, state.filter));
								}}
								onClick={() =>
									onShow(entry.path, defaultSide(entry, state.filter))
								}
							>
								<span className="review-path">{displayName(entry.path)}</span>
								<span className="review-state">{describeEntry(entry)}</span>
							</button>
						</li>
					))}
				</ul>
			)}
			{value.notShown > 0 && (
				<p className="files-hint" role="status">
					{value.notShown.toLocaleString('en')} more changed files not shown.
				</p>
			)}
			{selected && (
				<section className="review-diff" aria-label="diff">
					{offerView && (
						<div
							className="review-sides"
							role="group"
							aria-label="how much of this file to show"
						>
							<Button
								aria-pressed={state.view === 'agent'}
								onClick={() => onView('agent')}
							>
								agent changes
							</Button>
							<Button
								aria-pressed={state.view === 'all'}
								onClick={() => onView('all')}
							>
								every change
							</Button>
						</div>
					)}
					{state.view === 'agent' && state.diff?.note && (
						<p className="files-hint" role="status">
							{state.diff.note}
						</p>
					)}
					{both && (
						<div
							className="review-sides"
							role="group"
							aria-label="which changes to show"
						>
							<Button
								aria-pressed={!selected.staged}
								onClick={() => onShow(selected.path, false)}
							>
								unstaged
							</Button>
							<Button
								aria-pressed={selected.staged}
								onClick={() => onShow(selected.path, true)}
							>
								staged
							</Button>
						</div>
					)}
					{state.diff?.status === 'loading' && !state.diff.value && (
						<p role="status">reading the diff…</p>
					)}
					{state.diff?.status === 'error' && (
						<p role="alert">{state.diff.error}</p>
					)}
					{state.diff?.value?.kind === 'text' && interactionIdentity && (
						<DiffView
							key={interactionKey(interactionIdentity)}
							diff={state.diff.value}
							agent={agentView}
							commentReason={commentReason}
							interaction={interactionFor(
								interactions,
								interactionIdentity,
								state.diff.value.diff,
							)}
							onInteraction={next => onInteraction(interactionIdentity, next)}
							onComment={onComment}
							onOpenEditor={onOpenEditor}
						/>
					)}
					{state.diff?.value && state.diff.value.kind !== 'text' && (
						<div className="preview-metadata" role="status">
							<p>{state.diff.value.reason}</p>
							{state.diff.value.kind === 'too-large' && (
								<Button
									onClick={() => onOpenEditor(state.diff?.value?.path ?? '')}
								>
									open in editor
								</Button>
							)}
						</div>
					)}
					<Button onClick={onClear}>close diff</Button>
				</section>
			)}
		</div>
	);
}
