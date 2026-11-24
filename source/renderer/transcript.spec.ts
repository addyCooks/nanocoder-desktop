import test from 'ava';
import {toTurnEvent} from '@/main/nanocoder/turn-events';
import {
	applyEvent,
	applyEvents,
	carryMessageRows,
	carryMessageTimes,
	emptyTranscript,
	transcriptRowId,
} from '@/renderer/transcript';

test('SUB-05 historical outcome patches keep only the enum and remain immutable and ordered', t => {
	const first = applyEvent(emptyTranscript, {
		type: 'tool',
		id: 'history',
		status: 'unknown',
		history: {outcome: 'failed'},
	});
	const previous = first.items[0];
	const next = applyEvent(first, {
		type: 'tool',
		id: 'history',
		title: 'later title',
	});
	t.like(previous, {historyOutcome: 'failed'});
	t.like(next.items[0], {historyOutcome: 'failed', title: 'later title'});
	t.is(first.items[0], previous);
	t.not(next.items[0], previous);
	t.is(next.items.length, 1);
	t.false(Object.hasOwn(previous, 'history'));
});

test('SUB-05 absent historical outcome adds no transcript field', t => {
	const state = applyEvent(emptyTranscript, {type: 'tool', id: 'history'});
	t.false(Object.hasOwn(state.items[0], 'historyOutcome'));
});

test('SUB-05 unknown history is explicit and unlisted outcomes cannot enter transcript state', t => {
	const unknown = applyEvent(emptyTranscript, {
		type: 'tool',
		id: 'unknown',
		history: {outcome: 'unknown'},
	});
	t.like(unknown.items[0], {historyOutcome: 'unknown'});
	const unlisted = applyEvent(emptyTranscript, {
		type: 'tool',
		id: 'unlisted',
		history: {outcome: 'success' as 'unknown'},
	});
	t.false(Object.hasOwn(unlisted.items[0], 'historyOutcome'));
});

test('title-only subagent-prefixed tool updates retain classification status content and opaque ID (CHAT-05)', t => {
	const full = toTurnEvent({
		sessionUpdate: 'tool_call',
		toolCallId: 'subagent:fixture',
		title: 'starting',
		kind: 'execute',
		status: 'in_progress',
		content: [
			{type: 'content', content: {type: 'text', text: 'retained content'}},
		],
		rawInput: {task: 'fixture'},
	});
	const titleOnly = toTurnEvent({
		sessionUpdate: 'tool_call_update',
		toolCallId: 'subagent:fixture',
		title: 'still working',
	});
	t.truthy(full);
	t.truthy(titleOnly);
	if (!full || !titleOnly) return;
	const transcript = applyEvent(applyEvent(emptyTranscript, full), titleOnly);
	t.deepEqual(transcript.items, [
		{
			kind: 'tool',
			id: 'subagent:fixture',
			title: 'still working',
			status: 'in_progress',
			toolKind: 'execute',
			details: {input: '{"task":"fixture"}', content: ['retained content']},
		},
	]);
});

test('keeps reasoning separate from the agent answer (CHAT-05)', t => {
	t.like(applyEvent(emptyTranscript, {type: 'thought', text: 'Checking'}), {
		items: [{kind: 'thought', text: 'Checking'}],
		permissions: [],
	});
});

test('attaches reported usage to the answer without inferring context use (CHAT-19)', t => {
	const before = applyEvent(emptyTranscript, {type: 'text', text: 'answer'});
	t.deepEqual(
		applyEvent(before, {
			type: 'metadata',
			metadata: {
				usage: {totalTokens: 20, cost: 0.01},
				durationMs: 42,
				outcome: 'completed',
			},
		}),
		{
			items: [
				{
					kind: 'agent',
					text: 'answer',
					rowId: before.items[0].rowId,
					metadata: {
						usage: {totalTokens: 20, cost: 0.01},
						durationMs: 42,
						outcome: 'completed',
					},
				},
			],
			permissions: [],
		},
	);
});

