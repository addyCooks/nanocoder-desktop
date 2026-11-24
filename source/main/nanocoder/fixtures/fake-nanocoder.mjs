// Stands in for `nanocoder --acp` in tests. A .fake-nanocoder file in the working directory picks the behaviour.
import {createHash, randomUUID} from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	readFileSync,
	watch,
	writeFileSync,
} from 'node:fs';
import {isAbsolute, join, relative} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const mode = existsSync('.fake-nanocoder')
	? readFileSync('.fake-nanocoder', 'utf8').trim()
	: 'ok';
// What `files-timeline` kept before the agent's first edit of a file, as Nanocoder's snapshots do.
const before = new Map();
const MODES = ['normal', 'auto-accept', 'yolo', 'plan', 'architect'];
const TRUST_REASONS = {
	untrusted: 'is not trusted',
	changed: 'changed since you trusted it',
};
// Reports HTTP client MCP servers like Nanocoder 1.32.0, beside any mode.
const mcpHttp = existsSync('.fake-mcp-http');
// A test-owned absolute path outside the project, so a session secret never lands in a project folder.
const mcpRecord = process.env.NANOCODER_TEST_MCP_RECORD;
let nextSession = 0;
const scopedSessions = process.env.NANOCODER_TEST_SCOPED_SESSIONS === '1';
const sessionPrefix = `fake-session-${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12)}`;
let replayModel = 'old';
const replayConfig = () => [
	{
		id: 'model',
		name: 'model',
		type: 'select',
		category: 'model',
		currentValue: replayModel,
		options: [
			{name: 'old', value: 'old'},
			{name: 'confirmed', value: 'confirmed'},
		],
	},
];

const log = event => {
	const line = `${JSON.stringify(event)}\n`;
	if (
		event.method !== 'session/list' ||
		!existsSync('.fake-hold-list-stderr')
	) {
		return process.stderr.write(line);
	}
	let flushed = false;
	let watcher;
	const flush = () => {
		if (flushed || !existsSync('.fake-release-list-stderr')) return;
		flushed = true;
		watcher?.close();
		process.stderr.write(line);
	};
	watcher = watch('.', {persistent: false}, flush);
	flush();
};
const send = message =>
	process.stdout.write(`${JSON.stringify({jsonrpc: '2.0', ...message})}\n`);

function refuse(reason) {
	process.stderr.write(
		`[nanocoder] Directory ${process.cwd()} ${reason}. Pass --trust-directory to bypass the disclaimer for this run only, or set NANOCODER_TRUST_DIRECTORY=1 to trust this directory permanently.\n`,
	);
	process.exitCode = 1;
}

// Like Nanocoder 1.32.0: the tools a session turned off, of those it knows, are echoed back.
const disabledEcho = params => {
	if (mode === 'no-disabled-echo') return {};
	const requested = params?._meta?.['nanocoder/disabledTools'];
	return {
		_meta: {
			'nanocoder/disabledTools': Array.isArray(requested)
				? requested.filter(name => name === 'browser')
				: [],
		},
	};
};

