import test from 'ava';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Composer, type ComposerProps} from '@/renderer/composer';
import {keyHint} from '@/renderer/overlay-model';

const props: ComposerProps = {
	draft: 'retained fixture draft',
	editable: true,
	sendReason: null,
	controlReason: null,
	projectName: 'fixture',
	projectControls: null,
	mode: 'normal',
	defaultMode: 'normal',
	modePending: true,
	running: false,
	stopping: false,
	commands: [],
	onDraft() {},
	onSend() {},
	onCancel() {},
	onMode() {},
	onDefault() {},
	onConfig() {},
};
const render = (patch: Partial<ComposerProps> = {}) =>
	renderToStaticMarkup(createElement(Composer, {...props, ...patch}));

test('composer names model/provider scope for every thread and explains missing offers (CHAT-04 CHAT-10)', t => {
	let calls = 0;
	const html = render({
		onConfig: () => {
			calls++;
		},
		onMode: () => {
			calls++;
		},
	});
	t.true(
		html.includes('model and provider for every thread in project fixture'),
	);
	t.true(html.includes('available after the first message'));
	t.true(
		html.includes('Nanocoder supplies model options after a session exists'),
	);
	t.true(html.includes('ask anything…'));
	t.true(html.includes('<textarea'));
	t.is(calls, 0);
});

test('busy composer keeps the editable draft and cancel while blocking controls and send with reasons (CHAT-17)', t => {
	const html = render({
		running: true,
		modePending: false,
		controlReason: 'stop the running turn first',
		sendReason: 'another thread is running',
	});
	t.true(html.includes('retained fixture draft</textarea>'));
	t.notRegex(html, /<textarea[^>]*disabled/);
	t.regex(html, /<button(?=[^>]*aria-label="send")(?=[^>]*disabled="")[^>]*>/);
	t.regex(
		html,
		/<button(?=[^>]*role="combobox")(?=[^>]*aria-label="mode for this thread")(?=[^>]*disabled="")[^>]*>/,
	);
	t.true(html.includes('another thread is running'));
	t.true(html.includes('stop the running turn first'));
	t.true(html.includes('cancel turn'));
	t.true(html.includes('aria-describedby='));
});

test('mode selection distinguishes pending yolo from a project default and discloses alwaysAllow (CHAT-11 DEC-31)', t => {
	const html = render({mode: 'yolo'});
	t.true(html.includes('yolo · pending first message'));
	t.true(
		html.includes(
			'tools in Nanocoder&#x27;s alwaysAllow list still run without asking.',
		),
	);
	t.regex(
		html,
		/<button(?=[^>]*disabled="")[^>]*>use as this project&#x27;s default<\/button>/,
	);
	t.true(html.includes('yolo cannot be a project default'));
	const nonDefault = render({mode: 'plan', modePending: false});
	t.true(nonDefault.includes('use as this project&#x27;s default'));
	t.true(nonDefault.includes('project default: normal'));
});

test('project selects show only confirmed values and escape labels (CHAT-10 ACP-14)', t => {
	const html = render({
		projectName: '<fixture>',
		projectControls: {
			projectId: 'fixture',
			revision: 'fixture-revision',
			modelScope: 'project',
			threadId: null,
			modelGate: {enabled: true, reason: null},
			configOptions: [
				{
					id: 'model',
					name: 'model',
					currentValue: 'confirmed',
					options: [
						{name: 'old', value: 'old'},
						{name: '<confirmed>', value: 'confirmed'},
					],
				},
			],
		},
	});
	t.true(html.includes('model for every thread in project &lt;fixture&gt;'));
	t.true(
		html.includes(
			'aria-selected="true" data-value="confirmed" data-active="true">&lt;confirmed&gt;</li>',
		),
	);
	t.false(html.includes('<confirmed>'));
});

