import test from 'ava';
import {
	createThreadConversations,
	type ThreadConversationState,
} from '@/renderer/thread-conversations';
import {transcriptRowId} from '@/renderer/transcript';
import type {
	IpcResult,
	ProjectEvent,
	ThreadSnapshot,
	TurnEvent,
	TurnResult,
} from '@/shared/ipc';

const snapshot = (
	id: string,
	events: TurnEvent[] = [],
	projectId = 'project-a',
): ThreadSnapshot => ({
	thread: {
		id,
		projectId,
		title: id,
		nanocoderSessionId: null,
		mode: 'normal',
		sessionCwd: '/fixture',
		archiveState: 'active',
		runState: 'new',
		viewOnlyReason: null,
		lastActivityAt: '2026-10-30T14:00:00.000Z',
	},
	sequence: events.length ? 1 : 0,
	replaying: false,
	events,
});
const turn = (
	events: TurnEvent[],
	threadId = 'a',
	projectId = 'project-a',
): Extract<ProjectEvent, {type: 'turn'}> => ({
	type: 'turn',
	projectId,
	threadId,
	sequence: 2,
	events,
});

function fixture(
	onChange?: (state: ThreadConversationState) => void,
	now?: () => number,
) {
	const changes: ThreadConversationState[] = [];
	const timers: {callback(): void; delayMs: number; cancelled: boolean}[] = [];
	const conversations = createThreadConversations({
		onChange: state => {
			changes.push(state);
			onChange?.(state);
		},
		clock: {
			schedule(callback, delayMs) {
				const timer = {callback, delayMs, cancelled: false};
				timers.push(timer);
				return () => {
					timer.cancelled = true;
				};
			},
		},
		...(now && {now}),
	});
	conversations.selectProject('project-a');
	conversations.selectThread('a');
	return {conversations, changes, timers};
}

test('CHAT-08 snapshots retain matching live row identities despite different chunk boundaries', t => {
	const {conversations, timers} = fixture();
	conversations.receive(
		turn([
			{type: 'user', text: 'fixture'},
			{type: 'text', text: 'first '},
			{type: 'text', text: 'answer'},
		]),
	);
	timers
		.filter(timer => !timer.cancelled)
		.at(-1)
		?.callback();
	const previous = conversations
		.getState()
		.transcript.items.map(transcriptRowId);
	conversations.snapshot(
		snapshot('a', [
			{type: 'user', text: 'fixture'},
			{type: 'text', text: 'first answer'},
		]),
	);
	t.deepEqual(
		conversations.getState().transcript.items.map(transcriptRowId),
		previous,
	);
});

test('drafts and completed outcomes are thread-owned and a pending draft never becomes an optimistic or queued prompt (CHAT-03, CHAT-04, DATA-10)', t => {
	const {conversations} = fixture();
	t.is(conversations.getState().projectId, 'project-a');
	conversations.snapshot(
		snapshot('a', [
			{type: 'user', text: 'earlier'},
			{type: 'text', text: 'settled'},
		]),
	);
	const before = conversations.getState().transcript;
	conversations.setDraft(' first ');
	const ticket = conversations.beginTurn('a');
	if (!ticket) {
		t.fail('the selected draft should begin a turn');
		return;
	}
	t.is(ticket.text, 'first');
	t.is(conversations.getState().draft, '');
	t.is(conversations.getState().transcript, before);
	conversations.setDraft('next draft');
	t.is(conversations.beginTurn('a'), null);
	t.true(
		conversations.finishTurn(ticket, {
			ok: true,
			value: {stopReason: 'end_turn'},
		}),
	);
	t.is(conversations.getState().draft, 'next draft');
	t.is(conversations.getState().transcript, before);
	conversations.selectThread('b');
	t.is(conversations.getState().draft, '');
	conversations.setDraft('other thread');
	conversations.selectThread('a');
	t.is(conversations.getState().draft, 'next draft');
	t.deepEqual(conversations.getState().turn, {
		ok: true,
		value: {stopReason: 'end_turn'},
	});
});