const results = {
	initialize: () => ({
		protocolVersion: mode === 'future' ? 2 : 1,
		agentCapabilities:
			mode === 'no-gates' || mode === 'minimum-no-gates'
				? {}
				: {
						loadSession: true,
						providers: {},
						sessionCapabilities: {
							...(mode === 'no-close' ? {} : {close: {}}),
							...(mode === 'no-list' ? {} : {list: {}}),
							...(mode === 'no-delete' ? {} : {delete: {}}),
							...(mode === 'no-resume' ? {} : {resume: {}}),
						},
						...(mcpHttp && {mcpCapabilities: {http: true, sse: false}}),
					},
		agentInfo: {
			name: 'nanocoder',
			title: 'Nanocoder',
			version:
				mode === 'old-version'
					? '1.30.0'
					: mode === 'version-1.31'
						? '1.31.0'
						: mode === 'minimum-version' || mode === 'minimum-no-gates'
							? // Accepted but newer than the tested 1.32.0, so it warns.
								'1.32.1'
							: '9.9.9',
		},
		authMethods: [],
	}),
	'session/new': params => {
		if (mode === 'no-session') return undefined;
		// The end-to-end browser tests read this to call the desktop's server as the agent would.
		if (
			mcpHttp &&
			mcpRecord &&
			isAbsolute(mcpRecord) &&
			relative(process.cwd(), mcpRecord).startsWith('..')
		)
			writeFileSync(
				mcpRecord,
				JSON.stringify({
					mcpServers: params.mcpServers,
					meta: params._meta ?? null,
				}),
			);
		return {
			sessionId: scopedSessions
				? `${sessionPrefix}-${randomUUID()}`
				: mode === 'multiple-sessions'
					? `fake-session-${++nextSession}`
					: 'fake-session',
			modes: modeState(),
			...(mode === 'replay-gates' && {configOptions: replayConfig()}),
			...disabledEcho(params),
		};
	},
	'session/list': () =>
		mode === 'list-fails'
			? undefined
			: {
					sessions: [
						{
							sessionId: 'discovered-session',
							cwd: process.cwd(),
							title:
								mode === 'session-discovery'
									? '<script>saved fixture</script>'
									: 'existing saved session',
							updatedAt: '2026-10-29T12:00:00.000Z',
						},
					],
				},
	'session/set_mode': params => {
		if (mode === 'mode-fails') return undefined;
		// Like Nanocoder since nanocoder#1912: the change is confirmed with an update.
		notify('session/update', {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: 'current_mode_update',
				currentModeId: params.modeId,
			},
		});
		return {};
	},
	'session/close': () => ({}),
	'session/delete': () => (mode === 'delete-fails' ? undefined : {}),
};

const modeState = () => ({
	currentModeId: 'auto-accept',
	availableModes: MODES.filter(
		id => mode !== 'no-normal' || id !== 'normal',
	).map(id => ({id, name: id})),
});

function durableDelegations(sessionId, history) {
	const update = body => notify('session/update', {sessionId, update: body});
	if (history)
		update({
			sessionUpdate: 'user_message_chunk',
			content: {type: 'text', text: 'durable fixture private prompt'},
		});
	for (const [toolCallId, description] of [
		['durable-known', 'known delegation'],
		['durable-unknown', 'unreported delegation'],
	]) {
		update({
			sessionUpdate: 'tool_call',
			toolCallId,
			title: `explore: ${description}`,
			kind: 'think',
			status: history ? 'completed' : 'in_progress',
			rawInput: {
				subagent_type: 'explore',
				description,
				prompt: 'private durable delegation arguments',
			},
		});
		if (!history && toolCallId === 'durable-known')
			tool(sessionId, toolCallId, {status: 'failed'});
	}
}

