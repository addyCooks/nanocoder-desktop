import test from 'ava';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ConversationStream} from '@/renderer/conversation-stream';
import {
	applyEvents,
	emptyTranscript,
	type TranscriptItem,
} from '@/renderer/transcript';

const render = (items: TranscriptItem[], running = false) =>
	renderToStaticMarkup(
		createElement(ConversationStream, {
			transcript: {...emptyTranscript, items},
			running,
			children: createElement('p', null, 'approval slot fixture'),
		}),
	);

test('user and assistant rows expose copy controls without changing message text or composer labels', t => {
	const first = renderToStaticMarkup(
		createElement(ConversationStream, {
			transcript: {
				...emptyTranscript,
				items: [
					{kind: 'user', text: 'original user text', rowId: 'user-row'},
					{kind: 'agent', text: 'original **agent** text', rowId: 'agent-row'},
				],
			},
			running: false,
			onCopy() {},
		}),
	);
	t.is(first.match(/aria-label="copy text"/g)?.length, 2);
	t.false(first.includes('aria-label="copy message"'));
	t.false(first.includes('>copy<'));
});

test('empty streaming rows have no copy action and attachment summaries remain separate display text', t => {
	const html = renderToStaticMarkup(
		createElement(ConversationStream, {
			transcript: {
				...emptyTranscript,
				items: [
					{
						kind: 'user',
						text: 'original',
						attachmentSummary: ['attached: fixture.ts'],
					},
					{kind: 'agent', text: ''},
				],
			},
			running: true,
			onCopy() {},
		}),
	);
	t.is(html.match(/aria-label="copy text"/g)?.length, 1);
	t.true(html.includes('<div class="stream-plain">original</div>'));
	t.true(html.includes('<div class="stream-plain">attached: fixture.ts</div>'));
});

test('user and agent author labels show only reported token and cost metadata (CHAT-05 CHAT-19)', t => {
	const html = render([
		{kind: 'user', text: 'question'},
		{
			kind: 'agent',
			text: '# answer',
			metadata: {usage: {totalTokens: 20, cost: 0.01}},
		},
	]);
	t.true(html.includes('stream-author'));
	t.true(html.includes('you'));
	t.true(html.includes('Nanocoder'));
	t.true(html.includes('+20 tok'));
	t.true(html.includes('reported cost: 0.01'));
	t.true(html.includes('<h1>answer</h1>'));
	t.true(html.includes('approval slot fixture'));
	const absent = render([{kind: 'agent', text: 'no usage reported'}]);
	t.false(absent.includes('stream-token-chip'));
	t.false(absent.includes('role="progressbar"'));
});

test('assistant-less turns show reported usage in their own turn row (CHAT-19)', t => {
	const transcript = applyEvents(emptyTranscript, [
		{type: 'user', text: 'first question'},
		{type: 'text', text: 'settled answer'},
		{
			type: 'metadata',
			metadata: {usage: {totalTokens: 17}, outcome: 'completed'},
		},
		{type: 'user', text: 'next question'},
		{type: 'tool', id: 'next-tool', status: 'failed'},
		{
			type: 'metadata',
			metadata: {usage: {totalTokens: 31}, outcome: 'failed'},
		},
	]);
	const html = render(transcript.items);
	t.regex(
		html,
		/<li class="gate-message-agent"[^>]*>(?:(?!<\/li>).)*\+17 tok(?:(?!<\/li>).)*completed(?:(?!<\/li>).)*settled answer(?:(?!<\/li>).)*<\/li>/,
	);
	t.regex(
		html,
		/<li class="gate-message-turn-metadata"[^>]*>(?:(?!<\/li>).)*turn details(?:(?!<\/li>).)*\+31 tok(?:(?!<\/li>).)*failed(?:(?!<\/li>).)*<\/li>/,
	);
	t.notRegex(
		html,
		/<li class="gate-message-agent"[^>]*>(?:(?!<\/li>).)*\+31 tok/,
	);
});

