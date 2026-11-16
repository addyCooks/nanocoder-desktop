import * as React from 'react';
import {
	type DiffCursor,
	type DiffRow,
	diffKey,
	parseDiff,
	selectLines,
} from '@/renderer/diff-parse';
import {keyHint} from '@/renderer/overlay-model';
import {
	defaultSide,
	describeEntry,
	type ReviewFilter,
	type ReviewState,
	type ReviewView,
	visibleEntries,
} from '@/renderer/review-controller';
import {Button} from '@/renderer/ui';
import {displayName} from '@/shared/files';
import type {PromptAttachment} from '@/shared/ipc';
import type {ReviewDiff, ReviewEntry} from '@/shared/review';

// Very large diffs show their first lines; the rest is for an editor (PERF-08).
const MAX_ROWS = 5_000;

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
	onComment,
	onOpenEditor,
}: {
	diff: Extract<ReviewDiff, {kind: 'text'}>;
	agent: boolean;
	commentReason: string | null;
	onComment(comment: CommentAttachment): void;
	onOpenEditor(path: string, line?: number): void;
}): React.ReactElement {
	const rows = React.useMemo(() => parseDiff(diff.diff), [diff.diff]);
	const shown = rows.slice(0, MAX_ROWS);
	const [cursor, setCursor] = React.useState<DiffCursor | null>(null);
	const [comment, setComment] = React.useState('');
	const [added, setAdded] = React.useState<string | null>(null);
	const nodes = React.useRef(new Map<number, HTMLElement>());
	const pending = React.useRef<number | null>(null);
	// The diff itself changed, so any earlier selection no longer points at the same lines.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the text changes
	React.useEffect(() => {
		setCursor(null);
	}, [diff.diff]);
	React.useEffect(() => {
		if (pending.current === null) return;
		nodes.current.get(pending.current)?.focus();
		pending.current = null;
	});
	const selection = cursor
		? selectLines(shown, cursor.anchor, cursor.cursor)
		: null;
	const low = cursor ? Math.min(cursor.anchor, cursor.cursor) : -1;
	const high = cursor ? Math.max(cursor.anchor, cursor.cursor) : -1;
	const first = shown.findIndex(row => row.selectable);
	const tabbable = cursor ? cursor.cursor : first;
	const side = diff.staged ? 'staged' : 'unstaged';
	const label = agent ? 'agent changes' : side;
	const described = agent ? 'agent changes' : `${side} changes`;
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
				className="diff-lines"
				role="listbox"
				aria-label={`${described} in ${displayName(diff.path)}. select lines to comment on them`}
				aria-multiselectable="true"
				onKeyDown={event => {
					if (event.altKey || event.ctrlKey || event.metaKey) return;
					if (event.key === 'Escape' && cursor) {
						event.preventDefault();
						event.stopPropagation();
						setCursor(null);
						return;
					}
					const next = diffKey(
						shown,
						cursor ??
							(tabbable >= 0 ? {anchor: tabbable, cursor: tabbable} : null),
						event.key,
						event.shiftKey,
					);
					if (!next) return;
					event.preventDefault();
					pending.current = next.cursor;
					setCursor(next);
				}}
			>
				{shown.map((row, index) => (
					<div
						// Rows never reorder within one diff, so their position is their identity.
						key={index}
						ref={node => {
							if (node) nodes.current.set(index, node);
							else nodes.current.delete(index);
						}}
						role="option"
						aria-selected={
							row.selectable ? index >= low && index <= high : undefined
						}
						aria-disabled={row.selectable ? undefined : true}
						tabIndex={index === tabbable ? 0 : -1}
						className={`diff-row diff-row--${row.kind}${
							row.selectable && index >= low && index <= high
								? ' diff-row--selected'
								: ''
						}`}
						onClick={event => {
							if (!row.selectable) return;
							setAdded(null);
							setCursor(
								event.shiftKey && cursor
									? {anchor: cursor.anchor, cursor: index}
									: {anchor: index, cursor: index},
							);
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
				))}
				{rows.length > MAX_ROWS && (
					<div
						className="diff-more"
						role="option"
						aria-disabled="true"
						aria-selected={undefined}
					>
						{(rows.length - MAX_ROWS).toLocaleString('en')} more lines not
						shown. open the file in an editor to review them.
					</div>
				)}
			</div>
			{selection && (
				<form
					className="review-comment"
					aria-label="review comment"
					onSubmit={event => {
						event.preventDefault();
						const text = comment.trim();
						if (!text || commentReason) return;
						onComment({
							kind: 'review-comment',
							path: diff.path,
							startLine: selection.startLine,
							endLine: selection.endLine,
							side,
							comment: text,
							excerpt: selection.excerpt,
						});
						setComment('');
						setCursor(null);
						setAdded(
							`comment on ${displayName(diff.path)}:${selection.startLine} added. it goes with your next message.`,
						);
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
							onChange={event => setComment(event.target.value)}
							onKeyDown={event => event.stopPropagation()}
						/>
					</label>
					{commentReason && <p className="files-hint">{commentReason}</p>}
					<div className="review-comment-actions">
						<Button
							type="submit"
							disabled={!comment.trim() || commentReason !== null}
						>
							add to next message
						</Button>
						<Button onClick={() => setCursor(null)}>clear selection</Button>
					</div>
				</form>
			)}
			{added && (
				<p role="status" className="files-hint">
					{added}
				</p>
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
		? value.entries.find(entry => entry.path === selected.path)
		: undefined;
	const agentView = state.diff?.source === 'agent';
	const offerView = current?.touched === true && value.agentChanges.enabled;
	const both =
		!agentView &&
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
					{entries.map(entry => (
						<li key={entry.path}>
							<button
								type="button"
								className="review-entry"
								aria-pressed={selected?.path === entry.path}
								onClick={() => onShow(entry.path, defaultSide(entry))}
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
					{state.diff?.value?.kind === 'text' && (
						<DiffView
							key={`${state.diff.value.path}:${state.diff.value.staged}:${state.diff.source}`}
							diff={state.diff.value}
							agent={agentView}
							commentReason={commentReason}
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
