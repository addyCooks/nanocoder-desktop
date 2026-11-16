import {randomUUID} from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {createWorkspaceControls} from '@/main/controls/workspace-controls';
import {confirmYolo} from '@/main/controls/yolo-consent';
import {IpcFailure} from '@/main/ipc/handle-request';
import {fakeEvents} from '@/main/nanocoder/fixtures/fake-project';
import {ProjectSupervisor} from '@/main/nanocoder/supervisor';
import {desktopStoreFactory} from '@/main/store';
import {createNodeSqliteDriver} from '@/main/store/node-sqlite';
import {createThreadService} from '@/main/threads/thread-service';
import type {ProjectControls, ProjectInfo, ThreadInfo} from '@/shared/ipc';

async function fixture(t: ExecutionContext, scenario?: string) {
	const root = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-controls-')),
	);
	const projectRoot = path.join(root, 'project');
	mkdirSync(projectRoot);
	if (scenario)
		writeFileSync(path.join(projectRoot, '.fake-nanocoder'), scenario);
	const store = await desktopStoreFactory.open({
		databasePath: path.join(root, 'desktop.sqlite'),
		driver: createNodeSqliteDriver(),
	});
	const project: ProjectInfo = {
		id: randomUUID(),
		canonicalRoot: projectRoot,
		sessionCwd: projectRoot,
		displayName: 'fixture project',
		trusted: true,
		defaultMode: 'normal',
		createdAt: '2026-10-30T12:00:00.000Z',
		lastOpenedAt: '2026-10-30T12:00:00.000Z',
		availability: 'available',
	};
	store.projects.save(project);
	let launches = 0;
	const supervisor = new ProjectSupervisor({
		resolveRuntime: async () => {
			launches++;
			return {
				ok: true,
				runtime: {
					nodePath: realpathSync.native(process.execPath),
					cliPath: path.join(
						import.meta.dirname,
						'../nanocoder/fixtures/fake-control-nanocoder.mjs',
					),
					version: '9.9.9',
					nodeVersion: process.version,
					source: 'override',
				},
			};
		},
		clientInfo: {name: 'controls-fixture', version: '0.0.0'},
		confirmTrust: async () => false,
	});
	let controls!: ReturnType<typeof createWorkspaceControls>;
	const threads = createThreadService({
		store,
		supervisor,
		onSessionPrepared: context => controls.hooks.onSessionPrepared(context),
		beforeFirstPrompt: context => controls.hooks.beforeFirstPrompt(context),
		validateBeforePrepare: (lease, thread, reason) =>
			controls.hooks.validateBeforePrepare(lease, thread, reason),
		resolveLiveMode: (...args) => controls.hooks.resolveLiveMode(...args),
	});
	const published: ProjectControls[] = [];
	const writes: ThreadInfo[] = [];
	const saveThread = store.threads.save;
	store.threads.save = thread => {
		writes.push(structuredClone(thread));
		saveThread(thread);
	};
	let confirm = async () => true;
	let confirmations = 0;
	controls = createWorkspaceControls({
		store,
		threads,
		getConnection: threads.getControlConnection,
		publishControls: value => {
			published.push(value);
			supervisor.publishControls(value);
		},
		publishThread: thread => supervisor.publishThread(thread),
		publishProject: owner => supervisor.announceProject(owner),
		confirmYolo: async () => {
			confirmations++;
			return confirm();
		},
	});
	t.teardown(async () => {
		await supervisor.close();
		controls.dispose();
		threads.dispose();
		store.close();
		rmSync(root, {recursive: true, force: true});
	});
	const thread = await threads.createThread({projectId: project.id});
	const request = {projectId: project.id, threadId: thread.id};
	return {
		store,
		supervisor,
		threads,
		controls,
		project,
		thread,
		request,
		writes,
		published,
		launches: () => launches,
		confirmations: () => confirmations,
		confirm: (next: typeof confirm) => {
			confirm = next;
		},
		rpc: () => fakeEvents(supervisor.getConnection(project.id).stderr.lines()),
	};
}