test('a cursor belongs only to the currently streaming last agent message (CHAT-05)', t => {
	const agent: TranscriptItem = {kind: 'agent', text: 'answer'};
	t.true(render([agent], true).includes('stream-cursor'));
	t.false(render([agent]).includes('stream-cursor'));
	t.false(
		render(
			[agent, {kind: 'tool', id: 't', title: 'tool', status: 'in_progress'}],
			true,
		).includes('stream-cursor'),
	);
});

test('reasoning has its own label and tool details expand through native disclosure (CHAT-05)', t => {
	const html = render([
		{kind: 'thought', text: 'reasoning fixture'},
		{
			kind: 'tool',
			id: 't',
			title: 'fixture tool',
			status: 'in_progress',
			details: {input: '<script>fixture</script>', content: ['fixture result']},
		},
	]);
	t.true(html.includes('stream-reasoning'));
	t.true(html.includes('reasoning fixture'));
	t.true(html.includes('<details'));
	t.true(html.includes('<summary'));
	t.true(html.includes('spinner'));
	t.true(html.includes('running'));
	t.true(html.includes('&lt;script&gt;fixture&lt;/script&gt;'));
	t.notRegex(html, /<script\b/i);
});

test('tool status always has a word and a result glyph (CHAT-05)', t => {
	for (const [status, glyph] of [
		['completed', '✓'],
		['failed', '✕'],
		['pending', '○'],
	]) {
		const html = render([
			{kind: 'tool', id: 't', title: 'fixture tool', status},
		]);
		t.true(html.includes(glyph));
		t.true(html.includes(status));
	}
});

test('subagent and file-plan rows are inert truthful display, not child capabilities (ACP-12)', t => {
	const html = render([
		{kind: 'subagent', id: 'child', title: 'fixture child', state: null},
		{
			kind: 'plan',
			id: 'p',
			content: {kind: 'file', uri: 'file:///fixture/plan.md'},
		},
	]);
	t.true(html.includes('fixture child'));
	t.true(html.includes('state not reported'));
	t.true(html.includes('plan file not opened'));
	t.notRegex(html, /<button|<a\b|\shref=|\ssrc=/);
	t.false(html.includes('stop whole turn'));
});

test('context is shown only from an actual usage_update, never turn token totals (CHAT-19)', t => {
	const transcript = applyEvents(emptyTranscript, [
		{
			type: 'context',
			used: 12,
			size: 100,
			cost: {amount: 0.5, currency: 'USD'},
		},
	]);
	const html = renderToStaticMarkup(
		createElement(ConversationStream, {transcript, running: false}),
	);
	t.true(html.includes('role="progressbar"'));
	t.true(html.includes('aria-valuenow="12"'));
	t.true(html.includes('session cost: 0.5 USD'));
});

test('finished reasoning and completed tools fold while reported failures start open', t => {
	const html = render([
		{kind: 'thought', text: 'finished reasoning fixture'},
		{
			kind: 'tool',
			id: 'done',
			title: 'done',
			status: 'completed',
			details: {output: 'routine output'},
		},
		{
			kind: 'tool',
			id: 'bad',
			title: 'bad',
			status: 'failed',
			details: {output: 'reported failure'},
		},
	]);
	t.regex(html, /<details class="stream-reasoning">/);
	t.regex(html, /<details open="">/);
	t.true(html.includes('reported failure'));
	t.true(html.includes('routine output'));
});

test('one agent label per turn carries the first live message time under a day label (A2 C-22 C-23 C-28)', t => {
	const at = new Date(2026, 9, 31, 10, 42).getTime();
	const html = renderToStaticMarkup(
		createElement(ConversationStream, {
			transcript: {
				...emptyTranscript,
				items: [
					{kind: 'user', text: 'question', at},
					{kind: 'thought', text: 'thinking'},
					{
						kind: 'tool',
						id: 't',
						title: 'src/export.ts',
						status: 'completed',
						toolKind: 'read',
					},
					{kind: 'agent', text: 'answer', at: at + 5000},
				],
			},
			running: false,
			now: () => new Date(2026, 9, 31, 12, 0).getTime(),
		}),
	);
	t.is(html.match(/stream-author-agent/g)?.length, 1);
	t.true(html.includes('today · 10:42'));
	t.true(html.includes('you <time'));
	t.true(html.includes('reasoning · reported by Nanocoder'));
});