test('same-id foreign projects cannot expose content or finish old turn tickets, while each memory-only draft stays scoped (CHAT-03, DATA-10)', t => {
	const {conversations, timers} = fixture();
	conversations.setDraft('first project');
	const ticket = conversations.beginTurn('a');
	if (!ticket) {
		t.fail('the selected draft should begin a turn');
		return;
	}
	conversations.setDraft('retained draft');
	conversations.snapshot(
		snapshot('a', [{type: 'text', text: 'project-a content'}]),
	);
	conversations.selectProject('project-b');
	conversations.selectThread('a');
	t.is(conversations.getState().draft, '');
	t.deepEqual(conversations.getState().transcript.items, []);
	t.false(
		conversations.snapshot(snapshot('a', [{type: 'text', text: 'foreign'}])),
	);
	conversations.receive(turn([{type: 'text', text: 'foreign live'}]));
	t.is(timers.length, 0);
	conversations.setDraft('project-b draft');
	t.false(
		conversations.finishTurn(ticket, {
			ok: true,
			value: {stopReason: 'end_turn'},
		}),
	);
	t.false(
		conversations.setCancellation('project-a', 'a', {ok: true, value: null}),
	);
	t.is(conversations.getState().draft, 'project-b draft');
	conversations.selectProject('project-a');
	conversations.selectThread('a');
	t.is(conversations.getState().draft, 'retained draft');
	t.is(conversations.getState().transcript.items[0]?.text, 'project-a content');
});

test('live content batches for 16ms without changing a settled row identity (PERF-04, CHAT-05)', t => {
	const {conversations, timers, changes} = fixture();
	t.true(
		conversations.snapshot(
			snapshot('a', [
				{type: 'user', text: 'earlier'},
				{type: 'text', text: 'settled'},
				{type: 'user', text: 'next'},
			]),
		),
	);
	const settled = conversations.getState().transcript.items[1];
	const before = changes.length;
	for (let i = 0; i < 100; i++)
		conversations.receive(turn([{type: 'text', text: `${i},`}]));
	t.is(changes.length, before);
	t.is(timers.length, 1);
	t.is(timers[0].delayMs, 16);
	t.is(conversations.getState().transcript.items.length, 3);
	timers[0].callback();
	t.is(conversations.getState().transcript.items[1], settled);
	t.is(
		conversations.getState().transcript.items[3]?.text,
		Array.from({length: 100}, (_, i) => `${i},`).join(''),
	);
});

test('approval display and closure flush all preceding content immediately and cancel old frame callbacks (CHAT-05, ACP-10)', t => {
	const {conversations, changes, timers} = fixture();
	const request = {
		id: 'request-a',
		title: 'offered action',
		options: [{id: 'deny', name: 'deny', kind: 'reject_once' as const}],
	};
	conversations.receive(turn([{type: 'text', text: 'before approval'}]));
	conversations.receive(turn([{type: 'permission', request}]));
	t.deepEqual(conversations.getState().transcript.permissions, [request]);
	t.is(conversations.getState().transcript.items[0]?.text, 'before approval');
	const first = changes.find(state => state.transcript.permissions.length);
	t.is(first?.transcript.items[0]?.text, 'before approval');
	conversations.receive(turn([{type: 'permission-closed', id: request.id}]));
	t.deepEqual(conversations.getState().transcript.permissions, []);
	const before = changes.length;
	for (const timer of timers) {
		t.true(timer.cancelled);
		timer.callback();
	}
	t.is(changes.length, before);
});

