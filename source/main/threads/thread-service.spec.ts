import {randomUUID} from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {IpcFailure} from '@/main/ipc/handle-request';
import {
	type ConnectOptions,
	type NanocoderConnection,
	NanocoderFailure,
	type NanocoderTurnResult,
} from '@/main/nanocoder/acp-client';
import {FakeClock} from '@/main/nanocoder/fixtures/fake-clock';
import {fakeEvents, fakeRuntime} from '@/main/nanocoder/fixtures/fake-project';
import {connectProject} from '@/main/nanocoder/open-project';
import {ProjectSupervisor} from '@/main/nanocoder/supervisor';
import {desktopStoreFactory} from '@/main/store';
import {createNodeSqliteDriver} from '@/main/store/node-sqlite';
import type {ProjectOperationLease} from '@/main/threads/project-operations';
import {createThreadService} from '@/main/threads/thread-service';
import type {
	PermissionRequestInfo,
	ProjectEvent,
	ProjectInfo,
	ThreadInfo,
	TurnEvent,
} from '@/shared/ipc';
import {REPLAY_MISSING_REASON} from '@/shared/thread-replay';

const discoveryRow = (cwd: string, sessionId = 'discovered-session') => ({
	sessionId,
	cwd,
	title: 'saved import candidate',
	updatedAt: '2026-10-29T12:00:00.000Z',
});

async function discoveryFixture(t: ExecutionContext, mode?: string) {
	const f = await fixture(t, true);
	if (mode)
		writeFileSync(path.join(f.project.canonicalRoot, '.fake-nanocoder'), mode);
	await f.supervisor.ensureProcess(f.project);
	const connection = f.supervisor.getConnection(f.project.id);
	const drained = deferred<void>();
	const write = connection.stderr.write;
	// The last request of each probe is its bare name, and the probes run side by side.
	const check = () => {
		const seen = new Set(
			fakeEvents(connection.stderr.lines()).map(e => e.method),
		);
		if (
			['renameSession', 'timeline/list', 'pinSession'].every(m => seen.has(m))
		)
			drained.resolve();
	};
	connection.stderr.write = chunk => {
		write.call(connection.stderr, chunk);
		check();
	};
	check();
	try {
		await drained.promise;
	} finally {
		connection.stderr.write = write;
	}
	return {...f, connection};
}

async function importableFixture(
	t: ExecutionContext,
	sessionId = 'fake-session',
	mode?: string,
) {
	const f = await discoveryFixture(t, mode);
	f.connection.listSessions = async () => ({
		sessions: [
			{
				...discoveryRow(f.project.canonicalRoot, sessionId),
				mode: 'yolo',
				content: 'must not become imported metadata',
			},
		],
	});
	t.is(
		(await f.service.discoverSessions({projectId: f.project.id}))[0]?.id,
		sessionId,
	);
	return f;
}

test('ACP-18 import uses the same metadata authority without launch, consent, auto-open, prompt or selection', async t => {
	const f = await importableFixture(t);
	f.store.projects.save({...f.project, trusted: false});
	const calls = structuredClone(f.calls);
	const diagnostics = f.connection.stderr.lines();
	const ui = f.store.getUiState();
	const kinds: string[] = [];
	const metadata = f.service.projectOperations.runMetadataOperation;
	f.service.projectOperations.runMetadataOperation = (
		id,
		kind,
		work,
		scope,
	) => {
		kinds.push(kind);
		return metadata(id, kind, work, scope);
	};
	const imported = await f.service.importSession({
		projectId: f.project.id,
		sessionId: 'fake-session',
	});
	t.deepEqual(imported, {
		id: imported.id,
		projectId: f.project.id,
		nanocoderSessionId: 'fake-session',
		title: 'saved import candidate',
		archiveState: 'active',
		runState: 'ready',
		lastActivityAt: '2026-10-29T12:00:00.000Z',
		sessionCwd: f.project.canonicalRoot,
		mode: 'auto-accept',
		viewOnlyReason: null,
	});
	t.deepEqual(kinds, ['import-session']);
	t.deepEqual(f.store.threads.get(f.project.id, imported.id), imported);
	t.false(f.store.threads.getTitleManuallySet(f.project.id, imported.id));
	t.deepEqual(f.calls, calls);
	t.deepEqual(f.connection.stderr.lines(), diagnostics);
	t.deepEqual(f.store.getUiState(), ui);
});

for (const mode of ['normal', 'auto-accept', 'plan', 'architect'] as const) {
	test(`ACP-18 DEC-31 imported ${mode} default resumes and confirms that mode before the first explicit prompt`, async t => {
		const f = await importableFixture(t, 'fake-session', 'reported-usage');
		f.store.projects.save({...f.project, defaultMode: mode});
		const imported = await f.service.importSession({
			projectId: f.project.id,
			sessionId: 'fake-session',
		});
		t.is(imported.mode, mode);
		const scope = {projectId: f.project.id, threadId: imported.id};
		const opened = await f.service.openThread(scope);
		t.is(opened.thread.nanocoderSessionId, 'fake-session');
		t.is(opened.thread.mode, mode);
		const requests = () =>
			fakeEvents(f.connection.stderr.lines()).filter(
				e => typeof e.method === 'string' && e.method.startsWith('session/'),
			);
		t.deepEqual(requests(), [
			{
				method: 'session/resume',
				params: {
					sessionId: 'fake-session',
					cwd: f.project.canonicalRoot,
					mcpServers: [],
				},
			},
			{
				method: 'session/set_mode',
				params: {sessionId: 'fake-session', modeId: mode},
			},
		]);
		await f.service.promptThread({...scope, text: 'explicit imported prompt'});
		t.deepEqual(
			requests().map(e => e.method),
			['session/resume', 'session/set_mode', 'session/prompt'],
		);
	});
}

test('ACP-18 same-owner reimport is a true no-op, including archived state, manual title, activity and publication', async t => {
	const f = await importableFixture(t);
	const known = seed(f.project, {
		nanocoderSessionId: 'fake-session',
		archiveState: 'archived',
		title: 'manual saved title',
		mode: 'plan',
	});
	f.store.threads.save(known);
	f.store.threads.setTitle({
		projectId: known.projectId,
		threadId: known.id,
		title: known.title,
		manuallySet: true,
	});
	t.deepEqual(await f.service.discoverSessions({projectId: f.project.id}), []);
	const scope = {projectId: known.projectId, threadId: known.id};
	const before = await f.service.getThreadSnapshot(scope);
	const ui = f.store.getUiState();
	const diagnostics = f.connection.stderr.lines();
	const events: ProjectEvent[] = [];
	t.teardown(f.supervisor.subscribe(event => events.push(event)));
	const save = f.store.threads.save;
	let writes = 0;
	f.store.threads.save = row => {
		writes++;
		save(row);
	};
	t.deepEqual(
		await f.service.importSession({
			projectId: known.projectId,
			sessionId: 'fake-session',
		}),
		known,
	);
	t.is(writes, 0);
	t.deepEqual(events, []);
	t.deepEqual(await f.service.getThreadSnapshot(scope), before);
	t.true(f.store.threads.getTitleManuallySet(known.projectId, known.id));
	t.deepEqual(f.store.getUiState(), ui);
	t.deepEqual(f.connection.stderr.lines(), diagnostics);
});

test('ACP-18 cross-owner import refuses without leaking a title or rewriting either owner', async t => {
	const f = await importableFixture(t);
	const otherRoot = path.join(f.root, 'other-project');
	mkdirSync(otherRoot);
	const other = {
		...f.project,
		id: randomUUID(),
		canonicalRoot: otherRoot,
		sessionCwd: otherRoot,
	};
	f.store.projects.save(other);
	const known = seed(other, {
		nanocoderSessionId: 'fake-session',
		title: 'private foreign title',
	});
	f.store.threads.save(known);
	t.deepEqual(await f.service.discoverSessions({projectId: f.project.id}), []);
	const error = await t.throwsAsync(
		f.service.importSession({
			projectId: f.project.id,
			sessionId: 'fake-session',
		}),
		{code: 'DENIED'},
	);
	t.false(error?.message.includes(known.title));
	t.deepEqual(f.store.threads.get(other.id, known.id), known);
	t.deepEqual(f.store.threads.list(f.project.id, 'active'), []);
});

test('ACP-18 direct import validates the shared opaque ID before ownership lookup, cache or writes', async t => {
	const f = await fixture(t);
	let lookedUp = 0;
	f.store.threads.getBySessionId = () => {
		lookedUp++;
		return undefined;
	};
	for (const sessionId of [
		'',
		' ',
		'\uD800',
		'é'.repeat(101),
		'session\u202e',
	]) {
		await t.throwsAsync(
			f.service.importSession({projectId: f.project.id, sessionId}),
			{code: 'VALIDATION'},
		);
	}
	t.is(lookedUp, 0);
	t.deepEqual(f.calls, []);
	t.deepEqual(f.store.threads.list(f.project.id, 'active'), []);
});

test('ACP-18 import requires current cached proof and cannot use an arbitrary or failed-refresh ID', async t => {
	const f = await importableFixture(t);
	await t.throwsAsync(
		f.service.importSession({projectId: f.project.id, sessionId: 'arbitrary'}),
		{code: 'DENIED'},
	);
	f.connection.listSessions = async () => {
		throw new Error('private failure');
	};
	t.deepEqual(await f.service.discoverSessions({projectId: f.project.id}), []);
	await t.throwsAsync(
		f.service.importSession({
			projectId: f.project.id,
			sessionId: 'fake-session',
		}),
		{code: 'UNAVAILABLE'},
	);
	t.deepEqual(f.store.threads.list(f.project.id, 'active'), []);
});

for (const change of ['outside', 'missing'] as const) {
	test(`ACP-18 import revalidates the originally listed cwd after its symlink becomes ${change}`, async t => {
		const f = await discoveryFixture(t);
		const alias = path.join(f.root, 'reported-cwd');
		symlinkSync(f.project.canonicalRoot, alias, 'junction');
		f.connection.listSessions = async () => ({
			sessions: [discoveryRow(alias, 'fake-session')],
		});
		t.is(
			(await f.service.discoverSessions({projectId: f.project.id})).length,
			1,
		);
		unlinkSync(alias);
		if (change === 'outside') symlinkSync(f.root, alias, 'junction');
		const diagnostics = f.connection.stderr.lines();
		await t.throwsAsync(
			f.service.importSession({
				projectId: f.project.id,
				sessionId: 'fake-session',
			}),
			{code: change === 'outside' ? 'OUTSIDE_ROOT' : 'DENIED'},
		);
		t.deepEqual(f.store.threads.list(f.project.id, 'active'), []);
		t.deepEqual(f.connection.stderr.lines(), diagnostics);
	});
}

test('ACP-18 import and execution share the same project slot in both directions', async t => {
	const f = await importableFixture(t);
	const held = deferred<void>();
	const active = f.service.runProjectOperation(
		f.project.id,
		'mode',
		async () => held.promise,
	);
	try {
		await t.throwsAsync(
			f.service.importSession({
				projectId: f.project.id,
				sessionId: 'fake-session',
			}),
			{code: 'BUSY'},
		);
	} finally {
		held.resolve();
		await active;
	}
	const importing = f.service.importSession({
		projectId: f.project.id,
		sessionId: 'fake-session',
	});
	await t.throwsAsync(
		f.service.runProjectOperation(f.project.id, 'mode', async () => {
			t.fail('Execution entered an import metadata lease');
		}),
		{code: 'BUSY'},
	);
	await importing;
});

for (const reset of [
	'detach',
	'dispose',
	'replace',
	'root',
	'cwd',
	'latest',
] as const) {
	test(`ACP-18 ${reset} invalidates completed import proof without writing a row`, async t => {
		const f = await importableFixture(t);
		if (reset === 'detach') await f.service.detach([f.project]);
		if (reset === 'dispose') f.service.dispose();
		if (reset === 'replace') {
			await f.supervisor.stop(f.project.id);
			await f.supervisor.ensureProcess(f.project);
		}
		if (reset === 'root' || reset === 'cwd') {
			const changed = path.join(f.project.canonicalRoot, 'changed');
			mkdirSync(changed);
			if (reset === 'root')
				f.store.projects.save({
					...f.project,
					canonicalRoot: changed,
					sessionCwd: changed,
				});
			else {
				const get = f.store.projects.get;
				f.store.projects.get = id => {
					const project = get(id);
					return project?.id === f.project.id
						? {...project, sessionCwd: changed}
						: project;
				};
			}
		}
		if (reset === 'latest') {
			f.connection.listSessions = async () => ({
				sessions: [discoveryRow(f.project.canonicalRoot, 'latest')],
			});
			t.is(
				(await f.service.discoverSessions({projectId: f.project.id}))[0]?.id,
				'latest',
			);
		}
		await t.throwsAsync(
			f.service.importSession({
				projectId: f.project.id,
				sessionId: 'fake-session',
			}),
			{
				code:
					reset === 'dispose'
						? 'AGENT_UNAVAILABLE'
						: reset === 'latest'
							? 'DENIED'
							: 'UNAVAILABLE',
			},
		);
		t.deepEqual(f.store.threads.list(f.project.id, 'active'), []);
	});
}

test('ACP-18 concurrent cross-project imports cannot steal the globally unique saved session key', async t => {
	const f = await importableFixture(t);
	const otherRoot = path.join(f.root, 'other-project');
	mkdirSync(otherRoot);
	const other = {
		...f.project,
		id: randomUUID(),
		canonicalRoot: otherRoot,
		sessionCwd: otherRoot,
	};
	f.store.projects.save(other);
	await f.supervisor.ensureProcess(other);
	const connection = f.supervisor.getConnection(other.id);
	connection.listSessions = async () => ({
		sessions: [discoveryRow(otherRoot, 'fake-session')],
	});
	t.is((await f.service.discoverSessions({projectId: other.id})).length, 1);
	const results = await Promise.allSettled(
		[f.project, other].map(project =>
			f.service.importSession({
				projectId: project.id,
				sessionId: 'fake-session',
			}),
		),
	);
	t.is(results.filter(result => result.status === 'fulfilled').length, 1);
	const rejected = results.find(result => result.status === 'rejected');
	t.true(
		rejected?.status === 'rejected' && rejected.reason instanceof IpcFailure,
	);
	if (rejected?.status === 'rejected') t.is(rejected.reason.code, 'DENIED');
	t.is(
		[f.project, other].flatMap(project =>
			f.store.threads.list(project.id, 'active'),
		).length,
		1,
	);
});

test('ACP-18 missing discovery activity uses the local clock for metadata, not an invented remote time', async t => {
	const f = await discoveryFixture(t);
	f.connection.listSessions = async () => ({
		sessions: [
			{
				sessionId: 'fake-session',
				cwd: f.project.canonicalRoot,
				title: '<strong>plain metadata title</strong>',
			},
		],
	});
	const listed = await f.service.discoverSessions({projectId: f.project.id});
	t.is(listed[0]?.lastActivityAt, null);
	const imported = await f.service.importSession({
		projectId: f.project.id,
		sessionId: 'fake-session',
	});
	t.is(imported.lastActivityAt, '2026-10-30T14:00:00.000Z');
	t.is(imported.title, '<strong>plain metadata title</strong>');
});

test('ACP-18 offline discovery is an empty read without launch, consent or known-thread changes', async t => {
	const f = await fixture(t);
	const known = seed(f.project, {nanocoderSessionId: 'known'});
	f.store.threads.save(known);
	const ui = f.store.getUiState();
	t.deepEqual(await f.service.discoverSessions({projectId: f.project.id}), []);
	t.deepEqual(f.calls, []);
	t.deepEqual(f.store.threads.get(f.project.id, known.id), known);
	t.deepEqual(f.store.getUiState(), ui);
});

test('ACP-18 ready mixed-root discovery projects only unknown exact native roots and never persists or selects', async t => {
	const f = await discoveryFixture(t);
	const known = seed(f.project, {nanocoderSessionId: 'known'});
	f.store.threads.save(known);
	const foreign = path.join(f.root, 'foreign');
	const nested = path.join(f.project.canonicalRoot, 'nested');
	const outside = path.join(f.project.canonicalRoot, 'outside');
	for (const dir of [foreign, nested]) mkdirSync(dir);
	symlinkSync(foreign, outside, 'junction');
	const caseAlias = path.join(f.root, 'PROJECT');
	let caseResolves = false;
	try {
		caseResolves = realpathSync.native(caseAlias) === f.project.canonicalRoot;
	} catch {}
	const privateRow = (cwd: string, id: string) => ({
		sessionId: id,
		cwd,
		get title(): string {
			t.fail('Foreign title reached service projection');
			throw new Error('private title');
		},
	});
	f.connection.listSessions = async () => ({
		sessions: [
			discoveryRow(f.project.canonicalRoot),
			discoveryRow(f.project.canonicalRoot, 'known'),
			discoveryRow(caseAlias, 'case-alias'),
			privateRow(foreign, 'foreign'),
			privateRow(nested, 'nested'),
			privateRow(outside, 'outside-symlink'),
		],
	});
	const calls = structuredClone(f.calls);
	const diagnostics = f.connection.stderr.lines();
	const ui = f.store.getUiState();
	t.deepEqual(await f.service.discoverSessions({projectId: f.project.id}), [
		...(caseResolves
			? [
					{
						id: 'case-alias',
						title: 'saved import candidate',
						sessionCwd: f.project.canonicalRoot,
						lastActivityAt: '2026-10-29T12:00:00.000Z',
					},
				]
			: []),
		{
			id: 'discovered-session',
			title: 'saved import candidate',
			sessionCwd: f.project.canonicalRoot,
			lastActivityAt: '2026-10-29T12:00:00.000Z',
		},
	]);
	t.deepEqual(f.calls, calls);
	t.deepEqual(f.connection.stderr.lines(), diagnostics);
	t.deepEqual(f.store.threads.list(f.project.id, 'active'), [known]);
	t.deepEqual(f.store.getUiState(), ui);
});

for (const unavailable of [
	'no-list',
	'missing-adapter',
	'list-fails',
] as const) {
	test(`ACP-18 ${unavailable} discovery returns empty without launch or thread changes`, async t => {
		const f = await discoveryFixture(t, unavailable);
		const known = seed(f.project, {nanocoderSessionId: 'known'});
		f.store.threads.save(known);
		if (unavailable === 'missing-adapter') delete f.connection.listSessions;
		const calls = structuredClone(f.calls);
		const beforeMethods = fakeEvents(f.connection.stderr.lines())
			.filter(event => event.method)
			.map(event => event.method);
		t.deepEqual(
			await f.service.discoverSessions({projectId: f.project.id}),
			[],
		);
		t.deepEqual(f.store.threads.get(f.project.id, known.id), known);
		t.deepEqual(f.calls, calls);
		const methods = fakeEvents(f.connection.stderr.lines())
			.filter(event => event.method)
			.map(event => event.method);
		t.deepEqual(methods, [
			...beforeMethods,
			...(unavailable === 'list-fails' ? ['session/list'] : []),
		]);
	});
}

test('ACP-18 reordered discovery cannot publish an older response or erase a later failure', async t => {
	const f = await discoveryFixture(t);
	const entered = deferred<void>();
	const pending = deferred<unknown>();
	f.connection.listSessions = async () => {
		entered.resolve();
		return pending.promise;
	};
	const first = f.service.discoverSessions({projectId: f.project.id});
	await Promise.race([
		entered.promise,
		first.then(() => {
			throw new Error('Discovery did not request the ready connection');
		}),
	]);
	f.connection.listSessions = async () => ({
		sessions: [discoveryRow(f.project.canonicalRoot, 'newest')],
	});
	t.is(
		(await f.service.discoverSessions({projectId: f.project.id}))[0]?.id,
		'newest',
	);
	pending.resolve({sessions: [discoveryRow(f.project.canonicalRoot, 'old')]});
	t.deepEqual(await first, []);
	f.connection.listSessions = async () => {
		throw new Error('private list failure');
	};
	t.deepEqual(await f.service.discoverSessions({projectId: f.project.id}), []);
});

for (const teardown of ['detach', 'dispose', 'replace'] as const) {
	test(`ACP-18 ${teardown} invalidates an in-flight discovery without late projection or writes`, async t => {
		const f = await discoveryFixture(t);
		const entered = deferred<void>();
		const pending = deferred<unknown>();
		f.connection.listSessions = async () => {
			entered.resolve();
			return pending.promise;
		};
		const first = f.service.discoverSessions({projectId: f.project.id});
		await Promise.race([
			entered.promise,
			first.then(() => {
				throw new Error('Discovery did not request the ready connection');
			}),
		]);
		if (teardown === 'detach') await f.service.detach([f.project]);
		if (teardown === 'dispose') f.service.dispose();
		if (teardown === 'replace') {
			await f.supervisor.stop(f.project.id);
			await f.supervisor.ensureProcess(f.project);
		}
		pending.resolve({sessions: [discoveryRow(f.project.canonicalRoot)]});
		t.deepEqual(await first, []);
		t.deepEqual(f.store.threads.list(f.project.id, 'active'), []);
	});
}

for (const source of ['open', 'recovery'] as const) {
	for (const code of ['NOT_FOUND', 'AGENT_UNAVAILABLE'] as const) {
		test(`CHAT-09 ${source} ${code} classifies resume failure without changing metadata or readable history`, async t => {
			const f = await fixture(t, true);
			const thread = seed(f.project, {nanocoderSessionId: 'fake-session'});
			f.store.threads.save(thread);
			const request = {projectId: f.project.id, threadId: thread.id};
			f.store.threads.setTitle({
				...request,
				title: 'manual history fixture',
				manuallySet: true,
			});
			const before = await f.service.openThread(request);
			const scope = {...request, sessionId: 'fake-session'};
			const sql = f.store.threadHistory.read(scope);
			const runs = f.store.agentRuns.list(f.project.id, thread.id);
			if (source === 'open') {
				await f.supervisor.stop(f.project.id);
				writeFileSync(
					path.join(f.project.canonicalRoot, '.fake-nanocoder'),
					code === 'NOT_FOUND' ? 'missing-session' : 'resume-fails',
				);
				await f.service.openThread(request);
			} else {
				const connection = f.supervisor.getConnection(f.project.id);
				connection.resumeSession = async () => {
					throw new NanocoderFailure(code, 'safe fixture resume refusal');
				};
				await t.throwsAsync(
					f.service.restore(
						f.project,
						connection,
						new AbortController().signal,
					),
				);
			}
			const after = await f.service.getThreadSnapshot(request);
			t.is(
				after.thread.runState,
				code === 'NOT_FOUND' ? 'view-only' : 'failed',
			);
			t.is(
				after.thread.viewOnlyReason,
				code === 'NOT_FOUND'
					? REPLAY_MISSING_REASON
					: source === 'open'
						? 'Nanocoder could not resume the session'
						: 'safe fixture resume refusal',
			);
			t.is(after.thread.id, before.thread.id);
			t.is(after.thread.nanocoderSessionId, before.thread.nanocoderSessionId);
			t.is(after.thread.title, before.thread.title);
			t.is(after.thread.lastActivityAt, before.thread.lastActivityAt);
			t.true(f.store.threads.getTitleManuallySet(f.project.id, thread.id));
			t.deepEqual(after.events, before.events);
			t.deepEqual(after.result, before.result);
			t.deepEqual(f.store.threadHistory.read(scope), sql);
			t.deepEqual(f.store.agentRuns.list(f.project.id, thread.id), runs);
			t.true(after.replaying);
			await t.throwsAsync(
				f.service.promptThread({...request, text: 'must remain unqueued'}),
				{code: 'UNAVAILABLE'},
			);
		});
	}
}

for (const kind of ['mode', 'config'] as const) {
	test(`CHAT-08 failed replay refuses shared ${kind} work before any control callback`, async t => {
		const f = await fixture(t, true);
		const thread = seed(f.project, {nanocoderSessionId: 'fake-session'});
		f.store.threads.save(thread);
		f.store.threadHistory.apply = () => {
			throw new IpcFailure('AGENT_UNAVAILABLE', 'fixture commit refusal');
		};
		await f.service.openThread({projectId: f.project.id, threadId: thread.id});
		let changes = 0;
		const result = await f.service
			.runProjectOperation(f.project.id, kind, async () => {
				changes++;
				return null;
			})
			.then(
				() => 'accepted',
				(error: unknown) =>
					error instanceof IpcFailure ? error.code : 'unknown',
			);
		t.is(result, 'UNAVAILABLE');
		t.is(changes, 0);
	});
}

test('CHAT-08 failed replay keeps controls hidden except inside a distinct new-thread prompt owner', async t => {
	const f = await fixture(t, true);
	const thread = seed(f.project, {nanocoderSessionId: 'fake-session'});
	f.store.threads.save(thread);
	f.store.threadHistory.apply = () => {
		throw new IpcFailure('AGENT_UNAVAILABLE', 'fixture commit refusal');
	};
	await f.service.openThread({projectId: f.project.id, threadId: thread.id});
	const next = await f.service.createThread({projectId: f.project.id});
	t.is(f.service.getControlConnection(f.project.id), undefined);
	await f.service.runProjectOperation(
		f.project.id,
		'prompt',
		async () => {
			t.is(f.service.getControlConnection(f.project.id), undefined);
		},
		{threadId: thread.id},
	);
	await t.throwsAsync(
		f.service.promptThread({
			projectId: f.project.id,
			threadId: thread.id,
			text: 'must not enter the failed session',
		}),
		{code: 'UNAVAILABLE'},
	);
	await f.service
		.runProjectOperation(
			f.project.id,
			'prompt',
			async lease => {
				f.service.projectOperations.assertCurrent(lease);
				t.is(
					f.service.getControlConnection(f.project.id),
					f.supervisor.getConnection(f.project.id),
				);
				f.service.projectOperations.invalidate(f.project.id);
				t.is(f.service.getControlConnection(f.project.id), undefined);
			},
			{threadId: next.id},
		)
		.catch(error => {
			if (!(error instanceof IpcFailure) || error.code !== 'AGENT_UNAVAILABLE')
				throw error;
		});
	t.is(f.service.getControlConnection(f.project.id), undefined);
	const failed = await f.service.getThreadSnapshot({
		projectId: f.project.id,
		threadId: thread.id,
	});
	t.true(failed.replaying);
	t.is(failed.thread.nanocoderSessionId, 'fake-session');
	t.deepEqual(failed.events, []);
});

test('CHAT-08 a recreated owner recovers the stored sequence floor before publishing begin', async t => {
	const f = await fixture(t, true);
	const thread = seed(f.project, {nanocoderSessionId: 'fake-session'});
	f.store.threads.save(thread);
	const request = {projectId: f.project.id, threadId: thread.id};
	await f.service.openThread(request);
	const scope = {...request, sessionId: 'fake-session'};
	const before = f.store.threadHistory.read(scope);
	if (!before) throw new Error('Missing first committed history');
	f.service.dispose();
	const packets: ProjectEvent[] = [];
	const restarted = createThreadService({
		store: f.store,
		supervisor: f.supervisor,
		onEvent: event => packets.push(event),
	});
	t.teardown(() => restarted.dispose());
	const snapshot = await restarted.openThread(request);
	const floor = Math.floor(before.sequence / 10001);
	assertReplayMarkers(
		t,
		packets,
		thread,
		[
			['begin', floor + 1],
			['complete', floor + 3],
		],
		snapshot.replayEpoch,
	);
	t.is(snapshot.sequence, floor + 3);
	const after = f.store.threadHistory.read(scope);
	t.deepEqual(after?.turns, before.turns);
	t.deepEqual(after?.executions, before.executions);
});

