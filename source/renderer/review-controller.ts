import type {FilesApi} from '@/shared/files';
import type {
	AgentDiff,
	ReviewApi,
	ReviewDiff,
	ReviewEntry,
	ReviewStatus,
} from '@/shared/review';

export type ReviewFilter = 'all' | 'staged' | 'unstaged' | 'touched';

// Whether a touched file opens as only the agent's lines or as everything Git sees (GIT-09).
export type ReviewView = 'agent' | 'all';

export interface ReviewState {
	projectId: string | null;
	status: 'idle' | 'loading' | 'ready' | 'error';
	value: ReviewStatus | null;
	error: string | null;
	filter: ReviewFilter;
	view: ReviewView;
	selected: {path: string; staged: boolean} | null;
	diff: {
		status: 'loading' | 'ready' | 'error';
		value: ReviewDiff | null;
		error: string | null;
		// Only the agent's lines, as Nanocoder's snapshot shows them.
		source: 'agent' | 'git';
		// Why the agent's lines are not shown for a file the last turn touched (GIT-10).
		note: string | null;
	} | null;
}

export type ReviewBridge = Pick<ReviewApi, 'status' | 'diff' | 'agentDiff'> &
	Pick<FilesApi, 'onEvent'>;

export const emptyReviewState = (projectId: string | null): ReviewState => ({
	projectId,
	status: 'idle',
	value: null,
	error: null,
	filter: 'all',
	view: 'agent',
	selected: null,
	diff: null,
});

// GIT-03: staged and unstaged are separate views of the same paths.
export function visibleEntries(
	value: ReviewStatus | null,
	filter: ReviewFilter,
): ReviewEntry[] {
	if (!value?.available) return [];
	const paths = new Map<string, ReviewEntry>();
	for (const entry of value.entries) {
		const previous = paths.get(entry.path);
		paths.set(
			entry.path,
			previous
				? {
						...previous,
						oldPath: previous.oldPath ?? entry.oldPath,
						staged: previous.staged === 'none' ? entry.staged : previous.staged,
						unstaged:
							previous.unstaged === 'none' ? entry.unstaged : previous.unstaged,
						untracked: previous.untracked || entry.untracked,
						conflicted: previous.conflicted || entry.conflicted,
						touched: previous.touched || entry.touched,
					}
				: entry,
		);
	}
	return [...paths.values()].filter(entry => {
		switch (filter) {
			case 'staged':
				return entry.staged !== 'none';
			case 'unstaged':
				return entry.unstaged !== 'none' || entry.untracked || entry.conflicted;
			case 'touched':
				return entry.touched;
			default:
				return true;
		}
	});
}

// Which side opens first: staged only when nothing is left unstaged.
export function defaultSide(
	entry: ReviewEntry,
	filter: ReviewFilter = 'all',
): boolean {
	if (filter === 'staged') return true;
	if (filter === 'unstaged') return false;
	return (
		entry.staged !== 'none' &&
		entry.unstaged === 'none' &&
		!entry.untracked &&
		!entry.conflicted
	);
}

function selectionIsVisible(
	selected: {path: string; staged: boolean},
	entries: readonly ReviewEntry[],
	filter: ReviewFilter,
): boolean {
	const entry = entries.find(item => item.path === selected.path);
	if (!entry) return false;
	if (selected.staged && entry.staged === 'none') return false;
	if (
		!selected.staged &&
		entry.unstaged === 'none' &&
		!entry.untracked &&
		!entry.conflicted
	)
		return false;
	if (filter === 'staged') return selected.staged;
	if (filter === 'unstaged') return !selected.staged;
	if (filter === 'touched') return entry.touched;
	return true;
}

function fromAgent(diff: AgentDiff): ReviewDiff {
	return diff.kind === 'text'
		? {...diff, staged: false}
		: {path: diff.path, staged: false, kind: 'none', reason: diff.reason};
}