for (const boundary of ['local', 'replayed'] as const) {
	test(`assistant-less turn metadata cannot cross a ${boundary} user boundary (CHAT-19)`, t => {
		const first = applyEvents(emptyTranscript, [
			{type: 'user', text: 'first question'},
			{type: 'text', text: 'settled answer'},
			{
				type: 'metadata',
				metadata: {usage: {totalTokens: 17}, outcome: 'completed'},
			},
		]);
		const before =
			boundary === 'local'
				? applyEvent(first, {type: 'user', text: 'next question'}, 50)
				: applyEvents(first, [{type: 'user', text: 'next question'}]);
		const after = applyEvents(before, [
			{type: 'tool', id: 'next-tool', status: 'failed'},
			{
				type: 'metadata',
				metadata: {usage: {totalTokens: 31}, outcome: 'failed'},
			},
		]);
		t.deepEqual(after.items[1].metadata, {
			usage: {totalTokens: 17},
			outcome: 'completed',
		});
		t.is(after.items[1], first.items[1]);
		t.deepEqual(after.items.at(-1), {
			kind: 'turn-metadata',
			metadata: {usage: {totalTokens: 31}, outcome: 'failed'},
		});
	});
}

test('assistant-less turns keep separate usage rows and merge only their own metadata (CHAT-19)', t => {
	const first = applyEvents(emptyTranscript, [
		{type: 'user', text: 'first question'},
		{type: 'metadata', metadata: {usage: {totalTokens: 17, cost: 0.01}}},
	]);
	const after = applyEvents(first, [
		{type: 'user', text: 'next question'},
		{type: 'metadata', metadata: {usage: {totalTokens: 31}}},
		{type: 'thought', text: 'checking'},
		{type: 'text', text: 'later answer'},
		{type: 'metadata', metadata: {durationMs: 8, outcome: 'failed'}},
	]);
	t.is(after.items[1], first.items[1]);
	t.deepEqual(after.items[1], {
		kind: 'turn-metadata',
		metadata: {usage: {totalTokens: 17, cost: 0.01}},
	});
	t.deepEqual(after.items[3], {
		kind: 'turn-metadata',
		metadata: {usage: {totalTokens: 31}, durationMs: 8, outcome: 'failed'},
	});
	t.is(after.items[5].metadata, undefined);
});

test('different reported message IDs do not merge (CHAT-05)', t => {
	let transcript = applyEvent(emptyTranscript, {
		type: 'text',
		text: 'one',
		messageId: 'one',
	});
	transcript = applyEvent(transcript, {
		type: 'text',
		text: 'two',
		messageId: 'two',
	});
	t.deepEqual(transcript.items, [
		{kind: 'agent', text: 'one', messageId: 'one'},
		{kind: 'agent', text: 'two', messageId: 'two'},
	]);
});

test('plan snapshots replace in place and removal removes only that plan (ACP-12)', t => {
	let transcript = applyEvent(emptyTranscript, {
		type: 'plan',
		id: 'p',
		content: {kind: 'markdown', text: 'one'},
	});
	t.deepEqual(transcript, {
		items: [{kind: 'plan', id: 'p', content: {kind: 'markdown', text: 'one'}}],
		permissions: [],
	});
	transcript = applyEvent(transcript, {type: 'text', text: 'settled'});
	const settled = transcript.items[1];
	transcript = applyEvent(transcript, {
		type: 'plan',
		id: 'p',
		content: {kind: 'markdown', text: 'two'},
	});
	t.deepEqual(transcript.items[0], {
		kind: 'plan',
		id: 'p',
		content: {kind: 'markdown', text: 'two'},
	});
	t.is(transcript.items[1], settled);
	transcript = applyEvent(transcript, {type: 'plan', id: 'p', content: null});
	t.deepEqual(transcript.items, [settled]);
});