test('composed first send keeps pending yolo memory-only and orders safe acknowledgement, identity, yolo and prompt (CHAT-04 DEC-31)', async t => {
	const f = await fixture(t);
	const initial = f.controls.controls.getProjectControls({
		projectId: f.project.id,
	});
	t.false(initial.modelGate.enabled);
	t.is(
		(await f.controls.setThreadMode({...f.request, mode: 'yolo'})).mode,
		'yolo',
	);
	t.is(f.launches(), 0);
	t.is((await f.threads.getThreadSnapshot(f.request)).thread.mode, 'yolo');
	t.is(f.store.threads.get(f.project.id, f.thread.id)?.mode, 'normal');
	await f.threads.promptThread({...f.request, text: 'fixture request'});
	t.deepEqual(
		f
			.rpc()
			.filter(event =>
				['session/new', 'session/set_mode', 'session/prompt'].includes(
					String(event.method),
				),
			)
			.map(event => [event.method, (event.params as {modeId?: string}).modeId]),
		[
			['session/new', undefined],
			['session/set_mode', 'normal'],
			['session/set_mode', 'yolo'],
			['session/prompt', undefined],
		],
	);
	t.is(f.confirmations(), 1);
	t.true(f.writes.every(thread => thread.mode !== 'yolo'));
	t.is((await f.threads.getThreadSnapshot(f.request)).thread.mode, 'yolo');
	t.true(
		f.controls.controls.getProjectControls({projectId: f.project.id}).modelGate
			.enabled,
	);
});

test('composed offers come from another owned project thread and provider success returns the actual selected model (CHAT-10)', async t => {
	const f = await fixture(t);
	await f.threads.promptThread({...f.request, text: 'fixture'});
	const other = await f.threads.createThread({projectId: f.project.id});
	t.is(other.nanocoderSessionId, null);
	const offered = f.controls.controls.getProjectControls({
		projectId: f.project.id,
	});
	t.true(offered.modelGate.enabled);
	const confirmed = await f.controls.controls.setProjectConfigOption({
		projectId: f.project.id,
		revision: offered.revision,
		configId: 'provider',
		value: 'b',
	});
	t.is(
		confirmed.configOptions.find(option => option.id === 'model')?.currentValue,
		'confirmed',
	);
	t.is(f.rpc().filter(event => event.method === 'session/new').length, 1);
	t.is(
		f.rpc().filter(event => event.method === 'session/set_config_option')
			.length,
		1,
	);
	t.is(f.store.threads.get(f.project.id, other.id)?.nanocoderSessionId, null);
});

test('native cancel/default/Escape keeps an earlier pending plan usable at first send (DEC-31 CHAT-04)', async t => {
	const f = await fixture(t);
	await f.controls.setThreadMode({...f.request, mode: 'plan'});
	const saved = f.store.threads.get(f.project.id, f.thread.id);
	const writes = f.writes.length;
	f.confirm(() =>
		confirmYolo({
			project: f.project,
			thread: f.thread,
			ask: async options => {
				t.is(options.defaultId, 0);
				t.is(options.cancelId, 0);
				return 0;
			},
		}),
	);
	t.is(
		(await f.controls.setThreadMode({...f.request, mode: 'yolo'})).mode,
		'plan',
	);
	t.is(f.launches(), 0);
	t.is(f.confirmations(), 1);
	t.is(f.writes.length, writes);
	t.deepEqual(f.store.threads.get(f.project.id, f.thread.id), saved);
	await f.threads.promptThread({
		...f.request,
		text: 'fixture after cancelled yolo',
	});
	t.is(f.rpc().filter(event => event.method === 'session/prompt').length, 1);
	t.deepEqual(
		f
			.rpc()
			.filter(event => event.method === 'session/set_mode')
			.map(event => (event.params as {modeId: string}).modeId),
		['plan'],
	);
	t.is((await f.threads.getThreadSnapshot(f.request)).thread.mode, 'plan');
});

test('a cancelled yolo selection can be selected again, confirmed and used once at first send (DEC-31)', async t => {
	const f = await fixture(t);
	f.confirm(async () => false);
	t.is(
		(await f.controls.setThreadMode({...f.request, mode: 'yolo'})).mode,
		'normal',
	);
	t.is(f.launches(), 0);
	f.confirm(async () => true);
	t.is(
		(await f.controls.setThreadMode({...f.request, mode: 'yolo'})).mode,
		'yolo',
	);
	t.is(f.launches(), 0);
	t.is(f.confirmations(), 2);
	await f.threads.promptThread({
		...f.request,
		text: 'fixture after renewed acceptance',
	});
	t.deepEqual(
		f
			.rpc()
			.filter(event => event.method === 'session/set_mode')
			.map(event => (event.params as {modeId: string}).modeId),
		['normal', 'yolo'],
	);
	t.is(f.rpc().filter(event => event.method === 'session/prompt').length, 1);
	t.true(f.writes.every(thread => thread.mode !== 'yolo'));
});