export class ReviewController {
	private state: ReviewState = emptyReviewState(null);
	private epoch = 0;
	private statusToken = 0;
	private diffToken = 0;
	private running = false;
	private dirty = false;
	private disposed = false;
	private open = true;
	private selectOnRead = false;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly bridge: ReviewBridge,
		private readonly changed: (state: ReviewState) => void,
	) {
		this.unsubscribe = bridge.onEvent(event => {
			if (
				!this.disposed &&
				event.type === 'review-changed' &&
				event.projectId === this.state.projectId
			)
				void this.refresh();
		});
	}

	getState(): ReviewState {
		return this.state;
	}

	setOpen(open: boolean): void {
		if (open === this.open) return;
		this.open = open;
		if (!open) return;
		this.selectOnRead = true;
		void this.refresh();
	}

	select(projectId: string | null): void {
		if (projectId === this.state.projectId) return;
		++this.epoch;
		this.running = false;
		this.dirty = false;
		this.update(emptyReviewState(projectId));
		if (projectId) void this.refresh();
	}

	setFilter(filter: ReviewFilter): void {
		const selected = this.state.selected;
		if (
			selected &&
			!selectionIsVisible(
				selected,
				visibleEntries(this.state.value, filter),
				filter,
			)
		) {
			++this.diffToken;
			this.update({...this.state, filter, selected: null, diff: null});
			return;
		}
		this.update({...this.state, filter});
	}

	setView(view: ReviewView): void {
		if (view === this.state.view) return;
		this.update({...this.state, view});
		const selected = this.state.selected;
		if (selected) void this.show(selected.path, selected.staged);
	}

	// Changes that arrive while a read is running are folded into one more read.
	async refresh(): Promise<void> {
		const projectId = this.state.projectId;
		if (!projectId) return;
		if (this.running) {
			this.dirty = true;
			return;
		}
		this.running = true;
		const epoch = this.epoch;
		const token = ++this.statusToken;
		this.update({
			...this.state,
			status: this.state.value ? 'ready' : 'loading',
			error: null,
		});
		const result = await this.bridge.status({projectId}).catch(() => null);
		if (this.disposed || epoch !== this.epoch) return;
		this.running = false;
		if (token === this.statusToken) {
			const opening =
				this.open && (this.state.value === null || this.selectOnRead);
			this.update({
				...this.state,
				status: result?.ok ? 'ready' : 'error',
				value: result?.ok ? result.value : this.state.value,
				error: result?.ok
					? null
					: result
						? result.error.message
						: 'The repository could not be read',
			});
			const selected = this.state.selected;
			if (result?.ok) {
				const entries = visibleEntries(this.state.value, this.state.filter);
				if (this.open && entries.length > 0) this.selectOnRead = false;
				if (selected) {
					if (selectionIsVisible(selected, entries, this.state.filter))
						void this.show(selected.path, selected.staged);
					else this.clearSelection();
				} else if (opening && entries.length === 1) {
					const only = entries[0];
					void this.show(only.path, defaultSide(only, this.state.filter));
				}
			}
		}
		if (this.dirty) {
			this.dirty = false;
			void this.refresh();
		}
	}

	async show(path: string, staged: boolean): Promise<void> {
		const projectId = this.state.projectId;
		if (!projectId) return;
		const epoch = this.epoch;
		const token = ++this.diffToken;
		const reload =
			this.state.selected?.path === path &&
			this.state.selected.staged === staged;
		const previous = reload ? this.state.diff : null;
		this.update({
			...this.state,
			selected: {path, staged},
			diff: {
				status: 'loading',
				value: previous?.value ?? null,
				error: null,
				source: previous?.source ?? 'git',
				note: previous?.note ?? null,
			},
		});
		const current = this.state.value?.available ? this.state.value : null;
		const touched =
			current?.entries.some(entry => entry.path === path && entry.touched) ??
			false;
		let note: string | null = null;
		if (!staged && this.state.view === 'agent' && touched && current) {
			if (current.agentChanges.enabled) {
				const agent = await this.bridge
					.agentDiff({projectId, path})
					.catch(() => null);
				if (this.disposed || epoch !== this.epoch || token !== this.diffToken)
					return;
				if (agent?.ok && agent.value.kind !== 'fallback') {
					this.update({
						...this.state,
						diff: {
							status: 'ready',
							value: fromAgent(agent.value),
							error: null,
							source: 'agent',
							note: null,
						},
					});
					return;
				}
				note = agent?.ok
					? agent.value.kind === 'fallback'
						? agent.value.reason
						: null
					: "The agent's own lines could not be read.";
			} else note = current.agentChanges.reason;
		}
		const result = await this.bridge
			.diff({projectId, path, staged})
			.catch(() => null);
		if (this.disposed || epoch !== this.epoch || token !== this.diffToken)
			return;
		this.update({
			...this.state,
			diff: result?.ok
				? {
						status: 'ready',
						value: result.value,
						error: null,
						source: 'git',
						note,
					}
				: {
						status: 'error',
						value: null,
						error: result ? result.error.message : 'The diff could not be read',
						source: 'git',
						note,
					},
		});
	}

	clearSelection(): void {
		++this.diffToken;
		this.update({...this.state, selected: null, diff: null});
	}

	dispose(): void {
		this.disposed = true;
		++this.epoch;
		this.unsubscribe();
	}

	private update(next: ReviewState): void {
		if (this.disposed) return;
		this.state = next;
		this.changed(next);
	}
}

const STATE_WORDS = {
	none: '',
	modified: 'modified',
	added: 'added',
	deleted: 'deleted',
	renamed: 'renamed',
} as const;

// One plain sentence for a row of the review list, used by screen readers and
// as the visible summary, so neither depends on colour.
export function describeEntry(entry: ReviewEntry): string {
	const parts: string[] = [];
	if (entry.conflicted) parts.push('has a merge conflict');
	if (entry.untracked) parts.push('untracked');
	if (entry.staged !== 'none')
		parts.push(`staged ${STATE_WORDS[entry.staged]}`);
	if (entry.unstaged !== 'none')
		parts.push(`unstaged ${STATE_WORDS[entry.unstaged]}`);
	if (entry.oldPath) parts.push(`from ${entry.oldPath}`);
	if (entry.touched) parts.push('touched in the last turn');
	return parts.join(', ');
}