test('replay replaces a flushed prefix without duplicate old chunks and retains the failed-turn notice (CHAT-04, CHAT-05)', t => {
	const {conversations, timers} = fixture();
	conversations.setDraft('failed');
	const ticket = conversations.beginTurn('a');
	if (!ticket) {
		t.fail('the selected draft should begin a turn');
		return;
	}
	conversations.receive(
		turn([
			{type: 'user', text: 'failed'},
			{type: 'text', text: 'old partial'},
		]),
	);
	t.true(
		conversations.finishTurn(ticket, {
			ok: false,
			error: {
				code: 'AGENT_UNAVAILABLE',
				message: 'failed turn',
				retryable: true,
			},
		}),
	);
	conversations.receive(turn([{type: 'text', text: 'obsolete suffix'}]));
	t.true(
		conversations.snapshot(
			snapshot('a', [
				{type: 'user', text: 'earlier'},
				{type: 'text', text: 'history from main'},
			]),
		),
	);
	t.like(conversations.getState().transcript.items, [
		{kind: 'user', text: 'earlier'},
		{kind: 'agent', text: 'history from main'},
		{kind: 'failure', text: 'failed turn'},
	]);
	for (const timer of timers) timer.callback();
	t.is(conversations.getState().transcript.items.length, 3);
});

test('terminal results flush owned content before the failure notice and preserve the editable next draft (CHAT-05, DATA-10)', t => {
	const {conversations, timers} = fixture();
	conversations.setDraft('sent');
	const ticket = conversations.beginTurn('a');
	if (!ticket) {
		t.fail('the selected draft should begin a turn');
		return;
	}
	conversations.receive(
		turn([
			{type: 'user', text: 'sent'},
			{type: 'text', text: 'partial'},
		]),
	);
	conversations.setDraft('next draft');
	const failed = {
		ok: false as const,
		error: {
			code: 'AGENT_UNAVAILABLE' as const,
			message: 'turn failed',
			retryable: true,
		},
	};
	t.true(conversations.finishTurn(ticket, failed));
	t.deepEqual(
		conversations.getState().transcript.items.map(item => item.kind),
		['user', 'agent', 'failure'],
	);
	t.is(conversations.getState().draft, 'next draft');
	t.true(timers[0].cancelled);
	t.false(conversations.finishTurn(ticket, failed));
	t.is(conversations.getState().transcript.items.length, 3);
});

test('cancelled preparation restores an unsent draft but never overwrites a new draft or resends displayed input (CHAT-06, DATA-10)', t => {
	const {conversations} = fixture();
	const cancelled = {
		ok: true as const,
		value: {stopReason: 'cancelled' as const},
	};
	conversations.setDraft(' original \n draft ');
	const first = conversations.beginTurn('a');
	if (!first) {
		t.fail('the selected draft should begin a turn');
		return;
	}
	t.true(conversations.finishTurn(first, cancelled));
	t.is(conversations.getState().draft, ' original \n draft ');
	t.deepEqual(conversations.getState().transcript.items, []);
	conversations.setDraft('sent');
	const second = conversations.beginTurn('a');
	if (!second) {
		t.fail('the selected draft should begin a turn');
		return;
	}
	conversations.receive(turn([{type: 'user', text: 'sent'}]));
	t.true(conversations.finishTurn(second, cancelled));
	t.is(conversations.getState().draft, '');
	conversations.setDraft('old');
	const third = conversations.beginTurn('a');
	if (!third) {
		t.fail('the selected draft should begin a turn');
		return;
	}
	conversations.setDraft('new draft');
	t.true(conversations.finishTurn(third, cancelled));
	t.is(conversations.getState().draft, 'new draft');
});