// Replays an earlier exchange, as Nanocoder does, then answers with the mode state.
async function resume(id, params) {
	const {sessionId} = params;
	if (mode === 'die-in-resume') process.exit(3);
	const knownSession =
		(mode === 'session-discovery' && sessionId === 'discovered-session') ||
		(scopedSessions
			? typeof sessionId === 'string' &&
				sessionId.startsWith(`${sessionPrefix}-`) &&
				/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
					sessionId.slice(sessionPrefix.length + 1),
				)
			: sessionId === 'fake-session');
	if (!knownSession || mode === 'missing-session') {
		send({
			id,
			error: {
				code: -32603,
				message: 'Internal error',
				data: {details: `Session not found on disk: ${sessionId}`},
			},
		});
		return;
	}
	if (mode === 'resume-fails') {
		send({id, error: {code: -32603, message: 'Internal error'}});
		return;
	}
	if (mode === 'replay-gates') {
		await new Promise(resolve => {
			if (existsSync('.fake-replay-release')) return resolve();
			const watcher = watch('.', {persistent: false}, () => {
				if (!existsSync('.fake-replay-release')) return;
				watcher.close();
				resolve();
			});
			if (existsSync('.fake-replay-release')) {
				watcher.close();
				resolve();
			}
		});
		if (readFileSync('.fake-replay-release', 'utf8') === 'fail') {
			send({id, error: {code: -32603, message: 'fixture replay failure'}});
			return;
		}
		if (readFileSync('.fake-replay-release', 'utf8') === 'missing') {
			send({
				id,
				error: {
					code: -32603,
					message: 'Internal error',
					data: {details: `Session not found on disk: ${sessionId}`},
				},
			});
			return;
		}
		for (let index = 0; index < 100; index++) {
			notify('session/update', {
				sessionId,
				update: {
					sessionUpdate: 'user_message_chunk',
					content: {type: 'text', text: `restored user ${index}`},
				},
			});
			notify('session/update', {
				sessionId,
				update: {
					sessionUpdate: 'agent_message_chunk',
					content: {type: 'text', text: `restored answer ${index}`},
				},
			});
		}
		send({
			id,
			result: {
				modes: modeState(),
				configOptions: replayConfig(),
				...disabledEcho(params),
			},
		});
		return;
	}
	if (mode === 'durable-replay') {
		durableDelegations(sessionId, true);
		send({id, result: {modes: modeState(), ...disabledEcho(params)}});
		return;
	}
	const update = body => notify('session/update', {sessionId, update: body});
	if (mode === 'replay-foreign')
		notify('session/update', {
			sessionId: 'foreign-session',
			update: {
				sessionUpdate: 'user_message_chunk',
				content: {type: 'text', text: 'private foreign history'},
			},
		});
	if (
		[
			'replay-count-overflow',
			'replay-count-limit',
			'replay-bytes-overflow',
			'replay-utf8-overflow',
			'replay-bytes-limit',
		].includes(mode)
	) {
		const empty = {
			sessionUpdate: 'agent_message_chunk',
			content: {type: 'text', text: ''},
		};
		const count =
			mode === 'replay-count-limit'
				? 100000
				: mode === 'replay-count-overflow'
					? 100001
					: mode === 'replay-utf8-overflow'
						? 6
						: mode === 'replay-bytes-limit'
							? 1
							: 17;
		const text = mode.startsWith('replay-count-')
			? 'x'
			: mode === 'replay-bytes-limit'
				? 'x'.repeat(
						16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(empty), 'utf8'),
					)
				: (mode === 'replay-utf8-overflow' ? '€' : 'x').repeat(1024 * 1024);
		for (let index = 0; index < count; index++)
			update({
				sessionUpdate: 'agent_message_chunk',
				content: {type: 'text', text},
			});
		send({id, result: {modes: modeState(), ...disabledEcho(params)}});
		return;
	}
	update({
		sessionUpdate: 'user_message_chunk',
		content: {type: 'text', text: 'Earlier question'},
	});
	update({
		sessionUpdate: 'agent_message_chunk',
		content: {type: 'text', text: 'Earlier answer'},
	});
	update({
		sessionUpdate: 'tool_call',
		toolCallId: 'old_call',
		title: 'execute_bash: echo old',
		status: 'completed',
	});
	send({id, result: {modes: modeState(), ...disabledEcho(params)}});
}

const waiting = new Map();
let nextId = 1000;
const notify = (method, params) => send({method, params});
const ask = (method, params) =>
	new Promise(resolve => {
		const id = nextId++;
		waiting.set(id, resolve);
		send({id, method, params});
	});

