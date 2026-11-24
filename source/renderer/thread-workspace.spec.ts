import test from 'ava';
import {
	createThreadWorkspace,
	type ThreadWorkspaceState,
	threadWorkspaceForProject,
} from '@/renderer/thread-workspace';
import type {
	IpcResult,
	ProjectEvent,
	ThreadInfo,
	ThreadRequest,
	ThreadSnapshot,
	TurnResult,
	UiState,
	WorkspaceRequests,
} from '@/shared/ipc';

const ok = <T>(value: T): IpcResult<T> => ({ok: true, value});
const row = (id: string, projectId = 'project-a'): ThreadInfo => ({
	id,
	projectId,
	title: id,
	archiveState: 'active',
	nanocoderSessionId: 'actual-session',
	mode: 'normal',
	sessionCwd: '/fixture',
	runState: 'ready',
	viewOnlyReason: null,
	lastActivityAt: '2026-10-30T14:00:00.000Z',
});
const snap = (id: string, projectId = 'project-a'): ThreadSnapshot => ({
	thread: row(id, projectId),
	events: [],
	sequence: 0,
	replaying: false,
});
const ui = (
	projectId = 'project-a',
	threadId: string | null = 'a',
): UiState => ({
	window: {width: 1240, height: 900, x: null, y: null, maximised: false},
	activeProjectId: projectId,
	activeThreadId: threadId,
	openThreadIds: threadId ? [threadId] : [],
	inspector: null,
	bottomPanel: null,
});
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => {
		resolve = done;
	});
	return {resolve, promise};
};

function fixture() {
	const calls: unknown[] = [];
	const changes: ThreadWorkspaceState[] = [];
	const timers: {callback(): void; cancelled: boolean}[] = [];
	let listener: ((event: ProjectEvent) => void) | undefined;
	let count = 0;
	const rows = [row('a'), row('b', 'project-b')];
	const bridge = {
		listThreads: async (request: WorkspaceRequests['listThreads']) => {
			calls.push(['list', request]);
			return ok(
				rows.filter(
					row =>
						row.projectId === request.projectId &&
						row.archiveState === request.archiveState,
				),
			);
		},
		getUiState: async (
			_request: Record<string, never>,
		): Promise<IpcResult<UiState>> => {
			calls.push(['ui']);
			return ok(ui());
		},
		createThread: async (request: WorkspaceRequests['createThread']) => {
			calls.push(['create', request]);
			const created = {
				...row(`new-${++count}`, request.projectId),
				nanocoderSessionId: null,
				runState: 'new' as const,
			};
			rows.push(created);
			return ok(created);
		},
		getThreadSnapshot: async (request: ThreadRequest) => {
			calls.push(['snapshot', request]);
			return ok({
				...snap(request.threadId, request.projectId),
				thread:
					rows.find(
						row =>
							row.id === request.threadId &&
							row.projectId === request.projectId,
					) ?? row(request.threadId, request.projectId),
			});
		},
		openThread: async (request: ThreadRequest) => {
			calls.push(['open', request]);
			return ok(snap(request.threadId, request.projectId));
		},
		promptThread: async (
			request: WorkspaceRequests['promptThread'],
		): Promise<IpcResult<TurnResult>> => {
			calls.push(['prompt', request]);
			return ok({stopReason: 'end_turn'});
		},
		cancelThread: async (request: ThreadRequest): Promise<IpcResult<null>> => {
			calls.push(['cancel', request]);
			return ok(null);
		},
		answerThreadPermission: async (
			request: WorkspaceRequests['answerThreadPermission'],
		): Promise<IpcResult<null>> => {
			calls.push(['answer', request]);
			return ok(null);
		},
		renameThread: async (request: WorkspaceRequests['renameThread']) =>
			ok({...row(request.threadId, request.projectId), title: request.title}),
		setThreadMode: async (request: WorkspaceRequests['setThreadMode']) => {
			calls.push(['mode', request]);
			return ok({
				...(rows.find(
					thread =>
						thread.id === request.threadId &&
						thread.projectId === request.projectId,
				) ?? row(request.threadId, request.projectId)),
				mode: request.mode,
			});
		},
		archiveThread: async (request: WorkspaceRequests['archiveThread']) =>
			ok({
				...row(request.threadId, request.projectId),
				archiveState: request.archived
					? ('archived' as const)
					: ('active' as const),
			}),
		removeThread: async (_request: ThreadRequest) => ok(null),
		deleteThreadHistory: async (_request: ThreadRequest) =>
			ok({status: 'cancelled' as const}),
		onProjectEvent: (callback: (event: ProjectEvent) => void) => {
			listener = callback;
			return () => {
				listener = undefined;
			};
		},
	};
	const model = createThreadWorkspace({
		bridge,
		onChange: state => changes.push(state),
		clock: {
			schedule(callback) {
				const timer = {callback, cancelled: false};
				timers.push(timer);
				return () => {
					timer.cancelled = true;
				};
			},
		},
	});
	return {
		model,
		bridge,
		calls,
		changes,
		timers,
		rows,
		emit: (event: ProjectEvent) => listener?.(event),
	};
}