test('composed config uncertainty blocks every later prompt before content, not just the first prompt (ACP-14)', async t => {
	const f = await fixture(t, 'config-fails');
	await f.threads.promptThread({...f.request, text: 'first fixture'});
	await f.threads.promptThread({...f.request, text: 'second fixture'});
	const offered = f.controls.controls.getProjectControls({
		projectId: f.project.id,
	});
	await t.throwsAsync(
		f.controls.controls.setProjectConfigOption({
			projectId: f.project.id,
			revision: offered.revision,
			configId: 'provider',
			value: 'b',
		}),
	);
	const before = await f.threads.getThreadSnapshot(f.request);
	await t.throwsAsync(
		f.threads.promptThread({...f.request, text: 'blocked fixture'}),
		{instanceOf: IpcFailure},
	);
	const after = await f.threads.getThreadSnapshot(f.request);
	t.deepEqual(after.events, before.events);
	t.is(f.rpc().filter(event => event.method === 'session/prompt').length, 2);
});

test('a pending native confirmation reserves the same authority used by ThreadService prompts (CHAT-17)', async t => {
	const f = await fixture(t);
	let entered!: () => void;
	let decide!: (value: boolean) => void;
	const waiting = new Promise<void>(done => {
		entered = done;
	});
	const decision = new Promise<boolean>(done => {
		decide = done;
	});
	f.confirm(() => {
		entered();
		return decision;
	});
	const selecting = f.controls.setThreadMode({...f.request, mode: 'yolo'});
	t.teardown(() => decide(false));
	await waiting;
	await t.throwsAsync(
		f.threads.promptThread({...f.request, text: 'must not start'}),
		{code: 'BUSY'},
	);
	t.is(f.launches(), 0);
	decide(false);
	await selecting;
});

test('lifecycle invalidation aborts a native confirmation instead of accepting its late yolo response (DEC-31)', async t => {
	const f = await fixture(t);
	let entered!: () => void;
	let decide!: (value: boolean) => void;
	const waiting = new Promise<void>(done => {
		entered = done;
	});
	const decision = new Promise<boolean>(done => {
		decide = done;
	});
	f.confirm(() => {
		entered();
		return decision;
	});
	const selecting = f.controls.setThreadMode({...f.request, mode: 'yolo'});
	const refused = t.throwsAsync(selecting, {instanceOf: IpcFailure});
	t.teardown(() => decide(false));
	await waiting;
	f.controls.invalidate(f.project.id);
	decide(true);
	await refused;
	t.is(f.launches(), 0);
	t.is(f.store.threads.get(f.project.id, f.thread.id)?.mode, 'normal');
	t.is((await f.threads.getThreadSnapshot(f.request)).thread.mode, 'normal');
});

test('a repeated prompt after direct authority invalidation safely resumes instead of retaining previous-epoch yolo (DEC-31)', async t => {
	const f = await fixture(t);
	await f.controls.setThreadMode({...f.request, mode: 'yolo'});
	await f.threads.promptThread({...f.request, text: 'first fixture'});
	f.threads.projectOperations.invalidate(f.project.id);
	await f.threads.promptThread({...f.request, text: 'second fixture'});
	t.is(f.rpc().filter(event => event.method === 'session/resume').length, 1);
	t.deepEqual(
		f
			.rpc()
			.filter(event => event.method === 'session/set_mode')
			.map(event => (event.params as {modeId: string}).modeId),
		['normal', 'yolo', 'normal'],
	);
	t.is((await f.threads.getThreadSnapshot(f.request)).thread.mode, 'normal');
	t.is(f.launches(), 1);
	t.is(f.confirmations(), 1);
	t.true(f.writes.every(thread => thread.mode !== 'yolo'));
});