test('compaction patches preserve omissions, clear null and append chunks in order (ACP-12)', t => {
	let transcript = applyEvent(emptyTranscript, {
		type: 'compaction-chunk',
		id: 'c',
		text: 'one',
	});
	t.deepEqual(transcript, {
		items: [
			{kind: 'compaction', id: 'c', status: 'in_progress', summary: 'one'},
		],
		permissions: [],
	});
	transcript = applyEvent(transcript, {
		type: 'compaction',
		id: 'c',
		status: 'completed',
		error: 'fixture error',
	});
	transcript = applyEvent(transcript, {
		type: 'compaction-chunk',
		id: 'c',
		text: 'two',
	});
	t.deepEqual(transcript.items[0], {
		kind: 'compaction',
		id: 'c',
		status: 'completed',
		summary: 'onetwo',
		error: 'fixture error',
	});
	transcript = applyEvent(transcript, {
		type: 'compaction',
		id: 'c',
		status: 'completed',
		summary: null,
		error: null,
	});
	t.deepEqual(transcript.items[0], {
		kind: 'compaction',
		id: 'c',
		status: 'completed',
		summary: null,
		error: null,
	});
});

test('subagent metadata patches never add child actions or guessed state (ACP-12)', t => {
	let transcript = applyEvent(emptyTranscript, {
		type: 'subagent',
		id: 'child',
		title: 'one',
		description: 'detail',
		state: 'running',
	});
	t.deepEqual(transcript, {
		items: [
			{
				kind: 'subagent',
				id: 'child',
				title: 'one',
				description: 'detail',
				state: 'running',
			},
		],
		permissions: [],
	});
	transcript = applyEvent(transcript, {
		type: 'subagent',
		id: 'child',
		title: null,
		state: null,
	});
	t.deepEqual(transcript.items[0], {
		kind: 'subagent',
		id: 'child',
		title: null,
		description: 'detail',
		state: null,
	});
});

test('inter-session content replaces, clears and appends while sender identity is retained (ACP-12)', t => {
	let transcript = applyEvent(emptyTranscript, {
		type: 'session-message',
		id: 'm',
		sender: 'child',
		text: 'one',
		append: false,
	});
	t.deepEqual(transcript, {
		items: [{kind: 'session-message', id: 'm', sender: 'child', text: 'one'}],
		permissions: [],
	});
	transcript = applyEvent(transcript, {
		type: 'session-message',
		id: 'm',
		text: 'two',
		append: true,
	});
	transcript = applyEvent(transcript, {
		type: 'session-message',
		id: 'm',
		recipient: 'parent',
		append: false,
	});
	t.deepEqual(transcript.items[0], {
		kind: 'session-message',
		id: 'm',
		sender: 'child',
		recipient: 'parent',
		text: 'onetwo',
	});
	transcript = applyEvent(transcript, {
		type: 'session-message',
		id: 'm',
		text: '',
		append: false,
	});
	t.deepEqual(transcript.items[0], {
		kind: 'session-message',
		id: 'm',
		sender: 'child',
		recipient: 'parent',
		text: '',
	});
});

test('tool detail patches replace content without losing input or settled rows (CHAT-05)', t => {
	let transcript = applyEvent(emptyTranscript, {
		type: 'tool',
		id: 'tool',
		details: {content: ['one'], input: 'input'},
	});
	t.deepEqual(transcript.items[0], {
		kind: 'tool',
		id: 'tool',
		title: 'tool',
		status: 'pending',
		details: {content: ['one'], input: 'input'},
	});
	transcript = applyEvent(transcript, {type: 'text', text: 'settled'});
	const settled = transcript.items[1];
	transcript = applyEvent(transcript, {
		type: 'tool',
		id: 'tool',
		details: {content: []},
	});
	t.deepEqual(transcript.items[0], {
		kind: 'tool',
		id: 'tool',
		title: 'tool',
		status: 'pending',
		details: {content: [], input: 'input'},
	});
	t.is(transcript.items[1], settled);
});

test('reported mode configuration context and notices remain display data (ACP-12)', t => {
	t.deepEqual(applyEvent(emptyTranscript, {type: 'mode', id: 'plan'}), {
		...emptyTranscript,
		mode: 'plan',
	});
	t.deepEqual(applyEvent(emptyTranscript, {type: 'config', options: []}), {
		...emptyTranscript,
		config: [],
	});
	t.deepEqual(
		applyEvent(emptyTranscript, {type: 'context', used: 12, size: 100}),
		{...emptyTranscript, context: {used: 12, size: 100}},
	);
	t.deepEqual(
		applyEvent(emptyTranscript, {
			type: 'notice',
			title: 'notice',
			severity: 'warning',
		}),
		{
			items: [{kind: 'notice', title: 'notice', severity: 'warning'}],
			permissions: [],
		},
	);
});