const OPTIONS = [
	{optionId: 'allow', name: 'Allow', kind: 'allow_once'},
	{optionId: 'deny', name: 'Deny', kind: 'reject_once'},
];
const permissionOptions =
	mode === 'all-permissions'
		? [
				{optionId: 'allow', name: 'Allow once', kind: 'allow_once'},
				{optionId: 'allow-always', name: 'Allow always', kind: 'allow_always'},
				{optionId: 'deny', name: 'Reject once', kind: 'reject_once'},
				{optionId: 'deny-always', name: 'Reject all', kind: 'reject_always'},
			]
		: mode === 'ask-user'
			? [
					{optionId: 'answer-0', name: 'First choice', kind: 'allow_once'},
					{optionId: 'answer-1', name: 'Second choice', kind: 'allow_once'},
				]
			: OPTIONS;
const cancellations = new Map();
const say = (sessionId, text) =>
	notify('session/update', {
		sessionId,
		update: {
			sessionUpdate: 'agent_message_chunk',
			content: {type: 'text', text},
		},
	});
const tool = (sessionId, toolCallId, update) =>
	notify('session/update', {
		sessionId,
		update: {sessionUpdate: 'tool_call_update', toolCallId, ...update},
	});

// Reads each linked file back through the desktop, echoes attached comments, and
// can edit a file with an `edit` tool call: enough to see files, review comments
// and touched labels work end to end.
async function filesFixture(id, params) {
	const {sessionId} = params;
	const blocks = params.prompt ?? [];
	const [first, ...rest] = blocks;
	const typed = first?.type === 'text' ? first.text : '';
	for (const block of rest) {
		if (block.type === 'resource_link') {
			const answer = await ask('fs/read_text_file', {
				sessionId,
				path: fileURLToPath(block.uri),
			});
			say(
				sessionId,
				answer?.error
					? `read refused for ${block.name}: ${answer.error.message}\n`
					: `read ${block.name}: ${String(answer?.content ?? '').trim()}\n`,
			);
		} else if (block.type === 'resource') {
			say(sessionId, `embedded ${block.resource.uri}\n`);
		} else if (block.type === 'text') {
			say(sessionId, `comment received: ${block.text}\n`);
		}
	}
	const edit = /edit (\S+)/u.exec(typed)?.[1];
	if (edit) {
		before.set(edit, readFileSync(edit, 'utf8'));
		appendFileSync(edit, 'agent edit\n');
		notify('session/update', {
			sessionId,
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'edit-1',
				title: `edit_file: ${edit}`,
				kind: 'edit',
				status: 'completed',
				locations: [{path: join(process.cwd(), edit)}],
			},
		});
	}
	say(sessionId, 'files fixture done');
	send({id, result: {stopReason: 'end_turn'}});
}

async function streamFixture(id, sessionId) {
	const update = body => notify('session/update', {sessionId, update: body});
	update({
		sessionUpdate: 'available_commands_update',
		availableCommands: [
			{
				name: '/review',
				description: 'review fixture changes',
				input: {hint: 'focus'},
			},
		],
	});
	update({
		sessionUpdate: 'agent_thought_chunk',
		content: {type: 'text', text: 'checking the scripted fixture'},
	});
	update({
		sessionUpdate: 'tool_call',
		toolCallId: 'subagent:fixture',
		title: 'fixture tool',
		kind: 'execute',
		status: 'in_progress',
		content: [
			{type: 'content', content: {type: 'text', text: 'fixture tool detail'}},
		],
		rawInput: {fixture: true},
	});
	say(
		sessionId,
		'# streamed fixture\n\n[fixture link](https://fixture.invalid) ![fixture image](https://fixture.invalid/image)\n\n<script>fixture</script>\n\n```ts\nconst fakeFixture = 67;\n```\n\n',
	);
	await new Promise(resolve => {
		let index = 0;
		const started = performance.now();
		const period = 1000 / 105;
		const tick = () => {
			const due = Math.min(
				300,
				Math.floor((performance.now() - started) / period),
			);
			while (index < due) say(sessionId, `item ${++index}\n\n`);
			if (index === 300) resolve();
			else
				setTimeout(
					tick,
					Math.max(0, started + (index + 1) * period - performance.now()),
				);
		};
		tick();
	});
	tool(sessionId, 'subagent:fixture', {title: 'fixture tool finished'});
	tool(sessionId, 'subagent:fixture', {status: 'completed'});
	update({
		sessionUpdate: 'usage_update',
		used: 1250,
		size: 10000,
		cost: {amount: 0.5, currency: 'USD'},
	});
	send({
		id,
		result: {
			stopReason: 'end_turn',
			usage: {inputTokens: 100, outputTokens: 300, totalTokens: 400},
			_meta: {
				'nanocoder/usage': {cost: 0.01, privatePayload: 'synthetic-private'},
				unknown: 'synthetic-private',
			},
		},
	});
}