test('switch remove and disposal flush or discard only owned queues and refuse every stale completion (CHAT-03, CHAT-14)', t => {
	const {conversations, timers, changes} = fixture();
	conversations.receive(turn([{type: 'text', text: 'before switch'}]));
	conversations.selectThread('b');
	t.deepEqual(conversations.getState().transcript.items, []);
	t.true(timers[0].cancelled);
	conversations.selectThread('a');
	t.is(conversations.getState().transcript.items[0]?.text, 'before switch');
	conversations.setDraft('sent');
	const ticket = conversations.beginTurn('a');
	if (!ticket) {
		t.fail('the selected draft should begin a turn');
		return;
	}
	conversations.receive(turn([{type: 'text', text: 'discarded'}]));
	conversations.remove('a');
	t.is(conversations.getState().activeThreadId, null);
	t.false(
		conversations.finishTurn(ticket, {
			ok: true,
			value: {stopReason: 'end_turn'},
		}),
	);
	t.false(
		conversations.snapshot(snapshot('a', [{type: 'text', text: 'removed'}])),
	);
	conversations.receive(turn([{type: 'text', text: 'removed live'}]));
	const before = changes.length;
	conversations.dispose();
	conversations.selectProject('project-b');
	conversations.selectThread('a');
	conversations.setDraft('too late');
	t.false(conversations.snapshot(snapshot('a', [], 'project-b')));
	for (const timer of timers) timer.callback();
	t.is(changes.length, before);
	t.is(conversations.getState().projectId, null);
	t.deepEqual(conversations.getState().transcript.items, []);
});

for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
	for (const delivery of ['live', 'snapshot'] as const) {
		test(`an authoritative ${delivery} ${outcome} result survives a project round trip and settles only its owning fallback card (CHAT-03, SUB-04)`, t => {
			const {conversations, timers} = fixture();
			conversations.setDraft('sent');
			const stale = conversations.beginTurn('a');
			if (!stale) return t.fail('expected a turn ticket');
			conversations.selectProject('project-b');
			conversations.selectThread('a');
			conversations.setDraft('unrelated project draft');
			conversations.selectProject('project-a');
			conversations.selectThread('a');
			conversations.setDraft('next draft');
			const events: TurnEvent[] = [
				{type: 'user', text: 'sent'},
				{
					type: 'tool',
					id: 'opaque fallback',
					status: 'in_progress',
					delegation: {history: false},
				},
			];
			const result: IpcResult<TurnResult> =
				outcome === 'failed'
					? {
							ok: false,
							error: {
								code: 'AGENT_UNAVAILABLE',
								message: 'safe turn failure',
								retryable: false,
							},
						}
					: {
							ok: true,
							value: {
								stopReason: outcome === 'cancelled' ? 'cancelled' : 'end_turn',
							},
						};
			if (delivery === 'snapshot') {
				const prefix = {...snapshot('a', events), result};
				conversations.snapshot(prefix);
			} else {
				conversations.receive(turn(events));
				const terminal = {...turn([]), result};
				conversations.receive(terminal);
				t.true(timers[0].cancelled);
			}
			t.deepEqual(conversations.getState().turn, result);
			const tool = conversations.getState().transcript.items[1];
			t.is(tool.kind, 'tool');
			if (tool.kind === 'tool') t.is(tool.turnOutcome, outcome);
			t.is(conversations.getState().draft, 'next draft');
			t.false(conversations.finishTurn(stale, null));
			t.deepEqual(conversations.getState().turn, result);
			conversations.selectProject('project-b');
			conversations.selectThread('a');
			t.is(conversations.getState().turn, null);
			t.is(conversations.getState().draft, 'unrelated project draft');
		});
	}
	test(`a mapped ${outcome} terminal settles only its flushed current subagent cards and cannot revert on the next turn (SUB-04, CHAT-05)`, t => {
		const {conversations, timers} = fixture();
		conversations.snapshot(
			snapshot('a', [
				{type: 'user', text: 'earlier'},
				{
					type: 'tool',
					id: 'subagent:opaque',
					status: 'in_progress',
					delegation: {history: true},
				},
			]),
		);
		const earlier = conversations.getState().transcript.items[1];
		conversations.setDraft('sent');
		const ticket = conversations.beginTurn('a');
		if (!ticket) return t.fail('the selected draft should begin a turn');
		conversations.receive(
			turn([
				{type: 'user', text: 'sent'},
				{
					type: 'tool',
					id: 'subagent:opaque',
					status: 'in_progress',
					delegation: {history: false},
				},
			]),
		);
		conversations.setDraft('next draft');
		const result: IpcResult<TurnResult> =
			outcome === 'failed'
				? {
						ok: false,
						error: {
							code: 'AGENT_UNAVAILABLE',
							message: 'turn failed',
							retryable: true,
						},
					}
				: {
						ok: true,
						value: {
							stopReason: outcome === 'cancelled' ? 'cancelled' : 'end_turn',
						},
					};
		t.true(conversations.finishTurn(ticket, result));
		const items = conversations.getState().transcript.items;
		const settled = items[3];
		t.is(settled.kind, 'tool');
		if (settled.kind !== 'tool') return;
		t.is(settled.turnOutcome, outcome);
		t.is(items[1], earlier);
		t.true(timers[0].cancelled);
		t.is(conversations.getState().draft, 'next draft');
		t.truthy(conversations.beginTurn('a'));
		conversations.receive(
			turn([
				{type: 'user', text: 'next draft'},
				{
					type: 'tool',
					id: 'subagent:opaque',
					status: 'pending',
					delegation: {history: false},
				},
			]),
		);
		conversations.flush('a');
		t.is(conversations.getState().transcript.items[3], settled);
		const next = conversations.getState().transcript.items.at(-1);
		t.is(next?.kind, 'tool');
		if (next?.kind === 'tool') t.is(next.turnOutcome, undefined);
	});
}

