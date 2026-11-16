import test from 'ava';
import {
	commandModifier,
	dialogLabel,
	filterActions,
	focusReturn,
	importedToast,
	keyHint,
	moveSelection,
	notifyImported,
	type PaletteAction,
	runAction,
	type Toast,
	toastQueue,
} from '@/renderer/overlay-model';

function action(id: string, label: string, keywords = ''): PaletteAction {
	return {id, label, glyph: '○', keywords, run() {}};
}

test('palette filtering matches every query word without case sensitivity', t => {
	const actions = [
		action('open', 'open a project folder'),
		action('theme', 'switch theme'),
	];
	t.deepEqual(filterActions(actions, ' PROJECT open '), [actions[0]]);
	t.deepEqual(filterActions(actions, 'missing'), []);
	t.deepEqual(filterActions(actions, '   '), actions);
});

test('palette ranking prefers exact labels then prefixes then words then keywords', t => {
	const actions = [
		action('keyword', 'change appearance', 'theme'),
		action('word', 'switch theme'),
		action('prefix', 'theme settings'),
		action('exact', 'theme'),
	];
	t.deepEqual(
		filterActions(actions, 'theme').map(item => item.id),
		['exact', 'prefix', 'word', 'keyword'],
	);
});

test('equal palette ranks keep the source order including disabled actions', t => {
	const actions = [
		action('one', 'open one'),
		{...action('two', 'open two'), disabledReason: 'unavailable'},
	];
	t.deepEqual(filterActions(actions, 'open'), actions);
	t.deepEqual(filterActions(actions, 'two'), [actions[1]]);
});

test('keyboard selection wraps, resets and handles empty results', t => {
	t.is(moveSelection(0, 1, 3), 1);
	t.is(moveSelection(2, 1, 3), 0);
	t.is(moveSelection(0, -1, 3), 2);
	t.is(moveSelection(-1, 1, 3), 0);
	t.is(moveSelection(8, 0, 2), 0);
	t.is(moveSelection(0, 1, 0), -1);
});

test('disabled reasons prevent execution without hiding the action', t => {
	let called = 0;
	const disabled = {
		...action('open', 'open project'),
		disabledReason: 'another folder is opening',
		run: () => called++,
	};
	t.false(runAction(disabled));
	t.is(called, 0);
	t.deepEqual(filterActions([disabled], 'open'), [disabled]);
	t.true(runAction({...disabled, disabledReason: undefined}));
	t.is(called, 1);
	t.false(runAction(undefined));
});

test('focus returns to the saved connected control', t => {
	let focused = '';
	const restore = focusReturn(
		{
			isConnected: true,
			focus: () => {
				focused = 'original';
			},
		},
		{
			isConnected: true,
			focus: () => {
				focused = 'fallback';
			},
		},
	);
	restore();
	t.is(focused, 'original');
});

test('focus return uses a safe fallback when the saved control disappears', t => {
	let focused = '';
	focusReturn(
		{
			isConnected: false,
			focus: () => {
				focused = 'removed';
			},
		},
		{
			isConnected: true,
			focus: () => {
				focused = 'fallback';
			},
		},
	)();
	t.is(focused, 'fallback');
	focused = '';
	focusReturn(null, {
		isConnected: true,
		focus: () => {
			focused = 'fallback';
		},
	})();
	t.is(focused, 'fallback');
});

test('focus return falls back if the saved control becomes disabled', t => {
	let focused = '';
	const target = {
		isConnected: true,
		disabled: true,
		focus: () => {
			focused = 'disabled';
		},
	};
	focusReturn(target, {
		isConnected: true,
		focus: () => {
			focused = 'fallback';
		},
	})();
	t.is(focused, 'fallback');
});

test('command shortcuts use the Mac symbol on macOS and Ctrl elsewhere (E-19)', t => {
	t.is(commandModifier('MacIntel'), '⌘');
	t.is(commandModifier('Win32'), 'Ctrl+');
	t.is(commandModifier('Linux x86_64'), 'Ctrl+');
	t.is(keyHint('↵ send · ⇧↵ newline', 'MacIntel'), '↵ send · ⇧↵ newline');
	t.is(
		keyHint('↵ send · ⇧↵ newline', 'Linux x86_64'),
		'Enter send · Shift+Enter newline',
	);
	t.is(keyHint('⏎', 'Win32'), 'Enter');
});