test('rebuilds a resumed thread from its replayed events', t => {
	let transcript = emptyTranscript;
	for (const event of [
		{type: 'user', text: 'Earlier question'},
		{type: 'text', text: 'Earlier answer'},
		{type: 'tool', id: 'c1', title: 'ls', status: 'completed'},
	] as const) {
		transcript = applyEvent(transcript, event);
	}
	t.like(transcript.items, [
		{kind: 'user', text: 'Earlier question'},
		{kind: 'agent', text: 'Earlier answer'},
		{kind: 'tool', id: 'c1', title: 'ls', status: 'completed'},
	]);
	t.deepEqual(transcript.permissions, []);
});

test('joins consecutive agent text into one message', t => {
	let transcript = applyEvent(emptyTranscript, {type: 'user', text: 'Hi'});
	transcript = applyEvent(transcript, {type: 'text', text: 'Hello, '});
	transcript = applyEvent(transcript, {type: 'text', text: 'there.'});
	t.like(transcript.items, [
		{kind: 'user', text: 'Hi'},
		{kind: 'agent', text: 'Hello, there.'},
	]);
});

test('starts a new agent message after a tool call', t => {
	let transcript = applyEvent(emptyTranscript, {type: 'text', text: 'One'});
	transcript = applyEvent(transcript, {
		type: 'tool',
		id: 'c1',
		title: 'ls',
		status: 'pending',
	});
	transcript = applyEvent(transcript, {type: 'text', text: 'Two'});
	t.deepEqual(
		transcript.items.map(item => item.kind),
		['agent', 'tool', 'agent'],
	);
});

test('updates a tool call by id and keeps what the update leaves out', t => {
	let transcript = applyEvent(emptyTranscript, {
		type: 'tool',
		id: 'c1',
		title: 'execute_bash: ls',
		status: 'pending',
	});
	transcript = applyEvent(transcript, {
		type: 'tool',
		id: 'c1',
		status: 'completed',
	});
	transcript = applyEvent(transcript, {
		type: 'tool',
		id: 'c2',
		status: 'failed',
	});
	t.deepEqual(transcript.items, [
		{kind: 'tool', id: 'c1', title: 'execute_bash: ls', status: 'completed'},
		{kind: 'tool', id: 'c2', title: 'c2', status: 'failed'},
	]);
});

const request = (id: string) => ({
	id,
	title: `execute_bash: ${id}`,
	options: [{id: 'allow', name: 'Allow', kind: 'allow_once' as const}],
});

test('shows a permission request until it closes', t => {
	let transcript = applyEvent(emptyTranscript, {
		type: 'permission',
		request: request('permission-1'),
	});
	t.deepEqual(transcript.permissions, [request('permission-1')]);

	transcript = applyEvent(transcript, {type: 'permission-closed', id: 'other'});
	t.deepEqual(transcript.permissions, [request('permission-1')]);

	transcript = applyEvent(transcript, {
		type: 'permission-closed',
		id: 'permission-1',
	});
	t.deepEqual(transcript.permissions, []);
});

test('keeps every waiting request, so none can be left unanswerable', t => {
	let transcript = applyEvent(emptyTranscript, {
		type: 'permission',
		request: request('permission-1'),
	});
	transcript = applyEvent(transcript, {
		type: 'permission',
		request: request('permission-2'),
	});
	t.deepEqual(
		transcript.permissions.map(({id}) => id),
		['permission-1', 'permission-2'],
	);

	transcript = applyEvent(transcript, {
		type: 'permission-closed',
		id: 'permission-1',
	});
	t.deepEqual(
		transcript.permissions.map(({id}) => id),
		['permission-2'],
	);
});

test('does not list the same request twice', t => {
	let transcript = applyEvent(emptyTranscript, {
		type: 'permission',
		request: request('permission-1'),
	});
	transcript = applyEvent(transcript, {
		type: 'permission',
		request: request('permission-1'),
	});
	t.is(transcript.permissions.length, 1);
});