test('unprompted current config notification publishes a new revision without clearing another pending yolo (ACP-14 DEC-31)', async t => {
	const f = await fixture(t, 'config-notify-unprompted');
	await f.threads.promptThread({...f.request, text: 'fixture first session'});
	const before = f.controls.controls.getProjectControls({
		projectId: f.project.id,
	});
	const pending = await f.threads.createThread({projectId: f.project.id});
	const request = {projectId: f.project.id, threadId: pending.id};
	await f.controls.setThreadMode({...request, mode: 'yolo'});
	await f.supervisor.getConnection(f.project.id).probeExtensions();
	const pushed = f.published.at(-1);
	if (!pushed) throw new Error('Expected pushed project controls');
	t.not(pushed?.revision, before.revision);
	t.is(
		pushed?.configOptions.find(option => option.id === 'model')?.currentValue,
		'confirmed',
	);
	const after = f.controls.controls.getProjectControls({
		projectId: f.project.id,
	});
	t.is(after.revision, pushed.revision);
	t.is((await f.threads.getThreadSnapshot(request)).thread.mode, 'yolo');
	t.is(f.store.threads.get(f.project.id, pending.id)?.nanocoderSessionId, null);
	t.is(f.launches(), 1);
	await t.throwsAsync(
		f.controls.controls.setProjectConfigOption({
			projectId: f.project.id,
			revision: before.revision,
			configId: 'provider',
			value: 'b',
		}),
		{code: 'DENIED'},
	);
	t.is(
		f.rpc().filter(event => event.method === 'session/set_config_option')
			.length,
		0,
	);
	await f.threads.promptThread({...request, text: 'fixture pending yolo'});
	t.is((await f.threads.getThreadSnapshot(request)).thread.mode, 'yolo');
	t.is(f.confirmations(), 1);
	t.true(f.writes.every(thread => thread.mode !== 'yolo'));
});

test('CHAT-09 view-only retry resumes the saved session only through an explicit open (DEC-42)', async t => {
	const f = await fixture(t, 'resume-missing');
	await f.threads.promptThread({...f.request, text: 'fixture request'});
	const saved =
		f.store.threads.get(f.project.id, f.thread.id)?.nanocoderSessionId ?? null;
	t.truthy(saved);
	await f.supervisor.stop(f.project.id);
	const count = (method: string) =>
		f.rpc().filter(event => event.method === method).length;
	const missing = await f.threads.openThread(f.request);
	t.is(missing.thread.runState, 'view-only');
	t.is(count('session/resume'), 1);
	const retried = await f.threads.openThread(f.request);
	t.is(retried.thread.runState, 'view-only');
	t.is(count('session/resume'), 2);
	await t.throwsAsync(f.threads.promptThread({...f.request, text: 'refused'}), {
		instanceOf: IpcFailure,
	});
	await t.throwsAsync(f.controls.setThreadMode({...f.request, mode: 'plan'}), {
		instanceOf: IpcFailure,
	});
	t.is(count('session/prompt'), 0);
	writeFileSync(path.join(f.project.canonicalRoot, '.fake-resume-ok'), 'ok');
	const restored = await f.threads.openThread(f.request);
	t.is(restored.thread.runState, 'ready');
	t.is(restored.thread.nanocoderSessionId, saved);
	t.is(count('session/resume'), 3);
	t.is(count('session/new'), 0);
});

test('disposed project controls ignore a later current-session config notification (ACP-14)', async t => {
	const f = await fixture(t, 'config-notify-unprompted');
	await f.threads.promptThread({...f.request, text: 'fixture session'});
	const before = f.published.length;
	f.controls.dispose();
	await f.supervisor.getConnection(f.project.id).probeExtensions();
	t.is(f.published.length, before);
	t.is(
		f.supervisor.getConnection(f.project.id).getSessionOffers('session-1')
			?.configOptions?.[1]?.currentValue,
		'old',
	);
});

test('thread invalidation forgets pending yolo and session controls so the next prompt stays safe (DEC-31)', async t => {
	const f = await fixture(t);
	await f.controls.setThreadMode({...f.request, mode: 'yolo'});
	await f.threads.promptThread({...f.request, text: 'first fixture'});
	const before = f.published.length;
	f.controls.invalidateThread(f.project.id, f.thread.id);
	t.true(f.published.length > before);
	f.controls.invalidateThread(f.project.id, f.thread.id);
	await f.threads.promptThread({...f.request, text: 'second fixture'});
	t.is(
		f
			.rpc()
			.filter(event => event.method === 'session/set_mode')
			.map(event => (event.params as {modeId: string}).modeId)
			.at(-1),
		'normal',
	);
	t.is(f.confirmations(), 1);
});