let subagentTurn = 0;
async function subagentFixture(id, {sessionId, prompt}) {
	const text = prompt
		.filter(part => part.type === 'text')
		.map(part => part.text)
		.join('');
	const update = body => notify('session/update', {sessionId, update: body});
	const turn = ++subagentTurn;
	const roots = text.includes('two')
		? [`delegate-${turn}-1`, `delegate-${turn}-2`]
		: [`delegate-${turn}-1`];
	const fallback = text.includes('fallback');
	for (const toolCallId of roots) {
		update({
			sessionUpdate: 'tool_call',
			toolCallId,
			title: fallback ? 'agent' : 'explore: inspect fixture',
			kind: 'think',
			status: 'pending',
			rawInput: fallback
				? {}
				: {
						subagent_type: 'explore',
						description: 'inspect fixture',
						prompt: 'private fixture task',
					},
		});
		tool(sessionId, toolCallId, {status: 'in_progress'});
		if (!fallback)
			tool(sessionId, toolCallId, {
				title: 'explore • 1.2k tokens • 3 tools (read_file)',
			});
	}
	if (text.includes('fast')) {
		for (const root of roots) tool(sessionId, root, {status: 'completed'});
		send({id, result: {stopReason: 'end_turn'}});
		return;
	}
	let cancelled = false;
	const cancellation = new Promise(resolve =>
		cancellations.set(sessionId, () => {
			cancelled = true;
			resolve();
		}),
	);
	try {
		if (text.includes('no approval') || fallback) {
			await cancellation;
			send({id, result: {stopReason: 'cancelled'}});
			return;
		}
		const calls = roots.map((_, index) => `subagent:inner-${turn}-${index}`);
		const answers = await Promise.all(
			calls.map(toolCallId => {
				const title = 'execute_bash fixture (explore)';
				update({
					sessionUpdate: 'tool_call',
					toolCallId,
					title,
					kind: 'execute',
					status: 'pending',
				});
				return ask('session/request_permission', {
					sessionId,
					toolCall: {toolCallId, title, status: 'pending'},
					options: OPTIONS,
				});
			}),
		);
		if (
			cancelled ||
			answers.some(answer => answer.outcome.outcome !== 'selected')
		) {
			send({id, result: {stopReason: 'cancelled'}});
			return;
		}
		calls.forEach((call, index) =>
			tool(sessionId, call, {
				status:
					answers[index].outcome.optionId === 'allow' ? 'completed' : 'failed',
			}),
		);
		for (const root of roots)
			tool(sessionId, root, {
				status: text.includes('failure') ? 'failed' : 'completed',
			});
		say(sessionId, 'fixture delegation settled');
		send({id, result: {stopReason: 'end_turn'}});
	} finally {
		cancellations.delete(sessionId);
	}
}