const at = (item: object) =>
	Object.hasOwn(item, 'at') ? Reflect.get(item, 'at') : 'none';

test('live user and first agent chunks take the applied time while joins and other rows add none', t => {
	let transcript = applyEvents(
		emptyTranscript,
		[
			{type: 'user', text: 'sent', messageId: 'u'},
			{type: 'thought', text: 'thinking'},
			{type: 'text', text: 'first', messageId: 'm'},
		],
		10,
	);
	transcript = applyEvent(
		transcript,
		{type: 'text', text: ' joined', messageId: 'm'},
		20,
	);
	transcript = applyEvents(
		transcript,
		[
			{type: 'tool', id: 'tool', status: 'completed'},
			{type: 'plan', id: 'plan', content: {entries: []}},
			{type: 'text', text: 'second'},
			{type: 'metadata', metadata: {durationMs: 1}},
		],
		30,
	);
	t.deepEqual(transcript.items.map(at), [10, 'none', 10, 'none', 'none', 30]);
	t.is(transcript.items[2]?.text, 'first joined');
	t.like(transcript.items[5], {
		kind: 'agent',
		text: 'second',
		metadata: {durationMs: 1},
	});
});

test('replayed or snapshot events applied without a time add no time field', t => {
	const transcript = applyEvents(emptyTranscript, [
		{type: 'user', text: 'saved'},
		{type: 'text', text: 'saved answer'},
	]);
	t.like(transcript.items, [
		{kind: 'user', text: 'saved'},
		{kind: 'agent', text: 'saved answer'},
	]);
	t.false(transcript.items.some(item => Object.hasOwn(item, 'at')));
});

test('carried times follow the shared message id and never a text prefix (A2)', t => {
	const previous = applyEvents(
		emptyTranscript,
		[
			{type: 'user', text: 'first', messageId: 'u1'},
			{type: 'text', text: 'partial', messageId: 'a1'},
			{type: 'user', text: 'second', messageId: 'u2'},
			{type: 'text', text: 'reply', messageId: 'a2'},
		],
		50,
	);
	const next = carryMessageTimes(
		previous,
		applyEvents(emptyTranscript, [
			{type: 'user', text: 'first', messageId: 'u1'},
			{type: 'text', text: 'partial and more', messageId: 'a1'},
			{type: 'user', text: 'second', messageId: 'u3'},
			{type: 'text', text: 'reply'},
		]),
	);
	t.deepEqual(next.items.map(at), [50, 50, 'none', 'none']);
});

test('id-less messages carry only on one exact text match and never by prefix (A2)', t => {
	const previous = applyEvents(
		emptyTranscript,
		[
			{type: 'user', text: 'saved'},
			{type: 'text', text: 'partial'},
			{type: 'user', text: 'twice'},
			{type: 'user', text: 'twice'},
			{type: 'text', text: 'reply'},
		],
		50,
	);
	const next = carryMessageTimes(
		previous,
		applyEvents(emptyTranscript, [
			{type: 'user', text: 'saved'},
			{type: 'text', text: 'partial and more'},
			{type: 'user', text: 'twice'},
			{type: 'text', text: 'reply', messageId: 'a9'},
		]),
	);
	t.deepEqual(next.items.map(at), [50, 'none', 'none', 'none']);
});

test('an id on only one side never carries a time (A2)', t => {
	const previous = applyEvents(
		emptyTranscript,
		[{type: 'text', text: 'reply', messageId: 'a1'}],
		50,
	);
	const next = carryMessageTimes(
		previous,
		applyEvents(emptyTranscript, [{type: 'text', text: 'reply'}]),
	);
	t.is(next.items.map(at)[0], 'none');
});

test('row identity survives streamed appends and prefers reported structural ids', t => {
	const streamed = applyEvents(emptyTranscript, [
		{type: 'text', text: 'first chunk'},
		{type: 'text', text: ' and the next chunk'},
	]);
	t.is(
		transcriptRowId(streamed.items[0], 0),
		`agent:${streamed.items[0].rowId}`,
	);
	const identified = applyEvents(emptyTranscript, [
		{type: 'text', text: 'first chunk', messageId: 'message-1'},
		{type: 'text', text: ' and the next chunk', messageId: 'message-1'},
	]);
	t.is(transcriptRowId(identified.items[0], 0), 'agent:message-1');
});