test('CHAT-09 explicit retry opens only the selected saved thread and preserves its unqueued draft', async t => {
	const {model, rows, calls} = fixture();
	rows[0] = {
		...rows[0],
		runState: 'failed',
		viewOnlyReason: 'safe retryable refusal',
	};
	await model.selectProject('project-a');
	model.setDraft('keep this unsent draft');
	calls.length = 0;
	t.true(await model.open('a'));
	t.is(model.getState().conversation.draft, 'keep this unsent draft');
	t.is(model.getState().workspace.activeThreadId, 'a');
	t.deepEqual(
		calls.filter(call => Array.isArray(call) && call[0] !== 'snapshot'),
		[['open', {projectId: 'project-a', threadId: 'a'}]],
	);
	t.false(calls.some(call => Array.isArray(call) && call[0] === 'prompt'));
});

test('CHAT-09 view-only metadata retains its hidden memory draft without another bridge call', async t => {
	const {model, emit, calls} = fixture();
	await model.selectProject('project-a');
	model.setDraft('editable memory-only draft');
	const before = structuredClone(calls);
	emit({
		type: 'thread',
		projectId: 'project-a',
		sequence: 1,
		thread: {
			...row('a'),
			runState: 'view-only',
			viewOnlyReason: 'missing saved history',
		},
	});
	t.is(model.getState().workspace.threads[0]?.runState, 'view-only');
	t.is(model.getState().conversation.draft, 'editable memory-only draft');
	t.deepEqual(calls, before);
});

test('CHAT-08 replay snapshot refuses send, mode and approval without clearing an editable memory draft', async t => {
	const {model, bridge, calls} = fixture();
	bridge.getThreadSnapshot = async request =>
		ok(
			Object.assign(snap(request.threadId, request.projectId), {
				replaying: true,
				replayEpoch: 'b60c4d2a-f55e-4e8f-b397-84f65adc1aac',
			}),
		);
	await model.selectProject('project-a');
	model.setDraft('unsent memory-only draft');
	const before = structuredClone(calls);
	t.is(await model.send(), null);
	t.false(await model.setMode('a', 'plan'));
	t.false((await model.answer('a', 'request', 'allow')).ok);
	t.is(model.getState().conversation.draft, 'unsent memory-only draft');
	t.deepEqual(calls, before);
});

test('CHAT-08 complete waits for the exact snapshot prefix and synchronous renderer flush before enabling a send', async t => {
	const {model, bridge, emit, calls, changes} = fixture();
	await model.selectProject('project-a');
	model.setDraft('keep my draft');
	const epoch = 'b60c4d2a-f55e-4e8f-b397-84f65adc1aac';
	const prefix = deferred<IpcResult<ThreadSnapshot>>();
	bridge.getThreadSnapshot = () => prefix.promise;
	emit({
		type: 'turn',
		projectId: 'project-a',
		threadId: 'a',
		sequence: 1,
		events: [],
		replay: {epoch, phase: 'begin'},
	});
	emit({
		type: 'turn',
		projectId: 'project-a',
		threadId: 'a',
		sequence: 2,
		events: [],
		replay: {epoch, phase: 'complete'},
	});
	t.is(await model.send(), null);
	t.false(calls.some(call => Array.isArray(call) && call[0] === 'prompt'));
	prefix.resolve(
		ok(
			Object.assign(snap('a'), {
				sequence: 2,
				replayEpoch: epoch,
				events: [{type: 'user', text: 'restored prefix'}],
			}),
		),
	);
	await prefix.promise;
	await Promise.resolve();
	t.like(model.getState().conversation.transcript.items, [
		{kind: 'user', text: 'restored prefix'},
	]);
	const enabled = changes.filter(
		state =>
			state.workspace.replay?.a === undefined &&
			state.conversation.transcript.items.some(
				item => item.kind === 'user' && item.text === 'restored prefix',
			),
	);
	t.true(enabled.length > 0);
	t.true((await model.send())?.ok);
});

