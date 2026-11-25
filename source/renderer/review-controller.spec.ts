import test from 'ava';
import {
	defaultSide,
	describeEntry,
	ReviewController,
	type ReviewState,
	visibleEntries,
} from '@/renderer/review-controller';
import type {FilesEvent} from '@/shared/files';
import type {IpcResult} from '@/shared/ipc';
import type {
	AgentDiff,
	ReviewDiff,
	ReviewEntry,
	ReviewStatus,
} from '@/shared/review';

const entry = (
	path: string,
	extra: Partial<ReviewEntry> = {},
): ReviewEntry => ({
	path,
	oldPath: null,
	staged: 'none',
	unstaged: 'none',
	untracked: false,
	conflicted: false,
	touched: false,
	...extra,
});

const status = (
	entries: ReviewEntry[],
	agentChanges: {enabled: boolean; reason: string | null} = {
		enabled: false,
		reason: null,
	},
): ReviewStatus => ({
	available: true,
	git: {path: '/usr/bin/git', version: '2.40.0'},
	head: 'h',
	branch: 'main',
	entries,
	notShown: 0,
	turn: null,
	agentChanges,
});

const ok = <T>(value: T): IpcResult<T> => ({ok: true, value});
const fail = (message: string): IpcResult<never> => ({
	ok: false,
	error: {code: 'UNAVAILABLE', message, retryable: false},
});
const textDiff = (path: string, staged: boolean): ReviewDiff => ({
	path,
	staged,
	kind: 'text',
	diff: '@@ -1 +1 @@\n-a\n+b\n',
	added: 1,
	removed: 1,
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => {
		resolve = done;
	});
	return {promise, resolve};
}

function fixture() {
	const calls: string[] = [];
	let listener: ((event: FilesEvent) => void) | undefined;
	const states: ReviewState[] = [];
	const holds: Array<ReturnType<typeof deferred<IpcResult<ReviewStatus>>>> = [];
	let current: IpcResult<ReviewStatus> = ok(status([]));
	let diff: (path: string, staged: boolean) => Promise<IpcResult<ReviewDiff>> =
		async (path, staged) => ok(textDiff(path, staged));
	let agent: (path: string) => Promise<IpcResult<AgentDiff>> = async path =>
		ok({
			path,
			kind: 'text',
			diff: '@@ -2 +2 @@\n-x\n+y\n',
			added: 1,
			removed: 1,
		});
	const controller = new ReviewController(
		{
			agentDiff: async ({path}) => {
				calls.push(`agent:${path}`);
				return agent(path);
			},
			status: async () => {
				calls.push('status');
				const hold = holds.shift();
				return hold ? hold.promise : current;
			},
			diff: async ({path, staged}) => {
				calls.push(`diff:${path}:${staged}`);
				return diff(path, staged);
			},
			onEvent: next => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
		},
		state => states.push(state),
	);
	return {
		controller,
		calls,
		holds,
		states,
		emit: (event: FilesEvent) => listener?.(event),
		set: (value: IpcResult<ReviewStatus>) => {
			current = value;
		},
		setAgent: (next: typeof agent) => {
			agent = next;
		},
		setDiff: (next: typeof diff) => {
			diff = next;
		},
		flush: () => new Promise<void>(resolve => setImmediate(resolve)),
	};
}