test('composer names this thread, not the project, when Nanocoder keeps model state per session (ACP-14 CHAT-10)', t => {
	const controls = {
		projectId: 'project',
		revision: 'revision',
		modelScope: 'thread' as const,
		threadId: 'thread',
		modelGate: {enabled: true, reason: null},
		configOptions: [
			{
				id: 'model' as const,
				name: 'model',
				currentValue: 'old',
				options: [{name: 'old', value: 'old'}],
			},
		],
	};
	const html = render({projectControls: controls});
	t.true(html.includes('model for this thread in project fixture'));
	t.true(html.includes('model applies to this thread only.'));
	t.false(html.includes('every thread'));
	const shared = render({
		projectControls: {...controls, modelScope: 'project'},
	});
	t.true(shared.includes('model for every thread in project fixture'));
	t.true(shared.includes('model applies to every thread in fixture.'));
	t.false(shared.includes('this thread only'));
});

test('composer context pill and gauge require actual reported context, not draft length (CHAT-19 U.5)', t => {
	const absent = render();
	t.false(absent.includes('role="progressbar"'));
	t.false(absent.includes('ctx '));
	t.false(absent.includes('estimated'));
	const actual = render({context: {used: 32, size: 100}});
	t.true(actual.includes('ctx 32%'));
	t.true(actual.includes('role="progressbar"'));
	t.true(actual.includes('aria-valuenow="32"'));
});

test('composer shows one draft hint, help row and control note without a prompt glyph (C-01 C-02 C-05 C-09)', t => {
	const ready = render({draft: '', modePending: false});
	t.true(ready.includes('ready for your next message'));
	t.true(ready.includes('enter a message to send'));
	t.true(ready.includes(keyHint('↵ send · ⇧↵ newline')));
	t.false(ready.includes('›'));
	t.regex(
		ready,
		/composer-send"><svg[^>]*lucide-arrow-up[^>]*aria-hidden="true"/,
	);
	t.true(
		ready.includes(
			'model applies to every thread in fixture. tools in Nanocoder&#x27;s alwaysAllow list still run without asking.',
		),
	);
	const running = render({
		running: true,
		modePending: false,
		controlReason: 'model + mode locked until the project turn stops',
		sendReason: 'turn in progress · draft is not queued',
	});
	t.true(running.includes('turn in progress · draft is not queued'));
	t.true(running.includes('write a draft for later…'));
	t.true(running.includes('composer-cancel">cancel turn</button>'));
	t.true(
		running.includes(
			'model + mode locked until the project turn stops. model applies to every thread in fixture.',
		),
	);
	t.false(running.includes('stop the project turn'));
});

test('the draft textarea describes its state and keyboard hint together', t => {
	const html = render({draft: ''});
	const described = /<textarea[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
	const [descriptionId, helpId] = (described ?? '').split(' ');
	t.is(described?.split(' ').length, 2);
	t.true(
		html.includes(
			`<span id="${descriptionId}" class="sr-only" aria-hidden="true">ready for your next message; enter a message to send</span>`,
		),
	);
	t.true(html.includes(`aria-describedby="${descriptionId}"`));
	t.true(html.includes(`<p id="${helpId}" class="sr-only composer-help">`));
	t.true(html.includes(keyHint('↵ send · ⇧↵ newline')));
	t.true(html.includes('<p class="gate-hint">ready for your next message</p>'));
	const busy = render({
		running: true,
		modePending: false,
		sendReason: 'another thread is running',
	});
	t.true(
		busy.includes(
			'class="sr-only" aria-hidden="true">another thread is running</span>',
		),
	);
});

test('the options disclosure is a button that controls its body (C-05)', t => {
	const html = render({});
	const toggle =
		/<button type="button" class="composer-options-toggle" aria-label="mode and project default details" title="mode and project default" aria-expanded="false" aria-controls="([^"]+)"><svg/.exec(
			html,
		);
	const id = toggle?.[1] ?? '';
	t.truthy(id);
	t.true(html.includes(`<div id="${id}" class="gate-actions" hidden="">`));
	t.false(html.includes('<details'));
});
