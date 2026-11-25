import test from 'ava';
import {filterActions, runAction} from '@/renderer/overlay-model';
import {
	importPalette,
	threadPalette,
	threadSearchPalette,
} from '@/renderer/thread-palette';
import type {ThreadInfo} from '@/shared/ipc';

const thread: ThreadInfo = {
	id: '22222222-2222-4222-8222-222222222222',
	projectId: '11111111-1111-4111-8111-111111111111',
	nanocoderSessionId: null,
	title: 'fixture thread',
	archiveState: 'active',
	runState: 'new',
	lastActivityAt: '2026-10-29T00:00:00.000Z',
	sessionCwd: '/fixture/project',
	mode: 'normal',
	viewOnlyReason: null,
};

function fixture(overrides: Partial<Parameters<typeof threadPalette>[0]> = {}) {
	const calls: unknown[] = [];
	const actions = threadPalette({
		projectId: thread.projectId,
		projectName: 'tide',
		newShortcut: '⌘N',
		thread,
		pending: false,
		onNew: () => {
			calls.push(['new']);
		},
		onRename: threadId => {
			calls.push(['rename', threadId]);
		},
		onArchive: (threadId, archived) => {
			calls.push(['archive', threadId, archived]);
		},
		...overrides,
	});
	return {actions, calls};
}

test('thread palette exposes the actual new rename and archive callbacks (CHAT-03, CHAT-12, CHAT-13)', t => {
	const {actions, calls} = fixture();
	t.deepEqual(
		actions.map(action => action.label),
		['new thread in tide', 'rename thread', 'archive thread'],
	);
	for (const action of actions) t.true(runAction(action));
	t.deepEqual(calls, [
		['new'],
		['rename', thread.id],
		['archive', thread.id, true],
	]);
});

test('new thread shows the new thread shortcut and opens its dialog (D1, E-12, E-19)', t => {
	const {actions} = fixture();
	t.is(actions[0]?.shortcut, '⌘N');
	t.true(actions[0]?.opensDialog);
	const bare = fixture({projectName: undefined}).actions;
	t.is(bare[0]?.label, 'new thread');
});

test('rename and archive open their dialogs and do not close the palette first (E-02, E-24)', t => {
	const {actions} = fixture();
	t.true(actions[1]?.opensDialog);
	t.true(actions[2]?.opensDialog);
	const unarchive = fixture({
		thread: {...thread, archiveState: 'archived'},
	}).actions;
	t.is(unarchive[2]?.label, 'unarchive thread');
	t.false(unarchive[2]?.opensDialog);
});

test('unavailable thread palette actions give reasons and never invoke their callbacks (CHAT-03, CHAT-12, CHAT-13)', t => {
	for (const [overrides, enabled] of [
		[{projectId: null}, [false, false, false]],
		[{thread: null}, [true, false, false]],
		[{thread: {...thread, projectId: 'other-project'}}, [true, false, false]],
		[{pending: true}, [false, false, false]],
		[{thread: {...thread, runState: 'running'}}, [true, false, false]],
		[{thread: {...thread, runState: 'waiting-approval'}}, [true, false, false]],
		[
			{renameDisabledReason: 'Nanocoder did not confirm rename'},
			[true, false, true],
		],
	] as const) {
		const {actions, calls} = fixture(overrides);
		t.is(actions.length, 3);
		for (const [index, action] of actions.entries()) {
			const previous = [...calls];
			t.is(runAction(action), enabled[index]);
			if (!enabled[index]) {
				t.truthy(action.disabledReason);
				t.deepEqual(calls, previous);
			}
		}
	}
});

test('project turns refuse thread metadata changes but not a new draft, as the rail button does (E-35)', t => {
	const {actions, calls} = fixture({projectBusy: true});
	t.true(runAction(actions[0]));
	t.is(
		actions[1]?.disabledReason,
		'another project turn owns these actions. stop it or wait before changing thread metadata.',
	);
	t.is(actions[2]?.disabledReason, actions[1]?.disabledReason);
	t.false(runAction(actions[1]));
	t.false(runAction(actions[2]));
	t.deepEqual(calls, [['new']]);
});

test('archived thread palette command unarchives the selected thread (CHAT-13)', t => {
	const {actions, calls} = fixture({
		thread: {...thread, archiveState: 'archived'},
	});
	t.is(actions[2]?.label, 'unarchive thread');
	t.true(runAction(actions[2]));
	t.deepEqual(calls, [['archive', thread.id, false]]);
});

test('import saved sessions moves to the rail list only when it is shown (E-11)', t => {
	let imports = 0;
	const [ready] = importPalette({
		ready: true,
		onImport: () => {
			imports++;
		},
	});
	t.is(ready?.label, 'import saved sessions');
	t.true(runAction(ready));
	t.is(imports, 1);
	const [waiting] = importPalette({ready: false, onImport: () => imports++});
	t.truthy(waiting?.disabledReason);
	t.false(runAction(waiting));
	t.is(imports, 1);
});

test('rename receives only the thread id, never palette focus or thread authority', t => {
	let received: unknown[] = [];
	const {actions} = fixture({
		onRename: (...args) => {
			received = args;
		},
	});
	t.true(runAction(actions[1]));
	t.deepEqual(received, [thread.id]);
});

test('rename and archive keep their own keywords, never the selected title', t => {
	const {actions} = fixture();
	t.is(actions[1]?.keywords, 'name chat session');
	t.is(actions[2]?.keywords, 'history chat session');
	t.deepEqual(filterActions(actions, 'fixture thread'), []);
	t.deepEqual(
		filterActions(actions, 'rename').map(item => item.id),
		['thread-rename'],
	);
	t.deepEqual(
		filterActions(actions, 'archive').map(item => item.id),
		['thread-archive'],
	);
});

test('thread search uses current-project metadata and marks the selected thread', t => {
	const opened: string[] = [];
	const archived = {
		...thread,
		id: '33333333-3333-4333-8333-333333333333',
		title: 'archived fixture',
		archiveState: 'archived' as const,
	};
	const results = threadSearchPalette({
		projectId: thread.projectId,
		threads: [
			thread,
			archived,
			{...thread, id: 'other-project', projectId: 'other-project'},
		],
		activeThreadId: thread.id,
		pending: false,
		onOpen: id => opened.push(id),
	});
	t.deepEqual(
		results.map(result => ({
			id: result.id,
			archived: result.archived,
			current: result.current,
		})),
		[
			{id: `thread-open-${thread.id}`, archived: false, current: true},
			{id: `thread-open-${archived.id}`, archived: true, current: false},
		],
	);
	t.true(runAction(results[0]));
	t.true(runAction(results[1]));
	t.deepEqual(opened, [thread.id, archived.id]);
});

test('pending thread requests disable search results without hiding them', t => {
	const [result] = threadSearchPalette({
		projectId: thread.projectId,
		threads: [thread],
		activeThreadId: null,
		pending: true,
		onOpen: () => t.fail('a pending open must not run'),
	});
	t.is(result?.disabledReason, 'another thread request is pending');
	t.false(runAction(result));
});