test('CHAT-08 a fresh marker never reuses a stored slot on an exact batch boundary', async t => {
	const f = await fixture(t, true);
	const thread = seed(f.project, {nanocoderSessionId: 'fake-session'});
	f.store.threads.save(thread);
	const request = {projectId: f.project.id, threadId: thread.id};
	const scope = {...request, sessionId: 'fake-session'};
	await f.service.openThread(request);
	const before = f.store.threadHistory.read(scope);
	if (!before) throw new Error('Missing committed fixture history');
	const boundary = 5 * 10001;
	f.store.threadHistory.apply(scope, {
		expectedRevision: before.revision,
		source: 'live',
		generation: before.generation,
		sequence: boundary,
		complete: before.complete,
		turns: [],
		executions: [],
		agentRuns: [],
	});
	t.is(f.store.threadHistory.read(scope)?.sequence, boundary);
	f.service.dispose();
	const packets: ProjectEvent[] = [];
	const restarted = createThreadService({
		store: f.store,
		supervisor: f.supervisor,
		onEvent: event => packets.push(event),
	});
	t.teardown(() => restarted.dispose());
	const snapshot = await restarted.openThread(request);
	const floor = Math.floor(boundary / 10001);
	assertReplayMarkers(
		t,
		packets,
		thread,
		[
			['begin', floor + 1],
			['complete', floor + 3],
		],
		snapshot.replayEpoch,
	);
	t.true((packets[0]?.sequence ?? 0) * 10001 > boundary);
	t.deepEqual(f.store.threadHistory.read(scope)?.turns, before.turns);
	t.deepEqual(f.store.threadHistory.read(scope)?.executions, before.executions);
});

test('CHAT-08 failed commit publishes only failed, keeps the gate closed and retries the same ID with a fresh epoch', async t => {
	const packets: ProjectEvent[] = [];
	const f = await fixture(t, true, event => packets.push(event));
	const thread = seed(f.project, {nanocoderSessionId: 'fake-session'});
	f.store.threads.save(thread);
	const request = {projectId: f.project.id, threadId: thread.id};
	const scope = {...request, sessionId: 'fake-session'};
	const apply = f.store.threadHistory.apply.bind(f.store.threadHistory);
	f.store.threadHistory.apply = () => {
		throw new IpcFailure('AGENT_UNAVAILABLE', 'fixture commit refused');
	};
	const failed = await f.service.openThread(request);
	assertReplayMarkers(
		t,
		packets,
		thread,
		[
			['begin', 1],
			['failed', 2],
		],
		failed.replayEpoch,
	);
	t.true(failed.replaying);
	t.deepEqual(failed.events, []);
	t.is(f.store.threadHistory.read(scope), undefined);
	t.deepEqual(f.store.agentRuns.list(f.project.id, thread.id), []);
	t.is(f.service.getControlConnection(f.project.id), undefined);
	f.store.threadHistory.apply = apply;
	const retried = await f.service.openThread(request);
	assertReplayMarkers(
		t,
		packets.slice(2),
		thread,
		[
			['begin', 3],
			['complete', 5],
		],
		retried.replayEpoch,
	);
	t.not(retried.replayEpoch, failed.replayEpoch);
	t.false(retried.replaying);
	t.is(retried.thread.nanocoderSessionId, 'fake-session');
	t.is(retried.thread.runState, 'ready');
	t.truthy(f.store.threadHistory.read(scope));
	t.truthy(f.service.getControlConnection(f.project.id));
	const methods = fakeEvents(
		f.supervisor.getConnection(f.project.id).stderr.lines(),
	).map(event => event.method);
	t.is(methods.filter(method => method === 'session/resume').length, 2);
	t.false(methods.includes('session/new'));
	t.false(methods.includes('session/prompt'));
});

test('CHAT-08 cancelling a replay handoff preserves interrupted rather than inventing a failed turn', async t => {
	const entered = deferred<void>();
	const release = deferred<void>();
	const f = await fixture(t, true, undefined, false, {
		onSessionPrepared: async () => {
			entered.resolve();
			await release.promise;
		},
	});
	const thread = seed(f.project, {nanocoderSessionId: 'fake-session'});
	f.store.threads.save(thread);
	const request = {projectId: f.project.id, threadId: thread.id};
	const turning = f.service.promptThread({...request, text: 'not sent'});
	await entered.promise;
	const cancelled = f.service.cancelThread(request);
	release.resolve();
	await cancelled;
	t.deepEqual(await turning, {stopReason: 'cancelled'});
	const snapshot = await f.service.getThreadSnapshot(request);
	t.is(snapshot.thread.runState, 'interrupted');
	t.deepEqual(snapshot.events, []);
	t.false(f.calls.some(call => call.startsWith('prompt')));
});

test('CHAT-08 opaque replay boundaries surround commit before ready publication', async t => {
	const stages: string[] = [];
	const markers: Extract<ProjectEvent, {type: 'turn'}>[] = [];
	const f = await fixture(t, true, event => {
		if (event.type === 'turn' && event.replay) {
			markers.push(event);
			stages.push(event.replay.phase);
		}
	});
	const thread = seed(f.project, {
		nanocoderSessionId: 'fake-session',
		runState: 'interrupted',
	});
	f.store.threads.save(thread);
	const apply = f.store.threadHistory.apply.bind(f.store.threadHistory);
	f.store.threadHistory.apply = (...args) => {
		const revision = apply(...args);
		stages.push('commit');
		return revision;
	};
	const unsubscribe = f.supervisor.subscribe(event => {
		if (
			event.type === 'thread' &&
			event.thread.id === thread.id &&
			event.thread.runState === 'ready'
		)
			stages.push('ready');
	});
	t.teardown(unsubscribe);
	const snapshot = await f.service.openThread({
		projectId: f.project.id,
		threadId: thread.id,
	});
	t.deepEqual(stages, ['begin', 'commit', 'complete', 'ready']);
	t.is(markers[0].replay?.epoch, markers[1].replay?.epoch);
	t.is(snapshot.replayEpoch, markers[0].replay?.epoch);
	t.false(snapshot.replaying);
	t.deepEqual(
		markers.map(event => event.events),
		[[], []],
	);
	t.true(markers.every(event => event.result === undefined));
});

test('CHAT-08 ready publication follows the committed replay prefix', async t => {
	const f = await fixture(t, true);
	const thread = seed(f.project, {
		nanocoderSessionId: 'fake-session',
		runState: 'interrupted',
	});
	f.store.threads.save(thread);
	const stages: string[] = [];
	const apply = f.store.threadHistory.apply.bind(f.store.threadHistory);
	f.store.threadHistory.apply = (...args) => {
		const revision = apply(...args);
		stages.push('commit');
		return revision;
	};
	const unsubscribe = f.supervisor.subscribe(event => {
		if (
			event.type === 'thread' &&
			event.thread.id === thread.id &&
			event.thread.runState === 'ready'
		)
			stages.push('ready');
	});
	t.teardown(unsubscribe);
	await f.service.openThread({projectId: f.project.id, threadId: thread.id});
	t.deepEqual(stages, ['commit', 'ready']);
});

for (const control of ['mode', 'config'] as const) {
	for (const action of [
		'archive',
		'remove',
		'rename-unsaved',
		'rename-saved',
		'delete-history',
	] as const) {
		test(`CHAT-17 ${action} refuses the shared ${control} owner before metadata consent or ACP work`, async t => {
			const f = await fixture(t, true);
			const thread = seed(f.project, {
				nanocoderSessionId: action === 'rename-unsaved' ? null : 'saved',
			});
			f.store.threads.save(thread);
			const held = deferred<void>();
			const owner = f.service.runProjectOperation(
				f.project.id,
				`set-${control}`,
				() => held.promise,
			);
			const request = {projectId: f.project.id, threadId: thread.id};
			try {
				const mutation =
					action === 'archive'
						? f.service.archiveThread({...request, archived: true})
						: action === 'remove'
							? f.service.removeThread(request)
							: action.startsWith('rename')
								? f.service.renameThread({...request, title: 'not saved'})
								: f.service.deleteThreadHistory(request);
				await t.throwsAsync(mutation, {instanceOf: IpcFailure, code: 'BUSY'});
				t.deepEqual(f.store.threads.get(f.project.id, thread.id), thread);
				t.deepEqual(f.calls, []);
			} finally {
				held.resolve();
				await owner;
			}
		});
	}
}

for (const action of ['archive', 'remove', 'rename-unsaved'] as const) {
	test(`CHAT-17 ${action} reserves before its synchronous metadata write and refuses reentrant controls`, async t => {
		const f = await fixture(t, true);
		const thread = seed(f.project, {nanocoderSessionId: null});
		f.store.threads.save(thread);
		let controlsStarted = 0;
		const attempts: Promise<string>[] = [];
		const compete = () => {
			attempts.push(
				f.service
					.runProjectOperation(f.project.id, 'set-mode', async () => {
						controlsStarted++;
					})
					.then(
						() => 'allowed',
						(error: IpcFailure) => error.code,
					),
			);
		};
		const save = f.store.threads.save.bind(f.store.threads);
		const remove = f.store.threads.remove.bind(f.store.threads);
		const setTitle = f.store.threads.setTitle.bind(f.store.threads);
		f.store.threads.save = value => {
			compete();
			return save(value);
		};
		f.store.threads.remove = (projectId, threadId) => {
			compete();
			return remove(projectId, threadId);
		};
		f.store.threads.setTitle = value => {
			compete();
			return setTitle(value);
		};
		const request = {projectId: f.project.id, threadId: thread.id};
		if (action === 'archive')
			await f.service.archiveThread({...request, archived: true});
		else if (action === 'remove')
			t.is(await f.service.removeThread(request), null);
		else await f.service.renameThread({...request, title: 'saved offline'});
		t.deepEqual(await Promise.all(attempts), ['BUSY']);
		t.is(controlsStarted, 0);
		t.deepEqual(f.calls, []);
	});
}

for (const action of ['archive', 'remove', 'rename-unsaved'] as const) {
	test(`CHAT-17 ${action} preserves untrusted offline metadata without preparing Nanocoder`, async t => {
		let hooks = 0;
		const f = await fixture(t, false, undefined, false, {
			validateBeforePrepare: () => {
				hooks++;
			},
			onSessionPrepared: () => {
				hooks++;
			},
		});
		const thread = seed(f.project, {nanocoderSessionId: null});
		f.store.threads.save(thread);
		renameSync(f.project.canonicalRoot, `${f.project.canonicalRoot}-offline`);
		const request = {projectId: f.project.id, threadId: thread.id};
		if (action === 'archive')
			t.is(
				(await f.service.archiveThread({...request, archived: true}))
					.archiveState,
				'archived',
			);
		else if (action === 'remove') {
			t.is(await f.service.removeThread(request), null);
			t.is(f.store.threads.get(f.project.id, thread.id), undefined);
		} else
			t.is(
				(await f.service.renameThread({...request, title: 'offline title'}))
					.title,
				'offline title',
			);
		t.deepEqual(f.calls, []);
		t.is(hooks, 0);
	});
}

for (const kind of ['high', 'low'] as const) {
	test(`CHAT-08 a new session acknowledgement refuses ${kind} surrogate before storing or prompting`, async t => {
		const events: ProjectEvent[] = [];
		let prepared = 0;
		const f = await fixture(
			t,
			true,
			event => {
				if (event.type === 'turn') events.push(event);
			},
			false,
			{
				onSessionPrepared: () => {
					prepared++;
				},
			},
		);
		const saved = await f.service.createThread({projectId: f.project.id});
		await f.supervisor.ensureProcess(f.project);
		const connection = f.supervisor.getConnection(f.project.id);
		connection.newSession = async () => ({
			id: kind === 'high' ? 'session\uD800' : 'session\uDFFF',
			mode: 'normal',
		});
		let prompts = 0;
		connection.prompt = async () => {
			prompts++;
			return {stopReason: 'end_turn'};
		};
		const error: unknown = await f.service
			.promptThread({
				projectId: f.project.id,
				threadId: saved.id,
				text: 'never sent',
			})
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		t.is(f.store.threads.get(f.project.id, saved.id)?.nanocoderSessionId, null);
		t.true(error instanceof IpcFailure);
		if (error instanceof IpcFailure) {
			t.is(error.code, 'VALIDATION');
			t.is(error.message, 'Invalid desktop metadata');
		}
		t.is(prompts, 0);
		t.is(prepared, 0);
		t.deepEqual(events, []);
		t.is(f.supervisor.getState(f.project.id).status, 'stopped');
	});
}

test('CHAT-17 cancellation retains the active prompt slot until the cancel acknowledgement settles', async t => {
	const f = await waitingThread(t);
	const entered = deferred<void>();
	const release = deferred<void>();
	const original = f.supervisor.cancel.bind(f.supervisor);
	f.supervisor.cancel = async (...args) => {
		await original(...args);
		entered.resolve();
		await release.promise;
	};
	const cancelling = f.service.cancelThread(f.target);
	try {
		await entered.promise;
		await t.throwsAsync(
			f.service.runProjectOperation(f.project.id, 'set-mode', async () => {}),
			{instanceOf: IpcFailure, code: 'BUSY'},
		);
		await t.throwsAsync(
			f.service.archiveThread({...f.target, archived: true}),
			{
				instanceOf: IpcFailure,
				code: 'BUSY',
			},
		);
		await t.throwsAsync(f.service.removeThread(f.target), {
			instanceOf: IpcFailure,
			code: 'BUSY',
		});
	} finally {
		release.resolve();
		await cancelling;
	}
	t.deepEqual(await f.turn, {stopReason: 'cancelled'});
});

for (const upstream of [false, true]) {
	test(`CHAT-17 ${upstream ? 'history deletion' : 'desktop removal'} invalidates its exact scope without losing completed removal`, async t => {
		const f = await fixture(t, true);
		const thread = seed(f.project);
		f.store.threads.save(thread);
		const invalidated: string[] = [];
		const invalidate = f.service.projectOperations.invalidateThread;
		f.service.projectOperations.invalidateThread = (
			projectId,
			threadId,
			stop,
		) => {
			invalidated.push(`${projectId}/${threadId}`);
			invalidate(projectId, threadId, stop);
		};
		const request = {projectId: f.project.id, threadId: thread.id};
		if (upstream) {
			f.confirmDeletion(async () => true);
			await f.supervisor.ensureProcess(f.project);
			f.supervisor.getConnection(f.project.id).deleteSession = async () => {};
			t.deepEqual(await f.service.deleteThreadHistory(request), {
				status: 'deleted',
			});
		} else t.is(await f.service.removeThread(request), null);
		t.deepEqual(invalidated, [`${f.project.id}/${thread.id}`]);
		t.is(f.store.threads.get(f.project.id, thread.id), undefined);
		t.false(f.service.projectOperations.isBusy(f.project.id));
	});
}

test('CHAT-17 a pending history dialog cannot block active permission and cancel exceptions in another project', async t => {
	const f = await waitingThread(t, true);
	const otherRoot = path.join(f.root, 'other');
	mkdirSync(otherRoot);
	const other = {
		...f.project,
		id: randomUUID(),
		canonicalRoot: otherRoot,
		sessionCwd: otherRoot,
		trusted: false,
	};
	f.store.projects.save(other);
	const thread = seed(other);
	f.store.threads.save(thread);
	const entered = deferred<void>();
	const answer = deferred<boolean>();
	f.confirmDeletion(() => {
		entered.resolve();
		return answer.promise;
	});
	const deletion = f.service.deleteThreadHistory({
		projectId: other.id,
		threadId: thread.id,
	});
	try {
		await entered.promise;
		for (const attempt of [
			() => f.service.deleteThreadHistory(f.target),
			() => f.service.archiveThread({...f.target, archived: true}),
			() => f.service.removeThread(f.target),
		])
			await t.throwsAsync(attempt(), {instanceOf: IpcFailure, code: 'BUSY'});
		t.is(
			await f.service.answerThreadPermission({
				...f.target,
				requestId: f.requests[0].id,
				optionId: 'allow',
			}),
			null,
		);
		t.is(await f.service.cancelThread(f.target), null);
		t.deepEqual(await f.turn, {stopReason: 'cancelled'});
		t.deepEqual(f.calls, ['launch', 'confirm-delete']);
	} finally {
		answer.resolve(false);
		await deletion;
	}
	t.deepEqual(await deletion, {status: 'cancelled'});
});

test('CHAT-17 declining history deletion keeps cancellation truthful after an automatic title changes', async t => {
	const f = await fixture(t);
	const thread = seed(f.project);
	f.store.threads.save(thread);
	f.confirmDeletion(async () => {
		f.store.threads.setTitle({
			projectId: f.project.id,
			threadId: thread.id,
			title: 'updated while the dialog was open',
			manuallySet: false,
		});
		return false;
	});
	t.deepEqual(
		await f.service.deleteThreadHistory({
			projectId: f.project.id,
			threadId: thread.id,
		}),
		{status: 'cancelled'},
	);
	t.deepEqual(f.calls, ['confirm-delete']);
});

test('CHAT-17 preparation cancellation holds the slot through both the pending hook and child-stop settlement', async t => {
	const entered = deferred<void>();
	const releaseHook = deferred<void>();
	const f = await fixture(t, true, undefined, false, {
		beforeFirstPrompt: async () => {
			entered.resolve();
			await releaseHook.promise;
		},
	});
	const thread = await f.service.createThread({projectId: f.project.id});
	const target = {projectId: f.project.id, threadId: thread.id};
	const turn = f.service.promptThread({...target, text: 'not sent'});
	void turn.catch(() => undefined);
	await entered.promise;
	const stopped = deferred<void>();
	const releaseStop = deferred<void>();
	const stop = f.supervisor.stop.bind(f.supervisor);
	f.supervisor.stop = async id => {
		const state = await stop(id);
		stopped.resolve();
		await releaseStop.promise;
		return state;
	};
	const cancellation = f.service.cancelThread(target);
	try {
		await stopped.promise;
		for (const attempt of [
			() =>
				f.service.runProjectOperation(
					f.project.id,
					'set-config',
					async () => {},
				),
			() => f.service.archiveThread({...target, archived: true}),
			() => f.service.removeThread(target),
		])
			await t.throwsAsync(attempt(), {instanceOf: IpcFailure, code: 'BUSY'});
	} finally {
		releaseHook.resolve();
		releaseStop.resolve();
		await cancellation;
		f.supervisor.stop = stop;
	}
	t.deepEqual(await turn, {stopReason: 'cancelled'});
});

test('CHAT-17 a control lease cannot stand in for an active permission or cancellation owner', async t => {
	const f = await fixture(t, true);
	const thread = seed(f.project, {nanocoderSessionId: 'saved'});
	f.store.threads.save(thread);
	const request = {projectId: f.project.id, threadId: thread.id};
	const original = f.supervisor.getState.bind(f.supervisor);
	f.supervisor.getState = id => ({...original(id), activeThreadId: 'saved'});
	let answered = 0;
	let cancelled = 0;
	f.supervisor.answerPermission = () => {
		answered++;
		return true;
	};
	f.supervisor.cancel = async () => {
		cancelled++;
	};
	await f.service.runProjectOperation(
		f.project.id,
		'set-mode',
		async () => {
			await t.throwsAsync(
				f.service.answerThreadPermission({
					...request,
					requestId: 'offered',
					optionId: 'allow',
				}),
				{instanceOf: IpcFailure, code: 'DENIED'},
			);
			t.is(await f.service.cancelThread(request), null);
		},
		{threadId: thread.id},
	);
	t.is(answered, 0);
	t.is(cancelled, 0);
	t.deepEqual(f.calls, []);
});

for (const change of ['epoch', 'connection'] as const) {
	test(`CHAT-17 a changed ${change} cannot grant an active permission`, async t => {
		const f = await waitingThread(t);
		const original = f.supervisor.getConnection.bind(f.supervisor);
		if (change === 'epoch')
			f.service.projectOperations.invalidate(f.project.id);
		else {
			const replacement = {...f.connection};
			f.supervisor.getConnection = () => replacement;
		}
		let answered = 0;
		const answer = f.supervisor.answerPermission.bind(f.supervisor);
		f.supervisor.answerPermission = (...args) => {
			answered++;
			return answer(...args);
		};
		try {
			await t.throwsAsync(
				f.service.answerThreadPermission({
					...f.target,
					requestId: f.requests[0].id,
					optionId: 'allow',
				}),
				{instanceOf: IpcFailure, code: 'AGENT_UNAVAILABLE'},
			);
			t.is(answered, 0);
		} finally {
			f.supervisor.getConnection = original;
		}
	});
}

test('CHAT-08 a well-formed Unicode new acknowledgement is saved and prompted without changing its identity', async t => {
	const f = await fixture(t, true);
	const saved = await f.service.createThread({projectId: f.project.id});
	await f.supervisor.ensureProcess(f.project);
	const connection = f.supervisor.getConnection(f.project.id);
	const sessionId = 'session/é/\u{1F680}';
	connection.newSession = async () => ({id: sessionId, mode: 'normal'});
	connection.getSessionOffers = id =>
		id === sessionId
			? {offeredModes: ['normal'], configOptions: []}
			: undefined;
	let prompts = 0;
	connection.prompt = async id => {
		prompts++;
		t.is(id, sessionId);
		t.is(
			f.store.threads.get(f.project.id, saved.id)?.nanocoderSessionId,
			sessionId,
		);
		return {stopReason: 'end_turn'};
	};
	await f.service.promptThread({
		projectId: f.project.id,
		threadId: saved.id,
		text: 'fixture prompt',
	});
	t.is(prompts, 1);
	t.is(
		f.store.threads.get(f.project.id, saved.id)?.nanocoderSessionId,
		sessionId,
	);
});

for (const path of ['open', 'recovery'] as const) {
	for (const kind of ['high', 'low', 'mismatched'] as const) {
		test(`CHAT-08 ${path} refuses a ${kind} resumed acknowledgement before mode history or hooks change`, async t => {
			let prepared = 0;
			const f = await fixture(t, true, undefined, false, {
				onSessionPrepared: () => {
					prepared++;
				},
			});
			const saved = seed(f.project, {nanocoderSessionId: 'fake-session'});
			f.store.threads.save(saved);
			const request = {projectId: f.project.id, threadId: saved.id};
			await f.supervisor.ensureProcess(f.project);
			if (path === 'recovery') await f.service.openThread(request);
			const before = await f.service.getThreadSnapshot(request);
			const beforePrepared = prepared;
			const connection = f.supervisor.getConnection(f.project.id);
			const id = {
				high: 'session\uD800',
				low: 'session\uDFFF',
				mismatched: 'different-session',
			}[kind];
			connection.resumeSession = async () => ({
				session: {id, mode: 'plan'},
				history: [{type: 'text', text: 'refused replay fixture'}],
			});
			await t.throwsAsync(
				path === 'open'
					? f.service.openThread(request)
					: f.service.restore(
							f.project,
							connection,
							new AbortController().signal,
						),
				{code: kind === 'mismatched' ? 'DENIED' : 'VALIDATION'},
			);
			const after = await f.service.getThreadSnapshot(request);
			t.is(after.thread.nanocoderSessionId, 'fake-session');
			t.is(after.thread.mode, before.thread.mode);
			t.deepEqual(after.events, before.events);
			t.is(prepared, beforePrepared);
		});
	}
	test(`CHAT-08 ${path} keeps a well-formed Unicode resumed identity exact`, async t => {
		const f = await fixture(t, true);
		const sessionId = 'session/é/\u{1F680}';
		const saved = seed(f.project, {nanocoderSessionId: sessionId});
		f.store.threads.save(saved);
		const request = {projectId: f.project.id, threadId: saved.id};
		await f.supervisor.ensureProcess(f.project);
		const connection = f.supervisor.getConnection(f.project.id);
		connection.getSessionOffers = id =>
			id === sessionId
				? {offeredModes: ['normal', 'plan'], configOptions: []}
				: undefined;
		connection.resumeSession = async id => {
			t.is(id, sessionId);
			return {session: {id, mode: 'plan'}, history: []};
		};
		t.is((await f.service.openThread(request)).thread.runState, 'ready');
		if (path === 'recovery')
			await f.service.restore(
				f.project,
				connection,
				new AbortController().signal,
			);
		t.is((await f.service.getThreadSnapshot(request)).thread.runState, 'ready');
		t.is(
			f.store.threads.get(f.project.id, saved.id)?.nanocoderSessionId,
			sessionId,
		);
	});
}

test('SUB-05 live identities commit before user and tool publication without retaining task content', async t => {
	let inspect: ((event: ProjectEvent) => void) | undefined;
	const f = await fixture(t, true, event => inspect?.(event));
	const thread = await f.service.createThread({projectId: f.project.id});
	const request = {projectId: f.project.id, threadId: thread.id};
	const publishedExecutionIds: string[] = [];
	const publishedTurnCounts: number[] = [];
	const publishedExecutionCounts: number[] = [];
	let publishedUsers = 0;
	inspect = event => {
		if (event.type !== 'turn' || event.threadId !== thread.id) return;
		const sessionId = f.store.threads.get(
			f.project.id,
			thread.id,
		)?.nanocoderSessionId;
		if (!sessionId) throw new Error('The published turn has no saved session');
		const history = f.store.threadHistory.read({
			...request,
			sessionId,
		});
		if (event.events.some(item => item.type === 'user')) {
			publishedUsers++;
			publishedTurnCounts.push(history?.turns.length ?? 0);
		}
		if (!event.events.some(item => item.type === 'tool')) return;
		publishedExecutionCounts.push(history?.executions.length ?? 0);
		const rows = f.store.agentRuns.list(f.project.id, thread.id);
		if (rows[0]?.id !== history?.executions[0]?.id)
			throw new Error(
				'The published execution does not match the committed run',
			);
		if (rows[0]) publishedExecutionIds.push(rows[0].id);
	};
	await f.supervisor.ensureProcess(f.project);
	const connection = f.supervisor.getConnection(f.project.id);
	connection.prompt = async sessionId => {
		f.notifyUpdate({
			sessionId,
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'opaque/live-delegation',
				kind: 'think',
				title: 'private delegated task',
				status: 'pending',
				rawInput: {subagent_type: 'explore', prompt: 'private arguments'},
			},
		});
		for (const status of ['in_progress', 'failed'] as const)
			f.notifyUpdate({
				sessionId,
				update: {
					sessionUpdate: 'tool_call_update',
					toolCallId: 'opaque/live-delegation',
					title: 'private progress',
					status,
				},
			});
		return {stopReason: 'end_turn'};
	};
	await f.service.promptThread({...request, text: 'private accepted prompt'});
	const scope = {...request, sessionId: 'fake-session'};
	const history = f.store.threadHistory.read(scope);
	t.is(publishedUsers, 1);
	t.deepEqual(publishedTurnCounts, [1]);
	t.deepEqual(publishedExecutionCounts, [1, 1, 1]);
	t.is(publishedExecutionIds.length, 3);
	t.is(new Set(publishedExecutionIds).size, 1);
	t.like(history, {
		complete: true,
		turns: [{outcome: 'completed'}],
		executions: [{toolCallId: 'opaque/live-delegation', outcome: 'failed'}],
	});
	t.is(f.store.agentRuns.list(f.project.id, thread.id)[0]?.status, 'failed');
	t.false(JSON.stringify(history).includes('private'));
	const snapshot = await f.service.getThreadSnapshot(request);
	t.true((history?.sequence ?? -1) > snapshot.sequence);
	for (const privateField of [
		'firstSlot',
		'highWaterMark',
		'executionId',
		'turnId',
	])
		t.false(JSON.stringify(snapshot).includes(`"${privateField}":`));
});