test('every overlay request has a dialog name for assistive technology (E-02, E-03, E-37)', t => {
	t.is(dialogLabel('palette'), 'command palette');
	t.is(dialogLabel('shortcuts'), 'keyboard shortcuts');
	t.is(dialogLabel({kind: 'new-thread'}), 'new thread');
	t.is(dialogLabel({kind: 'thread-menu', threadId: 'a'}), 'thread actions');
	t.is(dialogLabel({kind: 'rename', threadId: 'a'}), 'rename thread');
	t.is(dialogLabel({kind: 'archive', threadId: 'a'}), 'archive thread');
	t.is(dialogLabel({kind: 'remove', threadId: 'a'}), 'remove from desktop');
	t.is(
		dialogLabel({kind: 'other-thread', threadId: 'a'}),
		'another thread is running',
	);
});

test('workspace dialogs take their accessible names from the overlay labels (E-02, E-03)', t => {
	t.is(dialogLabel('projects'), 'your projects');
	t.is(dialogLabel('runtime'), 'runtime details');
	t.is(dialogLabel('capabilities'), 'capabilities, with reasons');
	t.is(dialogLabel('archives'), 'archived threads');
	t.is(dialogLabel('diagnostics'), 'review captured diagnostics');
});

function fixture() {
	let now = 0;
	let sequence = 0;
	const timers = new Map<number, {at: number; callback(): void}>();
	const updates: (Toast | null)[] = [];
	const queue = toastQueue(
		{
			schedule(callback, delay) {
				const id = ++sequence;
				timers.set(id, {at: now + delay, callback});
				return () => {
					timers.delete(id);
				};
			},
		},
		toast => updates.push(toast),
	);
	return {
		queue,
		updates,
		timers,
		advance(milliseconds: number) {
			const end = now + milliseconds;
			for (;;) {
				const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
				if (!next || next[1].at > end) break;
				now = next[1].at;
				timers.delete(next[0]);
				next[1].callback();
			}
			now = end;
		},
	};
}

test('toast hides after 2400ms and finishes its 180ms exit using an injected clock', t => {
	const f = fixture();
	f.queue.push('theme changed');
	t.deepEqual(f.updates.at(-1), {
		id: 1,
		message: 'theme changed',
		exiting: false,
	});
	f.advance(2399);
	t.is(f.updates.length, 1);
	f.advance(1);
	t.deepEqual(f.updates.at(-1), {
		id: 1,
		message: 'theme changed',
		exiting: true,
	});
	f.advance(180);
	t.is(f.updates.at(-1), null);
});

test('toast queue shows messages in order and gives each a full display interval', t => {
	const f = fixture();
	f.queue.push('first');
	f.queue.push('second');
	t.is(f.updates.length, 1);
	f.advance(2580);
	t.deepEqual(f.updates.at(-1), {id: 2, message: 'second', exiting: false});
	f.advance(2399);
	t.false(f.updates.at(-1)?.exiting);
	f.advance(181);
	t.is(f.updates.at(-1), null);
});

test('disposing the toast queue cancels callbacks and rejects later messages', t => {
	const f = fixture();
	f.queue.push('first');
	f.queue.push('second');
	f.queue.dispose();
	t.is(f.timers.size, 0);
	f.queue.push('third');
	f.advance(10000);
	t.is(f.updates.length, 1);
});

test('import notice fires once, only after a successful metadata import (E-52)', async t => {
	const notices: string[] = [];
	const requested: string[] = [];
	const importSession = notifyImported(
		async id => {
			requested.push(id);
			return true;
		},
		message => notices.push(message),
	);
	t.true(await importSession('session-a'));
	t.deepEqual(requested, ['session-a']);
	t.deepEqual(notices, [importedToast]);
	t.is(
		importedToast,
		'thread metadata imported. selection and draft unchanged.',
	);
});

test('import notice stays silent when the import is refused or fails (E-52)', async t => {
	const notices: string[] = [];
	const refused = notifyImported(
		async () => false,
		message => notices.push(message),
	);
	t.false(await refused('session-a'));
	const failed = notifyImported(
		async () => {
			throw new Error('bridge failed');
		},
		message => notices.push(message),
	);
	await t.throwsAsync(failed('session-a'), {message: 'bridge failed'});
	t.deepEqual(notices, []);
});