// One turn: some text, protected tool calls that wait for the client's answers, more text.
async function runTurn(id, params) {
	const {sessionId} = params;
	if (mode === 'replay-gates') {
		say(sessionId, 'live replay gate fixture');
		send({id, result: {stopReason: 'end_turn'}});
		return;
	}
	if (mode === 'die-in-turn') process.exit(3);
	if (mode === 'die-in-held-turn') {
		await new Promise(resolve => {
			const watcher = watch('.', {persistent: false}, () => {
				if (!existsSync('.fake-turn-release')) return;
				watcher.close();
				resolve();
			});
			if (existsSync('.fake-turn-release')) {
				watcher.close();
				resolve();
			}
		});
		process.exit(3);
	}
	if (mode === 'durable-replay') {
		durableDelegations(sessionId, false);
		send({id, result: {stopReason: 'end_turn'}});
		return;
	}
	if (mode === 'mode-report') {
		// A mode change Nanocoder reports during a turn, as opposed to the confirmation at session open.
		notify('session/update', {
			sessionId,
			update: {sessionUpdate: 'current_mode_update', currentModeId: 'plan'},
		});
		say(sessionId, 'Mode reported.');
		send({id, result: {stopReason: 'end_turn'}});
		return;
	}
	if (mode === 'files' || mode === 'files-timeline')
		return filesFixture(id, params);
	if (mode === 'streaming') return streamFixture(id, sessionId);
	if (mode === 'subagents') return subagentFixture(id, params);
	if (
		mode === 'reported-usage' ||
		mode === 'session-discovery' ||
		mode === 'pin-extensions'
	) {
		say(sessionId, 'Reported usage fixture.');
		send({
			id,
			result: {
				stopReason: 'end_turn',
				usage: {inputTokens: 12, outputTokens: 8, totalTokens: 20},
				_meta: {
					'nanocoder/usage': {cost: 0.01, privatePayload: 'synthetic-private'},
				},
			},
		});
		return;
	}
	if (mode === 'prompt-error') {
		send({
			id,
			error: {code: -32603, message: `Provider failed for ${process.cwd()}`},
		});
		return;
	}
	say(sessionId, 'Working on it. ');
	if (mode === 'wait-for-cancel') {
		await new Promise(resolve => cancellations.set(sessionId, resolve));
		cancellations.delete(sessionId);
		send({id, result: {stopReason: 'cancelled'}});
		return;
	}
	const calls = mode === 'two-tools' ? ['call_1', 'call_2'] : ['call_1'];
	const title = toolCallId =>
		mode === 'ask-user'
			? 'Which fixture option?'
			: calls.length > 1
				? `execute_bash: echo ${toolCallId}`
				: 'execute_bash: echo hi';
	for (const toolCallId of calls) {
		// Nanocoder's ask_user reports kind 'other' and its own arguments as rawInput.
		notify('session/update', {
			sessionId,
			update: {
				sessionUpdate: 'tool_call',
				toolCallId,
				title: title(toolCallId),
				...(mode === 'ask-user'
					? {
							kind: 'other',
							rawInput: {
								question: title(toolCallId),
								options: ['First choice', 'Second choice'],
							},
						}
					: {}),
				status: 'pending',
			},
		});
	}
	const answers = await Promise.all(
		calls.map(toolCallId =>
			ask('session/request_permission', {
				sessionId,
				toolCall: {
					toolCallId,
					title: title(toolCallId),
					status: 'pending',
				},
				options: permissionOptions,
			}),
		),
	);
	log({answer: answers[0].outcome});
	if (answers.some(({outcome}) => outcome.outcome !== 'selected')) {
		for (const toolCallId of calls)
			tool(sessionId, toolCallId, {status: 'failed'});
		send({id, result: {stopReason: 'cancelled'}});
		return;
	}
	const allowed = answers.map(({outcome}) =>
		permissionOptions
			.find(option => option.optionId === outcome.optionId)
			?.kind.startsWith('allow'),
	);
	calls.forEach((toolCallId, index) =>
		tool(sessionId, toolCallId, {
			status: allowed[index] ? 'completed' : 'failed',
			...(mode === 'all-permissions' || mode === 'ask-user'
				? {title: `selected ${answers[index].outcome.optionId}`}
				: {}),
		}),
	);
	say(
		sessionId,
		calls.length > 1
			? 'Both answered.'
			: allowed[0]
				? 'Tool ran.'
				: 'Tool denied.',
	);
	send({id, result: {stopReason: 'end_turn'}});
}