test('SUB-05 later live turns reuse opaque tool IDs but receive different execution UUIDs', async t => {
	const f = await fixture(t, true);
	const thread = await f.service.createThread({projectId: f.project.id});
	const request = {projectId: f.project.id, threadId: thread.id};
	await f.supervisor.ensureProcess(f.project);
	const connection = f.supervisor.getConnection(f.project.id);
	connection.prompt = async sessionId => {
		f.notifyUpdate({
			sessionId,
			update: {
				sessionUpdate: 'tool_call',
				toolCallId: 'reused-provider-id',
				kind: 'think',
				status: 'pending',
				title: 'delegation',
				rawInput: {subagent_type: 'explore'},
			},
		});
		f.notifyUpdate({
			sessionId,
			update: {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'reused-provider-id',
				status: 'completed',
			},
		});
		return {stopReason: 'end_turn'};
	};
	await f.service.promptThread({...request, text: 'first private turn'});
	const first = f.store.threadHistory.read({
		...request,
		sessionId: 'fake-session',
	});
	await f.service.promptThread({...request, text: 'second private turn'});
	const second = f.store.threadHistory.read({
		...request,
		sessionId: 'fake-session',
	});
	t.is(first?.executions.length, 1);
	t.is(second?.turns.length, 2);
	t.is(second?.executions.length, 2);
	t.is(second?.executions[0].id, first?.executions[0].id);
	t.not(second?.executions[0].id, second?.executions[1].id);
	t.not(second?.executions[0].turnId, second?.executions[1].turnId);
	t.deepEqual(
		second?.executions.map(row => row.toolCallId),
		['reused-provider-id', 'reused-provider-id'],
	);
	t.deepEqual(
		f.store.agentRuns.list(f.project.id, thread.id).map(row => row.status),
		['completed', 'completed'],
	);
});

test('SUB-05 live publication splits 10001 updates through the same private slot allocator without overlap or loss', async t => {
	const batches: Array<Extract<ProjectEvent, {type: 'turn'}>> = [];
	const f = await fixture(t, true, event => {
		if (event.type === 'turn') batches.push(event);
	});
	const thread = await f.service.createThread({projectId: f.project.id});
	const request = {projectId: f.project.id, threadId: thread.id};
	await f.supervisor.ensureProcess(f.project);
	f.supervisor.getConnection(f.project.id).prompt = async sessionId => {
		f.notifyBatch(
			sessionId,
			Array.from({length: 10001}, (_, index) => ({
				type: 'text' as const,
				text: `piece-${index}`,
			})),
		);
		return {stopReason: 'end_turn'};
	};
	await f.service.promptThread({...request, text: 'private prompt'});
	t.deepEqual(
		batches.map(batch => batch.events.length),
		[1, 10000, 1, 0],
	);
	t.deepEqual(
		batches.map(batch => batch.sequence),
		[1, 2, 3, 4],
	);
	const snapshot = await f.service.getThreadSnapshot(request);
	t.is(snapshot.events.length, 10002);
	t.true(
		snapshot.events
			.slice(1)
			.every(
				(event, index) =>
					event.type === 'text' && event.text === `piece-${index}`,
			),
	);
	t.true(
		(f.store.threadHistory.read({...request, sessionId: 'fake-session'})
			?.sequence ?? -1) >
			snapshot.sequence * 10001 - 1,
	);
});

test('SUB-05 live approval-only completion never becomes execution success', async t => {
	const f = await fixture(t, true);
	const thread = await f.service.createThread({projectId: f.project.id});
	const request = {projectId: f.project.id, threadId: thread.id};
	await f.supervisor.ensureProcess(f.project);
	f.supervisor.getConnection(f.project.id).prompt = async sessionId => {
		f.notifyBatch(sessionId, [
			{
				type: 'tool',
				id: 'approval-root',
				status: 'pending',
				delegation: {role: 'explore', history: false},
			},
		]);
		f.notifyBatch(sessionId, [
			{
				type: 'tool',
				id: 'approval-root',
				status: 'completed',
				approvalOnly: true,
			},
		]);
		t.is(f.store.agentRuns.list(f.project.id, thread.id)[0]?.status, 'pending');
		t.is(
			f.store.threadHistory.read({...request, sessionId})?.executions[0]
				.outcome,
			'unknown',
		);
		return {stopReason: 'end_turn'};
	};
	await f.service.promptThread({...request, text: 'private prompt'});
	t.is(f.store.agentRuns.list(f.project.id, thread.id)[0]?.status, 'unknown');
	t.is(
		f.store.threadHistory.read({...request, sessionId: 'fake-session'})
			?.executions[0].outcome,
		'unknown',
	);
});

test('SUB-05 a failed live tool commit publishes no partial tool and cancels the exact owner without throwing from its notification', async t => {
	const events: TurnEvent[] = [];
	const f = await fixture(t, true, event => {
		if (event.type === 'turn') events.push(...event.events);
	});
	const thread = await f.service.createThread({projectId: f.project.id});
	const request = {projectId: f.project.id, threadId: thread.id};
	await f.supervisor.ensureProcess(f.project);
	const apply = f.store.threadHistory.apply;
	let failed = false;
	f.store.threadHistory.apply = (scope, patch) => {
		if (patch.executions.length && !failed) {
			failed = true;
			throw new IpcFailure('UNAVAILABLE', 'The fixture metadata commit failed');
		}
		return apply(scope, patch);
	};
	f.supervisor.getConnection(f.project.id).prompt = async sessionId => {
		t.notThrows(() =>
			f.notifyBatch(sessionId, [
				{
					type: 'tool',
					id: 'uncommitted-tool',
					status: 'in_progress',
					delegation: {role: 'explore', history: false},
				},
			]),
		);
		return {stopReason: 'end_turn'};
	};
	await t.throwsAsync(
		f.service.promptThread({...request, text: 'private prompt'}),
		{code: 'UNAVAILABLE'},
	);
	t.true(failed);
	t.false(events.some(event => event.type === 'tool'));
	t.deepEqual(f.store.agentRuns.list(f.project.id, thread.id), []);
	const history = f.store.threadHistory.read({
		...request,
		sessionId: 'fake-session',
	});
	t.is(history?.turns[0].outcome, 'failed');
	t.is(history?.complete, false);
	t.is((await f.service.getThreadSnapshot(request)).result?.ok, false);
});

test('SUB-05 live producer refuses replay-marked ordinary tools rather than accepting synthetic completion', async t => {
	const f = await fixture(t, true);
	const thread = await f.service.createThread({projectId: f.project.id});
	const request = {projectId: f.project.id, threadId: thread.id};
	await f.supervisor.ensureProcess(f.project);
	f.supervisor.getConnection(f.project.id).prompt = async sessionId => {
		f.notifyBatch(sessionId, [
			{
				type: 'tool',
				id: 'synthetic-tool',
				status: 'completed',
				history: {outcome: 'unknown'},
			},
		]);
		return {stopReason: 'end_turn'};
	};
	await t.throwsAsync(
		f.service.promptThread({...request, text: 'private prompt'}),
		{code: 'DENIED'},
	);
	t.deepEqual(
		f.store.threadHistory.read({...request, sessionId: 'fake-session'})
			?.executions,
		[],
	);
	t.deepEqual(f.store.agentRuns.list(f.project.id, thread.id), []);
});

test('SUB-05 a refused live terminal commit keeps SQL and observer state pending and never publishes success', async t => {
	const f = await fixture(t, true);
	const thread = await f.service.createThread({projectId: f.project.id});
	const request = {projectId: f.project.id, threadId: thread.id};
	await f.supervisor.ensureProcess(f.project);
	f.supervisor.getConnection(f.project.id).prompt = async sessionId => {
		f.notifyBatch(sessionId, [
			{
				type: 'tool',
				id: 'pending-root',
				status: 'in_progress',
				delegation: {role: 'explore', history: false},
			},
		]);
		return {stopReason: 'end_turn'};
	};
	const apply = f.store.threadHistory.apply;
	f.store.threadHistory.apply = (scope, patch) => {
		if (patch.turns.some(row => row.outcome !== 'unknown'))
			throw new IpcFailure('UNAVAILABLE', 'The fixture terminal commit failed');
		return apply(scope, patch);
	};
	await t.throwsAsync(
		f.service.promptThread({...request, text: 'private prompt'}),
		{code: 'UNAVAILABLE'},
	);
	t.is(
		f.store.threadHistory.read({...request, sessionId: 'fake-session'})
			?.turns[0].outcome,
		'unknown',
	);
	t.is(f.store.agentRuns.list(f.project.id, thread.id)[0]?.status, 'running');
	const snapshot = await f.service.getThreadSnapshot(request);
	t.is(snapshot.result?.ok, false);
	t.is(snapshot.thread.runState, 'failed');
});

test('SUB-05 a recreated owner replays live committed UUIDs and retains a genuinely failed outcome', async t => {
	const f = await fixture(t, true);
	const thread = await f.service.createThread({projectId: f.project.id});
	const request = {projectId: f.project.id, threadId: thread.id};
	await f.supervisor.ensureProcess(f.project);
	const connection = f.supervisor.getConnection(f.project.id);
	connection.prompt = async sessionId => {
		f.notifyBatch(sessionId, [
			{
				type: 'tool',
				id: 'failed-live-root',
				status: 'failed',
				delegation: {role: 'explore', history: false},
			},
		]);
		return {stopReason: 'end_turn'};
	};
	await f.service.promptThread({
		...request,
		text: 'private persisted elsewhere',
	});
	const scope = {...request, sessionId: 'fake-session'};
	const before = f.store.threadHistory.read(scope);
	f.service.dispose();
	connection.resumeSession = async id => ({
		session: {id, mode: 'normal'},
		history: [
			{type: 'user', text: 'private persisted elsewhere'},
			{
				type: 'tool',
				id: 'failed-live-root',
				status: 'completed',
				delegation: {role: 'explore', history: true},
			},
		],
	});
	const restarted = createThreadService({
		store: f.store,
		supervisor: f.supervisor,
	});
	t.teardown(() => restarted.dispose());
	const replayed = await restarted.openThread(request);
	const after = f.store.threadHistory.read(scope);
	t.deepEqual(after?.turns, before?.turns);
	t.deepEqual(after?.executions, before?.executions);
	t.like(replayed.events[1], {
		type: 'tool',
		id: 'failed-live-root',
		status: 'failed',
		history: {outcome: 'failed'},
	});
	t.is(f.store.agentRuns.list(f.project.id, thread.id).length, 1);
	t.is(f.store.agentRuns.list(f.project.id, thread.id)[0]?.status, 'failed');
	t.true((after?.generation ?? -1) > (before?.generation ?? -1));
	t.true((after?.sequence ?? -1) > (before?.sequence ?? -1));
});

test('SUB-05 late tool notifications after the owning turn ends cannot create new identities or cards', async t => {
	const f = await fixture(t, true);
	const thread = await f.service.createThread({projectId: f.project.id});
	const request = {projectId: f.project.id, threadId: thread.id};
	await f.supervisor.ensureProcess(f.project);
	f.supervisor.getConnection(f.project.id).prompt = async () => ({
		stopReason: 'end_turn',
	});
	await f.service.promptThread({...request, text: 'private prompt'});
	const before = f.store.threadHistory.read({
		...request,
		sessionId: 'fake-session',
	});
	const snapshot = await f.service.getThreadSnapshot(request);
	f.notifyBatch('fake-session', [
		{
			type: 'tool',
			id: 'late-tool',
			status: 'completed',
			delegation: {role: 'explore', history: false},
		},
	]);
	t.deepEqual(
		f.store.threadHistory.read({...request, sessionId: 'fake-session'}),
		before,
	);
	t.deepEqual(await f.service.getThreadSnapshot(request), snapshot);
	t.deepEqual(f.store.agentRuns.list(f.project.id, thread.id), []);
});

for (const outcome of ['failed', 'cancelled'] as const) {
	test(`SUB-05 explicit owning ${outcome} metadata is not replaced by a normal prompt stop`, async t => {
		const f = await fixture(t, true);
		const thread = await f.service.createThread({projectId: f.project.id});
		const request = {projectId: f.project.id, threadId: thread.id};
		await f.supervisor.ensureProcess(f.project);
		f.supervisor.getConnection(f.project.id).prompt = async sessionId => {
			f.notifyBatch(sessionId, [
				{
					type: 'tool',
					id: 'unfinished-root',
					status: 'in_progress',
					delegation: {role: 'explore', history: false},
				},
			]);
			return {stopReason: 'end_turn', metadata: {outcome}};
		};
		await f.service.promptThread({...request, text: 'private prompt'});
		const expected = outcome === 'cancelled' ? 'interrupted' : 'failed';
		const history = f.store.threadHistory.read({
			...request,
			sessionId: 'fake-session',
		});
		t.is(history?.turns[0].outcome, expected);
		t.is(history?.executions[0].outcome, expected);
		t.is(f.store.agentRuns.list(f.project.id, thread.id)[0]?.status, expected);
		t.is(
			(await f.service.getThreadSnapshot(request)).thread.runState,
			expected,
		);
	});
}

test('SUB-05 live cancellation leaves already completed executions unchanged', async t => {
	const f = await fixture(t, true);
	const thread = await f.service.createThread({projectId: f.project.id});
	const request = {projectId: f.project.id, threadId: thread.id};
	await f.supervisor.ensureProcess(f.project);
	f.supervisor.getConnection(f.project.id).prompt = async sessionId => {
		for (const [toolCallId, status] of [
			['finished', 'completed'],
			['unfinished', 'in_progress'],
		] as const)
			f.notifyUpdate({
				sessionId,
				update: {
					sessionUpdate: 'tool_call',
					toolCallId,
					kind: 'think',
					status,
					title: 'delegation',
					rawInput: {subagent_type: 'explore'},
				},
			});
		return {stopReason: 'cancelled'};
	};
	await f.service.promptThread({...request, text: 'private prompt'});
	t.deepEqual(
		f.store.threadHistory
			.read({...request, sessionId: 'fake-session'})
			?.executions.map(row => row.outcome),
		['completed', 'interrupted'],
	);
});

for (const outcome of ['cancelled', 'failed'] as const) {
	test(`SUB-05 owning live ${outcome} terminal settles unfinished delegation metadata`, async t => {
		const f = await fixture(t, true);
		const thread = await f.service.createThread({projectId: f.project.id});
		const request = {projectId: f.project.id, threadId: thread.id};
		await f.supervisor.ensureProcess(f.project);
		const connection = f.supervisor.getConnection(f.project.id);
		connection.prompt = async sessionId => {
			f.notifyUpdate({
				sessionId,
				update: {
					sessionUpdate: 'tool_call',
					toolCallId: 'unfinished-delegation',
					kind: 'think',
					status: 'in_progress',
					title: 'private unfinished delegation',
					rawInput: {subagent_type: 'explore'},
				},
			});
			if (outcome === 'failed')
				throw new NanocoderFailure(
					'AGENT_UNAVAILABLE',
					'The fixture turn failed',
				);
			return {stopReason: 'cancelled'};
		};
		const result = f.service.promptThread({...request, text: 'private prompt'});
		if (outcome === 'failed')
			await t.throwsAsync(result, {code: 'AGENT_UNAVAILABLE'});
		else t.deepEqual(await result, {stopReason: 'cancelled'});
		const expected = outcome === 'cancelled' ? 'interrupted' : 'failed';
		const history = f.store.threadHistory.read({
			...request,
			sessionId: 'fake-session',
		});
		t.like(history, {
			turns: [{outcome: expected}],
			executions: [{outcome: expected}],
		});
		t.is(f.store.agentRuns.list(f.project.id, thread.id)[0]?.status, expected);
	});
}

test('SUB-05 successful resume persists structural IDs before exposing synthetic tools', async t => {
	const packets: ProjectEvent[] = [];
	const f = await fixture(t, true, event => packets.push(event));
	const thread = seed(f.project, {nanocoderSessionId: 'mapped-history'});
	f.store.threads.save(thread);
	await f.supervisor.ensureProcess(f.project);
	const connection = f.supervisor.getConnection(f.project.id);
	connection.getSessionOffers = id =>
		id === 'mapped-history'
			? {offeredModes: ['normal'], configOptions: []}
			: undefined;
	connection.resumeSession = async id => ({
		session: {id, mode: 'normal'},
		history: [
			{type: 'user', text: 'synthetic private prompt'},
			{
				type: 'tool',
				id: 'opaque/delegation',
				title: 'synthetic private task',
				status: 'completed',
				delegation: {role: 'explore', history: true},
			},
		],
	});
	const opened = await f.service.openThread({
		projectId: f.project.id,
		threadId: thread.id,
	});
	t.is(opened.thread.runState, 'ready');
	const history = f.store.threadHistory.read({
		projectId: f.project.id,
		threadId: thread.id,
		sessionId: 'mapped-history',
	});
	t.truthy(history, 'successful replay must commit its structural ledger');
	t.is(history?.turns.length, 1);
	t.is(history?.executions.length, 1);
	t.is(history?.executions[0].toolCallId, 'opaque/delegation');
	t.is(opened.sequence, 3);
	assertReplayMarkers(
		t,
		packets,
		thread,
		[
			['begin', 1],
			['complete', 3],
		],
		opened.replayEpoch,
	);
	t.true((history?.sequence ?? -1) > opened.sequence);
	for (const privateField of [
		'firstSlot',
		'highWaterMark',
		'executionId',
		'turnId',
	])
		t.false(JSON.stringify(opened).includes(`"${privateField}":`));
	t.deepEqual(f.store.agentRuns.list(f.project.id, thread.id), [
		{
			id: history?.executions[0].id,
			threadId: thread.id,
			parentRunId: null,
			nanocoderChildId: null,
			role: 'explore',
			status: 'unknown',
		},
	]);
});

test('SUB-05 recreated ThreadService reuses committed UUIDs and recovers the private replay slot base', async t => {
	const f = await fixture(t, true);
	const thread = seed(f.project, {nanocoderSessionId: 'recreated-history'});
	f.store.threads.save(thread);
	await f.supervisor.ensureProcess(f.project);
	const connection = f.supervisor.getConnection(f.project.id);
	let resumes = 0;
	connection.getSessionOffers = id =>
		id === 'recreated-history'
			? {offeredModes: ['normal'], configOptions: []}
			: undefined;
	connection.resumeSession = async id => {
		t.is(id, 'recreated-history');
		resumes++;
		return {
			session: {id, mode: 'normal'},
			history: [
				{type: 'user', text: 'private restart fixture'},
				{
					type: 'tool',
					id: 'stable/restarted-call',
					status: 'completed',
					delegation: {role: 'explore', history: true},
				},
			],
		};
	};
	const request = {projectId: f.project.id, threadId: thread.id};
	const scope = {...request, sessionId: 'recreated-history'};
	const first = await f.service.openThread(request);
	const before = f.store.threadHistory.read(scope);
	f.service.dispose();
	const packets: ProjectEvent[] = [];
	const restarted = createThreadService({
		store: f.store,
		supervisor: f.supervisor,
		onEvent: event => packets.push(event),
	});
	t.teardown(() => restarted.dispose());
	const second = await restarted.openThread(request);
	const after = f.store.threadHistory.read(scope);
	t.is(resumes, 2);
	t.truthy(before);
	const floor = Math.floor((before?.sequence ?? 0) / 10_001);
	t.is(second.sequence, floor + 3);
	assertReplayMarkers(
		t,
		packets,
		second.thread,
		[
			['begin', floor + 1],
			['complete', floor + 3],
		],
		second.replayEpoch,
	);
	t.true((after?.sequence ?? -1) > (before?.sequence ?? -1));
	t.deepEqual(after?.turns, before?.turns);
	t.deepEqual(after?.executions, before?.executions);
	t.is(f.store.agentRuns.list(f.project.id, thread.id).length, 1);
	t.deepEqual(second.events, first.events);
});

test('SUB-05 replayed synthetic completion is inert and not a reported success', async t => {
	const f = await fixture(t, true);
	const thread = seed(f.project, {nanocoderSessionId: 'inert-history'});
	f.store.threads.save(thread);
	await f.supervisor.ensureProcess(f.project);
	const connection = f.supervisor.getConnection(f.project.id);
	connection.getSessionOffers = id =>
		id === 'inert-history'
			? {offeredModes: ['normal'], configOptions: []}
			: undefined;
	connection.resumeSession = async id => ({
		session: {id, mode: 'normal'},
		history: [
			{type: 'user', text: 'synthetic fixture'},
			{type: 'tool', id: 'opaque/tool', status: 'completed'},
		],
	});
	const opened = await f.service.openThread({
		projectId: f.project.id,
		threadId: thread.id,
	});
	t.like(
		opened.events.find(event => event.type === 'tool'),
		{
			history: {outcome: 'unknown'},
		},
	);
});

test('SUB-05 failed staged replay preserves the old SQL and readable prefix then retries the same saved ID', async t => {
	const f = await fixture(t, true);
	const thread = seed(f.project, {nanocoderSessionId: 'atomic-history'});
	f.store.threads.save(thread);
	await f.supervisor.ensureProcess(f.project);
	const connection = f.supervisor.getConnection(f.project.id);
	let ready = true;
	let resumes = 0;
	connection.getSessionOffers = id =>
		ready && id === 'atomic-history'
			? {offeredModes: ['normal'], configOptions: []}
			: undefined;
	connection.resumeSession = async id => {
		t.is(id, 'atomic-history');
		resumes++;
		ready = true;
		return {
			session: {id, mode: 'normal'},
			history: [
				{type: 'user', text: `private replay ${resumes}`},
				{
					type: 'tool',
					id: 'stable/tool',
					status: 'completed',
					delegation: {role: 'explore', history: true},
				},
			],
		};
	};
	const request = {projectId: f.project.id, threadId: thread.id};
	const initial = await f.service.openThread(request);
	const scope = {...request, sessionId: 'atomic-history'};
	const history = f.store.threadHistory.read(scope);
	const rows = f.store.agentRuns.list(f.project.id, thread.id);
	const apply = f.store.threadHistory.apply;
	let staged = 0;
	f.store.threadHistory.apply = (_scope, patch) => {
		staged = patch.agentRuns.length;
		throw new IpcFailure('INTERNAL', 'Synthetic identity commit failure');
	};
	ready = false;
	const failed = await f.service.openThread(request);
	t.deepEqual(failed.events, initial.events);
	t.is(failed.thread.nanocoderSessionId, 'atomic-history');
	t.is(staged, 1);
	t.deepEqual(f.store.threadHistory.read(scope), history);
	t.deepEqual(f.store.agentRuns.list(f.project.id, thread.id), rows);
	f.store.threadHistory.apply = apply;
	const retried = await f.service.openThread(request);
	t.is(retried.thread.runState, 'ready');
	t.is(resumes, 3);
	t.is(retried.thread.nanocoderSessionId, 'atomic-history');
	t.like(retried.events[0], {type: 'user', text: 'private replay 3'});
	t.deepEqual(
		f.store.threadHistory.read(scope)?.executions.map(row => row.id),
		history?.executions.map(row => row.id),
	);
});

test('SUB-05 failed structural read clears cached preparation before retrying the same history', async t => {
	const f = await fixture(t, true);
	const thread = seed(f.project, {nanocoderSessionId: 'fake-session'});
	f.store.threads.save(thread);
	const request = {projectId: f.project.id, threadId: thread.id};
	const initial = await f.service.openThread(request);
	const connection = f.supervisor.getConnection(f.project.id);
	let ready = false;
	let resumes = 0;
	connection.getSessionOffers = id =>
		ready && id === 'fake-session'
			? {offeredModes: ['normal'], configOptions: []}
			: undefined;
	const original = connection.resumeSession;
	connection.resumeSession = async (...args) => {
		resumes++;
		ready = true;
		return original(...args);
	};
	const read = f.store.threadHistory.read;
	let fail = true;
	f.store.threadHistory.read = scope => {
		if (fail) {
			fail = false;
			throw new IpcFailure('INTERNAL', 'Synthetic identity read failure');
		}
		return read(scope);
	};
	const failed = await f.service.openThread(request);
	t.deepEqual(failed.events, initial.events);
	const retried = await f.service.openThread(request);
	t.is(retried.thread.runState, 'ready');
	t.is(retried.thread.nanocoderSessionId, 'fake-session');
	t.is(resumes, 2);
	f.store.threadHistory.read = read;
});

async function fixture(
	t: ExecutionContext,
	enableRuntime = false,
	onEvent?: (event: ProjectEvent) => void,
	withLifecycle = false,
	hooks: Pick<
		Parameters<typeof createThreadService>[0],
		| 'onSessionPrepared'
		| 'onThreadSelected'
		| 'beforeFirstPrompt'
		| 'resolveLiveMode'
		| 'validateBeforePrepare'
	> = {},
) {
	const root = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-threads-')),
	);
	const store = await desktopStoreFactory.open({
		databasePath: path.join(root, 'desktop.sqlite'),
		driver: createNodeSqliteDriver(),
	});
	const calls: string[] = [];
	const connections: NanocoderConnection[] = [];
	const clock = new FakeClock();
	let service!: ReturnType<typeof createThreadService>;
	const projectRoot = path.join(root, 'project');
	mkdirSync(projectRoot);
	let update: ConnectOptions['onSessionUpdate'];
	let titleUpdate: ConnectOptions['onTitleChanged'];
	let confirm: NonNullable<
		Parameters<typeof createThreadService>[0]['confirmDeleteHistory']
	> = async () => false;
	const supervisor = new ProjectSupervisor({
		clock: withLifecycle ? clock : undefined,
		activity: withLifecycle ? id => service.activity(id) : undefined,
		recover: withLifecycle
			? (chosen, connection, signal) =>
					service.restore(chosen, connection, signal)
			: undefined,
		resolveRuntime: async () => {
			calls.push('launch');
			if (enableRuntime)
				return {
					ok: true,
					runtime: {
						...fakeRuntime,
						nodeVersion: process.version,
						version: '9.9.9',
						source: 'override',
					},
				};
			throw new Error('Metadata operations must not start Nanocoder');
		},
		clientInfo: {name: 'thread-fixture', version: '0.0.0'},
		confirmTrust: async () => false,
		connect: async options => {
			update = options.onSessionUpdate;
			titleUpdate = options.onTitleChanged;
			const connection = await connectProject(options);
			if (!('status' in connection)) connections.push(connection);
			return connection;
		},
	});
	const listeners = new Set<(event: ProjectEvent) => void>();
	const subscribe = supervisor.subscribe.bind(supervisor);
	supervisor.subscribe = listener => {
		listeners.add(listener);
		const off = subscribe(listener);
		return () => {
			listeners.delete(listener);
			off();
		};
	};
	t.teardown(async () => {
		await supervisor.close();
		service.dispose();
		store.close();
		rmSync(root, {recursive: true, force: true});
	});
	const project: ProjectInfo = {
		id: randomUUID(),
		canonicalRoot: projectRoot,
		sessionCwd: projectRoot,
		displayName: 'fixture',
		trusted: enableRuntime,
		defaultMode: 'auto-accept',
		lastOpenedAt: '2026-10-29T12:00:00.000Z',
		createdAt: '2026-10-29T12:00:00.000Z',
		availability: 'available',
	};
	store.projects.save(project);
	service = createThreadService({
		...hooks,
		store,
		supervisor,
		clock,
		now: () => new Date('2026-10-30T14:00:00.000Z'),
		onEvent,
		confirmDeleteHistory: snapshot => {
			calls.push('confirm-delete');
			return confirm(snapshot);
		},
	});
	return {
		root,
		store,
		calls,
		connections,
		project,
		supervisor,
		service,
		clock,
		confirmDeletion: (callback: typeof confirm) => {
			confirm = callback;
		},
		notifyTitle: (sessionId: string, title: string) => {
			if (!titleUpdate) throw new Error('No fixture connection is ready');
			titleUpdate({sessionId, title});
		},
		notifyBatch: (sessionId: string, events: TurnEvent[]) => {
			for (const listener of listeners)
				listener({
					type: 'turn',
					projectId: project.id,
					threadId: sessionId,
					sequence: 1,
					events,
				});
		},
		notifyUpdate: (
			notification: Parameters<
				NonNullable<ConnectOptions['onSessionUpdate']>
			>[0],
		) => {
			if (!update) throw new Error('No fixture connection is ready');
			update(notification);
		},
		notify: (sessionId: string, text: string) => {
			if (!update) throw new Error('No fixture connection is ready');
			update({
				sessionId,
				update: {
					sessionUpdate: 'agent_message_chunk',
					content: {type: 'text', text},
				},
			});
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => {
		resolve = done;
	});
	return {promise, resolve};
}

