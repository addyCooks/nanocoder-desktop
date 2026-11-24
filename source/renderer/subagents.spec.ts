import test from 'ava';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {toTurnEvent} from '@/main/nanocoder/turn-events';
import {ConversationStream} from '@/renderer/conversation-stream';
import {
	applyEvent,
	emptyTranscript,
	settleSubagentTurn,
} from '@/renderer/transcript';

function mapped(...args: Parameters<typeof toTurnEvent>) {
	const event = toTurnEvent(...args);
	if (!event) throw new Error('Fixture update did not map');
	return event;
}

const delegation = () =>
	mapped({
		sessionUpdate: 'tool_call',
		toolCallId: 'parent-call',
		title: 'explore: inspect fixture',
		kind: 'think',
		status: 'pending',
		rawInput: {
			subagent_type: 'explore',
			description: 'inspect fixture',
			prompt: 'private fixture prompt',
		},
	});

for (const outcome of [
	'completed',
	'failed',
	'interrupted',
	'unknown',
	undefined,
	'unlisted',
] as const) {
	test(`SUB-05 historical ${outcome ?? 'missing'} outcome stays inert and never becomes success`, t => {
		const transcript = applyEvent(emptyTranscript, {
			type: 'tool',
			id: 'historical',
			status: 'completed',
			delegation: {role: 'explore', history: true},
			...(outcome !== undefined && {
				history: {outcome: outcome as 'unknown'},
			}),
		});
		const html = renderToStaticMarkup(
			createElement(ConversationStream, {
				transcript,
				running: true,
				onStopTurn: () => {},
			}),
		);
		const expected =
			outcome === 'failed' || outcome === 'interrupted'
				? outcome
				: outcome === 'completed'
					? 'previously reported completed'
					: 'historical outcome not reported';
		t.true(html.includes(expected));
		t.false(html.includes('✓'));
		t.false(html.includes('<button'));
		t.is(
			html.includes('subagent-status--error'),
			outcome === 'failed' || outcome === 'interrupted',
		);
	});
}

test('SUB-01 extracts only display delegation metadata and retains it on title-only progress', t => {
	const initial = delegation();
	t.deepEqual(initial.type === 'tool' && initial.delegation, {
		role: 'explore',
		task: 'inspect fixture',
		history: false,
	});
	const first = applyEvent(emptyTranscript, initial);
	const next = applyEvent(
		first,
		mapped({
			sessionUpdate: 'tool_call_update',
			toolCallId: 'parent-call',
			title: 'explore • 1.2k tokens • 3 tools (read_file)',
			status: 'in_progress',
		}),
	);
	t.is(next.items.length, 1);
	const item = next.items[0];
	t.deepEqual(
		item.kind === 'tool' && item.delegation,
		initial.type === 'tool' && initial.delegation,
	);
});

test('SUB-01 tool IDs are scoped to their turn and late running updates do not revive terminal runs', t => {
	let state = applyEvent(emptyTranscript, delegation());
	state = applyEvent(state, {
		type: 'tool',
		id: 'parent-call',
		status: 'completed',
	});
	const settled = state.items[0];
	state = applyEvent(state, {
		type: 'tool',
		id: 'parent-call',
		status: 'in_progress',
		title: 'late progress',
	});
	t.is(state.items[0], settled);
	state = applyEvent(state, {type: 'user', text: 'new fixture turn'});
	state = applyEvent(state, delegation());
	t.is(state.items.length, 3);
	t.is(state.items[0], settled);
});

test('SUB-01 reused tool IDs retain independent rows and details across turns', t => {
	const first = applyEvent(emptyTranscript, {
		type: 'tool',
		id: 'reused-call',
		title: 'first fixture tool',
		status: 'completed',
		details: {content: ['first fixture detail']},
	});
	const previous = first.items[0];
	const next = applyEvent(
		applyEvent(first, {type: 'user', text: 'next fixture turn'}),
		{
			type: 'tool',
			id: 'reused-call',
			title: 'second fixture tool',
			status: 'completed',
			details: {content: ['second fixture detail']},
		},
	);
	t.is(next.items.length, 3);
	t.is(next.items[0], previous);
	t.deepEqual(
		next.items.filter(item => item.kind === 'tool').map(item => item.details),
		[{content: ['first fixture detail']}, {content: ['second fixture detail']}],
	);
});

test('SUB-07 recognises thin agent replay but never upgrades arbitrary think tools', t => {
	const historical = toTurnEvent(
		{
			sessionUpdate: 'tool_call',
			toolCallId: 'history',
			title: 'agent',
			rawInput: {},
			status: 'completed',
		},
		{history: true},
	);
	t.deepEqual(historical?.type === 'tool' && historical.delegation, {
		history: true,
	});
	const ordinary = toTurnEvent({
		sessionUpdate: 'tool_call',
		toolCallId: 'ordinary',
		title: 'analysis',
		kind: 'think',
	});
	t.is(ordinary?.type === 'tool' && ordinary.delegation, undefined);
});

test('SUB-03 prefixed child completion means approval, not successful execution', t => {
	const event = mapped({
		sessionUpdate: 'tool_call',
		toolCallId: 'subagent:inner',
		title: 'execute_bash (explore)',
		kind: 'execute',
		status: 'completed',
	});
	t.is(event.type === 'tool' && event.approvalOnly, true);
	const html = renderToStaticMarkup(
		createElement(ConversationStream, {
			transcript: applyEvent(emptyTranscript, event),
			running: false,
		}),
	);
	t.true(html.includes('approved'));
	t.true(html.includes('execution result not reported'));
	t.false(html.includes('succeeded'));
});