test('a refused repeated prompt restores only its unsent draft and never settles an earlier cached subagent (CHAT-04, CHAT-07, SUB-04)', t => {
	const {conversations} = fixture();
	conversations.snapshot(
		snapshot('a', [
			{type: 'user', text: 'same prompt'},
			{
				type: 'tool',
				id: 'subagent:opaque',
				status: 'in_progress',
				delegation: {history: false},
			},
		]),
	);
	const before = conversations.getState().transcript.items[1];
	conversations.setDraft(' same prompt ');
	const ticket = conversations.beginTurn('a');
	if (!ticket) return t.fail('the selected draft should begin a turn');
	t.true(
		conversations.finishTurn(ticket, {
			ok: true,
			value: {stopReason: 'cancelled'},
		}),
	);
	t.is(conversations.getState().draft, ' same prompt ');
	t.is(conversations.getState().transcript.items[1], before);
});

test('an old terminal cannot flush or settle a same-id subagent in a replacement project (SUB-04, CHAT-03)', t => {
	const {conversations, timers} = fixture();
	conversations.setDraft('old');
	const old = conversations.beginTurn('a');
	if (!old) return t.fail('the selected draft should begin a turn');
	conversations.selectProject('project-b');
	conversations.selectThread('a');
	conversations.setDraft('new');
	t.truthy(conversations.beginTurn('a'));
	conversations.receive(
		turn(
			[
				{type: 'user', text: 'new'},
				{
					type: 'tool',
					id: 'subagent:opaque',
					status: 'in_progress',
					delegation: {history: false},
				},
			],
			'a',
			'project-b',
		),
	);
	const before = conversations.getState();
	t.false(
		conversations.finishTurn(old, {
			ok: true,
			value: {stopReason: 'cancelled'},
		}),
	);
	t.is(conversations.getState().transcript, before.transcript);
	t.false(timers[0].cancelled);
	timers[0].callback();
	const tool = conversations.getState().transcript.items[1];
	t.is(tool.kind, 'tool');
	if (tool.kind === 'tool') t.is(tool.turnOutcome, undefined);
});