async function waitForFakeEvent(
	connection: NanocoderConnection,
	matches: (event: Record<string, unknown>) => boolean,
) {
	const {stderr} = connection;
	const write = stderr.write;
	try {
		await new Promise<void>(resolve => {
			const check = () => {
				if (fakeEvents(stderr.lines()).some(matches)) resolve();
			};
			stderr.write = chunk => {
				write.call(stderr, chunk);
				check();
			};
			check();
		});
	} finally {
		stderr.write = write;
	}
}

function nextFailure(supervisor: ProjectSupervisor) {
	const failed = deferred<void>();
	const off = supervisor.subscribe(event => {
		if (event.type === 'supervisor' && event.state.status === 'failed') {
			off();
			failed.resolve();
		}
	});
	return failed.promise;
}

function assertReplayMarkers(
	t: ExecutionContext,
	events: ProjectEvent[],
	thread: Pick<ThreadInfo, 'id' | 'projectId'>,
	markers: Array<['begin' | 'complete' | 'failed', number]>,
	expectedEpoch?: string,
) {
	const first = events[0];
	const epoch = first?.type === 'turn' ? first.replay?.epoch : undefined;
	if (markers.length) {
		t.regex(
			epoch ?? '',
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		if (expectedEpoch !== undefined) t.is(epoch, expectedEpoch);
	}
	t.deepEqual(
		events,
		markers.map(([phase, sequence]) => ({
			type: 'turn',
			projectId: thread.projectId,
			threadId: thread.id,
			sequence,
			events: [],
			replay: {epoch, phase},
		})),
	);
}

function seed(
	project: ProjectInfo,
	overrides: Partial<ThreadInfo> = {},
): ThreadInfo {
	return {
		id: randomUUID(),
		projectId: project.id,
		nanocoderSessionId: randomUUID(),
		title: 'fixture thread',
		archiveState: 'active',
		runState: 'ready',
		lastActivityAt: '2026-10-29T12:00:00.000Z',
		sessionCwd: project.sessionCwd,
		mode: 'normal',
		viewOnlyReason: null,
		...overrides,
	};
}

async function waitingThread(t: ExecutionContext, two = false) {
	const waiting = deferred<PermissionRequestInfo[]>();
	const requests: PermissionRequestInfo[] = [];
	const context = await fixture(t, true, event => {
		if (event.type !== 'turn') return;
		for (const item of event.events) {
			if (item.type !== 'permission') continue;
			requests.push(item.request);
			if (requests.length === (two ? 2 : 1)) waiting.resolve(requests);
		}
	});
	if (two)
		writeFileSync(
			path.join(context.project.canonicalRoot, '.fake-nanocoder'),
			'two-tools',
		);
	const metadata: ThreadInfo[] = [];
	context.supervisor.subscribe(event => {
		if (event.type === 'thread') metadata.push(event.thread);
	});
	const thread = await context.service.createThread({
		projectId: context.project.id,
	});
	const target = {projectId: context.project.id, threadId: thread.id};
	const turn = context.service.promptThread({
		...target,
		text: 'fixture request',
	});
	void turn.catch(() => undefined);
	t.teardown(async () => {
		await context.supervisor
			.cancel(context.project.id, 'fake-session')
			.catch(() => undefined);
		await turn.catch(() => undefined);
	});
	return {
		...context,
		thread,
		target,
		turn,
		requests: await waiting.promise,
		connection: context.supervisor.getConnection(context.project.id),
		metadata,
	};
}

for (const mode of [
	'resume-fails',
	'mode-fails',
	'no-normal',
	'missing-session',
	'no-resume',
]) {
	test(`cached ${mode} keeps its thread identity and refuses prompts until explicit same-history retry, never a fresh session (CHAT-04, ACP-13)`, async t => {
		const {project, store, service, supervisor} = await fixture(t, true);
		const thread = seed(project, {nanocoderSessionId: 'fake-session'});
		const other = seed(project, {nanocoderSessionId: null});
		store.threads.save(thread);
		store.threads.save(other);
		const request = {projectId: project.id, threadId: thread.id};
		const before = await service.openThread(request);
		await supervisor.stop(project.id);
		writeFileSync(path.join(project.canonicalRoot, '.fake-nanocoder'), mode);
		const unavailable = await service.openThread(request);
		t.is(
			unavailable.thread.runState,
			mode === 'missing-session' ? 'view-only' : 'failed',
		);
		t.truthy(unavailable.thread.viewOnlyReason);
		if (mode === 'resume-fails')
			t.is(
				unavailable.thread.viewOnlyReason,
				'Nanocoder could not resume the session',
			);
		if (mode === 'mode-fails')
			t.is(
				unavailable.thread.viewOnlyReason,
				'Nanocoder did not set the normal mode',
			);
		if (mode === 'no-normal')
			t.is(
				unavailable.thread.viewOnlyReason,
				'Nanocoder does not offer the normal mode',
			);
		if (mode === 'no-resume')
			t.is(
				unavailable.thread.viewOnlyReason,
				'This version of Nanocoder cannot resume sessions',
			);
		t.is(unavailable.thread.id, thread.id);
		t.is(unavailable.thread.nanocoderSessionId, thread.nanocoderSessionId);
		t.deepEqual(unavailable.events, before.events);
		t.deepEqual(store.threads.get(project.id, other.id), other);
		t.is(supervisor.getState(project.id).status, 'ready');
		const connection = supervisor.getConnection(project.id);
		await t.throwsAsync(service.promptThread({...request, text: 'refused'}), {
			instanceOf: IpcFailure,
		});
		const methods = fakeEvents(connection.stderr.lines()).map(
			event => event.method,
		);
		t.false(methods.includes('session/new'));
		t.false(methods.includes('session/prompt'));
		t.is(methods.includes('session/resume'), mode !== 'no-resume');
		if (mode !== 'missing-session')
			t.notRegex(unavailable.thread.viewOnlyReason ?? '', /no saved history/);
		await supervisor.stop(project.id);
		writeFileSync(path.join(project.canonicalRoot, '.fake-nanocoder'), 'ok');
		const reopened = await service.openThread(request);
		t.is(reopened.thread.runState, 'ready');
		t.is(reopened.thread.viewOnlyReason, null);
		t.is(reopened.thread.nanocoderSessionId, thread.nanocoderSessionId);
		const fresh = supervisor.getConnection(project.id);
		t.not(fresh, connection);
		t.deepEqual(
			fakeEvents(fresh.stderr.lines())
				.map(event => event.method)
				.filter(
					method => typeof method === 'string' && method.startsWith('session/'),
				),
			['session/resume', 'session/set_mode'],
		);
		const permission = deferred<PermissionRequestInfo>();
		const off = supervisor.subscribe(event => {
			if (event.type === 'turn')
				for (const item of event.events)
					if (item.type === 'permission') permission.resolve(item.request);
		});
		const turn = service.promptThread({...request, text: 'explicit retry'});
		const offered = await permission.promise;
		await service.answerThreadPermission({
			...request,
			requestId: offered.id,
			optionId: 'deny',
		});
		t.deepEqual(await turn, {stopReason: 'end_turn'});
		off();
		t.is(
			store.threads.get(project.id, thread.id)?.nanocoderSessionId,
			thread.nanocoderSessionId,
		);
		t.false(
			fakeEvents(fresh.stderr.lines()).some(
				event => event.method === 'session/new',
			),
		);
	});
}

for (const mode of [
	'no-resume',
	'missing-session',
	'resume-fails',
	'mode-fails',
	'no-normal',
]) {
	test(`${mode} automatic thread recovery stays unavailable without replacement history or re-prompt (ACP-13, CHAT-04)`, async t => {
		const {project, service, store, supervisor, clock, connections} =
			await fixture(t, true, undefined, true);
		const thread = await service.createThread({projectId: project.id});
		store.threads.save({...thread, mode: 'normal'});
		const failed = nextFailure(supervisor);
		writeFileSync(
			path.join(project.canonicalRoot, '.fake-nanocoder'),
			'die-in-turn',
		);
		await t.throwsAsync(
			service.promptThread({
				projectId: project.id,
				threadId: thread.id,
				text: 'synthetic failure',
			}),
		);
		await failed;
		writeFileSync(path.join(project.canonicalRoot, '.fake-nanocoder'), mode);
		const unavailable = deferred<void>();
		const off = supervisor.subscribe(event => {
			if (
				event.type === 'supervisor' &&
				['failed', 'unsupported'].includes(event.state.status) &&
				event.state.restart.nextAttemptAt === null
			)
				unavailable.resolve();
		});
		clock.advance(1000);
		await unavailable.promise;
		off();
		t.throws(() => supervisor.getConnection(project.id));
		t.is(clock.pending, 0);
		const connection = connections.at(-1);
		if (!connection) throw new Error('Missing recovered connection');
		const methods = fakeEvents(connection.stderr.lines()).map(
			event => event.method,
		);
		t.false(methods.includes('session/new'));
		t.false(methods.includes('session/prompt'));
		t.is(methods.includes('session/resume'), mode !== 'no-resume');
		t.is(
			store.threads.get(project.id, thread.id)?.nanocoderSessionId,
			'fake-session',
		);
	});
}

test('detaching a failed thread cancels its pending recovery without a later launch (ACP-13)', async t => {
	const {project, service, supervisor, clock, calls} = await fixture(
		t,
		true,
		undefined,
		true,
	);
	const thread = await service.createThread({projectId: project.id});
	const failed = nextFailure(supervisor);
	writeFileSync(
		path.join(project.canonicalRoot, '.fake-nanocoder'),
		'die-in-turn',
	);
	await t.throwsAsync(
		service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'synthetic failure',
		}),
	);
	await failed;
	t.not(supervisor.getState(project.id).restart.nextAttemptAt, null);
	await service.detach([project]);
	t.is(clock.pending, 0);
	clock.advance(60_000);
	t.is(supervisor.getState(project.id).status, 'stopped');
	t.is(calls.filter(call => call === 'launch').length, 1);
});

test('thread recovery remains starting through slow mode confirmation and detach settles the child without replaying content (ACP-13)', async t => {
	const mapped: ProjectEvent[] = [];
	const {project, service, supervisor, clock, connections} = await fixture(
		t,
		true,
		event => mapped.push(event),
		true,
	);
	const thread = await service.createThread({projectId: project.id});
	const failed = nextFailure(supervisor);
	writeFileSync(
		path.join(project.canonicalRoot, '.fake-nanocoder'),
		'die-in-turn',
	);
	await t.throwsAsync(
		service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'synthetic failure',
		}),
	);
	await failed;
	const before = mapped.length;
	writeFileSync(
		path.join(project.canonicalRoot, '.fake-nanocoder'),
		'slow-mode',
	);
	const waiting = deferred<void>();
	const off = supervisor.subscribe(event => {
		if (
			event.type === 'turn' &&
			event.events.some(
				item => item.type === 'text' && item.text === 'mode waiting',
			)
		)
			waiting.resolve();
	});
	clock.advance(1000);
	await waiting.promise;
	off();
	t.is(supervisor.getState(project.id).status, 'starting');
	t.throws(() => supervisor.getConnection(project.id));
	t.true(service.activity(project.id).preparing);
	await service.detach([project]);
	t.is(supervisor.getState(project.id).status, 'stopped');
	t.is(clock.pending, 0);
	const connection = connections.at(-1);
	if (!connection) throw new Error('Missing recovered connection');
	await connection.exited;
	t.false(
		fakeEvents(connection.stderr.lines()).some(
			event =>
				event.method === 'session/new' || event.method === 'session/prompt',
		),
	);
	const previous = mapped
		.slice(0, before)
		.filter(event => event.type === 'turn')
		.at(-1);
	assertReplayMarkers(t, mapped.slice(before), thread, [
		['begin', (previous?.sequence ?? 0) + 1],
	]);
	t.false(service.activity(project.id).preparing);
});

test('a mode result from a replaced connection cannot commit readiness or content, and explicit reopen resumes its saved identity (ACP-13, CHAT-04)', async t => {
	const {project, service, supervisor} = await fixture(t, true);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	const original = connection.newSession;
	const entered = deferred<void>();
	const release = deferred<void>();
	t.teardown(() => release.resolve());
	connection.newSession = async mode => {
		const result = await original(mode);
		entered.resolve();
		await release.promise;
		return result;
	};
	const request = {projectId: project.id, threadId: thread.id};
	const turn = service.promptThread({...request, text: 'never published'});
	const rejected = t.throwsAsync(turn, {code: 'AGENT_UNAVAILABLE'});
	await entered.promise;
	await supervisor.stop(project.id);
	await supervisor.ensureProcess(project);
	release.resolve();
	await rejected;
	const snapshot = await service.getThreadSnapshot(request);
	t.is(snapshot.thread.runState, 'new');
	t.is(snapshot.thread.nanocoderSessionId, 'fake-session');
	t.deepEqual(snapshot.events, []);
	t.false(service.activity(project.id).preparing);
	t.false(
		fakeEvents(connection.stderr.lines()).some(
			event => event.method === 'session/prompt',
		),
	);
	const reopened = await service.openThread(request);
	t.is(reopened.thread.runState, 'ready');
	t.is(reopened.thread.nanocoderSessionId, 'fake-session');
	t.deepEqual(
		fakeEvents(supervisor.getConnection(project.id).stderr.lines())
			.map(event => event.method)
			.filter(
				method => typeof method === 'string' && method.startsWith('session/'),
			),
		['session/resume', 'session/set_mode'],
	);
});

test('thread cancellation waits for the exact owning supervisor settlement before replying (ACP-10)', async t => {
	const {service, supervisor, target, turn} = await waitingThread(t);
	const original = supervisor.cancel.bind(supervisor);
	const entered = deferred<void>();
	const release = deferred<void>();
	t.teardown(() => {
		release.resolve();
		supervisor.cancel = original;
	});
	supervisor.cancel = async (...args) => {
		await original(...args);
		entered.resolve();
		await release.promise;
	};
	let settled = false;
	const cancellation = service.cancelThread(target).then(result => {
		settled = true;
		return result;
	});
	await entered.promise;
	t.false(settled);
	release.resolve();
	t.is(await cancellation, null);
	t.deepEqual(await turn, {stopReason: 'cancelled'});
});

test('signal exit settles the thread activity and revokes its pending approval (ACP-13, ACP-10)', async t => {
	const {project, service, supervisor, connection, target, requests, turn} =
		await waitingThread(t);
	t.true(service.activity(project.id).runningTurn);
	const started = fakeEvents(connection.stderr.lines()).find(
		event => event.started,
	);
	if (typeof started?.pid !== 'number') throw new Error('Missing fake child');
	const failed = deferred<void>();
	const off = supervisor.subscribe(event => {
		if (event.type === 'supervisor' && event.state.status === 'failed')
			failed.resolve();
	});
	const rejected = t.throwsAsync(turn);
	process.kill(started.pid, 'SIGTERM');
	await failed.promise;
	await rejected;
	off();
	t.deepEqual(
		supervisor.getState(project.id).exit,
		process.platform === 'win32'
			? {code: 1, signal: null}
			: {code: null, signal: 'SIGTERM'},
	);
	t.false(service.activity(project.id).runningTurn);
	await t.throwsAsync(
		service.answerThreadPermission({
			...target,
			requestId: requests[0].id,
			optionId: 'allow',
		}),
	);
});

test('ordinary history open refuses a located root before launch or former-cwd resume and keeps its saved identity (CHAT-01, CHAT-04)', async t => {
	const {project, service, store, supervisor, root, calls} = await fixture(
		t,
		true,
	);
	const thread = seed(project, {nanocoderSessionId: 'fake-session'});
	store.threads.save(thread);
	const request = {projectId: project.id, threadId: thread.id};
	const before = await service.openThread(request);
	await supervisor.stop(project.id);
	const located = path.join(root, 'located');
	mkdirSync(located);
	store.projects.save({
		...project,
		canonicalRoot: located,
		sessionCwd: located,
		trusted: true,
	});
	await t.throwsAsync(service.openThread(request), {
		instanceOf: IpcFailure,
		code: 'DENIED',
	});
	t.deepEqual(await service.getThreadSnapshot(request), before);
	t.is(calls.filter(call => call === 'launch').length, 1);
	t.is(supervisor.getState(project.id).status, 'stopped');
});

test('ACP-10 renderer detach drops cancelled approval payloads from retained snapshots before reopen', async t => {
	const {
		project,
		service,
		store,
		supervisor,
		connection,
		target,
		requests,
		turn,
	} = await waitingThread(t, true);
	const before = await service.getThreadSnapshot(target);
	t.is(before.events.filter(event => event.type === 'permission').length, 2);
	const scope = {...target, sessionId: 'fake-session'};
	const history = store.threadHistory.read(scope);
	await service.detach([project]);
	await turn;
	t.is(supervisor.getState(project.id).status, 'stopped');
	t.deepEqual(
		fakeEvents(connection.stderr.lines()).filter(event => event.answer),
		[{answer: {outcome: 'cancelled'}}],
	);
	const after = await service.getThreadSnapshot(target);
	t.deepEqual(
		after.events,
		before.events.filter(
			event =>
				event.type !== 'permission' && event.type !== 'permission-closed',
		),
	);
	t.is(after.sequence, before.sequence);
	t.is(after.result, undefined);
	t.deepEqual(store.threadHistory.read(scope), history);
	for (const request of requests)
		await t.throwsAsync(
			service.answerThreadPermission({
				...target,
				requestId: request.id,
				optionId: 'allow',
			}),
			{instanceOf: IpcFailure, code: 'DENIED'},
		);
	const reopened = await service.openThread(target);
	t.is(reopened.thread.nanocoderSessionId, 'fake-session');
	t.false(
		reopened.events.some(
			event =>
				event.type === 'permission' || event.type === 'permission-closed',
		),
	);
});

test('a restarted waiting thread is interrupted with no synthetic terminal, launch or surviving approval authority (CHAT-03, ACP-10)', async t => {
	const {project, root, service, store, supervisor, target, requests, turn} =
		await waitingThread(t);
	const waiting = store.threads.get(project.id, target.threadId);
	if (!waiting) throw new Error('Missing waiting fixture thread');
	t.is(waiting.runState, 'waiting-approval');
	await service.detach([project]);
	await turn;
	service.dispose();
	store.threads.save(waiting);
	store.close();
	const reopened = await desktopStoreFactory.open({
		databasePath: path.join(root, 'desktop.sqlite'),
		driver: createNodeSqliteDriver(),
	});
	let launches = 0;
	const fresh = new ProjectSupervisor({
		resolveRuntime: async () => {
			launches++;
			throw new Error('Restart metadata must not launch');
		},
		clientInfo: {name: 'restart-fixture', version: '0.0.0'},
		confirmTrust: async () => false,
	});
	const mapped: ProjectEvent[] = [];
	const restarted = createThreadService({
		store: reopened,
		supervisor: fresh,
		onEvent: event => mapped.push(event),
	});
	t.teardown(async () => {
		restarted.dispose();
		await fresh.close();
		reopened.close();
	});
	t.is(
		reopened.threads.get(project.id, target.threadId)?.runState,
		'interrupted',
	);
	t.deepEqual(await restarted.getThreadSnapshot(target), {
		thread: {...waiting, runState: 'interrupted'},
		sequence: 0,
		events: [],
		replaying: false,
	});
	await t.throwsAsync(
		restarted.answerThreadPermission({
			...target,
			requestId: requests[0].id,
			optionId: 'allow',
		}),
		{instanceOf: IpcFailure, code: 'DENIED'},
	);
	t.false(
		fresh.answerPermission(
			project.id,
			waiting.nanocoderSessionId ?? '',
			requests[0].id,
			'allow',
		),
	);
	t.is(fresh.getState(project.id).activeThreadId, null);
	t.is(launches, 0);
	t.deepEqual(mapped, []);
	t.false(
		supervisor.answerPermission(
			project.id,
			waiting.nanocoderSessionId ?? '',
			requests[0].id,
			'allow',
		),
	);
});

test('new thread is metadata-only until the first prompt (CHAT-03, CHAT-04)', async t => {
	const {project, service, store, calls} = await fixture(t);
	const thread = await service.createThread({projectId: project.id});
	t.regex(thread.id, /^[0-9a-f-]{36}$/);
	t.deepEqual(thread, {
		id: thread.id,
		projectId: project.id,
		nanocoderSessionId: null,
		title: 'new thread',
		archiveState: 'active',
		runState: 'new',
		lastActivityAt: '2026-10-30T14:00:00.000Z',
		sessionCwd: project.sessionCwd,
		mode: 'auto-accept',
		viewOnlyReason: null,
	});
	t.deepEqual(store.threads.get(project.id, thread.id), thread);
	t.is(store.getUiState().activeProjectId, project.id);
	t.is(store.getUiState().activeThreadId, thread.id);
	t.deepEqual(calls, []);
});

test('thread lifecycle attachment reports activity without creating or resuming any session (CHAT-03, ACP-13)', async t => {
	const {service, project, calls, clock} = await fixture(t);
	t.deepEqual(service.activity(project.id), {
		runningTurn: false,
		openSessions: 0,
		preparing: false,
		lastActivityAt: 0,
	});
	clock.advance(12);
	service.attachProject(project.id);
	t.deepEqual(service.activity(project.id), {
		runningTurn: false,
		openSessions: 1,
		preparing: false,
		lastActivityAt: clock.now(),
	});
	t.deepEqual(calls, []);
});

test('thread recovery uses the supplied starting connection and replaces its mapped snapshot without raw replay or re-prompting (ACP-13, CHAT-04)', async t => {
	const mapped: ProjectEvent[] = [];
	const {service, project, store, supervisor, clock} = await fixture(
		t,
		true,
		event => mapped.push(event),
		true,
	);
	const thread = await service.createThread({projectId: project.id});
	store.threads.save({...thread, mode: 'normal'});
	writeFileSync(
		path.join(project.canonicalRoot, '.fake-nanocoder'),
		'die-in-turn',
	);
	let failed!: () => void;
	const failure = new Promise<void>(resolve => {
		failed = resolve;
	});
	supervisor.subscribe(event => {
		if (event.type === 'supervisor' && event.state.status === 'failed')
			failed();
	});
	await t.throwsAsync(
		service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'synthetic failure',
		}),
	);
	await failure;
	const before = await service.getThreadSnapshot({
		projectId: project.id,
		threadId: thread.id,
	});
	t.false(before.result?.ok);
	const raw: ProjectEvent[] = [];
	let ready!: () => void;
	const recovered = new Promise<void>(resolve => {
		ready = resolve;
	});
	const off = supervisor.subscribe(event => {
		if (event.type === 'turn') raw.push(event);
		if (event.type === 'supervisor' && event.state.status === 'ready') ready();
	});
	clock.advance(1000);
	await recovered;
	off();
	const snapshot = await service.getThreadSnapshot({
		projectId: project.id,
		threadId: thread.id,
	});
	t.is(snapshot.thread.runState, 'ready');
	t.is(snapshot.result, undefined);
	t.is(snapshot.thread.mode, 'normal');
	t.is(snapshot.thread.nanocoderSessionId, 'fake-session');
	t.is(snapshot.sequence, before.sequence + 3);
	assertReplayMarkers(
		t,
		mapped.filter(
			event => event.type === 'turn' && event.sequence > before.sequence,
		),
		thread,
		[
			['begin', before.sequence + 1],
			['complete', before.sequence + 3],
		],
		snapshot.replayEpoch,
	);
	t.true(
		snapshot.events.some(
			event => event.type === 'user' && event.text === 'Earlier question',
		),
	);
	// Replay is never raw. The only live event is the confirmation of the mode just set (nanocoder#1912).
	t.deepEqual(
		raw.flatMap(event => (event.type === 'turn' ? event.events : [])),
		[{type: 'mode', id: 'normal'}],
	);
	const requests = fakeEvents(
		supervisor.getConnection(project.id).stderr.lines(),
	).filter(
		event =>
			typeof event.method === 'string' && event.method.startsWith('session/'),
	);
	t.deepEqual(
		requests.map(event => event.method),
		['session/resume', 'session/set_mode'],
	);
	t.false(
		mapped.some(
			event => event.type === 'turn' && event.threadId === 'fake-session',
		),
	);
});

test('thread detach cancels running and starting projects while preserving idle processes (ACP-13, ACP-10)', async t => {
	const {root, service, supervisor, store, project, turn, connection} =
		await waitingThread(t);
	const peers = ['idle', 'starting'].map(name => {
		const folder = path.join(root, name);
		mkdirSync(folder);
		const chosen = {
			...project,
			id: randomUUID(),
			canonicalRoot: folder,
			sessionCwd: folder,
		};
		store.projects.save(chosen);
		return chosen;
	});
	await supervisor.ensureProcess(peers[0]);
	const starting = supervisor.ensureProcess(peers[1]);
	await service.detach([project, ...peers]);
	t.is(supervisor.getState(project.id).status, 'stopped');
	t.is(supervisor.getState(peers[0].id).status, 'ready');
	await starting;
	t.is(supervisor.getState(peers[1].id).status, 'stopped');
	t.deepEqual(await turn, {stopReason: 'cancelled'});
	t.is(service.activity(project.id).openSessions, 0);
	await connection.exited;
	t.deepEqual(
		fakeEvents(connection.stderr.lines())
			.filter(event => 'answer' in event)
			.map(event => event.answer),
		[{outcome: 'cancelled'}],
	);
});

for (const [mode, resume] of [
	['slow-new', false],
	['slow-mode', false],
	['slow-resume', true],
	['slow-mode', true],
] as const) {
	test(`thread detach owns ${mode} ${resume ? 'resume' : 'new'} preparation before any prompt (ACP-13, CHAT-04)`, async t => {
		const {service, supervisor, store, project} = await fixture(t, true);
		writeFileSync(path.join(project.canonicalRoot, '.fake-nanocoder'), mode);
		const thread = resume
			? seed(project, {nanocoderSessionId: 'fake-session'})
			: await service.createThread({projectId: project.id});
		if (resume) store.threads.save(thread);
		await supervisor.ensureProcess(project);
		const connection = supervisor.getConnection(project.id);
		const waiting = deferred<void>();
		const off = supervisor.subscribe(event => {
			if (
				event.type === 'turn' &&
				event.events.some(
					item => item.type === 'text' && item.text.includes('waiting'),
				)
			)
				waiting.resolve();
		});
		if (mode === 'slow-resume') {
			const original = connection.resumeSession;
			connection.resumeSession = (...args) => {
				const pending = original(...args);
				waiting.resolve();
				return pending;
			};
		}
		const preparing = service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'never sent',
		});
		const rejected = t.throwsAsync(preparing);
		await waiting.promise;
		t.true(service.activity(project.id).preparing);
		await service.detach([]);
		t.is(supervisor.getState(project.id).status, 'stopped');
		await rejected;
		off();
		await connection.exited;
		t.false(
			fakeEvents(connection.stderr.lines()).some(
				event => event.method === 'session/prompt',
			),
		);
		t.false(service.activity(project.id).preparing);
	});
}