test('untimed history shows a saved-history day label and no times (A2)', t => {
	const html = render([
		{kind: 'user', text: 'old question'},
		{kind: 'agent', text: 'old answer'},
	]);
	t.true(html.includes('saved history'));
	t.true(html.includes('times are not saved in Nanocoder history'));
	t.false(html.includes('<time'));
});

test('a failed turn shows the supplied notice in place of the failure row (B-32 B-33)', t => {
	const notice = createElement('p', null, 'notice fixture');
	const withNotice = renderToStaticMarkup(
		createElement(ConversationStream, {
			transcript: {
				...emptyTranscript,
				items: [
					{kind: 'user', text: 'question'},
					{kind: 'failure', text: 'stopped'},
				],
			},
			running: false,
			failureNotice: notice,
		}),
	);
	t.true(withNotice.includes('notice fixture'));
	t.false(withNotice.includes('failed turn: stopped'));
	t.true(
		render([{kind: 'failure', text: 'stopped'}]).includes(
			'failed turn: stopped',
		),
	);
});

test('the stop reason stays in a data attribute and shows a line only when it is not end_turn (C-26)', t => {
	const agent = {
		...emptyTranscript,
		items: [{kind: 'agent' as const, text: 'done'}],
	};
	const normal = renderToStaticMarkup(
		createElement(ConversationStream, {
			transcript: agent,
			running: false,
			stopReason: 'end_turn',
		}),
	);
	t.true(normal.includes('data-stop-reason="end_turn"'));
	t.false(normal.includes('stream-turn-note'));
	t.false(normal.includes('turn ended'));
	const interrupted = renderToStaticMarkup(
		createElement(ConversationStream, {
			transcript: agent,
			running: false,
			stopReason: 'cancelled',
		}),
	);
	t.true(interrupted.includes('turn interrupted'));
});

test('consecutive tool calls share one panel with fold, status and verb rows (C-17 C-18 C-19)', t => {
	const html = render([
		{
			kind: 'tool',
			id: 'a',
			title: 'src/export.ts',
			status: 'completed',
			toolKind: 'read',
		},
		{
			kind: 'tool',
			id: 'b',
			title: 'src/export.ts',
			status: 'in_progress',
			toolKind: 'edit',
		},
	]);
	t.true(html.includes('stream-tool-first'));
	t.true(html.includes('stream-tool-last'));
	t.true(html.includes('running'));
	t.true(html.includes('waiting for Nanocoder&#x27;s tool result'));
	t.false(html.includes('tool <code'));
	t.false(html.includes(': completed'));
});

test('a running tool row shows its kind once and its reported title once (C-19)', t => {
	const html = render(
		[
			{
				kind: 'tool',
				id: 'c',
				title: 'execute_bash: pnpm test:unit -- export',
				status: 'in_progress',
				toolKind: 'execute',
			},
		],
		true,
	);
	t.true(html.includes('<span class="stream-tool-verb">execute </span>'));
	t.true(
		html.includes(
			'<p class="stream-tool-detail">execute_bash: pnpm test:unit -- export</p>',
		),
	);
	t.false(html.includes('<code class="stream-tool-name">'));
});

test('a finished tool row shows its kind word once, dropping it when the title already has it', t => {
	const kept = render([
		{
			kind: 'tool',
			id: 'e',
			title: 'src/export.ts',
			status: 'completed',
			toolKind: 'read',
		},
	]);
	t.true(kept.includes('<span class="stream-tool-verb">read </span>'));
	const once = render([
		{
			kind: 'tool',
			id: 'f',
			title: 'read src/export.ts',
			status: 'completed',
			toolKind: 'read',
		},
	]);
	t.false(once.includes('<span class="stream-tool-verb">read </span>'));
	t.true(
		once.includes('<code class="stream-tool-name">read src/export.ts</code>'),
	);
});