test('initial selection reads main cache only and restores only a desktop thread belonging to the selected project (CHAT-03, CHAT-04)', async t => {
	const {model, calls} = fixture();
	await model.selectProject('project-a');
	t.is(model.getState().workspace.activeThreadId, 'a');
	t.is(model.getState().conversation.activeThreadId, 'a');
	t.deepEqual(calls, [
		['list', {projectId: 'project-a', archiveState: 'active'}],
		['list', {projectId: 'project-a', archiveState: 'archived'}],
		['ui'],
		['snapshot', {projectId: 'project-a', threadId: 'a'}],
	]);
	await model.selectProject('project-b');
	t.is(model.getState().workspace.activeThreadId, 'b');
	t.false(
		calls.some(
			call =>
				Array.isArray(call) && ['open', 'create', 'prompt'].includes(call[0]),
		),
	);
});

test('mode action uses main metadata and preserves a new thread draft without starting a session (CHAT-04 DEC-31)', async t => {
	const {model, calls} = fixture();
	await model.selectProject('empty');
	await model.ensureThread();
	model.setDraft('keep this draft');
	calls.length = 0;
	t.true(await model.setMode('new-1', 'plan'));
	t.is(model.getState().workspace.threads[0]?.mode, 'plan');
	t.is(model.getState().workspace.threads[0]?.nanocoderSessionId, null);
	t.is(model.getState().conversation.draft, 'keep this draft');
	t.deepEqual(calls, [
		['mode', {projectId: 'empty', threadId: 'new-1', mode: 'plan'}],
	]);
});

test('an empty ready workspace creates one metadata-only default and never opens an ACP session or queues another creation (CHAT-04)', async t => {
	const {model, calls} = fixture();
	await model.selectProject('empty');
	t.is(calls.length, 3);
	const created = model.ensureThread();
	t.false(await model.ensureThread());
	t.true(await created);
	t.false(await model.ensureThread());
	t.is(model.getState().workspace.activeThreadId, 'new-1');
	t.is(model.getState().workspace.threads[0]?.nanocoderSessionId, null);
	t.deepEqual(calls.slice(3), [
		['create', {projectId: 'empty'}],
		['snapshot', {projectId: 'empty', threadId: 'new-1'}],
	]);
});

test('workspace composition flushes content before terminal state answer and cancel while keeping a draft editable and unqueued (CHAT-05, ACP-10)', async t => {
	const {model, bridge, calls, changes, emit} = fixture();
	await model.selectProject('project-a');
	const result = deferred<IpcResult<TurnResult>>();
	bridge.promptThread = request => {
		calls.push(['prompt', request]);
		return result.promise;
	};
	model.setDraft('sent');
	const sending = model.send();
	t.deepEqual(model.getState().conversation.transcript.items, []);
	emit({
		type: 'thread',
		projectId: 'project-a',
		sequence: 1,
		thread: {...row('a'), runState: 'running'},
	});
	emit({
		type: 'turn',
		projectId: 'project-a',
		threadId: 'a',
		sequence: 1,
		events: [
			{type: 'user', text: 'sent'},
			{type: 'text', text: 'before answer'},
		],
	});
	bridge.answerThreadPermission = async request => {
		t.is(
			model.getState().conversation.transcript.items[1]?.text,
			'before answer',
		);
		calls.push(['answer', request]);
		return ok(null);
	};
	t.deepEqual(await model.answer('a', 'request', 'offered'), ok(null));
	emit({
		type: 'turn',
		projectId: 'project-a',
		threadId: 'a',
		sequence: 2,
		events: [{type: 'text', text: ' and cancel'}],
	});
	bridge.cancelThread = async request => {
		t.is(
			model.getState().conversation.transcript.items[1]?.text,
			'before answer and cancel',
		);
		calls.push(['cancel', request]);
		return ok(null);
	};
	t.deepEqual(await model.cancel('a'), ok(null));
	model.setDraft('next draft');
	t.is(await model.send(), null);
	emit({
		type: 'turn',
		projectId: 'project-a',
		threadId: 'a',
		sequence: 3,
		events: [{type: 'metadata', metadata: {usage: {totalTokens: 10}}}],
	});
	emit({
		type: 'thread',
		projectId: 'project-a',
		sequence: 2,
		thread: {...row('a'), lastActivityAt: '2026-10-30T14:01:00.000Z'},
	});
	const terminal = changes.find(
		state =>
			state.workspace.threads[0]?.lastActivityAt === '2026-10-30T14:01:00.000Z',
	);
	t.is(
		terminal?.conversation.transcript.items[1]?.metadata?.usage?.totalTokens,
		10,
	);
	result.resolve(ok({stopReason: 'end_turn'}));
	t.deepEqual(await sending, ok({stopReason: 'end_turn'}));
	t.is(model.getState().conversation.draft, 'next draft');
	t.is(
		calls.filter(call => Array.isArray(call) && call[0] === 'prompt').length,
		1,
	);
});