for (const [mode, resume] of [
	['slow-new', false],
	['slow-mode', false],
	['slow-resume', true],
	['slow-mode', true],
] as const) {
	test(`thread cancel stops ${mode} ${resume ? 'resume' : 'new'} preparation before any prompt (CHAT-06, ACP-10)`, async t => {
		const {service, supervisor, store, project} = await fixture(t, true);
		writeFileSync(path.join(project.canonicalRoot, '.fake-nanocoder'), mode);
		const thread = resume
			? seed(project, {nanocoderSessionId: 'fake-session'})
			: await service.createThread({projectId: project.id});
		if (resume) store.threads.save(thread);
		await supervisor.ensureProcess(project);
		const connection = supervisor.getConnection(project.id);
		const waiting = deferred<void>();
		const off = supervisor.subscribe(event => {
			if (
				event.type === 'turn' &&
				event.events.some(
					item => item.type === 'text' && item.text.includes('waiting'),
				)
			)
				waiting.resolve();
		});
		if (mode === 'slow-resume') {
			const original = connection.resumeSession;
			connection.resumeSession = (...args) => {
				const pending = original(...args);
				waiting.resolve();
				return pending;
			};
		}
		const request = {projectId: project.id, threadId: thread.id};
		const turn = service.promptThread({...request, text: 'never sent'});
		void turn.catch(() => undefined);
		await waiting.promise;
		const peer = await service.createThread({projectId: project.id});
		t.is(
			await service.cancelThread({projectId: project.id, threadId: peer.id}),
			null,
		);
		t.is(supervisor.getState(project.id).status, 'ready');
		t.true(service.activity(project.id).preparing);
		t.is(await service.cancelThread(request), null);
		t.is(supervisor.getState(project.id).status, 'stopped');
		t.deepEqual(await turn, {stopReason: 'cancelled'});
		off();
		const snapshot = await service.getThreadSnapshot(request);
		t.is(snapshot.thread.runState, 'interrupted');
		t.deepEqual(snapshot.events, []);
		if (!resume) t.is(snapshot.thread.nanocoderSessionId, null);
		t.false(
			fakeEvents(connection.stderr.lines()).some(
				event => event.method === 'session/prompt',
			),
		);
	});
}

test('cancelling an already-settled turn cannot mistake pending cleanup for session preparation (CHAT-06)', async t => {
	const {service, supervisor, project} = await fixture(t, true);
	const thread = await service.createThread({projectId: project.id});
	const request = {projectId: project.id, threadId: thread.id};
	await supervisor.ensureProcess(project);
	supervisor.getConnection(project.id).prompt = async () => ({
		stopReason: 'end_turn',
	});
	let working = false;
	let cancelled: Promise<null> | undefined;
	const off = supervisor.subscribe(event => {
		if (event.type !== 'supervisor' || event.state.status !== 'ready') return;
		if (event.state.activeThreadId) working = true;
		else if (working && !cancelled) cancelled = service.cancelThread(request);
	});
	t.deepEqual(await service.promptThread({...request, text: 'finished'}), {
		stopReason: 'end_turn',
	});
	t.truthy(cancelled);
	await cancelled;
	off();
	t.is(supervisor.getState(project.id).status, 'ready');
	t.is((await service.getThreadSnapshot(request)).thread.runState, 'ready');
});

for (const action of ['cancel', 'detach'] as const) {
	for (const resume of [false, true]) {
		test(`a late ${resume ? 'resumed' : 'new'} mode result after ${action} cannot commit session preparation or user content (ACP-10, ACP-13)`, async t => {
			const {service, store, supervisor, project} = await fixture(t, true);
			const thread = resume
				? seed(project, {nanocoderSessionId: 'fake-session'})
				: await service.createThread({projectId: project.id});
			if (resume) store.threads.save(thread);
			await supervisor.ensureProcess(project);
			const connection = supervisor.getConnection(project.id);
			const entered = deferred<void>();
			const release = deferred<void>();
			t.teardown(() => release.resolve());
			if (resume) {
				const original = connection.resumeSession;
				connection.resumeSession = async (...args) => {
					const value = await original(...args);
					entered.resolve();
					await release.promise;
					return value;
				};
			} else {
				const original = connection.newSession;
				connection.newSession = async (...args) => {
					const value = await original(...args);
					entered.resolve();
					await release.promise;
					return value;
				};
			}
			const request = {projectId: project.id, threadId: thread.id};
			const turn = service.promptThread({...request, text: 'never published'});
			void turn.catch(() => undefined);
			const rejected =
				action === 'detach'
					? t.throwsAsync(turn, {code: 'AGENT_UNAVAILABLE'})
					: undefined;
			await entered.promise;
			const stopped =
				action === 'detach'
					? service.detach([])
					: service.cancelThread(request);
			release.resolve();
			await stopped;
			if (rejected) await rejected;
			else t.deepEqual(await turn, {stopReason: 'cancelled'});
			const snapshot = await service.getThreadSnapshot(request);
			t.is(snapshot.thread.nanocoderSessionId, resume ? 'fake-session' : null);
			t.deepEqual(snapshot.events, []);
			t.false(
				fakeEvents(connection.stderr.lines()).some(
					event => event.method === 'session/prompt',
				),
			);
		});
	}
}

for (const outcome of ['completed', 'cancelled', 'failed'] as const) {
	test(`a ${outcome} result is sequenced in the owning transient snapshot only and clears before the next accepted user turn (CHAT-03, DATA-07)`, async t => {
		const mapped: ProjectEvent[] = [];
		const {service, supervisor, project, store} = await fixture(
			t,
			true,
			event => mapped.push(event),
		);
		const thread = await service.createThread({projectId: project.id});
		const request = {projectId: project.id, threadId: thread.id};
		await supervisor.ensureProcess(project);
		const connection = supervisor.getConnection(project.id);
		connection.prompt = async () => {
			if (outcome === 'failed')
				throw new NanocoderFailure(
					'AGENT_UNAVAILABLE',
					'safe terminal failure',
				);
			return {stopReason: outcome === 'cancelled' ? 'cancelled' : 'end_turn'};
		};
		const prompting = service.promptThread({
			...request,
			text: 'synthetic turn',
		});
		if (outcome === 'failed')
			await t.throwsAsync(prompting, {
				code: 'AGENT_UNAVAILABLE',
				message: 'safe terminal failure',
			});
		else await prompting;
		const result =
			outcome === 'failed'
				? {
						ok: false,
						error: {
							code: 'AGENT_UNAVAILABLE',
							message: 'safe terminal failure',
							retryable: false,
						},
					}
				: {
						ok: true,
						value: {
							stopReason: outcome === 'cancelled' ? 'cancelled' : 'end_turn',
						},
					};
		const snapshot = await service.getThreadSnapshot(request);
		t.deepEqual(snapshot.result, result);
		const terminal = mapped.filter(event => event.type === 'turn').at(-1);
		t.deepEqual(terminal?.result, result);
		t.is(terminal?.sequence, snapshot.sequence);
		t.false(
			JSON.stringify(store.threads.get(project.id, thread.id)).includes(
				'stopReason',
			),
		);
		t.false(
			JSON.stringify(store.threads.get(project.id, thread.id)).includes(
				'safe terminal failure',
			),
		);
		const entered = deferred<void>();
		const response = deferred<NanocoderTurnResult>();
		connection.prompt = async () => {
			entered.resolve();
			return response.promise;
		};
		const next = service.promptThread({...request, text: 'next accepted turn'});
		await entered.promise;
		t.is((await service.getThreadSnapshot(request)).result, undefined);
		response.resolve({stopReason: 'end_turn'});
		await next;
	});
}

test('terminal failures use the same safe IPC failure without raw details and every returned result is cloned (DATA-07, ACP-13)', async t => {
	const mapped: ProjectEvent[] = [];
	const {service, supervisor, project, store} = await fixture(t, true, event =>
		mapped.push(event),
	);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	supervisor.getConnection(project.id).prompt = async () => {
		throw new Error('synthetic-raw-acp-body-not-for-renderer');
	};
	const request = {projectId: project.id, threadId: thread.id};
	const failure = await t.throwsAsync(
		service.promptThread({...request, text: 'synthetic accepted prompt'}),
		{
			instanceOf: IpcFailure,
			code: 'AGENT_UNAVAILABLE',
			message: 'The thread request could not finish',
		},
	);
	const expected = {
		ok: false,
		error: {
			code: failure?.code,
			message: failure?.message,
			retryable: false,
		},
	};
	const snapshot = await service.getThreadSnapshot(request);
	const terminal = mapped.filter(event => event.type === 'turn').at(-1);
	t.deepEqual(snapshot.result, expected);
	t.deepEqual(terminal?.result, expected);
	t.false(JSON.stringify(snapshot).includes('synthetic-raw-acp-body'));
	t.false(
		JSON.stringify(store.threads.get(project.id, thread.id)).includes(
			'stopReason',
		),
	);
	if (snapshot.result && !snapshot.result.ok)
		snapshot.result.error.message = 'changed snapshot';
	if (terminal?.result && !terminal.result.ok)
		terminal.result.error.message = 'changed event';
	t.deepEqual((await service.getThreadSnapshot(request)).result, expected);
});

test('resolved turn metadata uses only its owning desktop sequence and never the IPC result or metadata store (CHAT-19, DATA-07)', async t => {
	const events: ProjectEvent[] = [];
	const {service, supervisor, project, store} = await fixture(t, true, event =>
		events.push(event),
	);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const response = deferred<NanocoderTurnResult>();
	const entered = deferred<void>();
	supervisor.getConnection(project.id).prompt = async () => {
		entered.resolve();
		return response.promise;
	};
	const request = {projectId: project.id, threadId: thread.id};
	const turn = service.promptThread({...request, text: 'first'});
	await entered.promise;
	const peer = await service.createThread({projectId: project.id});
	const metadata = {
		usage: {totalTokens: 20},
		artifacts: [{kind: 'task' as const, path: 'transient-metadata-only.txt'}],
	};
	response.resolve({stopReason: 'end_turn', metadata});
	t.deepEqual(await turn, {stopReason: 'end_turn'});
	const mapped = events.filter(event => event.type === 'turn');
	t.deepEqual(
		mapped.map(event => ({
			threadId: event.threadId,
			sequence: event.sequence,
			events: event.events,
		})),
		[
			{
				threadId: thread.id,
				sequence: 1,
				events: [{type: 'user', text: 'first'}],
			},
			{
				threadId: thread.id,
				sequence: 2,
				events: [{type: 'metadata', metadata}],
			},
			{threadId: thread.id, sequence: 3, events: []},
		],
	);
	t.deepEqual(
		(
			await service.getThreadSnapshot({
				projectId: project.id,
				threadId: peer.id,
			})
		).events,
		[],
	);
	t.false(
		JSON.stringify(store.threads.list(project.id, 'active')).includes(
			'transient-metadata-only.txt',
		),
	);
	metadata.usage.totalTokens = 999;
	t.is(
		(await service.getThreadSnapshot(request)).events.at(-1)?.metadata?.usage
			?.totalTokens,
		20,
	);
});

for (const changed of ['session', 'root', 'cwd']) {
	test(`resolved metadata cannot enter a replacement ${changed} owner or overwrite its state (CHAT-19, ACP-13)`, async t => {
		const events: ProjectEvent[] = [];
		const {service, supervisor, store, project} = await fixture(
			t,
			true,
			event => events.push(event),
		);
		const thread = await service.createThread({projectId: project.id});
		await supervisor.ensureProcess(project);
		const entered = deferred<void>();
		const response = deferred<NanocoderTurnResult>();
		supervisor.getConnection(project.id).prompt = async () => {
			entered.resolve();
			return response.promise;
		};
		const request = {projectId: project.id, threadId: thread.id};
		const turn = service.promptThread({...request, text: 'old owner'});
		const refused = t.throwsAsync(turn, {code: 'AGENT_UNAVAILABLE'});
		await entered.promise;
		const current = {
			...(await service.getThreadSnapshot(request)).thread,
			runState: 'ready' as const,
			lastActivityAt: '2020-01-01T00:00:00.000Z',
		};
		const replacement = path.join(project.canonicalRoot, 'replacement');
		mkdirSync(replacement);
		if (changed === 'session')
			current.nanocoderSessionId = 'replacement-session';
		else if (changed === 'cwd') current.sessionCwd = replacement;
		else
			store.projects.save({
				...project,
				canonicalRoot: replacement,
				sessionCwd: replacement,
			});
		store.threads.save(current);
		response.resolve({
			stopReason: 'end_turn',
			metadata: {usage: {totalTokens: 20}},
		});
		await refused;
		t.deepEqual(store.threads.get(project.id, thread.id), current);
		t.false(
			events.some(
				event =>
					event.type === 'turn' &&
					event.events.some(item => item.type === 'metadata'),
			),
		);
	});
}

test('detached turn response metadata cannot publish into a later renderer attachment (CHAT-19, ACP-13)', async t => {
	const events: ProjectEvent[] = [];
	const {service, supervisor, project} = await fixture(t, true, event =>
		events.push(event),
	);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const entered = deferred<void>();
	const response = deferred<NanocoderTurnResult>();
	supervisor.getConnection(project.id).prompt = async () => {
		entered.resolve();
		return response.promise;
	};
	const request = {projectId: project.id, threadId: thread.id};
	const turn = service.promptThread({...request, text: 'old attachment'});
	await entered.promise;
	const detached = service.detach([]);
	response.resolve({
		stopReason: 'end_turn',
		metadata: {usage: {totalTokens: 20}},
	});
	await detached;
	t.deepEqual(await turn, {stopReason: 'end_turn'});
	t.false(
		events.some(
			event =>
				event.type === 'turn' &&
				event.events.some(item => item.type === 'metadata'),
		),
	);
	t.deepEqual((await service.getThreadSnapshot(request)).events, [
		{type: 'user', text: 'old attachment'},
	]);
	t.is((await service.getThreadSnapshot(request)).result, undefined);
	t.false(events.some(event => event.type === 'turn' && event.result));
});

test('resumed metadata remains part of the owned in-memory snapshot prefix (CHAT-19, CHAT-04)', async t => {
	const packets: ProjectEvent[] = [];
	const {service, supervisor, store, project} = await fixture(t, true, event =>
		packets.push(event),
	);
	const thread = seed(project, {nanocoderSessionId: 'fake-session'});
	store.threads.save(thread);
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	const original = connection.resumeSession;
	const metadata: TurnEvent = {
		type: 'metadata',
		metadata: {usage: {totalTokens: 30}},
	};
	connection.resumeSession = async (...args) => {
		const resumed = await original(...args);
		return {...resumed, history: [...resumed.history, metadata]};
	};
	const snapshot = await service.openThread({
		projectId: project.id,
		threadId: thread.id,
	});
	t.deepEqual(snapshot.events.at(-1), metadata);
	t.is(snapshot.sequence, 3);
	assertReplayMarkers(
		t,
		packets,
		thread,
		[
			['begin', 1],
			['complete', 3],
		],
		snapshot.replayEpoch,
	);
});

test('removed desktop metadata also forgets the remembered recovery session without resuming it (CHAT-14, ACP-13)', async t => {
	const {service, supervisor, store, project} = await fixture(t, true);
	const thread = seed(project, {nanocoderSessionId: 'fake-session'});
	store.threads.save(thread);
	await service.openThread({projectId: project.id, threadId: thread.id});
	await service.removeThread({projectId: project.id, threadId: thread.id});
	await supervisor.stop(project.id);
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	await t.notThrowsAsync(
		service.restore(project, connection, new AbortController().signal),
	);
	t.false(
		fakeEvents(connection.stderr.lines()).some(
			event =>
				typeof event.method === 'string' && event.method.startsWith('session/'),
		),
	);
});

for (const recovery of [false, true]) {
	test(`${recovery ? 'recovery' : 'ordinary open'} preserves a generated title received during post-resume validation (CHAT-12)`, async t => {
		const {service, supervisor, store, project, notifyTitle} = await fixture(
			t,
			true,
		);
		const thread = seed(project, {nanocoderSessionId: 'fake-session'});
		store.threads.save(thread);
		if (recovery) {
			await service.openThread({projectId: project.id, threadId: thread.id});
			await supervisor.stop(project.id);
		}
		await supervisor.ensureProcess(project);
		const connection = supervisor.getConnection(project.id);
		const originalResume = connection.resumeSession;
		let resumed = false;
		connection.resumeSession = async (...args) => {
			const result = await originalResume(...args);
			resumed = true;
			return result;
		};
		const originalGet = store.projects.get.bind(store.projects);
		let reads = 0;
		store.projects.get = id => {
			const owner = originalGet(id);
			if (resumed && ++reads === 2)
				notifyTitle('fake-session', 'late generated title');
			return owner;
		};
		if (recovery)
			await service.restore(project, connection, new AbortController().signal);
		else await service.openThread({projectId: project.id, threadId: thread.id});
		t.is(
			store.threads.get(project.id, thread.id)?.title,
			'late generated title',
		);
		t.false(store.threads.getTitleManuallySet(project.id, thread.id));
	});
}

for (const action of [
	'archive',
	'rename',
	'remove',
	'delete history',
] as const) {
	test(`thread recovery refuses ${action} of its preparing row (ACP-13, CHAT-12, CHAT-14)`, async t => {
		const {service, supervisor, store, project} = await fixture(t, true);
		const thread = seed(project, {nanocoderSessionId: 'fake-session'});
		store.threads.save(thread);
		const request = {projectId: project.id, threadId: thread.id};
		await service.openThread(request);
		const connection = supervisor.getConnection(project.id);
		const original = connection.resumeSession;
		const entered = deferred<void>();
		const release = deferred<void>();
		connection.resumeSession = async (...args) => {
			const result = await original(...args);
			entered.resolve();
			await release.promise;
			return result;
		};
		const restoring = service.restore(
			project,
			connection,
			new AbortController().signal,
		);
		t.teardown(async () => {
			release.resolve();
			await restoring.catch(() => undefined);
		});
		await entered.promise;
		const mutation =
			action === 'archive'
				? service.archiveThread({...request, archived: true})
				: action === 'rename'
					? service.renameThread({...request, title: 'not saved'})
					: action === 'remove'
						? service.removeThread(request)
						: service.deleteThreadHistory(request);
		await t.throwsAsync(mutation, {instanceOf: IpcFailure, code: 'BUSY'});
	});
}

test('thread recovery refuses a located root or mismatched supplied connection before session resume (ACP-13, CHAT-01)', async t => {
	for (const changed of ['cwd', 'connection-root']) {
		const {root, service, supervisor, store, project} = await fixture(t, true);
		const thread = seed(project, {nanocoderSessionId: 'fake-session'});
		store.threads.save(thread);
		await service.openThread({projectId: project.id, threadId: thread.id});
		await supervisor.stop(project.id);
		const folder = path.join(root, 'located');
		mkdirSync(folder);
		const located = {...project, canonicalRoot: folder, sessionCwd: folder};
		if (changed === 'cwd') {
			store.projects.save(located);
			store.threads.save({...thread, sessionCwd: folder});
		}
		await supervisor.ensureProcess(located);
		const connection = supervisor.getConnection(project.id);
		await t.throwsAsync(
			service.restore(
				changed === 'cwd' ? located : project,
				connection,
				new AbortController().signal,
			),
			{instanceOf: IpcFailure, code: 'DENIED'},
		);
		t.false(
			fakeEvents(connection.stderr.lines()).some(
				event => event.method === 'session/resume',
			),
		);
	}
});

test('thread recovery refuses already-aborted and late-aborted mode results without replacing history (ACP-13)', async t => {
	for (const late of [false, true]) {
		const packets: ProjectEvent[] = [];
		const {service, supervisor, store, project} = await fixture(
			t,
			true,
			event => packets.push(event),
		);
		const thread = seed(project, {nanocoderSessionId: 'fake-session'});
		store.threads.save(thread);
		const request = {projectId: project.id, threadId: thread.id};
		const before = await service.openThread(request);
		const identityScope = {...request, sessionId: 'fake-session'};
		const history = store.threadHistory.read(identityScope);
		const runs = store.agentRuns.list(project.id, thread.id);
		const connection = supervisor.getConnection(project.id);
		const entered = deferred<void>();
		const release = deferred<void>();
		const original = connection.resumeSession;
		connection.resumeSession = async (...args) => {
			const result = await original(...args);
			entered.resolve();
			await release.promise;
			return result;
		};
		const abort = new AbortController();
		if (!late) abort.abort(new Error('cancelled recovery'));
		const restoring = service.restore(project, connection, abort.signal);
		const rejected = t.throwsAsync(restoring, {message: 'cancelled recovery'});
		if (late) {
			await entered.promise;
			abort.abort(new Error('cancelled recovery'));
		}
		release.resolve();
		await rejected;
		const after = await service.getThreadSnapshot(request);
		t.deepEqual(after, {
			...before,
			...(late && {
				sequence: before.sequence + 1,
				replayEpoch: after.replayEpoch,
				replaying: true,
			}),
		});
		assertReplayMarkers(
			t,
			packets.filter(
				event => event.type === 'turn' && event.sequence > before.sequence,
			),
			thread,
			late ? [['begin', before.sequence + 1]] : [],
			late ? after.replayEpoch : undefined,
		);
		if (late) t.not(after.replayEpoch, before.replayEpoch);
		t.deepEqual(store.threadHistory.read(identityScope), history);
		t.deepEqual(store.agentRuns.list(project.id, thread.id), runs);
		t.false(service.activity(project.id).preparing);
	}
});

test('thread detach cancels a reopen queued behind idle stop without a second runtime resolution or spawn (ACP-13)', async t => {
	const {service, supervisor, store, project, clock, calls} = await fixture(
		t,
		true,
		undefined,
		true,
	);
	const thread = seed(project, {nanocoderSessionId: 'fake-session'});
	store.threads.save(thread);
	await service.openThread({projectId: project.id, threadId: thread.id});
	const connection = supervisor.getConnection(project.id);
	const release = deferred<void>();
	const originalClose = connection.close;
	connection.close = async () => {
		await release.promise;
		await originalClose();
	};
	t.teardown(() => release.resolve());
	await service.detach([project]);
	clock.advance(300_000);
	t.is(supervisor.getState(project.id).status, 'stopping');
	const reopened = supervisor.ensureProcess(project).catch(error => error);
	const detached = service.detach([project]);
	release.resolve();
	await detached;
	await reopened;
	t.is(calls.filter(call => call === 'launch').length, 1);
	t.is(supervisor.getState(project.id).status, 'stopped');
	t.is(service.activity(project.id).openSessions, 0);
});

test('thread detached cleanup settles every project even if one stop rejects (ACP-13)', async t => {
	const {root, service, supervisor, store, project} = await fixture(t, true);
	const folder = path.join(root, 'other');
	mkdirSync(folder);
	const other = {
		...project,
		id: randomUUID(),
		canonicalRoot: folder,
		sessionCwd: folder,
	};
	store.projects.save(other);
	const starting = [project, other].map(chosen =>
		supervisor.ensureProcess(chosen),
	);
	const originalStop = supervisor.stop.bind(supervisor);
	t.teardown(() => {
		supervisor.stop = originalStop;
	});
	const stopped: string[] = [];
	supervisor.stop = async id => {
		const state = await originalStop(id);
		stopped.push(id);
		if (id === project.id) throw new Error('fixture cleanup failure');
		return state;
	};
	await service.detach([project, other]);
	await Promise.all(starting);
	t.is(stopped.length, 2);
	t.is(supervisor.getState(project.id).status, 'stopped');
	t.is(supervisor.getState(other.id).status, 'stopped');
});

test('first prompt saves the mode-ready session ID before content is published (CHAT-04)', async t => {
	const events: ProjectEvent[] = [];
	const {project, service, store, supervisor} = await fixture(
		t,
		true,
		event => {
			if (event.type === 'turn') {
				t.truthy(
					store.threads.get(project.id, event.threadId)?.nanocoderSessionId,
				);
				events.push(event);
			}
		},
	);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	connection.prompt = async (sessionId, text) => {
		t.is(
			store.threads.get(project.id, thread.id)?.nanocoderSessionId,
			sessionId,
		);
		t.is(text, 'fixture first prompt');
		return {stopReason: 'end_turn'};
	};
	t.deepEqual(
		await service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'fixture first prompt',
		}),
		{stopReason: 'end_turn'},
	);
	const snapshot = await service.getThreadSnapshot({
		projectId: project.id,
		threadId: thread.id,
	});
	t.is(snapshot.thread.nanocoderSessionId, 'fake-session');
	t.is(snapshot.thread.runState, 'ready');
	t.is(snapshot.thread.title, 'fixture first prompt');
	t.deepEqual(snapshot.events, [{type: 'user', text: 'fixture first prompt'}]);
	t.is(snapshot.replaying, false);
	t.deepEqual(events, [
		{
			type: 'turn',
			projectId: project.id,
			threadId: thread.id,
			sequence: 1,
			events: [{type: 'user', text: 'fixture first prompt'}],
		},
		{
			type: 'turn',
			projectId: project.id,
			threadId: thread.id,
			sequence: 2,
			events: [],
			result: {ok: true, value: {stopReason: 'end_turn'}},
		},
	]);
	await supervisor.close();
	const requests = fakeEvents(connection.stderr.lines()).filter(
		event => typeof event.method === 'string',
	);
	t.deepEqual(
		requests
			.filter(event => String(event.method).startsWith('session/'))
			.map(event => event.method),
		['session/new', 'session/set_mode', 'session/close'],
	);
	t.is(
		(
			requests.find(event => event.method === 'session/set_mode')?.params as
				| {modeId?: string}
				| undefined
		)?.modeId,
		'auto-accept',
	);
});

test('the automatic title is redacted, free of control and bidi characters, and cut on a character boundary (DATA-04)', async t => {
	const [rlo, lri, pdi, bell, emoji] = [0x202e, 0x2066, 0x2069, 7, 0x1f600].map(
		code => String.fromCodePoint(code),
	);
	const cases: Array<[string, string]> = [
		[
			'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 && deploy',
			'export GITHUB_TOKEN=[redacted] && deploy',
		],
		[
			'curl -H "Authorization: Bearer sk-ant-api03-ZZZZZZZZZZZZZZZZ"',
			'curl -H "Authorization: [redacted]"',
		],
		[
			`${rlo}fdp.exe${lri} is${pdi} the${bell} file\n\tnow`,
			'fdp.exe is the file now',
		],
		['a'.repeat(79) + emoji + emoji, 'a'.repeat(79) + emoji],
		[`${rlo}${bell}`, 'new thread'],
	];
	for (const [text, title] of cases) {
		const {project, service, supervisor} = await fixture(t, true);
		await supervisor.ensureProcess(project);
		supervisor.getConnection(project.id).prompt = async () => ({
			stopReason: 'end_turn',
		});
		const {id} = await service.createThread({projectId: project.id});
		await service.promptThread({projectId: project.id, threadId: id, text});
		const snapshot = await service.getThreadSnapshot({
			projectId: project.id,
			threadId: id,
		});
		t.is(snapshot.thread.title, title);
		await supervisor.close();
	}
});

test('unknown project cannot create a thread (CHAT-03)', async t => {
	const {service, calls} = await fixture(t);
	const error = await t.throwsAsync(
		service.createThread({projectId: randomUUID()}),
		{instanceOf: IpcFailure},
	);
	t.is((error as IpcFailure).code, 'NOT_FOUND');
	t.deepEqual(calls, []);
});

test('thread lists are activity-ordered, project-scoped and archive-separated (CHAT-03, CHAT-13)', async t => {
	const {root, project, store, service, calls} = await fixture(t);
	const earlier = seed(project);
	const today = seed(project, {
		lastActivityAt: '2026-10-30T12:00:00.000Z',
	});
	const archived = seed(project, {archiveState: 'archived'});
	const otherRoot = path.join(root, 'other');
	mkdirSync(otherRoot);
	const other = {
		...project,
		id: randomUUID(),
		canonicalRoot: otherRoot,
		sessionCwd: otherRoot,
	};
	store.projects.save(other);
	for (const thread of [earlier, today, archived, seed(other)])
		store.threads.save(thread);
	t.deepEqual(
		await service.listThreads({projectId: project.id, archiveState: 'active'}),
		[today, earlier],
	);
	t.deepEqual(
		await service.listThreads({
			projectId: project.id,
			archiveState: 'archived',
		}),
		[archived],
	);
	t.deepEqual(calls, []);
});