test('terminal settlement rechecks the owning ticket after a flush callback changes the project (SUB-04, CHAT-03)', t => {
	let replace = false;
	const {conversations} = fixture(() => {
		if (!replace) return;
		replace = false;
		conversations.selectProject('project-b');
		conversations.selectThread('a');
		conversations.snapshot(
			snapshot(
				'a',
				[
					{type: 'user', text: 'new'},
					{
						type: 'tool',
						id: 'subagent:opaque',
						status: 'in_progress',
						delegation: {history: false},
					},
				],
				'project-b',
			),
		);
		conversations.setDraft('new turn');
		t.truthy(conversations.beginTurn('a'));
		conversations.setDraft('replacement draft');
	});
	conversations.setDraft('old');
	const old = conversations.beginTurn('a');
	if (!old) return t.fail('the selected draft should begin a turn');
	conversations.receive(turn([{type: 'user', text: 'old'}]));
	replace = true;
	t.false(
		conversations.finishTurn(old, {
			ok: true,
			value: {stopReason: 'cancelled'},
		}),
	);
	t.is(conversations.getState().projectId, 'project-b');
	t.is(conversations.getState().turn, null);
	t.is(conversations.getState().draft, 'replacement draft');
	t.is(conversations.beginTurn('a'), null);
	const tool = conversations.getState().transcript.items[1];
	t.is(tool.kind, 'tool');
	if (tool.kind === 'tool') t.is(tool.turnOutcome, undefined);
});

for (const delivery of ['live', 'snapshot'] as const) {
	test(`a stale ${delivery} terminal cannot settle a replacement generation even after returning to the same project and thread (CHAT-03, SUB-04)`, t => {
		let replace = false;
		const {conversations} = fixture(() => {
			if (!replace) return;
			replace = false;
			conversations.selectProject('project-b');
			conversations.selectProject('project-a');
			conversations.selectThread('a');
			conversations.snapshot(
				snapshot('a', [
					{type: 'user', text: 'replacement user'},
					{
						type: 'tool',
						id: 'replacement fallback',
						status: 'in_progress',
						delegation: {history: false},
					},
				]),
			);
			conversations.setDraft('replacement draft');
		});
		conversations.receive(turn([{type: 'user', text: 'old user'}]));
		replace = true;
		const result: IpcResult<TurnResult> = {
			ok: true,
			value: {stopReason: 'cancelled'},
		};
		if (delivery === 'snapshot')
			conversations.snapshot({...snapshot('a'), result});
		else conversations.receive({...turn([]), result});
		t.is(conversations.getState().turn, null);
		t.is(conversations.getState().draft, 'replacement draft');
		const tool = conversations.getState().transcript.items[1];
		t.is(tool?.kind, 'tool');
		if (tool?.kind === 'tool') {
			t.is(tool.id, 'replacement fallback');
			t.is(tool.turnOutcome, undefined);
		}
	});
}

test('replay without a terminal clears the old result but keeps its failure notice and never duplicates a native failure in the old command reply (CHAT-04)', t => {
	const {conversations} = fixture();
	conversations.setDraft('sent');
	const ticket = conversations.beginTurn('a');
	if (!ticket) return t.fail('expected a turn ticket');
	conversations.receive(turn([{type: 'user', text: 'sent'}]));
	const result: IpcResult<TurnResult> = {
		ok: false,
		error: {
			code: 'AGENT_UNAVAILABLE',
			message: 'safe failure',
			retryable: false,
		},
	};
	conversations.receive({...turn([]), result});
	conversations.finishTurn(ticket, result);
	t.is(
		conversations
			.getState()
			.transcript.items.filter(item => item.kind === 'failure').length,
		1,
	);
	conversations.snapshot(snapshot('a', [{type: 'user', text: 'restored'}]));
	t.is(conversations.getState().turn, null);
	t.is(
		conversations
			.getState()
			.transcript.items.filter(item => item.kind === 'failure').length,
		1,
	);
});

const epoch = '00000000-0000-4000-8000-000000000001';
const marker = (phase: 'begin' | 'complete' | 'failed', threadId = 'a') => ({
	...turn([], threadId),
	replay: {epoch, phase},
});
const times = (state: ThreadConversationState) =>
	state.transcript.items.map(item =>
		Object.hasOwn(item, 'at') ? Reflect.get(item, 'at') : 'none',
	);