test('SUB-01/04 renders a flat U.7 card with truthful depth and whole-turn stop', t => {
	const html = renderToStaticMarkup(
		createElement(ConversationStream, {
			transcript: applyEvent(emptyTranscript, delegation()),
			running: true,
			onStopTurn: async () => {},
		}),
	);
	t.true(html.includes('subagent-run-card'));
	t.true(html.includes('inspect fixture'));
	t.true(
		html.includes(
			'depth, elapsed time and child tool details were not reported.',
		),
	);
	t.false(html.includes('source bounds'));
	t.true(html.includes('display-only progress'));
	t.true(html.includes('reported role · explore'));
	t.true(html.includes('entire turn and all subagents'));
	t.true(html.includes('aria-label="stop whole turn: explore;'));
	t.true(html.includes('stop whole turn</button>'));
	t.is((html.match(/<button /g) ?? []).length, 1);
	t.false(html.includes('stop subagent'));
	t.false(html.includes('private fixture prompt'));
});

test('SUB-07 replay and SDK child rows are fallback cards without live controls', t => {
	const historical = mapped(
		{
			sessionUpdate: 'tool_call',
			toolCallId: 'history',
			title: 'agent',
			status: 'completed',
		},
		{history: true},
	);
	const title = ['<script>', 'fixture', '</script>'].join('');
	const transcript = applyEvent(applyEvent(emptyTranscript, historical), {
		type: 'subagent',
		id: 'unlinked-child',
		title,
		state: null,
	});
	const html = renderToStaticMarkup(
		createElement(ConversationStream, {
			transcript,
			running: true,
			onStopTurn: async () => {},
		}),
	);
	t.is((html.match(/class="subagent-run-card"/g) ?? []).length, 2);
	t.true(html.includes('aria-label="subagent run 1 of 2: subagent"'));
	t.true(html.includes('aria-label="subagent run 2 of 2: subagent"'));
	t.true(html.includes('historical outcome not reported'));
	t.true(html.includes('child tool details were not reported'));
	t.false(html.includes('<button'));
	t.notRegex(html, /<script\b/i);
});

test('SUB-04 known interrupted cards keep their outcome when another turn starts', t => {
	const settled = settleSubagentTurn(
		applyEvent(emptyTranscript, delegation()),
		'cancelled',
	);
	const state = applyEvent(
		applyEvent(settled, {type: 'user', text: 'next turn'}),
		delegation(),
	);
	const html = renderToStaticMarkup(
		createElement(ConversationStream, {transcript: state, running: true}),
	);
	t.true(html.includes('interrupted'));
	t.true(html.includes('pending'));
	t.false(html.includes('result not reported'));
	t.is(state.items[0], settled.items[0]);
});

for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
	test(`SUB-04 settled ${outcome} cards never regain stop while a new turn awaits its user boundary`, t => {
		const transcript = settleSubagentTurn(
			applyEvent(emptyTranscript, delegation()),
			outcome,
		);
		const html = renderToStaticMarkup(
			createElement(ConversationStream, {
				transcript,
				running: true,
				onStopTurn: async () => {},
			}),
		);
		t.false(html.includes('<button'));
	});
}

test('A11Y-01/02 subagent cards expose a named programmatic focus fallback', t => {
	const html = renderToStaticMarkup(
		createElement(ConversationStream, {
			transcript: applyEvent(emptyTranscript, delegation()),
			running: true,
			onStopTurn: async () => {},
		}),
	);
	t.regex(
		html,
		/<section[^>]*aria-label="subagent run 1 of 1: explore"[^>]*tabindex="-1"/,
	);
});

test('A11Y-03 same-name subagent landmarks have unique payload-free positions', t => {
	const first = delegation();
	const second = mapped({
		sessionUpdate: 'tool_call',
		toolCallId: 'private-second-tool-id',
		title: 'explore: inspect fixture',
		kind: 'think',
		status: 'pending',
		rawInput: {subagent_type: 'explore', description: 'inspect fixture'},
	});
	const html = renderToStaticMarkup(
		createElement(ConversationStream, {
			transcript: applyEvent(applyEvent(emptyTranscript, first), second),
			running: true,
		}),
	);
	const names = [...html.matchAll(/aria-label="(subagent run[^"]*)"/g)].map(
		match => match[1],
	);
	t.deepEqual(names, [
		'subagent run 1 of 2: explore',
		'subagent run 2 of 2: explore',
	]);
	t.false(names.join().includes('private-second-tool-id'));
	t.false(names.join().includes('inspect fixture'));
});

test('SUB-01 settled unfinished runs reject late progress without inventing success', t => {
	const settled = settleSubagentTurn(
		applyEvent(emptyTranscript, delegation()),
		'completed',
	);
	const next = applyEvent(settled, {
		type: 'tool',
		id: 'parent-call',
		status: 'in_progress',
		title: 'late progress',
	});
	t.is(next.items[0], settled.items[0]);
	const html = renderToStaticMarkup(
		createElement(ConversationStream, {transcript: next, running: false}),
	);
	t.true(html.includes('result not reported'));
	t.false(html.includes('✓'));
});