test('archive and unarchive change only desktop metadata (CHAT-13)', async t => {
	const {project, service, store, calls} = await fixture(t);
	const thread = seed(project);
	store.threads.save(thread);
	const request = {projectId: project.id, threadId: thread.id};
	t.deepEqual(await service.archiveThread({...request, archived: true}), {
		...thread,
		archiveState: 'archived',
	});
	t.deepEqual(store.threads.list(project.id, 'active'), []);
	t.deepEqual(
		await service.archiveThread({...request, archived: false}),
		thread,
	);
	t.deepEqual(store.threads.list(project.id, 'archived'), []);
	t.deepEqual(calls, []);
});

test('remove keeps upstream history and cleans only the removed desktop selection (CHAT-14, DATA-07)', async t => {
	const {project, service, store, calls} = await fixture(t);
	const thread = seed(project);
	const kept = seed(project);
	store.threads.save(thread);
	store.threads.save(kept);
	store.updateUiState({
		activeProjectId: project.id,
		activeThreadId: thread.id,
		openThreadIds: [thread.id, kept.id],
	});
	t.is(
		await service.removeThread({projectId: project.id, threadId: thread.id}),
		null,
	);
	t.is(store.threads.get(project.id, thread.id), undefined);
	t.deepEqual(store.threads.get(project.id, kept.id), kept);
	t.is(store.getUiState().activeProjectId, project.id);
	t.is(store.getUiState().activeThreadId, null);
	t.deepEqual(store.getUiState().openThreadIds, [kept.id]);
	t.deepEqual(calls, []);
});

test('cross-project thread mutations refuse before any side effect (CHAT-14)', async t => {
	const {root, project, service, store, calls} = await fixture(t);
	const otherRoot = path.join(root, 'other');
	mkdirSync(otherRoot);
	const other = {
		...project,
		id: randomUUID(),
		canonicalRoot: otherRoot,
		sessionCwd: otherRoot,
	};
	store.projects.save(other);
	const thread = seed(other);
	store.threads.save(thread);
	const request = {projectId: project.id, threadId: thread.id};
	for (const work of [
		() => service.archiveThread({...request, archived: true}),
		() => service.removeThread(request),
	]) {
		const error = await t.throwsAsync(work(), {instanceOf: IpcFailure});
		t.is((error as IpcFailure).code, 'NOT_FOUND');
	}
	t.deepEqual(store.threads.get(other.id, thread.id), thread);
	t.deepEqual(calls, []);
});

test('first prompt refuses an untrusted project without starting Nanocoder (CHAT-04, SEC-17)', async t => {
	const {project, service, store, calls} = await fixture(t);
	const thread = await service.createThread({projectId: project.id});
	const error = await t.throwsAsync(
		service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'fixture prompt',
		}),
		{instanceOf: IpcFailure},
	);
	t.is((error as IpcFailure).code, 'DENIED');
	t.is(store.threads.get(project.id, thread.id)?.nanocoderSessionId, null);
	t.deepEqual(calls, []);
});

test('first prompt refuses a moved project root before execution (CHAT-04, SEC-17)', async t => {
	const {project, service, store, calls} = await fixture(t, true);
	const thread = await service.createThread({projectId: project.id});
	renameSync(project.canonicalRoot, `${project.canonicalRoot}-moved`);
	const error = await t.throwsAsync(
		service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'fixture prompt',
		}),
		{instanceOf: IpcFailure},
	);
	t.is((error as IpcFailure).code, 'DENIED');
	t.is(store.threads.get(project.id, thread.id)?.nanocoderSessionId, null);
	t.deepEqual(calls, []);
});

test('failed mode preparation stores no session and publishes no content (CHAT-04, DEC-31)', async t => {
	const events: ProjectEvent[] = [];
	const {project, service, store} = await fixture(t, true, event => {
		if (event.type === 'turn') events.push(event);
	});
	writeFileSync(
		path.join(project.canonicalRoot, '.fake-nanocoder'),
		'mode-fails',
	);
	const thread = await service.createThread({projectId: project.id});
	const error = await t.throwsAsync(
		service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'fixture prompt',
		}),
		{instanceOf: IpcFailure},
	);
	t.is((error as IpcFailure).code, 'AGENT_UNAVAILABLE');
	t.is(store.threads.get(project.id, thread.id)?.nanocoderSessionId, null);
	t.deepEqual(events, []);
});

test('concurrent first sends cannot create two sessions in one project (CHAT-04, DEC-07)', async t => {
	const {project, service, supervisor} = await fixture(t, true);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	const entered = deferred<void>();
	const release = deferred<void>();
	const original = connection.newSession;
	let creations = 0;
	connection.newSession = async mode => {
		creations++;
		if (creations > 1) throw new Error('Duplicate session preparation');
		entered.resolve();
		await release.promise;
		return original(mode);
	};
	connection.prompt = async () => ({stopReason: 'end_turn'});
	const request = {
		projectId: project.id,
		threadId: thread.id,
		text: 'fixture prompt',
	};
	const first = service.promptThread(request);
	const handled = first.catch(() => undefined);
	await entered.promise;
	let error: Error | undefined;
	try {
		error = await t.throwsAsync(service.promptThread(request), {
			instanceOf: IpcFailure,
		});
	} finally {
		release.resolve();
		await handled;
	}
	t.is((error as IpcFailure).code, 'BUSY');
	t.is(creations, 1);
	t.deepEqual(await first, {stopReason: 'end_turn'});
});

test('live updates map only the saved session to its desktop thread (CHAT-04)', async t => {
	const events: ProjectEvent[] = [];
	const {project, service, supervisor, notify} = await fixture(
		t,
		true,
		event => {
			if (event.type === 'turn') events.push(event);
		},
	);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	supervisor.getConnection(project.id).prompt = async () => {
		notify('foreign-session', 'must not appear');
		notify('fake-session', 'fixture response');
		return {stopReason: 'end_turn'};
	};
	const request = {
		projectId: project.id,
		threadId: thread.id,
		text: 'fixture prompt',
	};
	await service.promptThread(request);
	const snapshot = await service.getThreadSnapshot(request);
	t.deepEqual(snapshot.events, [
		{type: 'user', text: 'fixture prompt'},
		{type: 'text', text: 'fixture response'},
	]);
	t.is(snapshot.sequence, 3);
	t.deepEqual(
		events.map(event => event.sequence),
		[1, 2, 3],
	);
	t.true(
		events.every(
			event => event.type === 'turn' && event.threadId === thread.id,
		),
	);
});

test('the next prompt preserves a generated title accepted during preparation (CHAT-12)', async t => {
	const {project, service, store, supervisor, notifyTitle} = await fixture(
		t,
		true,
	);
	const thread = await service.createThread({projectId: project.id});
	const request = {projectId: project.id, threadId: thread.id};
	await supervisor.ensureProcess(project);
	supervisor.getConnection(project.id).prompt = async () => ({
		stopReason: 'end_turn',
	});
	await service.promptThread({...request, text: 'first synthetic task'});
	const previous = store.threads.get(project.id, thread.id);
	if (!previous?.nanocoderSessionId) throw new Error('Missing saved session');
	const sessionId = previous.nanocoderSessionId;
	const ensure = supervisor.ensureProcess.bind(supervisor);
	supervisor.ensureProcess = async chosen => {
		const result = await ensure(chosen);
		notifyTitle(sessionId, 'generated between turns');
		t.is(
			store.threads.get(project.id, thread.id)?.title,
			'generated between turns',
		);
		return result;
	};
	await service.promptThread({...request, text: 'second synthetic task'});
	t.like(store.threads.get(project.id, thread.id), {
		...previous,
		title: 'generated between turns',
	});
	t.false(store.threads.getTitleManuallySet(project.id, thread.id));
});

test('recovery preserves a generated title accepted after its final async owner check (CHAT-12)', async t => {
	const {project, service, store, supervisor, notifyTitle} = await fixture(
		t,
		true,
	);
	const thread = seed(project, {nanocoderSessionId: 'fake-session'});
	store.threads.save(thread);
	const request = {projectId: project.id, threadId: thread.id};
	await service.openThread(request);
	await supervisor.stop(project.id);
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	const resume = connection.resumeSession;
	let resumed = false;
	connection.resumeSession = async (...args) => {
		const result = await resume(...args);
		resumed = true;
		return result;
	};
	const get = store.threads.get.bind(store.threads);
	let reads = 0;
	let accepted = false;
	store.threads.get = (projectId, threadId) => {
		const current = get(projectId, threadId);
		if (resumed && ++reads === 2)
			queueMicrotask(() => {
				notifyTitle('fake-session', 'generated after recovery check');
				accepted =
					get(project.id, thread.id)?.title ===
					'generated after recovery check';
			});
		return current;
	};
	await service.restore(project, connection, new AbortController().signal);
	t.true(accepted);
	t.like(get(project.id, thread.id), {
		...thread,
		title: 'generated after recovery check',
	});
});

for (const delivery of ['metadata', 'success terminal', 'failure terminal']) {
	test(`turn state preserves a generated title accepted by the ${delivery} listener (CHAT-12)`, async t => {
		let observe: ((event: ProjectEvent) => void) | undefined;
		const {project, service, store, supervisor, notifyTitle} = await fixture(
			t,
			true,
			event => observe?.(event),
		);
		const thread = await service.createThread({projectId: project.id});
		const request = {projectId: project.id, threadId: thread.id};
		await supervisor.ensureProcess(project);
		const connection = supervisor.getConnection(project.id);
		connection.prompt = async () => ({stopReason: 'end_turn'});
		await service.promptThread({...request, text: 'first synthetic task'});
		const previous = store.threads.get(project.id, thread.id);
		if (!previous?.nanocoderSessionId) throw new Error('Missing saved session');
		const sessionId = previous.nanocoderSessionId;
		let accepted = false;
		observe = event => {
			if (
				event.type === 'turn' &&
				(delivery === 'metadata'
					? event.events.some(item => item.type === 'metadata')
					: event.result !== undefined)
			) {
				notifyTitle(sessionId, 'generated at turn end');
				accepted =
					store.threads.get(project.id, thread.id)?.title ===
					'generated at turn end';
			}
		};
		connection.prompt = async () => {
			if (delivery === 'failure terminal')
				throw new NanocoderFailure(
					'AGENT_UNAVAILABLE',
					'Synthetic prompt failed',
				);
			return {stopReason: 'end_turn', metadata: {usage: {totalTokens: 20}}};
		};
		const prompted = service.promptThread({
			...request,
			text: 'second synthetic task',
		});
		if (delivery === 'failure terminal')
			await t.throwsAsync(prompted, {instanceOf: IpcFailure});
		else await prompted;
		t.true(accepted);
		t.like(store.threads.get(project.id, thread.id), {
			...previous,
			runState: delivery === 'failure terminal' ? 'failed' : 'ready',
			title: 'generated at turn end',
		});
	});
}

test('turn completion preserves title metadata updated during the turn (CHAT-12)', async t => {
	const {project, service, store, supervisor} = await fixture(t, true);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	supervisor.getConnection(project.id).prompt = async () => {
		const current = store.threads.get(project.id, thread.id);
		if (!current) throw new Error('Missing fixture thread');
		store.threads.save({...current, title: 'fixture generated title'});
		return {stopReason: 'end_turn'};
	};
	await service.promptThread({
		projectId: project.id,
		threadId: thread.id,
		text: 'fixture prompt',
	});
	t.is(
		store.threads.get(project.id, thread.id)?.title,
		'fixture generated title',
	);
});

test('archive and remove refuse while the thread is preparing its first session (CHAT-04, CHAT-14)', async t => {
	const {project, service, supervisor} = await fixture(t, true);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	const entered = deferred<void>();
	const release = deferred<void>();
	const original = connection.newSession;
	connection.newSession = async mode => {
		entered.resolve();
		await release.promise;
		return original(mode);
	};
	connection.prompt = async () => ({stopReason: 'end_turn'});
	const request = {projectId: project.id, threadId: thread.id};
	const pending = service
		.promptThread({...request, text: 'fixture prompt'})
		.catch(() => undefined);
	await entered.promise;
	let outcomes: string[];
	try {
		outcomes = await Promise.all(
			[
				service.archiveThread({...request, archived: true}),
				service.removeThread(request),
			].map(work =>
				work.then(
					() => 'allowed',
					(error: IpcFailure) => error.code,
				),
			),
		);
	} finally {
		release.resolve();
		await pending;
	}
	t.deepEqual(outcomes, ['BUSY', 'BUSY']);
});

test('an archived thread cannot accept a prompt (CHAT-13)', async t => {
	const {project, service, supervisor} = await fixture(t, true);
	const thread = await service.createThread({projectId: project.id});
	const request = {projectId: project.id, threadId: thread.id};
	await service.archiveThread({...request, archived: true});
	await supervisor.ensureProcess(project);
	let prompts = 0;
	supervisor.getConnection(project.id).prompt = async () => {
		prompts++;
		return {stopReason: 'end_turn'};
	};
	const error = await t.throwsAsync(
		service.promptThread({...request, text: 'fixture prompt'}),
		{instanceOf: IpcFailure},
	);
	t.is((error as IpcFailure).code, 'DENIED');
	t.is(prompts, 0);
});

test('trust revoked during session preparation prevents content and execution (CHAT-04, SEC-17)', async t => {
	const events: ProjectEvent[] = [];
	const {project, service, store, supervisor} = await fixture(
		t,
		true,
		event => {
			if (event.type === 'turn') events.push(event);
		},
	);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	const original = connection.newSession;
	connection.newSession = async mode => {
		const session = await original(mode);
		store.projects.save({...project, trusted: false});
		return session;
	};
	let prompts = 0;
	connection.prompt = async () => {
		prompts++;
		return {stopReason: 'end_turn'};
	};
	const error = await t.throwsAsync(
		service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'fixture prompt',
		}),
		{instanceOf: IpcFailure},
	);
	t.is((error as IpcFailure).code, 'DENIED');
	t.is(
		store.threads.get(project.id, thread.id)?.nanocoderSessionId,
		'fake-session',
	);
	t.is(prompts, 0);
	t.deepEqual(events, []);
});

test('failed session-ID storage stops the process before content is shown (CHAT-04, DATA-07)', async t => {
	const events: ProjectEvent[] = [];
	const {project, service, store, supervisor} = await fixture(
		t,
		true,
		event => {
			if (event.type === 'turn') events.push(event);
		},
	);
	const thread = await service.createThread({projectId: project.id});
	const original = store.threads.save;
	store.threads.save = value => {
		if (value.nanocoderSessionId)
			throw new IpcFailure('INTERNAL', 'Fixture storage failure');
		original(value);
	};
	try {
		const error = await t.throwsAsync(
			service.promptThread({
				projectId: project.id,
				threadId: thread.id,
				text: 'fixture prompt',
			}),
			{instanceOf: IpcFailure},
		);
		t.is((error as IpcFailure).code, 'INTERNAL');
		t.is(supervisor.getState(project.id).status, 'stopped');
		t.is(store.threads.get(project.id, thread.id)?.nanocoderSessionId, null);
		t.deepEqual(events, []);
	} finally {
		store.threads.save = original;
	}
});

test('session ID survives the process ending immediately after session/new without showing content (CHAT-04)', async t => {
	const events: ProjectEvent[] = [];
	const {root, project, service, store, supervisor} = await fixture(
		t,
		true,
		event => {
			if (event.type === 'turn') events.push(event);
		},
	);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	const original = connection.newSession;
	connection.newSession = async mode => {
		const session = await original(mode);
		await supervisor.stop(project.id);
		return session;
	};
	const error = await t.throwsAsync(
		service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'fixture prompt',
		}),
		{instanceOf: IpcFailure},
	);
	t.is((error as IpcFailure).code, 'AGENT_UNAVAILABLE');
	t.is(
		store.threads.get(project.id, thread.id)?.nanocoderSessionId,
		'fake-session',
	);
	store.close();
	const reopened = await desktopStoreFactory.open({
		databasePath: path.join(root, 'desktop.sqlite'),
		driver: createNodeSqliteDriver(),
	});
	try {
		t.is(
			reopened.threads.get(project.id, thread.id)?.nanocoderSessionId,
			'fake-session',
		);
		t.deepEqual(events, []);
	} finally {
		reopened.close();
	}
});

test('a history confirmation returned after detach cannot launch or delete anything (CHAT-14, ACP-13)', async t => {
	const {service, store, project, calls, confirmDeletion} = await fixture(
		t,
		true,
	);
	const thread = seed(project);
	store.threads.save(thread);
	const entered = deferred<void>();
	const answer = deferred<boolean>();
	confirmDeletion(() => {
		entered.resolve();
		return answer.promise;
	});
	const deleting = service.deleteThreadHistory({
		projectId: project.id,
		threadId: thread.id,
	});
	const rejected = t.throwsAsync(deleting, {
		instanceOf: IpcFailure,
		code: 'AGENT_UNAVAILABLE',
	});
	await entered.promise;
	await service.detach([project]);
	answer.resolve(true);
	await rejected;
	t.deepEqual(calls, ['confirm-delete']);
	t.deepEqual(store.threads.get(project.id, thread.id), thread);
});

for (const action of ['rename', 'delete'] as const) {
	test(`a late upstream ${action} result cannot mutate desktop metadata after detach (CHAT-12, CHAT-14, ACP-13)`, async t => {
		const {service, store, supervisor, project, confirmDeletion} =
			await fixture(t, true);
		const thread = seed(project);
		store.threads.save(thread);
		writeFileSync(
			path.join(project.canonicalRoot, '.fake-nanocoder'),
			'extensions',
		);
		await supervisor.ensureProcess(project);
		const connection = supervisor.getConnection(project.id);
		const entered = deferred<void>();
		const answer = deferred<void>();
		connection.renameSession = async () => {
			entered.resolve();
			await answer.promise;
			return 'late fixture title';
		};
		connection.deleteSession = async () => {
			entered.resolve();
			await answer.promise;
		};
		confirmDeletion(async () => true);
		const request = {projectId: project.id, threadId: thread.id};
		const mutation =
			action === 'rename'
				? service.renameThread({...request, title: 'late fixture title'})
				: service.deleteThreadHistory(request);
		const rejected = t.throwsAsync(mutation, {
			instanceOf: IpcFailure,
			code: 'AGENT_UNAVAILABLE',
		});
		await entered.promise;
		let detached = false;
		const detaching = service.detach([project]).then(() => {
			detached = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		t.false(detached);
		await t.throwsAsync(
			service.runProjectOperation(project.id, 'set-mode', async () => {}),
			{instanceOf: IpcFailure, code: 'BUSY'},
		);
		answer.resolve();
		await detaching;
		await rejected;
		t.deepEqual(store.threads.get(project.id, thread.id), thread);
		t.false(store.threads.getTitleManuallySet(project.id, thread.id));
		t.is(
			(await service.archiveThread({...request, archived: true})).archiveState,
			'archived',
		);
	});
}

test('deleting history needs a separate main confirmation and cancellation starts no process (CHAT-14)', async t => {
	const {project, service, store, calls, confirmDeletion} = await fixture(t);
	const thread = seed(project);
	store.threads.save(thread);
	confirmDeletion(async snapshot => {
		t.deepEqual(snapshot, {project, thread});
		return false;
	});
	t.deepEqual(
		await service.deleteThreadHistory({
			projectId: project.id,
			threadId: thread.id,
		}),
		{status: 'cancelled'},
	);
	t.deepEqual(store.threads.get(project.id, thread.id), thread);
	t.deepEqual(calls, ['confirm-delete']);
});

test('CHAT-17 an open history dialog blocks project mutations but leaves metadata readable and shutdown non-blocking', async t => {
	const f = await fixture(t);
	const thread = seed(f.project);
	const peer = seed(f.project, {nanocoderSessionId: null});
	f.store.threads.save(thread);
	f.store.threads.save(peer);
	const entered = deferred<void>();
	const answer = deferred<boolean>();
	f.confirmDeletion(() => {
		entered.resolve();
		return answer.promise;
	});
	const request = {projectId: f.project.id, threadId: thread.id};
	const peerRequest = {...request, threadId: peer.id};
	const deletion = f.service.deleteThreadHistory(request);
	const refused = t.throwsAsync(deletion, {code: 'AGENT_UNAVAILABLE'});
	await entered.promise;
	for (const attempt of [
		() =>
			f.service.runProjectOperation(f.project.id, 'set-mode', async () => {}),
		() =>
			f.service.runProjectOperation(f.project.id, 'set-config', async () => {}),
		() => f.service.archiveThread({...peerRequest, archived: true}),
		() => f.service.removeThread(peerRequest),
		() => f.service.renameThread({...peerRequest, title: 'not saved'}),
		() => f.service.promptThread({...peerRequest, text: 'not sent'}),
	]) {
		await t.throwsAsync(attempt(), {instanceOf: IpcFailure, code: 'BUSY'});
	}
	t.is((await f.service.getThreadSnapshot(request)).thread.id, thread.id);
	t.is(
		(
			await f.service.listThreads({
				projectId: f.project.id,
				archiveState: 'active',
			})
		).length,
		2,
	);
	await f.service.detach([f.project]);
	await refused;
	t.deepEqual(f.calls, ['confirm-delete']);
	answer.resolve(true);
	t.deepEqual(f.store.threads.get(f.project.id, thread.id), thread);
	t.deepEqual(f.calls, ['confirm-delete']);
});

test('accepted history deletion uses the saved session and removes metadata only after success (CHAT-14, DATA-07)', async t => {
	const {project, service, store, supervisor, confirmDeletion} = await fixture(
		t,
		true,
	);
	const thread = seed(project);
	store.threads.save(thread);
	store.updateUiState({
		activeProjectId: project.id,
		activeThreadId: thread.id,
		openThreadIds: [thread.id],
	});
	confirmDeletion(async () => true);
	await supervisor.ensureProcess(project);
	const deleted: string[] = [];
	supervisor.getConnection(project.id).deleteSession = async sessionId => {
		t.deepEqual(store.threads.get(project.id, thread.id), thread);
		deleted.push(sessionId);
	};
	t.deepEqual(
		await service.deleteThreadHistory({
			projectId: project.id,
			threadId: thread.id,
		}),
		{status: 'deleted'},
	);
	t.deepEqual(deleted, [thread.nanocoderSessionId]);
	t.is(store.threads.get(project.id, thread.id), undefined);
	t.is(store.getUiState().activeThreadId, null);
	t.deepEqual(store.getUiState().openThreadIds, []);
});

test('an upstream history deletion failure preserves the desktop row (CHAT-14)', async t => {
	const {project, service, store, supervisor, confirmDeletion} = await fixture(
		t,
		true,
	);
	const thread = seed(project);
	store.threads.save(thread);
	confirmDeletion(async () => true);
	await supervisor.ensureProcess(project);
	supervisor.getConnection(project.id).deleteSession = async () => {
		throw new NanocoderFailure('AGENT_UNAVAILABLE', 'Fixture delete failed');
	};
	const error = await t.throwsAsync(
		service.deleteThreadHistory({projectId: project.id, threadId: thread.id}),
		{instanceOf: IpcFailure},
	);
	t.is((error as IpcFailure).code, 'AGENT_UNAVAILABLE');
	t.deepEqual(store.threads.get(project.id, thread.id), thread);
});

test('history deletion refuses an unadvertised delete capability (CHAT-14)', async t => {
	const {project, service, store, supervisor, confirmDeletion} = await fixture(
		t,
		true,
	);
	writeFileSync(
		path.join(project.canonicalRoot, '.fake-nanocoder'),
		'no-delete',
	);
	const thread = seed(project);
	store.threads.save(thread);
	confirmDeletion(async () => true);
	const error = await t.throwsAsync(
		service.deleteThreadHistory({projectId: project.id, threadId: thread.id}),
		{instanceOf: IpcFailure},
	);
	t.is((error as IpcFailure).code, 'UNSUPPORTED');
	t.deepEqual(store.threads.get(project.id, thread.id), thread);
	const connection = supervisor.getConnection(project.id);
	await supervisor.close();
	t.false(
		fakeEvents(connection.stderr.lines()).some(
			event => event.method === 'session/delete',
		),
	);
});

test('a history confirmation cannot delete a changed session identity (CHAT-14)', async t => {
	const {project, service, store, calls, confirmDeletion} = await fixture(
		t,
		true,
	);
	const thread = seed(project);
	store.threads.save(thread);
	const changed = {...thread, nanocoderSessionId: 'different-fixture-session'};
	confirmDeletion(async () => {
		store.threads.save(changed);
		return true;
	});
	const error = await t.throwsAsync(
		service.deleteThreadHistory({projectId: project.id, threadId: thread.id}),
		{instanceOf: IpcFailure},
	);
	t.is((error as IpcFailure).code, 'DENIED');
	t.deepEqual(store.threads.get(project.id, thread.id), changed);
	t.deepEqual(calls, ['confirm-delete']);
});

test('a pending history confirmation locks its desktop row against removal (CHAT-14)', async t => {
	const {project, service, store, confirmDeletion} = await fixture(t);
	const thread = seed(project);
	store.threads.save(thread);
	const entered = deferred<void>();
	const answer = deferred<boolean>();
	confirmDeletion(async () => {
		entered.resolve();
		return answer.promise;
	});
	const request = {projectId: project.id, threadId: thread.id};
	const deletion = service.deleteThreadHistory(request);
	void deletion.catch(() => undefined);
	const enteredOrError = await Promise.race([
		entered.promise.then(() => 'entered'),
		deletion.then(
			() => 'finished',
			() => 'failed',
		),
	]);
	let removal: string;
	try {
		removal = await service.removeThread(request).then(
			() => 'allowed',
			(error: IpcFailure) => error.code,
		);
	} finally {
		answer.resolve(false);
		await deletion.catch(() => undefined);
	}
	t.is(enteredOrError, 'entered');
	t.is(removal, 'BUSY');
	t.deepEqual(store.threads.get(project.id, thread.id), thread);
});

test('opening a new thread selects its metadata without starting a session (CHAT-03, CHAT-04)', async t => {
	const {project, service, store, calls} = await fixture(t);
	const thread = await service.createThread({projectId: project.id});
	store.updateUiState({activeThreadId: null, openThreadIds: []});
	t.deepEqual(
		await service.openThread({projectId: project.id, threadId: thread.id}),
		{thread, sequence: 0, replaying: false, events: []},
	);
	t.is(store.getUiState().activeThreadId, thread.id);
	t.deepEqual(store.getUiState().openThreadIds, [thread.id]);
	t.deepEqual(calls, []);
});

test('opening a current session reads its in-memory snapshot without resume (CHAT-03)', async t => {
	const {project, service, supervisor} = await fixture(t, true);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	connection.prompt = async () => ({stopReason: 'end_turn'});
	connection.resumeSession = async () => {
		throw new Error('A current session must not resume again');
	};
	const request = {projectId: project.id, threadId: thread.id};
	await service.promptThread({...request, text: 'fixture prompt'});
	const before = await service.getThreadSnapshot(request);
	t.deepEqual(await service.openThread(request), before);
});

test('opening a missing Nanocoder session keeps its ID and shows unable-to-resume reason (CHAT-04 upstream limit)', async t => {
	const {project, service, store} = await fixture(t, true);
	const thread = seed(project);
	store.threads.save(thread);
	const snapshot = await service.openThread({
		projectId: project.id,
		threadId: thread.id,
	});
	t.is(snapshot.thread.id, thread.id);
	t.is(snapshot.thread.nanocoderSessionId, thread.nanocoderSessionId);
	t.is(snapshot.thread.title, thread.title);
	t.is(snapshot.thread.runState, 'view-only');
	t.is(snapshot.thread.viewOnlyReason, REPLAY_MISSING_REASON);
	t.deepEqual(snapshot.events, []);
	t.deepEqual(store.threads.get(project.id, thread.id), snapshot.thread);
});

test('opening a stored session delegates replay and never restores yolo (CHAT-04, DEC-31)', async t => {
	const events: ProjectEvent[] = [];
	const {project, service, store, supervisor} = await fixture(
		t,
		true,
		event => {
			if (event.type === 'turn') events.push(event);
		},
	);
	const thread = seed(project, {
		nanocoderSessionId: 'fake-session',
		mode: 'yolo',
	});
	store.threads.save(thread);
	const snapshot = await service.openThread({
		projectId: project.id,
		threadId: thread.id,
	});
	t.is(snapshot.thread.nanocoderSessionId, 'fake-session');
	t.is(snapshot.thread.runState, 'ready');
	t.is(snapshot.thread.mode, 'auto-accept');
	t.deepEqual(snapshot.events, [
		{type: 'user', text: 'Earlier question'},
		{type: 'text', text: 'Earlier answer'},
		{
			type: 'tool',
			id: 'old_call',
			title: 'execute_bash: echo old',
			status: 'unknown',
			history: {outcome: 'unknown'},
		},
	]);
	assertReplayMarkers(
		t,
		events,
		thread,
		[
			['begin', 1],
			['complete', 3],
		],
		snapshot.replayEpoch,
	);
	const connection = supervisor.getConnection(project.id);
	await supervisor.close();
	const modes = fakeEvents(connection.stderr.lines())
		.filter(event => event.method === 'session/set_mode')
		.map(event => (event.params as {modeId: string}).modeId);
	t.deepEqual(modes, ['auto-accept']);
});

test('creating a thread keeps the persisted open-tab list bounded (CHAT-03)', async t => {
	const {project, service, store} = await fixture(t);
	const previous = Array.from({length: 100}, () => seed(project));
	for (const thread of previous) store.threads.save(thread);
	store.updateUiState({
		activeProjectId: project.id,
		activeThreadId: previous[0].id,
		openThreadIds: previous.map(thread => thread.id),
	});
	const thread = await service.createThread({projectId: project.id});
	t.deepEqual(store.getUiState().openThreadIds, [
		...previous.slice(1).map(thread => thread.id),
		thread.id,
	]);
	t.is(store.getUiState().activeThreadId, thread.id);
});

test('an unable-to-resume thread refuses prompts without showing new content (CHAT-04 upstream limit)', async t => {
	const events: ProjectEvent[] = [];
	const {project, service, store, calls} = await fixture(t, true, event => {
		if (event.type === 'turn') events.push(event);
	});
	const thread = seed(project, {
		runState: 'view-only',
		viewOnlyReason: 'Fixture history is not available',
	});
	store.threads.save(thread);
	const error = await t.throwsAsync(
		service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'fixture prompt',
		}),
		{instanceOf: IpcFailure},
	);
	t.is((error as IpcFailure).code, 'UNAVAILABLE');
	t.deepEqual(events, []);
	t.deepEqual(calls, []);
});