test('GIT-03 staged, unstaged and touched are separate filters over the same paths', t => {
	const value = status([
		entry('a.ts', {staged: 'modified'}),
		entry('b.ts', {unstaged: 'modified'}),
		entry('c.ts', {staged: 'added', unstaged: 'modified', touched: true}),
		entry('d.ts', {untracked: true}),
		entry('e.ts', {conflicted: true}),
	]);
	const names = (filter: Parameters<typeof visibleEntries>[1]) =>
		visibleEntries(value, filter).map(item => item.path);
	t.deepEqual(names('all'), ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
	t.deepEqual(names('staged'), ['a.ts', 'c.ts']);
	t.deepEqual(names('unstaged'), ['b.ts', 'c.ts', 'd.ts', 'e.ts']);
	t.deepEqual(names('touched'), ['c.ts']);
	t.deepEqual(visibleEntries(null, 'all'), []);
	t.deepEqual(visibleEntries({available: false, reason: 'No Git'}, 'all'), []);
});

test('GIT-03 the staged side opens first only when nothing is left unstaged', t => {
	t.true(defaultSide(entry('a', {staged: 'modified'})));
	t.false(defaultSide(entry('a', {staged: 'modified', unstaged: 'modified'})));
	t.false(defaultSide(entry('a', {unstaged: 'modified'})));
	t.false(defaultSide(entry('a', {untracked: true})));
	t.false(defaultSide(entry('a', {staged: 'added', conflicted: true})));
});

test('GIT-06 selecting a project reads its status; leaving it drops a late answer', async t => {
	const f = fixture();
	const hold = deferred<IpcResult<ReviewStatus>>();
	f.holds.push(hold);
	f.controller.select('one');
	f.controller.select('two');
	hold.resolve(ok(status([entry('stale.ts', {unstaged: 'modified'})])));
	await f.flush();
	t.false(JSON.stringify(f.controller.getState()).includes('stale.ts'));
	t.is(f.controller.getState().projectId, 'two');
	t.is(f.controller.getState().status, 'ready');
	f.controller.select(null);
	t.is(f.controller.getState().status, 'idle');
});

test('GIT-06 a review-changed event reads again, and several during one read become one more read', async t => {
	const f = fixture();
	f.controller.select('p');
	await f.flush();
	f.calls.length = 0;
	const hold = deferred<IpcResult<ReviewStatus>>();
	f.holds.push(hold);
	f.emit({type: 'review-changed', projectId: 'p'});
	f.emit({type: 'review-changed', projectId: 'p'});
	f.emit({type: 'review-changed', projectId: 'p'});
	f.emit({type: 'review-changed', projectId: 'other'});
	f.emit({type: 'watch-limit', projectId: 'p'});
	t.deepEqual(f.calls, ['status']);
	hold.resolve(ok(status([entry('a.ts', {unstaged: 'modified'})])));
	await f.flush();
	t.deepEqual(f.calls, ['status', 'status']);
	t.is(visibleEntries(f.controller.getState().value, 'all').length, 0);
});

test('GIT-13 a repository that cannot be read keeps the last good view and says why', async t => {
	const f = fixture();
	f.set(ok(status([entry('a.ts', {unstaged: 'modified'})])));
	f.controller.select('p');
	await f.flush();
	f.set(fail('The repository is too large to scan'));
	await f.controller.refresh();
	const state = f.controller.getState();
	t.is(state.status, 'error');
	t.is(state.error, 'The repository is too large to scan');
	t.is(visibleEntries(state.value, 'all').length, 1);
	f.set(
		ok({
			available: false,
			reason: 'This folder is not a Git repository, so review is unavailable',
		}),
	);
	await f.controller.refresh();
	t.is(f.controller.getState().status, 'ready');
	t.false(f.controller.getState().value?.available);
});

test('GIT-04 opening review with one change selects its diff immediately', async t => {
	const f = fixture();
	f.set(ok(status([entry('only.ts', {unstaged: 'modified'})])));
	f.controller.select('p');
	await f.flush();
	t.deepEqual(f.controller.getState().selected, {
		path: 'only.ts',
		staged: false,
	});
	t.is(f.controller.getState().diff?.value?.path, 'only.ts');
	t.deepEqual(f.calls, ['status', 'diff:only.ts:false']);
});

test('GIT-04 opening review with several changes preserves a valid selection and otherwise waits', async t => {
	const f = fixture();
	f.set(
		ok(
			status([
				entry('a.ts', {unstaged: 'modified'}),
				entry('b.ts', {staged: 'modified'}),
			]),
		),
	);
	f.controller.select('p');
	await f.flush();
	t.is(f.controller.getState().selected, null);
	t.deepEqual(f.calls, ['status']);
	await f.controller.show('b.ts', true);
	await f.controller.refresh();
	await f.flush();
	t.deepEqual(f.controller.getState().selected, {path: 'b.ts', staged: true});
	t.is(f.controller.getState().diff?.value?.path, 'b.ts');
	f.set(ok(status([entry('a.ts', {unstaged: 'modified'})])));
	await f.controller.refresh();
	await f.flush();
	t.is(f.controller.getState().selected, null);
	t.is(f.controller.getState().diff, null);
});

test('GIT-03 changing filters keeps a valid selection and clears one outside the filter', async t => {
	const f = fixture();
	f.set(
		ok(
			status([
				entry('a.ts', {unstaged: 'modified'}),
				entry('b.ts', {staged: 'modified'}),
			]),
		),
	);
	f.controller.select('p');
	await f.flush();
	await f.controller.show('b.ts', true);
	f.controller.setFilter('unstaged');
	t.is(f.controller.getState().selected, null);
	t.is(f.controller.getState().diff, null);
	await f.controller.show('a.ts', false);
	f.controller.setFilter('unstaged');
	t.deepEqual(f.controller.getState().selected, {path: 'a.ts', staged: false});
});

test('GIT-06 a refresh clears a selected side that disappeared from the index', async t => {
	const f = fixture();
	f.set(ok(status([entry('a.ts', {staged: 'modified'})])));
	f.controller.select('p');
	await f.flush();
	await f.controller.show('a.ts', true);
	f.set(ok(status([entry('a.ts', {unstaged: 'modified'})])));
	await f.controller.refresh();
	await f.flush();
	t.is(f.controller.getState().selected, null);
	t.is(f.controller.getState().diff, null);
});

test('GIT-05 a refresh clears a selection that is no longer touched', async t => {
	const f = fixture();
	f.set(ok(status([entry('a.ts', {unstaged: 'modified', touched: true})])));
	f.controller.select('p');
	await f.flush();
	await f.controller.show('a.ts', false);
	f.controller.setFilter('touched');
	f.set(ok(status([entry('a.ts', {unstaged: 'modified'})])));
	await f.controller.refresh();
	await f.flush();
	t.is(f.controller.getState().selected, null);
	t.is(f.controller.getState().diff, null);
});

test('GIT-04 review opening after a clean Files read selects the new sole change', async t => {
	const f = fixture();
	f.controller.setOpen(false);
	f.set(ok(status([])));
	f.controller.select('p');
	await f.flush();
	f.set(ok(status([entry('only.ts', {unstaged: 'modified'})])));
	await f.controller.refresh();
	await f.flush();
	t.is(f.controller.getState().selected, null);
	f.controller.setOpen(true);
	await f.flush();
	t.deepEqual(f.controller.getState().selected, {
		path: 'only.ts',
		staged: false,
	});
});

test('GIT-03 duplicate Git records for a path retain both sides through refresh', async t => {
	const f = fixture();
	f.set(
		ok(
			status([
				entry('a.ts', {staged: 'deleted'}),
				entry('a.ts', {untracked: true}),
			]),
		),
	);
	f.controller.select('p');
	await f.flush();
	t.is(visibleEntries(f.controller.getState().value, 'all').length, 1);
	await f.controller.show('a.ts', false);
	await f.controller.refresh();
	await f.flush();
	t.deepEqual(f.controller.getState().selected, {path: 'a.ts', staged: false});
});

test('GIT-04 showing a file reads that side only, and a late diff for an earlier file is dropped', async t => {
	const f = fixture();
	f.controller.select('p');
	await f.flush();
	const slow = deferred<IpcResult<ReviewDiff>>();
	f.setDiff(async (path, staged) =>
		path === 'a.ts' ? slow.promise : ok(textDiff(path, staged)),
	);
	void f.controller.show('a.ts', false);
	await f.controller.show('b.ts', true);
	slow.resolve(ok(textDiff('a.ts', false)));
	await f.flush();
	const state = f.controller.getState();
	t.deepEqual(state.selected, {path: 'b.ts', staged: true});
	t.is(state.diff?.value?.path, 'b.ts');
	f.setDiff(async () => fail('Git could not produce this diff'));
	await f.controller.show('c.ts', false);
	t.is(f.controller.getState().diff?.status, 'error');
	t.is(f.controller.getState().diff?.error, 'Git could not produce this diff');
	f.controller.clearSelection();
	t.is(f.controller.getState().selected, null);
	t.is(f.controller.getState().diff, null);
});

test('GIT-06 a refresh reloads the diff that is open so it never goes stale', async t => {
	const f = fixture();
	f.controller.select('p');
	await f.flush();
	await f.controller.show('a.ts', false);
	f.set(ok(status([entry('a.ts', {unstaged: 'modified'})])));
	f.calls.length = 0;
	await f.controller.refresh();
	await f.flush();
	t.deepEqual(f.calls, ['status', 'diff:a.ts:false']);
	t.is(f.controller.getState().diff?.status, 'ready');
});

test('GIT-03 the filter changes without another read', async t => {
	const f = fixture();
	f.controller.select('p');
	await f.flush();
	f.calls.length = 0;
	f.controller.setFilter('staged');
	t.is(f.controller.getState().filter, 'staged');
	t.deepEqual(f.calls, []);
});

test('GIT-06 disposing stops listening and ignores late answers', async t => {
	const f = fixture();
	const hold = deferred<IpcResult<ReviewStatus>>();
	f.holds.push(hold);
	f.controller.select('p');
	f.controller.dispose();
	f.emit({type: 'review-changed', projectId: 'p'});
	const seen = f.states.length;
	hold.resolve(ok(status([])));
	await f.flush();
	t.is(f.states.length, seen);
});

test('GIT-05 each review row is one plain sentence, with no reliance on colour', t => {
	t.is(
		describeEntry(entry('a.ts', {unstaged: 'modified'})),
		'unstaged modified',
	);
	t.is(
		describeEntry(
			entry('a.ts', {staged: 'added', unstaged: 'modified', touched: true}),
		),
		'staged added, unstaged modified, touched in the last turn',
	);
	t.is(describeEntry(entry('n.ts', {untracked: true})), 'untracked');
	t.is(
		describeEntry(entry('new.ts', {staged: 'renamed', oldPath: 'old.ts'})),
		'staged renamed, from old.ts',
	);
	t.is(
		describeEntry(entry('c.ts', {conflicted: true, unstaged: 'modified'})),
		'has a merge conflict, unstaged modified',
	);
	t.is(describeEntry(entry('x.ts')), '');
});

const touchedFile = (path: string) =>
	entry(path, {unstaged: 'modified', touched: true});
const on = {enabled: true, reason: null};

test('GIT-09 a touched file opens as only the agent lines when Nanocoder confirmed it', async t => {
	const f = fixture();
	f.set(ok(status([touchedFile('a.ts')], on)));
	f.controller.select('p');
	await f.flush();
	f.calls.length = 0;
	await f.controller.show('a.ts', false);
	t.deepEqual(f.calls, ['agent:a.ts']);
	const diff = f.controller.getState().diff;
	t.is(diff?.source, 'agent');
	t.is(diff?.note, null);
	t.is(diff?.value?.kind, 'text');
});

test('GIT-09 all changes shows what Git sees, and switching back asks for the agent lines again', async t => {
	const f = fixture();
	f.set(ok(status([touchedFile('a.ts')], on)));
	f.controller.select('p');
	await f.flush();
	await f.controller.show('a.ts', false);
	f.calls.length = 0;
	f.controller.setView('all');
	await f.flush();
	t.deepEqual(f.calls, ['diff:a.ts:false']);
	t.is(f.controller.getState().diff?.source, 'git');
	f.calls.length = 0;
	f.controller.setView('agent');
	await f.flush();
	t.deepEqual(f.calls, ['agent:a.ts']);
});

test('GIT-10 when the agent lines cannot be told apart the file falls back to Git with the reason', async t => {
	const f = fixture();
	f.set(ok(status([touchedFile('a.ts')], on)));
	f.controller.select('p');
	await f.flush();
	f.setAgent(async path =>
		ok({path, kind: 'fallback', reason: 'Nanocoder no longer keeps it'}),
	);
	f.calls.length = 0;
	await f.controller.show('a.ts', false);
	t.deepEqual(f.calls, ['agent:a.ts', 'diff:a.ts:false']);
	const diff = f.controller.getState().diff;
	t.is(diff?.source, 'git');
	t.is(diff?.note, 'Nanocoder no longer keeps it');
	f.setAgent(async () => fail('boom'));
	await f.controller.show('a.ts', false);
	t.is(f.controller.getState().diff?.source, 'git');
	t.truthy(f.controller.getState().diff?.note);
});

test('GIT-10 with the feature off a touched file shows Git and the gate reason, without asking Nanocoder', async t => {
	const f = fixture();
	f.set(
		ok(status([touchedFile('a.ts')], {enabled: false, reason: 'Not offered'})),
	);
	f.controller.select('p');
	await f.flush();
	f.calls.length = 0;
	await f.controller.show('a.ts', false);
	t.deepEqual(f.calls, ['diff:a.ts:false']);
	t.is(f.controller.getState().diff?.note, 'Not offered');
});

test('GIT-09 a file the last turn did not touch never asks for agent lines', async t => {
	const f = fixture();
	f.set(ok(status([entry('b.ts', {unstaged: 'modified'})], on)));
	f.controller.select('p');
	await f.flush();
	f.calls.length = 0;
	await f.controller.show('b.ts', false);
	t.deepEqual(f.calls, ['diff:b.ts:false']);
	t.is(f.controller.getState().diff?.note, null);
});