function serve() {
	if (mode === 'garbage') {
		process.stdout.write('Starting Nanocoder...\n');
	}
	createInterface({input: process.stdin})
		.on('line', line => {
			const {id, method, params, result: answered, error} = JSON.parse(line);
			if (method === undefined) {
				waiting.get(id)?.(error ? {error} : answered);
				waiting.delete(id);
				return;
			}
			log({method, params});
			if (
				method === '_nanocoder/timeline/read' &&
				(mode === 'extensions' ||
					mode === 'prefixed-extensions' ||
					mode === 'files-timeline')
			) {
				const {sessionId, checkpointId, path: readPath} = params ?? {};
				if (
					typeof sessionId !== 'string' ||
					typeof checkpointId !== 'string' ||
					typeof readPath !== 'string'
				) {
					send({
						id,
						error: {
							code: -32603,
							message: 'Internal error',
							data: {
								details:
									'timeline/read requires string sessionId, checkpointId and path',
							},
						},
					});
					return;
				}
				if (sessionId === 'gone-session') {
					send({
						id,
						error: {
							code: -32603,
							message: 'Internal error',
							data: {details: `Session not found: ${sessionId}`},
						},
					});
					return;
				}
				if (mode === 'files-timeline') {
					send({
						id,
						result: before.has(readPath)
							? {kind: 'text', content: before.get(readPath)}
							: {kind: 'created'},
					});
					return;
				}
				const answers = {
					'notes.txt': {kind: 'text', content: 'user edit\nuser line\n'},
					'fresh.txt': {kind: 'created'},
					'photo.png': {
						kind: 'unavailable',
						reason: 'The checkpoint holds no before-image for this path',
					},
				};
				send({id, result: answers[readPath] ?? {kind: 'garbage'}});
				return;
			}
			if (
				['_timeline/list', 'timeline/list'].includes(method) &&
				typeof params?.sessionId === 'string' &&
				((mode === 'extensions' && !method.startsWith('_')) ||
					(mode === 'prefixed-extensions' && method.startsWith('_')) ||
					(mode === 'files-timeline' && method.startsWith('_')))
			) {
				if (mode === 'files-timeline') {
					send({
						id,
						result: {
							entries: [...before.keys()].map((file, index) => ({
								id: `c${index + 1}`,
								seq: index + 1,
								truncateToMessageIndex: 2,
								filesChanged: [file],
								createdFiles: [],
								turnId: 'turn-1',
							})),
						},
					});
					return;
				}
				send({
					id,
					result: {
						entries: [
							{
								id: 'c1',
								seq: 1,
								truncateToMessageIndex: 2,
								filesChanged: ['notes.txt'],
								createdFiles: [],
							},
						],
					},
				});
				return;
			}
			if (
				[
					'renameSession',
					'_renameSession',
					'timeline/list',
					'_timeline/list',
					'pinSession',
					'_pinSession',
				].includes(method)
			) {
				if (mode === 'silent-probes') return;
				if (mode === 'ambiguous-probes') {
					send({id, error: {code: -32603, message: 'Internal error'}});
					return;
				}
				if (mode === 'successful-probes') {
					send({id, result: {}});
					return;
				}
				const bare = method.replace(/^_/, '');
				const supported =
					((mode === 'extensions' || mode === 'pin-extensions') &&
						!method.startsWith('_')) ||
					mode === 'prefixed-extensions' ||
					(mode === 'files-timeline' && method.startsWith('_'));
				if (
					supported &&
					bare === 'pinSession' &&
					typeof params?.sessionId === 'string' &&
					typeof params?.pinned === 'boolean'
				) {
					if (params.sessionId === 'gone-session')
						send({
							id,
							error: {
								code: -32603,
								message: 'Internal error',
								data: {details: 'Session not found on disk: gone-session'},
							},
						});
					else if (params.sessionId === 'wrong-reply')
						send({id, result: {pinned: !params.pinned}});
					else send({id, result: {pinned: params.pinned}});
					return;
				}
				if (
					supported &&
					bare === 'renameSession' &&
					typeof params?.sessionId === 'string' &&
					typeof params?.title === 'string'
				) {
					if (params.sessionId === 'gone-session')
						send({
							id,
							error: {
								code: -32603,
								message: 'Internal error',
								data: {details: 'Session not found: gone-session'},
							},
						});
					else if (params.title === 'malformed reply')
						send({id, result: {title: 42}});
					else if (params.title === 'empty reply') send({id, result: {}});
					else if (params.title === 'internal failure')
						send({id, error: {code: -32603, message: 'Internal error'}});
					else send({id, result: {title: `${params.title} (saved)`}});
					return;
				}
				send({
					id,
					error: supported
						? {
								code: -32603,
								message: 'Internal error',
								data: {
									details:
										bare === 'renameSession'
											? 'renameSession requires string sessionId and title params'
											: bare === 'pinSession'
												? 'pinSession requires a string sessionId and a boolean pinned'
												: 'timeline/list requires a string sessionId',
								},
							}
						: {code: -32601, message: 'Method not found'},
				});
				return;
			}
			if (method === 'session/set_mode' && mode === 'slow-mode') {
				say(params.sessionId, 'mode waiting');
				return;
			}
			if (
				(method === 'session/new' && mode === 'slow-new') ||
				(method === 'session/resume' && mode === 'slow-resume')
			) {
				say('fake-session', `${method} waiting`);
				return;
			}
			if (method === 'session/prompt') {
				void runTurn(id, params);
				return;
			}
			if (method === 'session/new' && mode === 'title-notice') {
				for (const title of [{title: 42}, {title: 'Fixture title'}])
					send({
						method: '_nanocoder/sessionTitleChanged',
						params: {sessionId: 'fake-session', ...title},
					});
			}
			if (method === 'session/set_config_option' && mode === 'replay-gates') {
				replayModel = params.value;
				send({id, result: {configOptions: replayConfig()}});
				return;
			}
			if (method === 'session/cancel') {
				cancellations.get(params.sessionId)?.();
				return;
			}
			if (method === 'session/resume') {
				resume(id, params);
				return;
			}
			if (id === undefined || (method === 'initialize' && mode === 'silent')) {
				return;
			}
			const result = results[method]?.(params);
			send(
				result === undefined
					? {id, error: {code: -32603, message: 'Internal error'}}
					: {id, result},
			);
		})
		.on('close', () => {
			if (mode === 'multiple-sessions') log({stdinClosed: true});
			if (mode !== 'ignore-shutdown') process.exit(0);
		});
}

log({
	started: true,
	pid: process.pid,
	cwd: process.cwd(),
	trustEnv: process.env.NANOCODER_TRUST_DIRECTORY ?? null,
});

if (mode === 'ignore-shutdown') {
	process.on('SIGTERM', () => {});
	setInterval(() => {}, 1000);
}

if (mode === 'refuse') {
	process.stderr.write('(node:1) Warning: an unrelated warning\n');
	refuse(TRUST_REASONS.untrusted);
} else if (mode in TRUST_REASONS && !existsSync('.fake-trusted')) {
	if (process.env.NANOCODER_TRUST_DIRECTORY === '1') {
		writeFileSync('.fake-trusted', '');
		serve();
	} else {
		refuse(TRUST_REASONS[mode]);
	}
} else if (mode === 'leak') {
	process.stderr.write(
		'[nanocoder] ACP initialization failed: Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz\n',
	);
	process.exitCode = 1;
} else if (mode === 'crash') {
	process.stderr.write(
		'TypeError: something broke\n    at main (cli.js:1:1)\n',
	);
	process.exitCode = 3;
} else if (mode === 'hang') {
	setInterval(() => {}, 1000);
} else {
	serve();
}