test('a view-only thread stays view-only with its reason when an explicit open fails generically (CHAT-09)', async t => {
	const {project, service, store, supervisor} = await fixture(t, true);
	const thread = seed(project, {
		nanocoderSessionId: 'fake-session',
		runState: 'view-only',
		viewOnlyReason: REPLAY_MISSING_REASON,
	});
	store.threads.save(thread);
	writeFileSync(
		path.join(project.canonicalRoot, '.fake-nanocoder'),
		'resume-fails',
	);
	const request = {projectId: project.id, threadId: thread.id};
	const opened = await service.openThread(request);
	t.is(opened.thread.runState, 'view-only');
	t.is(opened.thread.viewOnlyReason, REPLAY_MISSING_REASON);
	t.is(opened.thread.nanocoderSessionId, thread.nanocoderSessionId);
	t.is(store.threads.get(project.id, thread.id)?.runState, 'view-only');
	t.is(
		store.threads.get(project.id, thread.id)?.viewOnlyReason,
		REPLAY_MISSING_REASON,
	);
	const error = await t.throwsAsync(
		service.promptThread({...request, text: 'refused'}),
		{instanceOf: IpcFailure},
	);
	t.is((error as IpcFailure).code, 'UNAVAILABLE');
	const methods = fakeEvents(
		supervisor.getConnection(project.id).stderr.lines(),
	).map(event => event.method);
	t.false(methods.includes('session/prompt'));
});

test('generated titles map only saved IDs in their live owning project (CHAT-12)', async t => {
	const {project, service, store, supervisor, notifyTitle, root} =
		await fixture(t, true);
	const thread = seed(project, {nanocoderSessionId: 'fixture-session'});
	store.threads.save(thread);
	const otherRoot = path.join(root, 'other');
	mkdirSync(otherRoot);
	const other = {
		...project,
		id: randomUUID(),
		canonicalRoot: otherRoot,
		sessionCwd: otherRoot,
	};
	store.projects.save(other);
	const otherThread = seed(other, {
		nanocoderSessionId: 'other-fixture-session',
	});
	store.threads.save(otherThread);
	await supervisor.ensureProcess(project);
	notifyTitle('other-fixture-session', 'wrong project title');
	notifyTitle('unknown-fixture-session', 'unknown session title');
	t.deepEqual(store.threads.get(other.id, otherThread.id), otherThread);
	t.deepEqual(store.threads.get(project.id, thread.id), thread);
	notifyTitle('fixture-session', 'fixture generated title');
	t.is(
		store.threads.get(project.id, thread.id)?.title,
		'fixture generated title',
	);
	await supervisor.stop(project.id);
	notifyTitle('fixture-session', 'stale process title');
	t.is(
		(
			await service.getThreadSnapshot({
				projectId: project.id,
				threadId: thread.id,
			})
		).thread.title,
		'fixture generated title',
	);
});

test('renaming a desktop-only thread stores manual metadata without starting Nanocoder (CHAT-12)', async t => {
	const {project, service, store, calls} = await fixture(t);
	const thread = await service.createThread({projectId: project.id});
	const renamed = await service.renameThread({
		projectId: project.id,
		threadId: thread.id,
		title: '  fixture manual title  ',
	});
	t.deepEqual(renamed, {...thread, title: 'fixture manual title'});
	t.deepEqual(store.threads.get(project.id, thread.id), renamed);
	t.true(store.threads.getTitleManuallySet(project.id, thread.id));
	t.deepEqual(calls, []);
});

test('a manual rename survives a first-turn process crash and a later generated title (CHAT-12)', async t => {
	const {project, service, store, supervisor, notifyTitle, root} =
		await fixture(t, true);
	const thread = await service.createThread({projectId: project.id});
	const target = {projectId: project.id, threadId: thread.id};
	await service.renameThread({...target, title: 'fixture manual title'});
	const modeFile = path.join(project.canonicalRoot, '.fake-nanocoder');
	writeFileSync(modeFile, 'die-in-turn');
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	await t.throwsAsync(
		service.promptThread({...target, text: 'fixture first turn'}),
		{code: 'AGENT_UNAVAILABLE'},
	);
	t.is((await connection.exited).code, 3);
	await supervisor.stop(project.id);
	service.dispose();
	store.close();
	const reopened = await desktopStoreFactory.open({
		databasePath: path.join(root, 'desktop.sqlite'),
		driver: createNodeSqliteDriver(),
	});
	const restored = createThreadService({store: reopened, supervisor});
	t.teardown(() => {
		restored.dispose();
		reopened.close();
	});
	t.true(reopened.threads.getTitleManuallySet(project.id, thread.id));
	t.is(
		reopened.threads.get(project.id, thread.id)?.title,
		'fixture manual title',
	);
	writeFileSync(modeFile, 'ok');
	await supervisor.ensureProcess(project);
	notifyTitle('fake-session', 'late generated title');
	const snapshot = await restored.getThreadSnapshot(target);
	t.is(snapshot.thread.title, 'fixture manual title');
	t.is(snapshot.thread.nanocoderSessionId, 'fake-session');
	t.deepEqual(snapshot.events, []);
});

test('a manual title equal to the new-thread label is not replaced by first-prompt text (CHAT-12)', async t => {
	const {project, service, supervisor} = await fixture(t, true);
	const thread = await service.createThread({projectId: project.id});
	const target = {projectId: project.id, threadId: thread.id};
	await service.renameThread({...target, title: 'new thread'});
	await supervisor.ensureProcess(project);
	supervisor.getConnection(project.id).prompt = async () => ({
		stopReason: 'end_turn',
	});
	await service.promptThread({...target, text: 'fixture first turn'});
	t.is((await service.getThreadSnapshot(target)).thread.title, 'new thread');
});

test('renaming saved history uses its probed session and wins over generated titles (CHAT-12)', async t => {
	const {project, service, store, supervisor, notifyTitle} = await fixture(
		t,
		true,
	);
	const thread = seed(project);
	store.threads.save(thread);
	writeFileSync(
		path.join(project.canonicalRoot, '.fake-nanocoder'),
		'extensions',
	);
	await supervisor.ensureProcess(project);
	const calls: unknown[] = [];
	supervisor.getConnection(project.id).renameSession = async (
		sessionId,
		title,
	) => {
		calls.push({sessionId, title});
		t.false(store.threads.getTitleManuallySet(project.id, thread.id));
		notifyTitle(sessionId, 'in-flight generated title');
		return 'fixture renamed title';
	};
	const renamed = await service.renameThread({
		projectId: project.id,
		threadId: thread.id,
		title: ' fixture manual title ',
	});
	t.deepEqual(calls, [
		{sessionId: thread.nanocoderSessionId, title: 'fixture manual title'},
	]);
	t.deepEqual(renamed, {...thread, title: 'fixture renamed title'});
	t.true(store.threads.getTitleManuallySet(project.id, thread.id));
	notifyTitle(thread.nanocoderSessionId ?? '', 'late generated title');
	t.deepEqual(store.threads.get(project.id, thread.id), renamed);
});

test('history rename refuses an unprobed extension without changing local metadata (CHAT-12)', async t => {
	const {project, service, store, supervisor} = await fixture(t, true);
	const thread = seed(project);
	store.threads.save(thread);
	await supervisor.ensureProcess(project);
	let called = false;
	supervisor.getConnection(project.id).renameSession = async () => {
		called = true;
		return 'unexpected title';
	};
	await t.throwsAsync(
		service.renameThread({
			projectId: project.id,
			threadId: thread.id,
			title: 'fixture manual title',
		}),
		{code: 'UNSUPPORTED'},
	);
	t.false(called);
	t.deepEqual(store.threads.get(project.id, thread.id), thread);
	t.false(store.threads.getTitleManuallySet(project.id, thread.id));
});

test('a rejected upstream rename preserves the local title and automatic flag (CHAT-12)', async t => {
	const {project, service, store, supervisor} = await fixture(t, true);
	const thread = seed(project);
	store.threads.save(thread);
	writeFileSync(
		path.join(project.canonicalRoot, '.fake-nanocoder'),
		'extensions',
	);
	await supervisor.ensureProcess(project);
	supervisor.getConnection(project.id).renameSession = async () => {
		throw new NanocoderFailure('AGENT_UNAVAILABLE', 'fixture rename failed');
	};
	await t.throwsAsync(
		service.renameThread({
			projectId: project.id,
			threadId: thread.id,
			title: 'fixture manual title',
		}),
		{code: 'AGENT_UNAVAILABLE'},
	);
	t.deepEqual(store.threads.get(project.id, thread.id), thread);
	t.false(store.threads.getTitleManuallySet(project.id, thread.id));
});

test('a late rename answer cannot update a changed session identity (CHAT-12)', async t => {
	const {project, service, store, supervisor} = await fixture(t, true);
	const thread = seed(project);
	store.threads.save(thread);
	writeFileSync(
		path.join(project.canonicalRoot, '.fake-nanocoder'),
		'extensions',
	);
	await supervisor.ensureProcess(project);
	const changed = {...thread, nanocoderSessionId: 'changed-fixture-session'};
	supervisor.getConnection(project.id).renameSession = async () => {
		store.threads.save(changed);
		return 'fixture manual title';
	};
	await t.throwsAsync(
		service.renameThread({
			projectId: project.id,
			threadId: thread.id,
			title: 'fixture manual title',
		}),
		{code: 'DENIED'},
	);
	t.deepEqual(store.threads.get(project.id, thread.id), changed);
	t.false(store.threads.getTitleManuallySet(project.id, thread.id));
});

test('a pending upstream rename locks the desktop row until its answer (CHAT-12)', async t => {
	const {project, service, store, supervisor} = await fixture(t, true);
	const thread = seed(project);
	store.threads.save(thread);
	writeFileSync(
		path.join(project.canonicalRoot, '.fake-nanocoder'),
		'extensions',
	);
	await supervisor.ensureProcess(project);
	const entered = deferred<void>();
	const answer = deferred<string>();
	supervisor.getConnection(project.id).renameSession = async () => {
		entered.resolve();
		return answer.promise;
	};
	const target = {projectId: project.id, threadId: thread.id};
	const rename = service.renameThread({
		...target,
		title: 'fixture manual title',
	});
	void rename.catch(() => undefined);
	const state = await Promise.race([
		entered.promise.then(() => 'entered'),
		rename.then(
			() => 'finished',
			() => 'failed',
		),
	]);
	let removal: string;
	try {
		removal = await service.removeThread(target).then(
			() => 'allowed',
			(error: IpcFailure) => error.code,
		);
	} finally {
		answer.resolve('fixture manual title');
		await rename.catch(() => undefined);
	}
	t.is(state, 'entered');
	t.is(removal, 'BUSY');
	t.true(store.threads.getTitleManuallySet(project.id, thread.id));
});

test('an invalid stored-history title is refused before any process starts (CHAT-12)', async t => {
	const {project, service, store, calls} = await fixture(t, true);
	const thread = seed(project);
	store.threads.save(thread);
	for (const title of ['', '   ', 't'.repeat(501)])
		await t.throwsAsync(
			service.renameThread({
				projectId: project.id,
				threadId: thread.id,
				title,
			}),
			{code: 'VALIDATION'},
		);
	t.deepEqual(calls, []);
	t.deepEqual(store.threads.get(project.id, thread.id), thread);
});

test('project thread and supervisor metadata share one scoped sequence and cloned payloads (CHAT-03)', async t => {
	const {project, supervisor} = await fixture(t, true);
	const thread = seed(project);
	const changed = {...thread, title: 'fixture changed title'};
	const events: ProjectEvent[] = [];
	supervisor.subscribe(event => {
		if (event.type === 'thread') event.thread.title = 'listener mutation';
	});
	supervisor.subscribe(event => events.push(event));
	supervisor.announceProject(project);
	supervisor.publishThread(thread);
	await supervisor.ensureProcess(project);
	supervisor.publishThread(changed);
	supervisor.publishThreadRemoved(project.id, thread.id);
	supervisor.replayState(project.id);
	t.deepEqual(
		events.flatMap(event => (event.type === 'thread' ? [event.thread] : [])),
		[thread, changed],
	);
	t.true(events.some(event => event.type === 'project'));
	t.true(events.some(event => event.type === 'supervisor'));
	t.deepEqual(
		events.flatMap(event =>
			event.type === 'thread-removed' ? [event.threadId] : [],
		),
		[thread.id],
	);
	t.deepEqual(
		events.map(event => event.sequence),
		Array.from({length: events.length}, (_, index) => index + 1),
	);
	const other = {...project, id: randomUUID()};
	const otherId = randomUUID();
	supervisor.announceProject(other);
	supervisor.publishThreadRemoved(other.id, otherId);
	t.deepEqual(
		events
			.filter(event => event.projectId === other.id)
			.map(event => event.sequence),
		[1, 2],
	);
	t.is(thread.title, 'fixture thread');
});

test('thread metadata operations publish stored changes and a distinct removal event (CHAT-03, CHAT-12, CHAT-13, CHAT-14)', async t => {
	const {project, service, supervisor, calls} = await fixture(t);
	const events: ProjectEvent[] = [];
	supervisor.subscribe(event => events.push(event));
	const created = await service.createThread({projectId: project.id});
	const target = {projectId: project.id, threadId: created.id};
	const renamed = await service.renameThread({
		...target,
		title: 'fixture renamed',
	});
	const archived = await service.archiveThread({...target, archived: true});
	await service.removeThread(target);
	t.deepEqual(
		events.flatMap(event => (event.type === 'thread' ? [event.thread] : [])),
		[created, renamed, archived],
	);
	t.deepEqual(
		events.map(event => event.type),
		['thread', 'thread', 'thread', 'thread-removed'],
	);
	t.deepEqual(
		events.map(event => event.sequence),
		[1, 2, 3, 4],
	);
	t.like(events[3], {...target, type: 'thread-removed'});
	t.deepEqual(calls, []);
});

for (const deferStderr of [false, true]) {
	const suffix = deferStderr ? ' with deferred stderr' : '';
	test(`owned hooks receive safe saved sessions and run before first prompt on the same lease${suffix}`, async t => {
		const seen: string[] = [];
		const entered = deferred<void>();
		const received = deferred<void>();
		const chunks: string[] = [];
		const matchesMode = (event: Record<string, unknown>) => {
			const params = event.params as
				| {sessionId?: string; modeId?: string}
				| undefined;
			return (
				event.method === 'session/set_mode' &&
				params?.sessionId === 'fake-session' &&
				params.modeId === 'auto-accept'
			);
		};
		let preparedLease!: ProjectOperationLease;
		const {service, project, supervisor, store} = await fixture(
			t,
			true,
			undefined,
			false,
			{
				onSessionPrepared: async context => {
					const check = () => {
						service.projectOperations.assertCurrent(context.lease);
						t.true(service.projectOperations.isBusy(project.id));
						t.is(context.source, 'new');
						t.is(context.connection, supervisor.getConnection(project.id));
						t.is(context.thread.nanocoderSessionId, 'fake-session');
						t.is(
							store.threads.get(project.id, context.thread.id)
								?.nanocoderSessionId,
							'fake-session',
						);
					};
					check();
					preparedLease = context.lease;
					const observed = waitForFakeEvent(context.connection, matchesMode);
					entered.resolve();
					await observed;
					check();
					t.true(
						fakeEvents(context.connection.stderr.lines()).some(matchesMode),
					);
					seen.push('prepared');
				},
				beforeFirstPrompt: async context => {
					service.projectOperations.assertCurrent(context.lease);
					t.is(context.lease, preparedLease);
					await t.throwsAsync(
						service.projectOperations.runProjectOperation(
							project.id,
							'controls',
							async () => {
								t.fail('A hook must not reacquire the project lease');
							},
						),
						{code: 'BUSY'},
					);
					seen.push('before');
				},
			},
		);
		const thread = await service.createThread({projectId: project.id});
		await supervisor.ensureProcess(project);
		const connection = supervisor.getConnection(project.id);
		connection.prompt = async () => {
			seen.push('prompt');
			return {stopReason: 'end_turn'};
		};
		const write = connection.stderr.write;
		let holding = deferStderr;
		if (deferStderr)
			connection.stderr.write = chunk => {
				if (!holding) {
					write.call(connection.stderr, chunk);
					return;
				}
				chunks.push(chunk);
				if (fakeEvents(chunks.join('').split('\n')).some(matchesMode))
					received.resolve();
			};
		const request = {
			projectId: project.id,
			threadId: thread.id,
			text: 'fixture send',
		};
		try {
			const prompting = service.promptThread(request);
			if (deferStderr) {
				await Promise.race([
					Promise.all([entered.promise, received.promise]),
					prompting,
				]);
				t.false(fakeEvents(connection.stderr.lines()).some(matchesMode));
				t.deepEqual(seen, []);
				t.true(service.projectOperations.isBusy(project.id));
				holding = false;
				for (const chunk of chunks.splice(0)) connection.stderr.write(chunk);
			}
			await prompting;
			await service.promptThread(request);
			t.deepEqual(seen, ['prepared', 'before', 'prompt', 'prompt']);
			t.false(service.projectOperations.isBusy(project.id));
		} finally {
			holding = false;
			connection.stderr.write = write;
		}
	});
}

test('a pending yolo choice dropped after safe preparation visibly refuses instead of prompting normally', async t => {
	const events: ProjectEvent[] = [];
	let pending: ThreadInfo['mode'] | undefined = 'yolo';
	let validated = false;
	const {service, project, store, supervisor} = await fixture(
		t,
		true,
		event => events.push(event),
		false,
		{
			resolveLiveMode: (_project, _thread, sessionId) =>
				sessionId === null ? pending : 'normal',
			validateBeforePrepare: () => {
				t.is(pending, 'yolo');
				validated = true;
			},
			onSessionPrepared: context => {
				t.true(validated);
				t.is(context.session.mode, 'normal');
				pending = undefined;
			},
			beforeFirstPrompt: context => {
				t.is(context.session.mode, 'normal');
				t.is(context.thread.mode, 'normal');
				if (pending === undefined)
					throw new IpcFailure('DENIED', 'Confirm the yolo choice again');
			},
		},
	);
	store.projects.save({...project, defaultMode: 'normal'});
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	let prompts = 0;
	supervisor.getConnection(project.id).prompt = async () => {
		prompts++;
		return {stopReason: 'end_turn'};
	};
	await t.throwsAsync(
		service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'never sent',
		}),
		{
			code: 'DENIED',
			message: 'Confirm the yolo choice again',
		},
	);
	t.true(validated);
	t.is(prompts, 0);
	t.false(events.some(event => event.type === 'turn'));
	t.is(
		store.threads.get(project.id, thread.id)?.nanocoderSessionId,
		'fake-session',
	);
});

test('the before-first-prompt hook applied mode is preserved by the fresh running-row patch', async t => {
	let liveMode: ThreadInfo['mode'] = 'auto-accept';
	let publishedMode: ThreadInfo['mode'] | undefined;
	const {service, project, store, supervisor} = await fixture(
		t,
		true,
		event => {
			if (event.type === 'thread' && event.thread.runState === 'running')
				publishedMode = event.thread.mode;
		},
		false,
		{
			resolveLiveMode: () => liveMode,
			beforeFirstPrompt: context => {
				service.projectOperations.assertCurrent(context.lease);
				liveMode = 'yolo';
			},
		},
	);
	const save = store.threads.save;
	store.threads.save = thread => {
		t.not(thread.mode, 'yolo');
		save(thread);
	};
	supervisor.subscribe(event => {
		if (event.type === 'thread' && event.thread.runState === 'running')
			publishedMode = event.thread.mode;
	});
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	let sentMode: string | undefined;
	supervisor.getConnection(project.id).prompt = async () => {
		sentMode = liveMode;
		return {stopReason: 'end_turn'};
	};
	await service.promptThread({
		projectId: project.id,
		threadId: thread.id,
		text: 'fixture send',
	});
	t.is(sentMode, 'yolo');
	t.is(publishedMode, 'yolo');
	t.is(
		(
			await service.getThreadSnapshot({
				projectId: project.id,
				threadId: thread.id,
			})
		).thread.mode,
		'yolo',
	);
	t.is(store.threads.get(project.id, thread.id)?.mode, 'auto-accept');
});

test('a failed prepared-session handoff keeps saved identity but publishes no prompt content', async t => {
	const events: ProjectEvent[] = [];
	const {service, project, store, supervisor} = await fixture(
		t,
		true,
		event => events.push(event),
		false,
		{
			onSessionPrepared: () => {
				throw new IpcFailure('UNSUPPORTED', 'Current offers are unavailable');
			},
		},
	);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	supervisor.getConnection(project.id).prompt = async () => ({
		stopReason: 'end_turn',
	});
	await t.throwsAsync(
		service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'never sent',
		}),
		{
			code: 'UNSUPPORTED',
			message: 'Current offers are unavailable',
		},
	);
	t.is(
		store.threads.get(project.id, thread.id)?.nanocoderSessionId,
		'fake-session',
	);
	t.false(events.some(event => event.type === 'turn'));
	t.false(service.projectOperations.isBusy(project.id));
});

test('pending choice validation refuses inside the lease before any process preparation', async t => {
	const {service, project, supervisor, calls, store} = await fixture(
		t,
		true,
		undefined,
		false,
		{
			validateBeforePrepare: (lease, thread) => {
				service.projectOperations.assertCurrent(lease);
				t.is(thread.nanocoderSessionId, null);
				throw new IpcFailure('DENIED', 'The pending yolo choice expired');
			},
		},
	);
	const thread = await service.createThread({projectId: project.id});
	let preparations = 0;
	supervisor.ensureProcess = async () => {
		preparations++;
		throw new IpcFailure('UNSUPPORTED', 'Preparation must not run');
	};
	await t.throwsAsync(
		service.promptThread({
			projectId: project.id,
			threadId: thread.id,
			text: 'never sent',
		}),
		{
			code: 'DENIED',
			message: 'The pending yolo choice expired',
		},
	);
	t.is(preparations, 0);
	t.deepEqual(calls, []);
	t.is(store.threads.get(project.id, thread.id)?.nanocoderSessionId, null);
});

test('a failed live mode change makes the next send resume safely instead of prompting an unready session', async t => {
	let ready = true;
	let before = 0;
	const sources: string[] = [];
	const {service, project, supervisor} = await fixture(
		t,
		true,
		undefined,
		false,
		{
			onSessionPrepared: context => {
				sources.push(context.source);
			},
			beforeFirstPrompt: () => {
				if (++before === 1) {
					ready = false;
					throw new IpcFailure(
						'AGENT_UNAVAILABLE',
						'The requested mode failed',
					);
				}
			},
		},
	);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	Object.assign(connection, {
		getSessionOffers: () =>
			ready ? {offeredModes: ['normal'], configOptions: undefined} : undefined,
	});
	const resume = connection.resumeSession;
	let resumed = 0;
	connection.resumeSession = async (...args) => {
		resumed++;
		const restored = await resume(...args);
		ready = true;
		return restored;
	};
	const sentReadiness: boolean[] = [];
	connection.prompt = async () => {
		sentReadiness.push(ready);
		return {stopReason: 'end_turn'};
	};
	const request = {
		projectId: project.id,
		threadId: thread.id,
		text: 'fixture send',
	};
	await t.throwsAsync(service.promptThread(request), {
		code: 'AGENT_UNAVAILABLE',
	});
	await service.promptThread(request);
	t.is(resumed, 1);
	t.deepEqual(sources, ['new', 'resume']);
	t.deepEqual(sentReadiness, [true]);
});

test('opening a cached session with missing ready offers safely resumes the same saved ID', async t => {
	const {service, project, store, supervisor} = await fixture(t, true);
	const thread = seed(project, {nanocoderSessionId: 'fake-session'});
	store.threads.save(thread);
	const request = {projectId: project.id, threadId: thread.id};
	await service.openThread(request);
	const connection = supervisor.getConnection(project.id);
	let ready = false;
	Object.assign(connection, {
		getSessionOffers: () => (ready ? {offeredModes: ['normal']} : undefined),
	});
	const resume = connection.resumeSession;
	let resumed = 0;
	connection.resumeSession = async (id, mode) => {
		t.is(id, 'fake-session');
		resumed++;
		const restored = await resume(id, mode);
		ready = true;
		return restored;
	};
	await service.openThread(request);
	t.is(resumed, 1);
	t.true(ready);
	t.is(
		store.threads.get(project.id, thread.id)?.nanocoderSessionId,
		'fake-session',
	);
});