test('a new project render never projects the previous conversation while effect-driven selection is still pending (CHAT-03)', async t => {
	const {model, bridge, emit} = fixture();
	await model.selectProject('project-a');
	emit({
		type: 'turn',
		projectId: 'project-a',
		threadId: 'a',
		sequence: 1,
		events: [{type: 'text', text: 'old project'}],
	});
	model.setDraft('private draft');
	await model.cancel('a');
	const projected = threadWorkspaceForProject(model.getState(), 'project-b');
	t.is(projected.workspace.projectId, 'project-b');
	t.deepEqual(projected.workspace.threads, []);
	t.deepEqual(projected.conversation.transcript.items, []);
	t.is(projected.conversation.draft, '');
	const listing = deferred<IpcResult<ThreadInfo[]>>();
	bridge.listThreads = () => listing.promise;
	const selecting = model.selectProject('project-b');
	t.is(model.getState().workspace.projectId, 'project-b');
	t.deepEqual(model.getState().conversation.transcript.items, []);
	listing.resolve(ok([row('b', 'project-b')]));
	await selecting;
	t.is(model.getState().workspace.activeThreadId, 'b');
});

test('late initial UI preferences cannot select a thread after a newer project has finished loading (CHAT-03)', async t => {
	const {model, bridge} = fixture();
	const old = deferred<IpcResult<UiState>>();
	let requests = 0;
	bridge.getUiState = () =>
		++requests === 1 ? old.promise : Promise.resolve(ok(ui('project-b', 'b')));
	const initial = model.selectProject('project-a');
	await model.selectProject('project-b');
	old.resolve(ok(ui()));
	await initial;
	t.is(model.getState().workspace.activeThreadId, 'b');
	t.is(model.getState().conversation.projectId, 'project-b');
});

test('project switches and disposal prevent in-flight command results or callbacks from writing into the replacement view (CHAT-03, ACP-10)', async t => {
	const {model, bridge, changes, timers, emit} = fixture();
	await model.selectProject('project-a');
	t.is(model.getState().workspace.activeThreadId, 'a');
	const result = deferred<IpcResult<TurnResult>>();
	bridge.promptThread = () => result.promise;
	model.setDraft('old');
	const sending = model.send();
	t.is(model.getState().workspace.promptingThreadId, 'a');
	emit({
		type: 'turn',
		projectId: 'project-a',
		threadId: 'a',
		sequence: 1,
		events: [{type: 'text', text: 'pending'}],
	});
	await model.selectProject('project-b');
	const before = changes.length;
	result.resolve({
		ok: false,
		error: {code: 'AGENT_UNAVAILABLE', message: 'old failure', retryable: true},
	});
	t.is(await sending, null);
	t.is(changes.length, before);
	t.deepEqual(model.getState().conversation.transcript.items, []);
	model.dispose();
	const disposed = changes.length;
	for (const timer of timers) timer.callback();
	await model.selectProject('project-a');
	t.deepEqual(await model.answer('b', 'stale', 'offered'), {
		ok: false,
		error: {
			code: 'DENIED',
			message: 'this approval is no longer current',
			retryable: false,
		},
	});
	t.is(await model.cancel('b'), null);
	t.is(changes.length, disposed);
});

test('an uninitialised renderer projects only empty loading state for its requested project (CHAT-03)', t => {
	const initial = threadWorkspaceForProject(null, 'project-a');
	t.is(initial.workspace.projectId, 'project-a');
	t.true(initial.workspace.loading);
	t.deepEqual(initial.workspace.threads, []);
	t.is(initial.conversation.projectId, 'project-a');
	t.deepEqual(initial.conversation.transcript.items, []);
	t.is(initial.conversation.draft, '');
});