test('id-less replay rows never reuse an identity for different content', t => {
	const first = applyEvent(emptyTranscript, {
		type: 'text',
		text: 'first replay answer',
	});
	const second = applyEvent(emptyTranscript, {
		type: 'text',
		text: 'different replay answer',
	});
	t.not(
		transcriptRowId(first.items[0], 0),
		transcriptRowId(second.items[0], 0),
	);
});

test('CHAT-08 replay keeps the live row across chunk boundaries and repeated identical turns', t => {
	const previous = applyEvents(emptyTranscript, [
		{type: 'user', text: 'same question'},
		{type: 'text', text: 'first '},
		{type: 'text', text: 'answer'},
		{type: 'user', text: 'same question'},
		{type: 'text', text: 'first '},
		{type: 'text', text: 'answer'},
	]);
	const next = carryMessageRows(
		previous,
		applyEvents(emptyTranscript, [
			{type: 'user', text: 'same question'},
			{type: 'text', text: 'first answer'},
			{type: 'user', text: 'same question'},
			{type: 'text', text: 'first answer'},
		]),
	);
	t.deepEqual(
		next.items.map(transcriptRowId),
		previous.items.map(transcriptRowId),
	);
	t.is(new Set(next.items.map(transcriptRowId)).size, 4);
	const different = carryMessageRows(
		previous,
		applyEvents(emptyTranscript, [
			{type: 'user', text: 'different question'},
			{type: 'text', text: 'different answer'},
		]),
	);
	t.not(
		transcriptRowId(different.items[0], 0),
		transcriptRowId(previous.items[0], 0),
	);
});

test('CHAT-08 snapshot replacement never reuses a row for different text sharing its first chunk', t => {
	const previous = applyEvents(emptyTranscript, [
		{type: 'text', text: 'shared prefix'},
		{type: 'text', text: ' old answer'},
	]);
	const replacement = carryMessageRows(
		previous,
		applyEvents(emptyTranscript, [
			{type: 'text', text: 'shared prefix'},
			{type: 'text', text: ' new answer'},
		]),
	);
	t.not(
		transcriptRowId(previous.items[0], 0),
		transcriptRowId(replacement.items[0], 0),
	);
});

test('an empty agent message with a shared id never carries a time (A2)', t => {
	const previous = applyEvents(
		emptyTranscript,
		[{type: 'text', text: '', messageId: 'a1'}],
		50,
	);
	const next = carryMessageTimes(
		previous,
		applyEvents(emptyTranscript, [{type: 'text', text: '', messageId: 'a1'}]),
	);
	t.is(next.items.map(at)[0], 'none');
});

test('a message id on the new item never carries from an id-less earlier item (A2)', t => {
	const previous = applyEvents(
		emptyTranscript,
		[{type: 'text', text: 'reply'}],
		50,
	);
	const next = carryMessageTimes(
		previous,
		applyEvents(emptyTranscript, [
			{type: 'text', text: 'reply', messageId: 'a1'},
		]),
	);
	t.is(next.items.map(at)[0], 'none');
});

test('carrying times never overwrites a time, ignores empty agent text and keeps an unmatched transcript', t => {
	const previous = applyEvents(
		emptyTranscript,
		[
			{type: 'user', text: 'sent'},
			{type: 'text', text: ''},
		],
		1,
	);
	const stamped = applyEvent(emptyTranscript, {type: 'user', text: 'sent'}, 2);
	t.is(at(carryMessageTimes(previous, stamped).items[0]), 2);
	const unmatched = applyEvents(emptyTranscript, [
		{type: 'user', text: 'other'},
		{type: 'text', text: 'anything'},
	]);
	t.is(carryMessageTimes(previous, unmatched), unmatched);
	t.is(carryMessageTimes(emptyTranscript, unmatched), unmatched);
});