test('a cleared live-mode cache forces safe normal resume before the next prompt on the same connection', async t => {
	let liveMode: ThreadInfo['mode'] | undefined;
	let first = true;
	const {service, project, store, supervisor} = await fixture(
		t,
		true,
		undefined,
		false,
		{
			resolveLiveMode: (_project, _thread, sessionId) =>
				sessionId ? liveMode : undefined,
			onSessionPrepared: context => {
				liveMode = context.session.mode;
			},
			beforeFirstPrompt: () => {
				if (first) {
					liveMode = 'yolo';
					first = false;
				}
			},
		},
	);
	store.projects.save({...project, defaultMode: 'normal'});
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	Object.assign(connection, {
		getSessionOffers: () => ({offeredModes: ['normal', 'yolo']}),
	});
	const resume = connection.resumeSession;
	let resumed = 0;
	connection.resumeSession = async (...args) => {
		resumed++;
		return resume(...args);
	};
	const sentModes: Array<ThreadInfo['mode'] | undefined> = [];
	connection.prompt = async () => {
		sentModes.push(liveMode);
		return {stopReason: 'end_turn'};
	};
	const request = {
		projectId: project.id,
		threadId: thread.id,
		text: 'fixture send',
	};
	await service.promptThread(request);
	liveMode = undefined;
	await service.promptThread(request);
	t.is(resumed, 1);
	t.deepEqual(sentModes, ['yolo', 'normal']);
	t.deepEqual(
		fakeEvents(connection.stderr.lines())
			.filter(event => event.method === 'session/set_mode')
			.map(event => (event.params as {modeId: string}).modeId),
		['normal', 'normal'],
	);
	t.is(store.threads.get(project.id, thread.id)?.mode, 'normal');
});

test('failed preparation never marks an attempt prepared before a later safe attempt', async t => {
	let attempt = 0;
	const preparedAttempts: number[] = [];
	const {service, project, supervisor} = await fixture(
		t,
		true,
		undefined,
		false,
		{
			validateBeforePrepare: () => {
				attempt++;
			},
			onSessionPrepared: () => {
				preparedAttempts.push(attempt);
			},
		},
	);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	const create = connection.newSession;
	let creation = 0;
	connection.newSession = async mode => {
		if (++creation === 1)
			throw new IpcFailure('UNSUPPORTED', 'Safe mode was not acknowledged');
		return create(mode);
	};
	connection.prompt = async () => ({stopReason: 'end_turn'});
	const request = {
		projectId: project.id,
		threadId: thread.id,
		text: 'fixture send',
	};
	await t.throwsAsync(service.promptThread(request), {code: 'UNSUPPORTED'});
	t.deepEqual(preparedAttempts, []);
	await service.promptThread(request);
	t.is(attempt, 2);
	t.deepEqual(preparedAttempts, [2]);
});

test('an abandoned new-session response never calls the prepared-session handoff', async t => {
	let prepared = 0;
	const entered = deferred<void>();
	const release = deferred<void>();
	t.teardown(() => release.resolve());
	const {service, project, supervisor, store} = await fixture(
		t,
		true,
		undefined,
		false,
		{
			onSessionPrepared: () => {
				prepared++;
			},
		},
	);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	const create = connection.newSession;
	connection.newSession = async mode => {
		const session = await create(mode);
		entered.resolve();
		await release.promise;
		return session;
	};
	const turn = service.promptThread({
		projectId: project.id,
		threadId: thread.id,
		text: 'never sent',
	});
	const rejected = t.throwsAsync(turn, {code: 'AGENT_UNAVAILABLE'});
	await entered.promise;
	const detached = service.detach([project]);
	release.resolve();
	await Promise.all([rejected, detached]);
	t.is(prepared, 0);
	t.is(store.threads.get(project.id, thread.id)?.nanocoderSessionId, null);
});

for (const hook of ['prepared', 'before'] as const) {
	test(`a connection replaced during the ${hook} hook cannot publish or prompt`, async t => {
		let replace = () => {};
		const {service, project, supervisor} = await fixture(
			t,
			true,
			undefined,
			false,
			{
				onSessionPrepared:
					hook === 'prepared'
						? async () => {
								await Promise.resolve();
								replace();
							}
						: undefined,
				beforeFirstPrompt:
					hook === 'before'
						? async () => {
								await Promise.resolve();
								replace();
							}
						: undefined,
			},
		);
		const thread = await service.createThread({projectId: project.id});
		await supervisor.ensureProcess(project);
		const connection = supervisor.getConnection(project.id);
		let prompts = 0;
		connection.prompt = async () => {
			prompts++;
			return {stopReason: 'end_turn'};
		};
		const original = supervisor.getConnection.bind(supervisor);
		let replaced = false;
		supervisor.getConnection = projectId => {
			const current = original(projectId);
			return replaced ? {...current} : current;
		};
		replace = () => {
			replaced = true;
		};
		const request = {projectId: project.id, threadId: thread.id};
		await t.throwsAsync(
			service.promptThread({...request, text: 'never sent'}),
			{code: 'AGENT_UNAVAILABLE'},
		);
		t.is(prompts, 0);
		t.deepEqual((await service.getThreadSnapshot(request)).events, []);
	});
}

test('detaching an owned hook holds BUSY until both the hook and child shutdown settle', async t => {
	const entered = deferred<void>();
	const release = deferred<void>();
	const hookReturned = deferred<void>();
	const closeEntered = deferred<void>();
	const closeRelease = deferred<void>();
	t.teardown(() => {
		release.resolve();
		closeRelease.resolve();
	});
	const {service, project, supervisor} = await fixture(
		t,
		true,
		undefined,
		false,
		{
			onSessionPrepared: async context => {
				entered.resolve();
				await release.promise;
				t.true(context.lease.signal.aborted);
				hookReturned.resolve();
			},
		},
	);
	const thread = await service.createThread({projectId: project.id});
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	const close = connection.close;
	connection.close = async () => {
		closeEntered.resolve();
		await closeRelease.promise;
		await close();
	};
	const request = {projectId: project.id, threadId: thread.id};
	const turn = service.promptThread({...request, text: 'never sent'});
	const rejected = t.throwsAsync(turn, {code: 'AGENT_UNAVAILABLE'});
	await entered.promise;
	const detached = service.detach([project]);
	await closeEntered.promise;
	release.resolve();
	await hookReturned.promise;
	await new Promise(resolve => setImmediate(resolve));
	try {
		await t.throwsAsync(
			service.runProjectOperation(project.id, 'controls', async () => {}),
			{code: 'BUSY'},
		);
	} finally {
		closeRelease.resolve();
		await Promise.all([detached, rejected]);
	}
	t.deepEqual((await service.getThreadSnapshot(request)).events, []);
	t.false(service.projectOperations.isBusy(project.id));
});

test('opening and recovering history hand off safely without running the first-prompt hook', async t => {
	const sources: string[] = [];
	let before = 0;
	const {service, project, store, supervisor} = await fixture(
		t,
		true,
		undefined,
		false,
		{
			onSessionPrepared: context => {
				service.projectOperations.assertCurrent(context.lease);
				t.is(context.thread.nanocoderSessionId, 'fake-session');
				t.is(context.source, 'resume');
				sources.push(context.source);
			},
			beforeFirstPrompt: () => {
				before++;
			},
		},
	);
	const thread = seed(project, {nanocoderSessionId: 'fake-session'});
	store.threads.save(thread);
	const request = {projectId: project.id, threadId: thread.id};
	await service.openThread(request);
	t.deepEqual(sources, ['resume']);
	t.is(before, 0);
	const connection = supervisor.getConnection(project.id);
	await service.restore(project, connection, new AbortController().signal);
	t.deepEqual(sources, ['resume', 'resume']);
	t.is(before, 0);
	connection.prompt = async () => ({stopReason: 'end_turn'});
	await service.promptThread({...request, text: 'fixture send'});
	t.is(before, 1);
	t.deepEqual(sources, ['resume', 'resume']);
});

test('the control connection getter shares the exact starting recovery binding with the owned lease', async t => {
	let bound: NanocoderConnection | undefined;
	let exposed: NanocoderConnection | undefined;
	let supervisorRefused = false;
	const {service, project, store, supervisor} = await fixture(
		t,
		true,
		undefined,
		true,
		{
			onSessionPrepared: context => {
				if (supervisor.getState(project.id).status !== 'starting') return;
				try {
					supervisor.getConnection(project.id);
				} catch {
					supervisorRefused = true;
				}
				service.projectOperations.assertCurrent(context.lease);
				bound = context.connection;
				exposed = service.getControlConnection(project.id);
			},
		},
	);
	const thread = seed(project, {nanocoderSessionId: 'fake-session'});
	store.threads.save(thread);
	await service.openThread({projectId: project.id, threadId: thread.id});
	const first = supervisor.getConnection(project.id);
	const state = await supervisor.restart(project);
	t.is(state.status, 'ready');
	t.true(supervisorRefused);
	t.truthy(bound);
	t.not(bound, first);
	t.is(exposed, bound);
	t.is(
		service.getControlConnection(project.id),
		supervisor.getConnection(project.id),
	);
	t.is(service.getControlConnection(randomUUID()), undefined);
	service.dispose();
	t.is(service.getControlConnection(project.id), undefined);
});

test('an invalidated starting recovery cannot expose its connection while the owned hook is settling', async t => {
	const entered = deferred<NanocoderConnection>();
	const release = deferred<void>();
	t.teardown(() => release.resolve());
	const {service, project, store, supervisor} = await fixture(
		t,
		true,
		undefined,
		true,
		{
			onSessionPrepared: async context => {
				if (supervisor.getState(project.id).status !== 'starting') return;
				entered.resolve(context.connection);
				await release.promise;
			},
		},
	);
	const thread = seed(project, {nanocoderSessionId: 'fake-session'});
	store.threads.save(thread);
	await service.openThread({projectId: project.id, threadId: thread.id});
	const restarting = supervisor.restart(project);
	const bound = await entered.promise;
	const before = service.getControlConnection(project.id);
	service.projectOperations.invalidate(project.id);
	const after = service.getControlConnection(project.id);
	release.resolve();
	const state = await restarting;
	t.is(before, bound);
	t.is(after, undefined);
	t.is(state.status, 'failed');
	t.is(service.getControlConnection(project.id), undefined);
});

test('session prompt and title metadata publish in order before user content and ignore manual overrides (CHAT-04, CHAT-12)', async t => {
	const order: string[] = [];
	const {project, service, supervisor, notifyTitle} = await fixture(
		t,
		true,
		event => {
			if (
				event.type === 'turn' &&
				event.events.some(item => item.type === 'user')
			)
				order.push('user');
		},
	);
	const metadata: ThreadInfo[] = [];
	supervisor.subscribe(event => {
		if (event.type === 'thread') {
			metadata.push(event.thread);
			order.push(`${event.thread.runState}:${event.thread.nanocoderSessionId}`);
		}
	});
	const created = await service.createThread({projectId: project.id});
	writeFileSync(
		path.join(project.canonicalRoot, '.fake-nanocoder'),
		'extensions',
	);
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	connection.prompt = async sessionId => {
		notifyTitle(sessionId, 'fixture generated');
		return {stopReason: 'end_turn'};
	};
	connection.renameSession = async (_sessionId, title) => title;
	const target = {projectId: project.id, threadId: created.id};
	await service.promptThread({...target, text: 'fixture prompt'});
	t.deepEqual(
		metadata.map(row => [row.runState, row.title, row.nanocoderSessionId]),
		[
			['new', 'new thread', null],
			['new', 'new thread', 'fake-session'],
			['running', 'fixture prompt', 'fake-session'],
			['running', 'fixture generated', 'fake-session'],
			['ready', 'fixture generated', 'fake-session'],
		],
	);
	t.true(order.indexOf('new:fake-session') < order.indexOf('user'));
	await service.renameThread({...target, title: 'fixture manual'});
	t.is(metadata.at(-1)?.title, 'fixture manual');
	t.is(metadata.length, 6);
	notifyTitle('fake-session', 'late generated');
	t.is(metadata.length, 6);
});

test('missing-history view-only state is published without changing thread identity (CHAT-04)', async t => {
	const {project, service, store, supervisor} = await fixture(t, true);
	const thread = seed(project);
	store.threads.save(thread);
	const events: ProjectEvent[] = [];
	supervisor.subscribe(event => events.push(event));
	const snapshot = await service.openThread({
		projectId: project.id,
		threadId: thread.id,
	});
	t.deepEqual(
		events.flatMap(event => (event.type === 'thread' ? [event.thread] : [])),
		[snapshot.thread],
	);
	t.is(snapshot.thread.nanocoderSessionId, thread.nanocoderSessionId);
	t.is(snapshot.thread.runState, 'view-only');
});

test('waiting metadata remains until every concurrent permission closes (CHAT-06, U.3)', async t => {
	const {project, store, supervisor, target, turn, requests, metadata} =
		await waitingThread(t, true);
	t.is(
		store.threads.get(project.id, target.threadId)?.runState,
		'waiting-approval',
	);
	t.true(
		supervisor.answerPermission(
			project.id,
			'fake-session',
			requests[0].id,
			'allow',
		),
	);
	t.is(
		store.threads.get(project.id, target.threadId)?.runState,
		'waiting-approval',
	);
	t.true(
		supervisor.answerPermission(
			project.id,
			'fake-session',
			requests[1].id,
			'deny',
		),
	);
	t.is(store.threads.get(project.id, target.threadId)?.runState, 'running');
	t.deepEqual(await turn, {stopReason: 'end_turn'});
	t.deepEqual(
		metadata.map(row => row.runState),
		['new', 'new', 'running', 'waiting-approval', 'running', 'ready'],
	);
});

test('thread approval answers refuse unknown unoffered wrong-thread and closed requests (ACP-10, CHAT-06)', async t => {
	const {
		project,
		store,
		service,
		supervisor,
		connection,
		target,
		turn,
		requests,
	} = await waitingThread(t);
	const other = seed(project);
	store.threads.save(other);
	const answer = {...target, requestId: requests[0].id, optionId: 'allow'};
	for (const [request, code] of [
		[{...answer, threadId: randomUUID()}, 'NOT_FOUND'],
		[{...answer, projectId: randomUUID()}, 'NOT_FOUND'],
		[{...answer, threadId: other.id}, 'DENIED'],
		[{...answer, requestId: 'unknown-request'}, 'DENIED'],
		[{...answer, optionId: 'not-offered'}, 'DENIED'],
	] as const)
		await t.throwsAsync(service.answerThreadPermission(request), {
			instanceOf: IpcFailure,
			code,
		});
	t.is(
		store.threads.get(project.id, target.threadId)?.runState,
		'waiting-approval',
	);
	t.is(await service.answerThreadPermission(answer), null);
	t.deepEqual(await turn, {stopReason: 'end_turn'});
	await t.throwsAsync(service.answerThreadPermission(answer), {
		instanceOf: IpcFailure,
		code: 'DENIED',
	});
	await supervisor.close();
	t.deepEqual(
		fakeEvents(connection.stderr.lines())
			.filter(event => 'answer' in event)
			.map(event => event.answer),
		[{outcome: 'selected', optionId: 'allow'}],
	);
});

test('thread cancellation scopes the active session and cancels every approval without allowing it (ACP-10, CHAT-06)', async t => {
	const {
		project,
		store,
		service,
		supervisor,
		connection,
		target,
		turn,
		requests,
	} = await waitingThread(t, true);
	const other = seed(project);
	store.threads.save(other);
	t.is(await service.cancelThread({...target, threadId: other.id}), null);
	t.is(supervisor.getState(project.id).activeThreadId, 'fake-session');
	t.is(await service.cancelThread(target), null);
	t.deepEqual(await turn, {stopReason: 'cancelled'});
	t.is(store.threads.get(project.id, target.threadId)?.runState, 'interrupted');
	for (const request of requests)
		await t.throwsAsync(
			service.answerThreadPermission({
				...target,
				requestId: request.id,
				optionId: 'allow',
			}),
			{instanceOf: IpcFailure, code: 'DENIED'},
		);
	await supervisor.close();
	t.deepEqual(
		fakeEvents(connection.stderr.lines())
			.filter(event => 'answer' in event)
			.map(event => event.answer),
		[{outcome: 'cancelled'}],
	);
});

test('cancelling a sessionless thread is local and unknown targets are refused (ACP-10)', async t => {
	const {project, service, calls} = await fixture(t);
	const thread = await service.createThread({projectId: project.id});
	const target = {projectId: project.id, threadId: thread.id};
	t.is(await service.cancelThread(target), null);
	await t.throwsAsync(
		service.cancelThread({...target, threadId: randomUUID()}),
		{instanceOf: IpcFailure, code: 'NOT_FOUND'},
	);
	t.deepEqual(calls, []);
});

test('revoked trust refuses a live approval but still permits cancelling the turn (ACP-10, SEC-17)', async t => {
	const {
		project,
		store,
		service,
		supervisor,
		connection,
		target,
		turn,
		requests,
	} = await waitingThread(t);
	store.projects.save({...project, trusted: false});
	await t.throwsAsync(
		service.answerThreadPermission({
			...target,
			requestId: requests[0].id,
			optionId: 'allow',
		}),
		{instanceOf: IpcFailure, code: 'DENIED'},
	);
	t.is(await service.cancelThread(target), null);
	t.deepEqual(await turn, {stopReason: 'cancelled'});
	await supervisor.close();
	t.deepEqual(
		fakeEvents(connection.stderr.lines())
			.filter(event => 'answer' in event)
			.map(event => event.answer),
		[{outcome: 'cancelled'}],
	);
});

for (const mode of ['prompt-error', 'die-in-turn']) {
	test(`${mode} publishes failed instead of leaving the thread running (CHAT-15, DEC-33)`, async t => {
		const {project, store, service, supervisor} = await fixture(t, true);
		writeFileSync(path.join(project.canonicalRoot, '.fake-nanocoder'), mode);
		const metadata: ThreadInfo[] = [];
		supervisor.subscribe(event => {
			if (event.type === 'thread') metadata.push(event.thread);
		});
		const thread = await service.createThread({projectId: project.id});
		await t.throwsAsync(
			service.promptThread({
				projectId: project.id,
				threadId: thread.id,
				text: 'fixture prompt',
			}),
			{instanceOf: IpcFailure, code: 'AGENT_UNAVAILABLE'},
		);
		const stored = store.threads.get(project.id, thread.id);
		t.is(stored?.runState, 'failed');
		t.is(stored?.nanocoderSessionId, 'fake-session');
		t.is(stored?.title, 'fixture prompt');
		t.is(metadata.at(-1)?.runState, 'failed');
	});
}

test('another running thread remains readable without persisted view-only state or session switching (CHAT-17)', async t => {
	const {project, store, service, supervisor, connection, target, turn} =
		await waitingThread(t);
	const other = seed(project);
	store.threads.save(other);
	connection.resumeSession = async () => {
		throw new Error('A running turn must not switch sessions');
	};
	const otherTarget = {projectId: project.id, threadId: other.id};
	const snapshot = await service.openThread(otherTarget);
	t.deepEqual(snapshot.thread, other);
	t.deepEqual(snapshot.events, []);
	t.is(supervisor.getState(project.id).activeThreadId, 'fake-session');
	await t.throwsAsync(
		service.promptThread({...otherTarget, text: 'fixture overlap'}),
		{instanceOf: IpcFailure, code: 'BUSY'},
	);
	await service.cancelThread(target);
	await turn;
	t.deepEqual(store.threads.get(project.id, other.id), other);
});

test('opening untrusted history refuses without persisting a permanent view-only state (CHAT-15, SEC-17)', async t => {
	const {project, store, service, calls} = await fixture(t);
	const thread = seed(project);
	store.threads.save(thread);
	await t.throwsAsync(
		service.openThread({projectId: project.id, threadId: thread.id}),
		{instanceOf: IpcFailure, code: 'DENIED'},
	);
	t.deepEqual(store.threads.get(project.id, thread.id), thread);
	t.deepEqual(calls, []);
});

test('resuming retains the owning thread mode rather than a later project default (DEC-31)', async t => {
	const {project, store, service, supervisor} = await fixture(t, true);
	const thread = seed(project, {
		nanocoderSessionId: 'fake-session',
		mode: 'normal',
	});
	store.threads.save(thread);
	const snapshot = await service.openThread({
		projectId: project.id,
		threadId: thread.id,
	});
	t.is(snapshot.thread.mode, 'normal');
	const connection = supervisor.getConnection(project.id);
	await supervisor.close();
	t.deepEqual(
		fakeEvents(connection.stderr.lines())
			.filter(event => event.method === 'session/set_mode')
			.map(event => (event.params as {modeId: string}).modeId),
		['normal'],
	);
});

test('first prompt retains the new thread captured mode after its project default changes (DEC-31)', async t => {
	const {project, store, service, supervisor} = await fixture(t, true);
	store.projects.save({...project, defaultMode: 'normal'});
	const thread = await service.createThread({projectId: project.id});
	store.projects.save(project);
	await supervisor.ensureProcess(project);
	const connection = supervisor.getConnection(project.id);
	connection.prompt = async () => ({stopReason: 'end_turn'});
	await service.promptThread({
		projectId: project.id,
		threadId: thread.id,
		text: 'fixture prompt',
	});
	t.is(store.threads.get(project.id, thread.id)?.mode, 'normal');
	await supervisor.close();
	t.deepEqual(
		fakeEvents(connection.stderr.lines())
			.filter(event => event.method === 'session/set_mode')
			.map(event => (event.params as {modeId: string}).modeId),
		['normal'],
	);
});

test('thread modes are unavailable from the bare service until the controls are composed (DEC-31)', async t => {
	const f = await fixture(t);
	await t.throwsAsync(
		f.service.setThreadMode({
			projectId: f.project.id,
			threadId: '11111111-1111-4111-8111-111111111111',
			mode: 'plan',
		}),
		{code: 'UNAVAILABLE', message: 'This feature is not available yet'},
	);
});

test('CHAT-14 a thread without Nanocoder history refuses history deletion before confirmation', async t => {
	const f = await fixture(t);
	const thread = seed(f.project, {nanocoderSessionId: null});
	f.store.threads.save(thread);
	await t.throwsAsync(
		f.service.deleteThreadHistory({
			projectId: f.project.id,
			threadId: thread.id,
		}),
		{code: 'UNSUPPORTED'},
	);
	t.false(f.calls.includes('confirm-delete'));
	t.truthy(f.store.threads.get(f.project.id, thread.id));
});

test('opening or creating a thread tells the controls which thread is in view, and a thread that is not found tells them nothing (ACP-14 CHAT-10)', async t => {
	const selected: string[] = [];
	const f = await fixture(t, false, undefined, false, {
		onThreadSelected: (projectId, threadId) => {
			selected.push(`${projectId}:${threadId}`);
		},
	});
	const thread = seed(f.project, {nanocoderSessionId: null});
	f.store.threads.save(thread);
	await f.service.openThread({projectId: f.project.id, threadId: thread.id});
	const created = await f.service.createThread({projectId: f.project.id});
	t.deepEqual(selected, [
		`${f.project.id}:${thread.id}`,
		`${f.project.id}:${created.id}`,
	]);
	await t.throwsAsync(
		f.service.openThread({projectId: f.project.id, threadId: 'missing'}),
	);
	t.is(selected.length, 2);
});

async function pinFixture(
	t: ExecutionContext,
	mode: string | null,
	stubSessions = true,
) {
	const f = await fixture(t, true);
	if (mode)
		writeFileSync(path.join(f.project.canonicalRoot, '.fake-nanocoder'), mode);
	await f.supervisor.ensureProcess(f.project);
	const connection = f.supervisor.getConnection(f.project.id);
	const pins: Array<[string, boolean]> = [];
	let outcome: 'ok' | 'missing' | 'down' = 'ok';
	connection.pinSession = async (id, pinned) => {
		pins.push([id, pinned]);
		if (outcome === 'missing')
			throw new NanocoderFailure('NOT_FOUND', 'not saved yet');
		if (outcome === 'down') throw new Error('Nanocoder is down');
	};
	if (stubSessions) {
		connection.getSessionOffers = () => ({
			offeredModes: ['normal'],
			configOptions: [],
		});
		connection.resumeSession = async id => ({
			session: {id, mode: 'normal'},
			history: [],
		});
	}
	const thread = seed(f.project, {nanocoderSessionId: 'saved-session'});
	f.store.threads.save(thread);
	return {
		f,
		thread,
		pins,
		outcome: (next: typeof outcome) => {
			outcome = next;
		},
		open: async () => {
			const opened = await f.service.openThread({
				projectId: f.project.id,
				threadId: thread.id,
			});
			await f.service.settlePins();
			return opened;
		},
		unpinned: () => f.store.threads.listUnpinnedSessions().length,
	};
}

test('CHAT-23 opening a saved thread pins its session and remembers that it did (DEC-45)', async t => {
	const p = await pinFixture(t, 'extensions');
	t.is(p.unpinned(), 1);
	const opened = await p.open();
	t.is(opened.thread.runState, 'ready');
	t.deepEqual(p.pins, [['saved-session', true]]);
	t.is(p.unpinned(), 0);
	await p.open();
	t.is(p.pins.length, 1, 'a pinned session is not pinned again');
});

test('CHAT-23 a pin that Nanocoder refuses or cannot answer never stops the thread opening, and the thread stays marked unpinned', async t => {
	for (const outcome of ['missing', 'down'] as const) {
		const p = await pinFixture(t, 'extensions');
		p.outcome(outcome);
		const opened = await p.open();
		t.is(opened.thread.runState, 'ready');
		t.is(p.pins.length, 1);
		t.is(p.unpinned(), 1);
	}
});

test('CHAT-23 a Nanocoder that did not confirm the pin extension is never sent a pin', async t => {
	const p = await pinFixture(t, null);
	const opened = await p.open();
	t.is(opened.thread.runState, 'ready');
	t.deepEqual(p.pins, []);
	t.is(p.unpinned(), 1);
});

test('CHAT-23 a finished first turn pins the new session, since Nanocoder saves it only then', async t => {
	const p = await pinFixture(t, 'pin-extensions', false);
	const created = await p.f.service.createThread({projectId: p.f.project.id});
	t.is(p.pins.length, 0);
	await p.f.service.promptThread({
		projectId: p.f.project.id,
		threadId: created.id,
		text: 'first words',
	});
	await p.f.service.settlePins();
	t.is(p.pins.length, 1);
	t.is(p.pins[0][1], true);
	t.is(
		p.f.store.threads.get(p.f.project.id, created.id)?.nanocoderSessionId,
		p.pins[0][0],
	);
	t.true(p.f.store.threads.getSessionPinned(p.f.project.id, created.id));
});

test('DEC-45 a missing session names the limits Nanocoder reported, not the defaults', async t => {
	const {project, service, store} = await fixture(t, true);
	store.retention.set({days: 90, maxSessions: 250});
	const thread = seed(project);
	store.threads.save(thread);
	const snapshot = await service.openThread({
		projectId: project.id,
		threadId: thread.id,
	});
	t.is(snapshot.thread.runState, 'view-only');
	t.regex(snapshot.thread.viewOnlyReason ?? '', /not opened for 90 days/);
	t.regex(snapshot.thread.viewOnlyReason ?? '', /more than 250/);
	t.notRegex(snapshot.thread.viewOnlyReason ?? '', /By default/);
});

test('DEC-45 the limits a Nanocoder reports are kept for the warning and the notice, and a Nanocoder that reports none leaves them alone', async t => {
	const p = await pinFixture(t, null);
	const connection = p.f.supervisor.getConnection(p.f.project.id);
	const report = (retention: {days: number; maxSessions: number} | null) =>
		Object.defineProperty(connection, 'agent', {
			configurable: true,
			value: {
				...connection.agent,
				capabilities: {...connection.agent.capabilities, retention},
			},
		});
	const openNew = async (sessionId: string) => {
		const row = seed(p.f.project, {nanocoderSessionId: sessionId});
		p.f.store.threads.save(row);
		await p.f.service.openThread({
			projectId: p.f.project.id,
			threadId: row.id,
		});
	};
	t.is(p.f.store.retention.get(), undefined);
	await openNew('first-session');
	t.is(p.f.store.retention.get(), undefined);
	report({days: 45, maxSessions: 200});
	await openNew('second-session');
	t.deepEqual(p.f.store.retention.get(), {days: 45, maxSessions: 200});
	report(null);
	await openNew('third-session');
	t.deepEqual(p.f.store.retention.get(), {days: 45, maxSessions: 200});
});