test('live user and first agent chunks take the injected clock time when applied and joins keep it', t => {
	let clock = 1000;
	const {conversations, timers} = fixture(undefined, () => clock);
	conversations.receive(
		turn([
			{type: 'user', text: 'sent'},
			{type: 'thought', text: 'thinking'},
			{type: 'text', text: 'first'},
		]),
	);
	clock = 2000;
	timers[0].callback();
	t.deepEqual(times(conversations.getState()), [2000, 'none', 2000]);
	clock = 3000;
	conversations.receive(turn([{type: 'text', text: ' more'}]));
	conversations.flush('a');
	t.is(conversations.getState().transcript.items[2]?.text, 'first more');
	clock = 4000;
	conversations.receive(
		turn([
			{type: 'tool', id: 'tool', status: 'completed'},
			{type: 'notice', severity: 'info', title: 'notice'},
			{type: 'text', text: 'after tool'},
		]),
	);
	conversations.flush('a');
	t.deepEqual(times(conversations.getState()), [
		2000,
		'none',
		2000,
		'none',
		'none',
		4000,
	]);
});

test('replay markers flush live content first and keep replayed messages unstamped until replay completes', t => {
	const {conversations} = fixture(undefined, () => 5);
	conversations.receive(turn([{type: 'user', text: 'live before'}]));
	conversations.receive(marker('begin'));
	t.deepEqual(times(conversations.getState()), [5]);
	conversations.receive(
		turn([
			{type: 'user', text: 'replayed'},
			{type: 'text', text: 'replayed answer'},
		]),
	);
	conversations.receive(marker('complete'));
	t.deepEqual(times(conversations.getState()), [5, 'none', 'none']);
	conversations.receive(turn([{type: 'user', text: 'after'}]));
	conversations.flush('a');
	t.deepEqual(times(conversations.getState()), [5, 'none', 'none', 5]);
});

test('a replaying snapshot marks later unmarked events as replay for its thread only until replay fails', t => {
	const {conversations} = fixture(undefined, () => 7);
	t.true(
		conversations.snapshot({
			...snapshot('a', [{type: 'user', text: 'saved'}]),
			replaying: true,
		}),
	);
	conversations.receive(turn([{type: 'text', text: 'saved answer'}]));
	conversations.receive(turn([{type: 'user', text: 'other live'}], 'b'));
	conversations.flush();
	t.deepEqual(times(conversations.getState()), ['none', 'none']);
	conversations.receive(marker('failed'));
	conversations.receive(turn([{type: 'user', text: 'retry live'}]));
	conversations.flush();
	t.deepEqual(times(conversations.getState()), ['none', 'none', 7]);
	conversations.selectThread('b');
	t.deepEqual(times(conversations.getState()), [7]);
});

test('a settled snapshot ends replay and carries live times only to matching messages', t => {
	let clock = 100;
	const {conversations} = fixture(undefined, () => clock);
	const saved: TurnEvent[] = [
		{type: 'user', text: 'saved'},
		{type: 'text', text: 'saved answer'},
	];
	conversations.receive(marker('begin'));
	t.true(conversations.snapshot(snapshot('a', saved)));
	conversations.receive(
		turn([
			{type: 'user', text: 'live'},
			{type: 'text', text: 'partial'},
		]),
	);
	conversations.flush('a');
	t.deepEqual(times(conversations.getState()), ['none', 'none', 100, 100]);
	clock = 200;
	t.true(
		conversations.snapshot(
			snapshot('a', [
				...saved,
				{type: 'user', text: 'live'},
				{type: 'text', text: 'partial and more'},
			]),
		),
	);
	t.deepEqual(times(conversations.getState()), ['none', 'none', 100, 'none']);
	t.true(
		conversations.snapshot(
			snapshot('a', [
				...saved,
				{type: 'user', text: 'edited'},
				{type: 'text', text: 'different'},
			]),
		),
	);
	t.deepEqual(times(conversations.getState()), [
		'none',
		'none',
		'none',
		'none',
	]);
});
