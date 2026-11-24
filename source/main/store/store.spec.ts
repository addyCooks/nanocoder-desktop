import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {IpcFailure} from '@/main/ipc/handle-request';
import {desktopStoreFactory} from '@/main/store';
import type {SqlDatabase, SqlDriver} from '@/main/store/contracts';
import {
	migrate,
	migrations,
	schemaVersion,
	transaction,
} from '@/main/store/migrations';
import {createNodeSqliteDriver} from '@/main/store/node-sqlite';
import {repositories} from '@/main/store/repositories';
import type {ThreadHistoryPatch} from '@/main/store/thread-execution-identities';
import {
	createThreadHistoryObserver,
	type ReplayObservation,
} from '@/main/threads/thread-history-observer';
import type {ProjectInfo, ThreadInfo} from '@/shared/ipc';

test('ACP-18 main-only session lookup finds its exact owner without changing archived/manual metadata', async t => {
	const f = fixture(t);
	const store = await f.open();
	const owner = project(f.root);
	const otherRoot = path.join(f.root, 'other-project');
	mkdirSync(otherRoot);
	const other = project(otherRoot);
	store.projects.save(owner);
	store.projects.save(other);
	const sessionId = 'session/é/\u{1F680}';
	const foreignSessionId = randomUUID();
	const saved = thread(owner, {
		nanocoderSessionId: sessionId,
		archiveState: 'archived',
		title: 'manual title',
	});
	const foreign = thread(other, {nanocoderSessionId: foreignSessionId});
	const unsaved = thread(owner, {nanocoderSessionId: null});
	for (const row of [saved, foreign, unsaved]) store.threads.save(row);
	store.threads.setTitle({
		projectId: owner.id,
		threadId: saved.id,
		title: saved.title,
		manuallySet: true,
	});
	t.deepEqual(store.threads.getBySessionId(sessionId), saved);
	t.deepEqual(store.threads.getBySessionId(foreignSessionId), foreign);
	t.is(store.threads.getBySessionId('unknown-session'), undefined);
	t.is(store.threads.getBySessionId(` ${sessionId}`), undefined);
	t.deepEqual(store.threads.get(owner.id, saved.id), saved);
	t.true(store.threads.getTitleManuallySet(owner.id, saved.id));
});

test('ACP-18 main-only session lookup refuses malformed opaque identities without normalising them', async t => {
	const f = fixture(t);
	const store = await f.open();
	for (const id of ['', '   ', 'session\n', 'é'.repeat(101), '\uD800']) {
		t.throws(() => store.threads.getBySessionId(id), {code: 'VALIDATION'});
	}
});

for (const action of ['insert', 'update'] as const) {
	for (const kind of ['high', 'low', 'bytes', 'control'] as const) {
		test(`CHAT-08 durable session ${action} refuses ${kind} identity before any write`, async t => {
			const f = fixture(t);
			const store = await f.open();
			const owner = project(f.root);
			store.projects.save(owner);
			const before = thread(owner);
			if (action === 'update') store.threads.save(before);
			const invalid = {
				high: 'session\uD800',
				low: 'session\uDFFF',
				bytes: 'é'.repeat(101),
				control: 'session\u202e',
			}[kind];
			const error = t.throws(
				() => store.threads.save({...before, nanocoderSessionId: invalid}),
				{code: 'VALIDATION'},
			);
			t.is(error?.message, 'Invalid desktop metadata');
			t.deepEqual(
				store.threads.get(owner.id, before.id),
				action === 'update' ? before : undefined,
			);
		});
	}
}

test('CHAT-08 well-formed Unicode saved session metadata round-trips exactly', async t => {
	const f = fixture(t);
	const store = await f.open();
	const owner = project(f.root);
	const saved = thread(owner, {nanocoderSessionId: 'session/é/\u{1F680}'});
	store.projects.save(owner);
	store.threads.save(saved);
	t.deepEqual(store.threads.get(owner.id, saved.id), saved);
	store.close();
	t.deepEqual((await f.open()).threads.get(owner.id, saved.id), saved);
});

function fixture(t: ExecutionContext) {
	const root = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-store-')),
	);
	t.teardown(() => rmSync(root, {recursive: true, force: true}));
	const filename = path.join(root, 'desktop.sqlite');
	const driver = createNodeSqliteDriver();
	const open = async () => {
		const store = await desktopStoreFactory.open({
			databasePath: filename,
			driver,
		});
		t.teardown(() => store.close());
		return store;
	};
	return {root, filename, driver, open};
}

function project(
	root: string,
	overrides: Partial<ProjectInfo> = {},
): ProjectInfo {
	return {
		id: randomUUID(),
		canonicalRoot: root,
		sessionCwd: root,
		displayName: 'fixture',
		trusted: false,
		defaultMode: 'normal',
		lastOpenedAt: '2026-10-29T12:00:00.000Z',
		createdAt: '2026-10-29T12:00:00.000Z',
		availability: 'available',
		...overrides,
	};
}

function thread(
	owner: ProjectInfo,
	overrides: Partial<ThreadInfo> = {},
): ThreadInfo {
	return {
		id: randomUUID(),
		projectId: owner.id,
		nanocoderSessionId: randomUUID(),
		title: 'fixture thread',
		archiveState: 'active',
		runState: 'ready',
		lastActivityAt: '2026-10-29T12:00:00.000Z',
		sessionCwd: owner.sessionCwd,
		mode: 'normal',
		viewOnlyReason: null,
		...overrides,
	};
}

for (const restart of ['close', 'SIGKILL'] as const) {
	test(`CHAT-08 SUB-05 the main store retains one atomic replay identity/run commit after ${restart}`, async t => {
		const f = fixture(t);
		const store = await f.open();
		const owner = project(f.root);
		const sessionId = randomUUID();
		const saved = thread(owner, {nanocoderSessionId: sessionId});
		store.projects.save(owner);
		store.threads.save(saved);
		const scope = {projectId: owner.id, threadId: saved.id, sessionId};
		const turnId = randomUUID();
		const executionId = randomUUID();
		const patch: Omit<ThreadHistoryPatch, 'source' | 'agentRuns'> = {
			expectedRevision: null,
			generation: 1,
			sequence: 1,
			complete: true,
			turns: [{id: turnId, ordinal: 0, outcome: 'unknown'}],
			executions: [
				{
					id: executionId,
					turnId,
					toolCallId: 'safe-tool',
					ordinal: 0,
					outcome: 'unknown',
				},
			],
		};
		const entry: ReplayObservation = {
			context: {
				...scope,
				turnId,
				executionId,
				toolCallId: 'safe-tool',
				generation: 1,
				sequence: 1,
				source: 'replay',
				terminalEvidence: 'replay-synthetic',
				replayEpoch: randomUUID(),
				replayCommitted: true,
			},
			tool: {
				type: 'tool',
				id: 'safe-tool',
				status: 'completed',
				delegation: {
					role: 'explore',
					history: true,
					task: 'forbidden-task-sentinel',
				},
				details: {input: 'forbidden-input-sentinel'},
			},
		};
		if (restart === 'close') {
			const observer = createThreadHistoryObserver({
				scope,
				history: store.threadHistory,
				runs: store.agentRuns,
			});
			t.is(observer.commitReplay(patch, [entry]), 1);
			observer.dispose();
			store.close();
		} else {
			store.close();
			const script = `
				const {desktopStoreFactory} = await import(${JSON.stringify(new URL('./index.ts', import.meta.url).href)});
				const {createNodeSqliteDriver} = await import(${JSON.stringify(new URL('./node-sqlite.ts', import.meta.url).href)});
				const {createThreadHistoryObserver} = await import(${JSON.stringify(new URL('../threads/thread-history-observer.ts', import.meta.url).href)});
				const [filename, encoded] = process.argv.slice(1);
				const {scope, patch, entry} = JSON.parse(encoded);
				const store = await desktopStoreFactory.open({databasePath: filename, driver: createNodeSqliteDriver()});
				const observer = createThreadHistoryObserver({scope, history: store.threadHistory, runs: store.agentRuns});
				observer.commitReplay(patch, [entry]);
				process.kill(process.pid, 'SIGKILL');
			`;
			const crashed = spawnSync(
				process.execPath,
				[
					'--import=tsx',
					'--input-type=module',
					'-e',
					script,
					f.filename,
					JSON.stringify({scope, patch, entry}),
				],
				{stdio: 'ignore', timeout: 10000},
			);
			t.is(crashed.error, undefined);
			t.deepEqual(
				{status: crashed.status, signal: crashed.signal},
				process.platform === 'win32'
					? {status: 1, signal: null}
					: {status: null, signal: 'SIGKILL'},
			);
			t.true(readdirSync(f.root).includes('desktop.sqlite-wal'));
		}
		const reopened = await f.open();
		t.deepEqual(reopened.threadHistory.read(scope), {
			revision: 1,
			generation: 1,
			sequence: 1,
			complete: true,
			turns: patch.turns,
			executions: patch.executions,
		});
		t.deepEqual(reopened.agentRuns.list(scope.projectId, scope.threadId), [
			{
				id: executionId,
				threadId: saved.id,
				parentRunId: null,
				nanocoderChildId: null,
				role: 'explore',
				status: 'unknown',
			},
		]);
	});
}

test('opening a store reconciles only orphaned running and waiting rows, preserving all other metadata and manual titles (CHAT-03, DATA-07)', async t => {
	const f = fixture(t);
	const store = await f.open();
	const owner = project(f.root);
	store.projects.save(owner);
	const rows = (
		[
			'new',
			'ready',
			'running',
			'waiting-approval',
			'interrupted',
			'failed',
			'view-only',
		] as const
	).flatMap((runState, index) =>
		(['active', 'archived'] as const).map(archiveState => {
			const row = thread(owner, {
				runState,
				archiveState,
				nanocoderSessionId: runState === 'new' ? null : randomUUID(),
				title: `${runState} fixture`,
				viewOnlyReason:
					runState === 'view-only' ? 'fixture history unavailable' : null,
			});
			store.threads.save(row);
			store.threads.setTitle({
				projectId: owner.id,
				threadId: row.id,
				title: row.title,
				manuallySet: index % 2 === 0,
			});
			return {row, manuallySet: index % 2 === 0};
		}),
	);
	for (const {row} of rows)
		t.deepEqual(store.threads.get(owner.id, row.id), row);
	store.close();
	const reopened = await f.open();
	for (const {row, manuallySet} of rows) {
		t.deepEqual(reopened.threads.get(owner.id, row.id), {
			...row,
			runState: ['running', 'waiting-approval'].includes(row.runState)
				? 'interrupted'
				: row.runState,
		});
		t.is(reopened.threads.getTitleManuallySet(owner.id, row.id), manuallySet);
	}
});

function legacyMetadata(f: ReturnType<typeof fixture>, version: 1 | 2) {
	const database = f.driver.open(f.filename);
	const owner = project(f.root);
	const saved = thread(owner);
	try {
		for (const migration of migrations.slice(0, version))
			transaction(database, () => {
				database.exec(migration.sql);
				database
					.prepare('INSERT INTO schema_migration VALUES (?, ?)')
					.run(migration.version, '2026-10-29T12:00:00.000Z');
				database.exec(`PRAGMA user_version = ${migration.version}`);
			});
		const legacy = repositories(database);
		legacy.projects.save(owner);
		legacy.threads.save(saved);
	} finally {
		database.close();
	}
	return {owner, saved};
}

for (const version of [1, 2] as const)
	test(`upgrading a real 00${version} database protects existing titles and backs up once (CHAT-12)`, async t => {
		const f = fixture(t);
		const {owner, saved} = legacyMetadata(f, version);
		const backups: string[] = [];
		const store = await desktopStoreFactory.open({
			databasePath: f.filename,
			driver: {
				open: f.driver.open,
				backup: async (database, filename) => {
					t.is(schemaVersion(database), version);
					backups.push(filename);
					await f.driver.backup(database, filename);
				},
			},
		});
		t.teardown(() => store.close());
		t.true(store.threads.getTitleManuallySet(owner.id, saved.id));
		t.deepEqual(store.threads.get(owner.id, saved.id), saved);
		t.is(backups.length, 1);
		const backup = f.driver.open(backups[0]);
		try {
			t.is(schemaVersion(backup), version);
			t.false(
				backup
					.prepare('PRAGMA table_info(thread)')
					.all()
					.some(column => column.name === 'title_manually_set'),
			);
			t.is(
				backup.prepare('SELECT title FROM thread WHERE id = ?').get(saved.id)
					?.title,
				saved.title,
			);
		} finally {
			backup.close();
		}
		store.close();
		const upgraded = f.driver.open(f.filename);
		try {
			t.is(schemaVersion(upgraded), migrations.length);
			t.deepEqual(
				upgraded
					.prepare('SELECT version FROM schema_migration ORDER BY version')
					.all()
					.map(row => row.version),
				migrations.map(migration => migration.version),
			);
		} finally {
			upgraded.close();
		}
		(await f.open()).close();
		t.is(
			readdirSync(f.root).filter(name => name.includes('.backup-')).length,
			1,
		);
	});

test('a failed manual-title migration rolls back its column and version (CHAT-12, DATA-03)', t => {
	const f = fixture(t);
	const {saved} = legacyMetadata(f, 2);
	const database = f.driver.open(f.filename);
	t.teardown(() => database.close());
	const injected: SqlDatabase = {
		...database,
		exec: sql => {
			if (sql === 'PRAGMA user_version = 3')
				throw new IpcFailure('INTERNAL', 'fixture migration failure');
			database.exec(sql);
		},
	};
	t.throws(() => migrate(injected), {code: 'INTERNAL'});
	t.is(schemaVersion(database), 2);
	t.false(
		database
			.prepare('PRAGMA table_info(thread)')
			.all()
			.some(column => column.name === 'title_manually_set'),
	);
	t.is(
		database.prepare('SELECT title FROM thread WHERE id = ?').get(saved.id)
			?.title,
		saved.title,
	);
});

test('empty database runs every numbered migration and persists the version', async t => {
	const f = fixture(t);
	const store = await f.open();
	store.close();
	const db = f.driver.open(f.filename);
	t.teardown(() => db.close());
	t.is(schemaVersion(db), migrations.length);
	t.deepEqual(
		db
			.prepare('SELECT version FROM schema_migration ORDER BY version')
			.all()
			.map(row => row.version),
		migrations.map(migration => migration.version),
	);
	t.false(readdirSync(f.root).some(name => name.includes('.backup-')));
	if (process.platform !== 'win32')
		t.is(statSync(f.filename).mode & 0o777, 0o600);
});

test('title updates persist only scoped current metadata and a sticky boolean (CHAT-12)', async t => {
	const f = fixture(t);
	const store = await f.open();
	const owner = project(f.root);
	const saved = thread(owner);
	store.projects.save(owner);
	store.threads.save(saved);
	const target = {projectId: owner.id, threadId: saved.id};
	t.false(store.threads.getTitleManuallySet(owner.id, saved.id));
	t.deepEqual(
		store.threads.setTitle({
			...target,
			title: 'fixture generated',
			manuallySet: false,
		}),
		{...saved, title: 'fixture generated'},
	);
	t.false(store.threads.getTitleManuallySet(owner.id, saved.id));
	const renamed = store.threads.setTitle({
		...target,
		title: '  fixture manual  ',
		manuallySet: true,
	});
	t.deepEqual(renamed, {...saved, title: 'fixture manual'});
	t.true(store.threads.getTitleManuallySet(owner.id, saved.id));
	t.deepEqual(
		store.threads.setTitle({
			...target,
			title: 'late generated',
			manuallySet: false,
		}),
		renamed,
	);
	store.threads.save({...renamed, runState: 'running'});
	store.close();
	const reopened = await f.open();
	t.true(reopened.threads.getTitleManuallySet(owner.id, saved.id));
	t.deepEqual(reopened.threads.get(owner.id, saved.id), {
		...renamed,
		runState: 'interrupted',
	});
});

test('title metadata refuses cross-project targets and non-allowlisted fields (CHAT-12, DATA-04)', async t => {
	const f = fixture(t);
	const store = await f.open();
	const owner = project(f.root);
	const saved = thread(owner);
	store.projects.save(owner);
	store.threads.save(saved);
	const input = {
		projectId: owner.id,
		threadId: saved.id,
		title: 'fixture manual',
		manuallySet: true,
	};
	t.is(store.threads.getTitleManuallySet(randomUUID(), saved.id), undefined);
	t.throws(() => store.threads.setTitle({...input, projectId: randomUUID()}), {
		code: 'NOT_FOUND',
	});
	t.throws(() => store.threads.setTitle({...input, threadId: randomUUID()}), {
		code: 'NOT_FOUND',
	});
	for (const changed of [
		{title: ''},
		{title: '   '},
		{title: 't'.repeat(501)},
		{manuallySet: 'true'},
		{threadId: 'not-an-id'},
		{projectId: 'not-an-id'},
		{prompt: 'fixture content must not persist'},
		{history: []},
	]) {
		t.throws(
			() => store.threads.setTitle({...input, ...changed} as typeof input),
			{code: 'VALIDATION'},
		);
	}
	t.throws(() => store.threads.getTitleManuallySet('not-an-id', saved.id), {
		code: 'VALIDATION',
	});
	t.deepEqual(store.threads.get(owner.id, saved.id), saved);
	t.false(store.threads.getTitleManuallySet(owner.id, saved.id));
});

test('CHAT-08 current schema independently pins version seven, migration ids and the exact metadata tables', async t => {
	const f = fixture(t);
	(await f.open()).close();
	const db = f.driver.open(f.filename);
	t.teardown(() => db.close());
	t.is(db.prepare('PRAGMA user_version').get()?.user_version, 7);
	t.deepEqual(
		db
			.prepare('SELECT version FROM schema_migration ORDER BY version')
			.all()
			.map(row => row.version),
		[1, 2, 3, 4, 5, 6, 7],
	);
	t.deepEqual(
		db
			.prepare(
				"SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
			)
			.all()
			.map(row => row.name),
		[
			'agent_run',
			'browser_tab',
			'nanocoder_retention',
			'project',
			'schema_migration',
			'setting',
			'terminal_session',
			'thread',
			'thread_execution_identity',
			'thread_history',
			'thread_turn_identity',
			'turn_summary',
			'ui_state',
		],
	);
});

test('all migrated tables are introspected and have no content-bearing column', async t => {
	const f = fixture(t);
	(await f.open()).close();
	const db = f.driver.open(f.filename);
	t.teardown(() => db.close());
	const tables = db
		.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
		.all();
	t.is(tables.length, 13);
	let columns = 0;
	for (const table of tables) {
		const fields = db
			.prepare('SELECT name FROM pragma_table_info(?)')
			.all(table.name);
		t.true(fields.length > 0);
		for (const field of fields) {
			columns++;
			t.notRegex(
				String(field.name),
				/message|transcript|content|payload|output|stderr|scrollback|secret|credential|password|token|prompt|screenshot/i,
			);
		}
	}
	t.true(columns > 40);
});

test('previous version is backed up before upgrade with metadata preserved', async t => {
	const f = fixture(t);
	const previous = f.driver.open(f.filename);
	t.teardown(() => previous.close());
	previous.exec('PRAGMA journal_mode = WAL');
	transaction(previous, () => {
		previous.exec(migrations[0].sql);
		previous
			.prepare('INSERT INTO schema_migration VALUES (?, ?)')
			.run(1, '2026-10-28T12:00:00.000Z');
		previous.exec('PRAGMA user_version = 1');
		previous
			.prepare('INSERT INTO setting VALUES (?, ?)')
			.run('theme', '"light"');
	});
	t.true(statSync(`${f.filename}-wal`).size > 0);
	const calls: string[] = [];
	const wrapped: SqlDriver = {
		open: filename => f.driver.open(filename),
		backup: async (database, filename) => {
			t.is(schemaVersion(database), 1);
			calls.push(filename);
			await f.driver.backup(database, filename);
		},
	};
	const store = await desktopStoreFactory.open({
		databasePath: f.filename,
		driver: wrapped,
	});
	t.teardown(() => store.close());
	t.is(store.getSettings().theme, 'light');
	t.is(calls.length, 1);
	const backup = f.driver.open(calls[0]);
	t.teardown(() => backup.close());
	t.is(schemaVersion(backup), 1);
	t.is(
		backup.prepare('SELECT value FROM setting WHERE key = ?').get('theme')
			?.value,
		'"light"',
	);
	t.is(
		backup
			.prepare(
				"SELECT count(*) AS n FROM sqlite_schema WHERE name = 'ui_state'",
			)
			.get()?.n,
		0,
	);
	store.close();
	(await f.open()).close();
	t.is(
		readdirSync(f.root).filter(name => /\.backup-[\da-f-]+$/.test(name)).length,
		1,
	);
});

test('an existing empty database is backed up before its first migration', async t => {
	const f = fixture(t);
	f.driver.open(f.filename).close();
	(await f.open()).close();
	const files = readdirSync(f.root).filter(name => name.includes('.backup-'));
	t.is(files.length, 1);
	const backup = f.driver.open(path.join(f.root, files[0]));
	t.teardown(() => backup.close());
	t.is(schemaVersion(backup), 0);
});

test('a newer database is refused without backup, migration or quarantine', async t => {
	const f = fixture(t);
	const db = f.driver.open(f.filename);
	db.exec('PRAGMA user_version = 999');
	db.close();
	const before = readFileSync(f.filename);
	await t.throwsAsync(f.open, {instanceOf: IpcFailure, code: 'STORE_TOO_NEW'});
	t.deepEqual(readFileSync(f.filename), before);
	t.deepEqual(readdirSync(f.root), ['desktop.sqlite']);
});

test('a newer migration record is refused even if user_version is stale', async t => {
	const f = fixture(t);
	(await f.open()).close();
	const db = f.driver.open(f.filename);
	db.prepare('INSERT INTO schema_migration VALUES (?, ?)').run(
		999,
		'2026-10-29T12:00:00.000Z',
	);
	db.exec('PRAGMA user_version = 0');
	db.close();
	await t.throwsAsync(f.open, {code: 'STORE_TOO_NEW'});
	t.false(readdirSync(f.root).some(name => name.includes('.corrupt-')));
});

test('a failed migration rolls back its schema and recorded version', t => {
	const f = fixture(t);
	const db = f.driver.open(f.filename);
	t.teardown(() => db.close());
	const injected: SqlDatabase = {
		...db,
		exec: sql => {
			if (sql === 'PRAGMA user_version = 2')
				throw new IpcFailure('INTERNAL', 'fixture migration failure');
			db.exec(sql);
		},
	};
	t.throws(() => migrate(injected), {code: 'INTERNAL'});
	t.is(schemaVersion(db), 1);
	t.is(
		db
			.prepare(
				"SELECT count(*) AS n FROM sqlite_schema WHERE name = 'ui_state'",
			)
			.get()?.n,
		0,
	);
});

test('backup failure stops the upgrade and closes the connection', async t => {
	const f = fixture(t);
	f.driver.open(f.filename).close();
	let closed = false;
	const driver: SqlDriver = {
		open: filename => {
			const db = f.driver.open(filename);
			return {
				...db,
				close: () => {
					closed = true;
					db.close();
				},
			};
		},
		backup: async () => {
			throw new Error('fixture sensitive details');
		},
	};
	const error = await t.throwsAsync(
		() => desktopStoreFactory.open({databasePath: f.filename, driver}),
		{code: 'INTERNAL'},
	);
	t.false(error?.message.includes('sensitive'));
	t.true(closed);
	const db = f.driver.open(f.filename);
	t.teardown(() => db.close());
	t.is(schemaVersion(db), 0);
});

test('corrupt bytes are moved aside and a fresh database starts', async t => {
	const f = fixture(t);
	const bytes = Buffer.from('fixture invalid SQLite bytes');
	writeFileSync(f.filename, bytes);
	const store = await f.open();
	t.is(store.getSettings().defaultMode, 'normal');
	t.deepEqual(store.projects.list(), []);
	const directory = readdirSync(f.root).find(name =>
		name.includes('.corrupt-'),
	);
	t.truthy(directory);
	t.deepEqual(
		readFileSync(path.join(f.root, directory as string, 'desktop.sqlite')),
		bytes,
	);
	store.close();
	(await f.open()).close();
	t.is(
		readdirSync(f.root).filter(name => name.includes('.corrupt-')).length,
		1,
	);
});

test('sidecars left after a connection closes are moved with the database', async t => {
	const f = fixture(t);
	writeFileSync(f.filename, 'fixture db');
	writeFileSync(`${f.filename}-wal`, 'fixture wal');
	writeFileSync(`${f.filename}-shm`, 'fixture shm');
	writeFileSync(`${f.filename}-journal`, 'fixture journal');
	let first = true;
	const driver: SqlDriver = {
		...f.driver,
		open: filename => {
			if (!first) return f.driver.open(filename);
			first = false;
			return {
				exec: () => {},
				prepare: sql => ({
					get: () =>
						sql === 'PRAGMA user_version' ? {user_version: 0} : undefined,
					run: () => ({changes: 0}),
					all: () => [{integrity_check: 'fixture corruption'}],
				}),
				close: () => {},
			};
		},
	};
	const store = await desktopStoreFactory.open({
		databasePath: f.filename,
		driver,
	});
	t.teardown(() => store.close());
	const directory = readdirSync(f.root).find(name =>
		name.includes('.corrupt-'),
	) as string;
	t.deepEqual(readdirSync(path.join(f.root, directory)).sort(), [
		'desktop.sqlite',
		'desktop.sqlite-journal',
		'desktop.sqlite-shm',
		'desktop.sqlite-wal',
	]);
	t.deepEqual(store.projects.list(), []);
});

test('invalid migration records are quarantined rather than partially upgraded', async t => {
	const f = fixture(t);
	(await f.open()).close();
	const db = f.driver.open(f.filename);
	db.prepare('DELETE FROM schema_migration WHERE version = ?').run(1);
	db.close();
	(await f.open()).close();
	t.true(readdirSync(f.root).some(name => name.includes('.corrupt-')));
});

test('settings and bounded UI state persist across close and reopen', async t => {
	const f = fixture(t);
	const store = await f.open();
	t.deepEqual(store.getSettings(), {
		publicBrowsingEnabled: false,
		defaultMode: 'normal',
		editor: 'system',
		nanocoderOverridePath: null,
		theme: 'dark',
		browserProfiles: [],
		browserAssignments: {},
		nanocoderBrowserEnabled: false,
		browserAllowedSites: [],
	});
	const settings = store.updateSettings({
		publicBrowsingEnabled: true,
		defaultMode: 'plan',
		editor: 'code',
		theme: 'light',
	});
	const state = store.updateUiState({
		window: {width: 1240, height: 840, x: -100, y: 20, maximised: true},
		activeProjectId: randomUUID(),
		activeThreadId: randomUUID(),
		openThreadIds: [randomUUID()],
		inspector: 'review',
		bottomPanel: 'terminal',
	});
	t.is(store.updateSettings({}).theme, 'light');
	t.deepEqual(store.updateUiState({}), state);
	store.close();
	const next = await f.open();
	t.deepEqual(next.getSettings(), settings);
	t.deepEqual(next.getUiState(), state);
	const detached = next.getUiState();
	detached.openThreadIds.push(randomUUID());
	t.deepEqual(next.getUiState(), state);
});

test('main can store a canonical runtime override but unavailable and relative paths are refused', async t => {
	const f = fixture(t);
	const store = await f.open();
	const executable = path.join(f.root, 'fixture-cli.js');
	writeFileSync(executable, '');
	t.is(
		store.updateSettings({nanocoderOverridePath: executable})
			.nanocoderOverridePath,
		executable,
	);
	t.throws(() => store.updateSettings({nanocoderOverridePath: 'relative.js'}), {
		code: 'VALIDATION',
	});
	t.throws(
		() =>
			store.updateSettings({
				nanocoderOverridePath: path.join(f.root, 'missing'),
			}),
		{code: 'VALIDATION'},
	);
	t.throws(() => store.updateSettings({nanocoderOverridePath: f.root}), {
		code: 'VALIDATION',
	});
	t.is(
		store.updateSettings({nanocoderOverridePath: null}).nanocoderOverridePath,
		null,
	);
});

test('the store refuses secrets, transcripts, payloads, arbitrary fields and unsafe defaults before writing', async t => {
	const f = fixture(t);
	const store = await f.open();
	const marker = 'fixture-never-persist-this-content';
	const before = store.getSettings();
	for (const key of [
		'apiKey',
		'oauthToken',
		'messages',
		'fileContents',
		'toolOutput',
		'stderr',
		'draft',
	]) {
		t.throws(() => store.updateSettings({[key]: marker} as never), {
			code: 'VALIDATION',
		});
		t.throws(() => store.updateUiState({[key]: marker} as never), {
			code: 'VALIDATION',
		});
	}
	t.throws(() => store.updateSettings({defaultMode: 'yolo'} as never), {
		code: 'VALIDATION',
	});
	t.throws(() => store.updateUiState({window: {width: 100_000}} as never), {
		code: 'VALIDATION',
	});
	t.throws(
		() =>
			store.updateUiState({
				openThreadIds: Array.from({length: 101}, () => randomUUID()),
			}),
		{code: 'VALIDATION'},
	);
	t.throws(
		() =>
			store.updateUiState({
				window: {...store.getUiState().window, content: marker},
			} as never),
		{code: 'VALIDATION'},
	);
	t.deepEqual(store.getSettings(), before);
	store.close();
	for (const file of readdirSync(f.root)) {
		if (statSync(path.join(f.root, file)).isFile())
			t.false(readFileSync(path.join(f.root, file)).includes(marker));
	}
});

test('database paths cannot be relative, symlinks, directories or hard links', async t => {
	const f = fixture(t);
	const open = (filename: string) =>
		desktopStoreFactory.open({databasePath: filename, driver: f.driver});
	await t.throwsAsync(() => open('relative.sqlite'), {code: 'VALIDATION'});
	await t.throwsAsync(() => open(`${f.filename}\0`), {code: 'VALIDATION'});
	await t.throwsAsync(() => open(f.root), {code: 'DENIED'});
	const target = path.join(f.root, 'target');
	writeFileSync(target, 'fixture unchanged');
	symlinkSync(target, f.filename);
	await t.throwsAsync(f.open, {code: 'DENIED'});
	t.is(readFileSync(target, 'utf8'), 'fixture unchanged');
	rmSync(f.filename);
	linkSync(target, f.filename);
	await t.throwsAsync(f.open, {code: 'DENIED'});
	t.is(readFileSync(target, 'utf8'), 'fixture unchanged');
});

test('SQLite sidecars cannot redirect writes through symlinks', async t => {
	const f = fixture(t);
	const target = path.join(f.root, 'target');
	writeFileSync(target, 'fixture unchanged');
	for (const suffix of ['-wal', '-shm', '-journal']) {
		symlinkSync(target, f.filename + suffix);
		await t.throwsAsync(f.open, {code: 'DENIED'});
		rmSync(f.filename + suffix);
	}
	t.is(readFileSync(target, 'utf8'), 'fixture unchanged');
});

test('a symlinked user-data directory is canonicalised and keeps the database inside it', async t => {
	const f = fixture(t);
	const actual = path.join(f.root, 'actual');
	const linked = path.join(f.root, 'linked');
	mkdirSync(actual);
	symlinkSync(
		actual,
		linked,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
	const store = await desktopStoreFactory.open({
		databasePath: path.join(linked, 'desktop.sqlite'),
		driver: f.driver,
	});
	t.teardown(() => store.close());
	store.updateSettings({theme: 'light'});
	t.true(readdirSync(actual).every(name => name.startsWith('desktop.sqlite')));
	t.true(readdirSync(actual).includes('desktop.sqlite'));
});

test('driver errors never expose SQLite inputs or filenames and foreign adapters are refused', async t => {
	const f = fixture(t);
	const db = f.driver.open(f.filename);
	t.teardown(() => db.close());
	t.throws(() => db.exec('fixture sensitive invalid SQL'), {
		code: 'INTERNAL',
		message: 'The desktop database could not complete the operation',
	});
	t.throws(() => db.prepare('fixture sensitive invalid SQL'), {
		code: 'INTERNAL',
	});
	await t.throwsAsync(
		() => f.driver.backup({...db}, path.join(f.root, 'backup')),
		{code: 'INTERNAL'},
	);
	await t.throwsAsync(
		() => f.driver.backup(db, path.join(f.root, 'missing', 'backup')),
		{code: 'INTERNAL'},
	);
	t.throws(() => f.driver.open(f.root), {code: 'INTERNAL'});
});

test('project and thread repositories round-trip metadata, sort, scope and remove desktop rows only', async t => {
	const f = fixture(t);
	const store = await f.open();
	const one = project(f.root);
	const otherRoot = path.join(f.root, 'other');
	mkdirSync(otherRoot);
	const two = project(otherRoot, {lastOpenedAt: '2026-10-29T13:00:00.000Z'});
	store.projects.save(one);
	store.projects.save(two);
	t.deepEqual(store.projects.list(), [two, one]);
	t.deepEqual(store.projects.get(one.id), one);
	t.is(store.projects.get(randomUUID()), undefined);
	const first = thread(one);
	const latest = thread(one, {lastActivityAt: '2026-10-29T13:00:00.000Z'});
	const archived = thread(one, {archiveState: 'archived'});
	for (const row of [first, latest, archived]) store.threads.save(row);
	t.deepEqual(store.threads.list(one.id, 'active'), [latest, first]);
	t.deepEqual(store.threads.list(one.id, 'archived'), [archived]);
	t.is(store.threads.get(two.id, first.id), undefined);
	store.threads.remove(two.id, first.id);
	t.deepEqual(store.threads.get(one.id, first.id), first);
	store.threads.save({...first, title: 'renamed', runState: 'running'});
	t.is(store.threads.get(one.id, first.id)?.title, 'renamed');
	store.projects.save({...one, displayName: 'renamed project', trusted: true});
	t.is(store.projects.get(one.id)?.displayName, 'renamed project');
	store.close();
	const reopened = await f.open();
	t.is(reopened.threads.get(one.id, first.id)?.runState, 'interrupted');
	reopened.threads.remove(one.id, first.id);
	t.is(reopened.threads.get(one.id, first.id), undefined);
	const sessionFile = path.join(f.root, 'fixture-session.json');
	writeFileSync(sessionFile, '{}');
	reopened.projects.remove(one.id);
	t.deepEqual(reopened.threads.list(one.id, 'active'), []);
	t.deepEqual(reopened.threads.list(one.id, 'archived'), []);
	t.is(readFileSync(sessionFile, 'utf8'), '{}');
	t.deepEqual(reopened.projects.list(), [two]);
});

test('repositories refuse content fields, unsafe defaults, cross-project moves and path escapes', async t => {
	const f = fixture(t);
	const store = await f.open();
	const owner = project(f.root, {defaultMode: 'plan'});
	store.projects.save(owner);
	t.throws(
		() => store.projects.save({...owner, defaultMode: 'yolo'} as never),
		{code: 'VALIDATION'},
	);
	t.throws(
		() => store.projects.save({...owner, messages: ['fixture']} as never),
		{code: 'VALIDATION'},
	);
	t.throws(() => store.projects.save({...owner, sessionCwd: tmpdir()}), {
		code: 'OUTSIDE_ROOT',
	});
	t.throws(
		() =>
			store.projects.save({
				...owner,
				canonicalRoot: path.join(f.root, 'missing'),
			}),
		{code: 'DENIED'},
	);
	const row = thread(owner, {mode: 'yolo'});
	store.threads.save(row);
	t.is(store.threads.get(owner.id, row.id)?.mode, 'plan');
	t.throws(() => store.threads.save({...row, toolOutput: 'fixture'} as never), {
		code: 'VALIDATION',
	});
	t.throws(() => store.threads.save({...row, projectId: randomUUID()}), {
		code: 'NOT_FOUND',
	});
	t.throws(
		() =>
			store.threads.save({...row, sessionCwd: realpathSync.native(tmpdir())}),
		{code: 'OUTSIDE_ROOT'},
	);
	const two = project(f.root, {id: randomUUID()});
	const sub = path.join(f.root, 'sub');
	mkdirSync(sub);
	store.projects.save({...two, canonicalRoot: sub, sessionCwd: sub});
	t.throws(() => store.threads.save({...row, projectId: two.id}), {
		code: 'DENIED',
	});
	t.throws(
		() =>
			store.threads.save({
				...row,
				id: randomUUID(),
				nanocoderSessionId: row.nanocoderSessionId,
			}),
		{code: 'INTERNAL'},
	);
});

test('repositories refuse a saved ACP session identity already owned by another project', async t => {
	const f = fixture(t);
	const store = await f.open();
	const first = project(f.root);
	const secondRoot = path.join(f.root, 'another-project');
	mkdirSync(secondRoot);
	const second = project(secondRoot);
	store.projects.save(first);
	store.projects.save(second);
	const original = thread(first);
	store.threads.save(original);
	const duplicate = thread(second, {
		nanocoderSessionId: original.nanocoderSessionId,
	});
	t.throws(() => store.threads.save(duplicate), {code: 'INTERNAL'});
	t.deepEqual(store.threads.get(first.id, original.id), original);
	t.deepEqual(store.threads.list(second.id, 'active'), []);
});

test('repositories mark missing and replaced roots without following them', async t => {
	const f = fixture(t);
	const store = await f.open();
	const root = path.join(f.root, 'project');
	const moved = path.join(f.root, 'moved');
	mkdirSync(root);
	const row = project(root);
	store.projects.save(row);
	renameSync(root, moved);
	t.is(store.projects.get(row.id)?.availability, 'missing');
	symlinkSync(moved, root, process.platform === 'win32' ? 'junction' : 'dir');
	t.is(store.projects.get(row.id)?.availability, 'changed');
	t.throws(() => store.projects.save({...row, trusted: true}), {
		code: 'DENIED',
	});
});

test('a project root replaced by a file is a changed folder, not an available one', async t => {
	const f = fixture(t);
	const store = await f.open();
	const root = path.join(f.root, 'project');
	mkdirSync(root);
	const row = project(root);
	store.projects.save(row);
	t.is(store.projects.get(row.id)?.availability, 'available');
	rmSync(root, {recursive: true});
	writeFileSync(root, 'not a folder');
	t.is(store.projects.get(row.id)?.availability, 'changed');
});

test('concurrent opens recheck the migration version under the write lock', async t => {
	const f = fixture(t);
	const previous = f.driver.open(f.filename);
	previous.exec(migrations[0].sql);
	previous
		.prepare('INSERT INTO schema_migration VALUES (?, ?)')
		.run(1, '2026-10-29T12:00:00.000Z');
	previous.prepare('INSERT INTO setting VALUES (?, ?)').run('theme', '"light"');
	previous.exec('PRAGMA user_version = 1');
	previous.close();
	let arrived = 0;
	let release!: () => void;
	const barrier = new Promise<void>(resolve => {
		release = resolve;
	});
	const backups: string[] = [];
	const driver: SqlDriver = {
		open: f.driver.open,
		backup: async (db, filename) => {
			await f.driver.backup(db, filename);
			backups.push(filename);
			if (++arrived === 2) release();
			await barrier;
		},
	};
	const stores = await Promise.all([
		desktopStoreFactory.open({databasePath: f.filename, driver}),
		desktopStoreFactory.open({databasePath: f.filename, driver}),
	]);
	for (const store of stores) {
		t.teardown(() => store.close());
		t.is(store.getSettings().theme, 'light');
	}
	t.is(backups.length, 2);
	for (const filename of backups) {
		const db = f.driver.open(filename);
		t.is(schemaVersion(db), 1);
		db.close();
	}
	stores[0].updateSettings({editor: 'zed'});
	stores[1].updateSettings({defaultMode: 'plan'});
	t.like(stores[0].getSettings(), {
		editor: 'zed',
		defaultMode: 'plan',
		theme: 'light',
	});
	stores[0].updateUiState({inspector: 'review'});
	stores[1].updateUiState({bottomPanel: 'terminal'});
	t.like(stores[0].getUiState(), {
		inspector: 'review',
		bottomPanel: 'terminal',
	});
	const db = f.driver.open(f.filename);
	t.teardown(() => db.close());
	t.is(schemaVersion(db), migrations.length);
	t.deepEqual(
		db
			.prepare('SELECT version FROM schema_migration ORDER BY version')
			.all()
			.map(row => row.version),
		migrations.map(migration => migration.version),
	);
});

test('settings and UI patches hold the write lock before reading the previous state', async t => {
	const f = fixture(t);
	(await f.open()).close();
	const rival = f.driver.open(f.filename);
	t.teardown(() => rival.close());
	let armed = false;
	let locked = false;
	let reads = 0;
	const driver: SqlDriver = {
		...f.driver,
		open: filename => {
			const db = f.driver.open(filename);
			return {
				...db,
				exec: sql => {
					db.exec(sql);
					if (sql === 'BEGIN IMMEDIATE') locked = true;
					if (sql === 'COMMIT' || sql === 'ROLLBACK') locked = false;
				},
				prepare: sql => {
					if (
						armed &&
						(sql === 'SELECT key, value FROM setting' ||
							sql === 'SELECT value FROM ui_state WHERE id = 1')
					) {
						reads++;
						t.true(locked);
						t.throws(() => rival.exec('BEGIN IMMEDIATE'), {code: 'INTERNAL'});
					}
					return db.prepare(sql);
				},
			};
		},
	};
	const store = await desktopStoreFactory.open({
		databasePath: f.filename,
		driver,
	});
	t.teardown(() => store.close());
	armed = true;
	store.updateSettings({theme: 'light'});
	store.updateUiState({inspector: 'review'});
	armed = false;
	t.is(reads, 2);
	t.false(locked);
	rival.exec('BEGIN IMMEDIATE');
	rival.exec('ROLLBACK');
	t.is(store.getSettings().theme, 'light');
	t.is(store.getUiState().inspector, 'review');
});

for (const version of [migrations.length, migrations.length + 1]) {
	test(`a failed integrity check cannot replace a newer ledger with user_version ${version}`, async t => {
		const f = fixture(t);
		(await f.open()).close();
		const db = f.driver.open(f.filename);
		db.exec(`
			CREATE TABLE future_table(n INTEGER CHECK(n >= 0)) STRICT;
			PRAGMA ignore_check_constraints = ON;
			INSERT INTO future_table VALUES (-1);
			PRAGMA ignore_check_constraints = OFF;
		`);
		db.prepare('INSERT INTO schema_migration VALUES (?, ?)').run(
			migrations.length + 1,
			'2026-10-29T12:00:00.000Z',
		);
		db.exec(`PRAGMA user_version = ${version}`);
		t.true(
			db
				.prepare('PRAGMA integrity_check')
				.all()
				.some(row => row.integrity_check !== 'ok'),
		);
		db.close();
		const before = readFileSync(f.filename);
		await t.throwsAsync(f.open, {code: 'STORE_TOO_NEW'});
		t.deepEqual(readFileSync(f.filename), before);
		t.deepEqual(readdirSync(f.root), ['desktop.sqlite']);
	});
}

test('metadata can be updated when its unchanged saved directory is missing', async t => {
	const f = fixture(t);
	const store = await f.open();
	const root = path.join(f.root, 'project');
	mkdirSync(root);
	const owner = project(root);
	const saved = thread(owner);
	store.projects.save(owner);
	store.threads.save(saved);
	renameSync(root, `${root}-moved`);
	store.threads.save({...saved, archiveState: 'archived'});
	const archived = store.threads.get(owner.id, saved.id);
	t.is(archived?.archiveState, 'archived');
	store.threads.save({...saved, archiveState: 'archived', runState: 'failed'});
	t.is(store.threads.get(owner.id, saved.id)?.runState, 'failed');
	t.is(store.threads.get(owner.id, saved.id)?.archiveState, 'archived');
	store.projects.save({...owner, displayName: 'missing project'});
	t.is(store.projects.get(owner.id)?.displayName, 'missing project');
	t.throws(() => store.threads.save({...saved, id: randomUUID()}), {
		code: 'DENIED',
	});
	t.throws(
		() => store.threads.save({...saved, sessionCwd: `${root}-missing`}),
		{code: 'DENIED'},
	);
	t.throws(() => store.projects.save({...owner, trusted: true}), {
		code: 'DENIED',
	});
});

test('mixed ISO precision is normalised and recent lists use chronological order', async t => {
	const f = fixture(t);
	const store = await f.open();
	const other = path.join(f.root, 'other');
	mkdirSync(other);
	const earlier = '2026-10-29T12:00:00Z';
	const later = '2026-10-29T12:00:00.100Z';
	const one = project(f.root, {lastOpenedAt: earlier, createdAt: earlier});
	const two = project(other, {lastOpenedAt: later});
	store.projects.save(one);
	store.projects.save(two);
	const first = thread(one, {lastActivityAt: earlier});
	const last = thread(one, {lastActivityAt: later});
	store.threads.save(first);
	store.threads.save(last);
	t.deepEqual(
		store.projects.list().map(row => row.id),
		[two.id, one.id],
	);
	t.deepEqual(
		store.threads.list(one.id, 'active').map(row => row.id),
		[last.id, first.id],
	);
	t.is(store.projects.get(one.id)?.createdAt, '2026-10-29T12:00:00.000Z');
	const db = f.driver.open(f.filename);
	t.teardown(() => db.close());
	t.is(
		db.prepare('SELECT last_opened_at FROM project WHERE id = ?').get(one.id)
			?.last_opened_at,
		'2026-10-29T12:00:00.000Z',
	);
	t.is(
		db.prepare('SELECT last_activity_at FROM thread WHERE id = ?').get(first.id)
			?.last_activity_at,
		'2026-10-29T12:00:00.000Z',
	);
	db.prepare('UPDATE project SET last_opened_at = ? WHERE id = ?').run(
		earlier,
		one.id,
	);
	db.prepare('UPDATE thread SET last_activity_at = ? WHERE id = ?').run(
		earlier,
		first.id,
	);
	t.deepEqual(
		store.projects.list().map(row => row.id),
		[two.id, one.id],
	);
	t.deepEqual(
		store.threads.list(one.id, 'active').map(row => row.id),
		[last.id, first.id],
	);
});

test('a stale runtime override does not block unrelated settings and can be cleared', async t => {
	const f = fixture(t);
	const store = await f.open();
	const cli = path.join(f.root, 'fixture-cli.js');
	writeFileSync(cli, '');
	store.updateSettings({nanocoderOverridePath: cli});
	renameSync(cli, `${cli}-moved`);
	t.is(store.updateSettings({theme: 'light'}).theme, 'light');
	t.is(
		store.updateSettings({nanocoderOverridePath: cli}).nanocoderOverridePath,
		cli,
	);
	t.throws(
		() => store.updateSettings({nanocoderOverridePath: `${cli}-missing`}),
		{code: 'VALIDATION'},
	);
	t.is(
		store.updateSettings({nanocoderOverridePath: null}).nanocoderOverridePath,
		null,
	);
});

test('native WAL recovery preserves committed data after SQLite closes and checkpoints', async t => {
	const f = fixture(t);
	(await f.open()).close();
	const script = `
		const {DatabaseSync} = require('node:sqlite');
		const db = new DatabaseSync(process.argv[1]);
		db.exec('PRAGMA journal_mode = WAL; UPDATE schema_migration SET version = 0 WHERE version = 1');
		process.kill(process.pid, 'SIGKILL');
	`;
	const crashed = spawnSync(process.execPath, ['-e', script, f.filename], {
		stdio: 'ignore',
	});
	t.is(crashed.error, undefined);
	t.not(crashed.status, 0);
	t.true(readdirSync(f.root).includes('desktop.sqlite-wal'));
	t.true(readdirSync(f.root).includes('desktop.sqlite-shm'));
	(await f.open()).close();
	const directory = readdirSync(f.root).find(name =>
		name.includes('.corrupt-'),
	) as string;
	t.deepEqual(readdirSync(path.join(f.root, directory)), ['desktop.sqlite']);
	const preserved = f.driver.open(
		path.join(f.root, directory, 'desktop.sqlite'),
	);
	t.teardown(() => preserved.close());
	t.is(
		preserved.prepare('SELECT min(version) AS n FROM schema_migration').get()
			?.n,
		0,
	);
});

test('foreign keys cascade metadata for turns, agents, terminal and browser', async t => {
	const f = fixture(t);
	const store = await f.open();
	const owner = project(f.root);
	const row = thread(owner);
	store.projects.save(owner);
	store.threads.save(row);
	const db = f.driver.open(f.filename);
	t.teardown(() => db.close());
	db.prepare('INSERT INTO turn_summary VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
		randomUUID(),
		row.id,
		'completed',
		'[]',
		row.lastActivityAt,
		row.lastActivityAt,
		null,
		null,
	);
	db.prepare('INSERT INTO agent_run VALUES (?, ?, ?, ?, ?, ?)').run(
		randomUUID(),
		row.id,
		null,
		null,
		'explore',
		'completed',
	);
	db.prepare('INSERT INTO terminal_session VALUES (?, ?, ?, ?)').run(
		randomUUID(),
		owner.id,
		f.root,
		'stopped',
	);
	db.prepare('INSERT INTO browser_tab VALUES (?, ?, ?, ?)').run(
		randomUUID(),
		owner.id,
		'http://localhost/',
		'fixture',
	);
	t.throws(
		() =>
			db
				.prepare('INSERT INTO setting VALUES (?, ?)')
				.run('apiKey', '"fixture"'),
		{code: 'INTERNAL'},
	);
	store.projects.remove(owner.id);
	for (const table of [
		'thread',
		'turn_summary',
		'agent_run',
		'terminal_session',
		'browser_tab',
	]) {
		t.is(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
	}
});

test('BRW-05 browser profiles and each project assignment persist, and refuse malformed or dangling data', async t => {
	const f = fixture(t);
	const store = await f.open();
	const profile = {id: randomUUID(), name: 'Work sites'};
	const project = randomUUID();
	const saved = store.updateSettings({
		browserProfiles: [profile],
		browserAssignments: {[project]: profile.id, [randomUUID()]: 'incognito'},
	});
	store.close();
	const next = await f.open();
	t.deepEqual(next.getSettings().browserProfiles, [profile]);
	t.deepEqual(next.getSettings().browserAssignments, saved.browserAssignments);
	const refused = (patch: Record<string, unknown>) =>
		t.throws(() => next.updateSettings(patch as never), {
			code: 'VALIDATION',
		});
	refused({browserProfiles: [{id: 'nope', name: 'x'}]});
	refused({browserProfiles: [{id: randomUUID(), name: ''}]});
	refused({browserProfiles: [{id: randomUUID(), name: 'x'.repeat(41)}]});
	refused({browserProfiles: [{id: randomUUID(), name: 'bad\nname'}]});
	refused({browserProfiles: [{id: randomUUID(), name: 'ok', extra: 1}]});
	refused({
		browserProfiles: [
			{id: randomUUID(), name: 'Same'},
			{id: randomUUID(), name: 'same'},
		],
	});
	refused({
		browserProfiles: Array.from({length: 21}, (_, i) => ({
			id: randomUUID(),
			name: `p${i}`,
		})),
	});
	refused({browserAssignments: {'not-a-project': 'default'}});
	refused({browserAssignments: {[project]: 'shared'}});
	refused({browserAssignments: {[project]: randomUUID()}});
	refused({
		browserAssignments: Object.fromEntries(
			Array.from({length: 501}, () => [randomUUID(), 'default']),
		),
	});
	t.deepEqual(next.getSettings().browserProfiles, [profile]);
});

test('BRW-05 a version four database keeps its settings when the setting table learns the browser profile keys', async t => {
	const f = fixture(t);
	const database = f.driver.open(f.filename);
	try {
		for (const migration of migrations.slice(0, 4))
			transaction(database, () => {
				database.exec(migration.sql);
				database
					.prepare('INSERT INTO schema_migration VALUES (?, ?)')
					.run(migration.version, '2026-10-29T12:00:00.000Z');
				database.exec(`PRAGMA user_version = ${migration.version}`);
			});
		database
			.prepare('INSERT INTO setting VALUES (?, ?)')
			.run('theme', '"light"');
		database
			.prepare('INSERT INTO setting VALUES (?, ?)')
			.run('publicBrowsingEnabled', 'true');
	} finally {
		database.close();
	}
	const store = await f.open();
	t.like(store.getSettings(), {
		theme: 'light',
		publicBrowsingEnabled: true,
		browserProfiles: [],
		browserAssignments: {},
	});
	const profile = {id: randomUUID(), name: 'Docs'};
	t.deepEqual(
		store.updateSettings({browserProfiles: [profile]}).browserProfiles,
		[profile],
	);
	t.true(readdirSync(f.root).some(name => name.includes('.backup')));
});

test('BRW-18 a version five database keeps its settings when the setting table learns the Nanocoder browser key, which starts off', async t => {
	const f = fixture(t);
	const database = f.driver.open(f.filename);
	try {
		for (const migration of migrations.slice(0, 5))
			transaction(database, () => {
				database.exec(migration.sql);
				database
					.prepare('INSERT INTO schema_migration VALUES (?, ?)')
					.run(migration.version, '2026-11-01T12:00:00.000Z');
				database.exec(`PRAGMA user_version = ${migration.version}`);
			});
		database
			.prepare('INSERT INTO setting VALUES (?, ?)')
			.run('publicBrowsingEnabled', 'true');
	} finally {
		database.close();
	}
	const store = await f.open();
	t.like(store.getSettings(), {
		publicBrowsingEnabled: true,
		nanocoderBrowserEnabled: false,
	});
	t.true(
		store.updateSettings({nanocoderBrowserEnabled: true})
			.nanocoderBrowserEnabled,
	);
	store.close();
	t.true((await f.open()).getSettings().nanocoderBrowserEnabled);
});

test('BRW-18 the Nanocoder browser setting accepts only a boolean', async t => {
	const store = await fixture(t).open();
	for (const value of ['yes', 1, null])
		t.throws(() =>
			store.updateSettings({nanocoderBrowserEnabled: value} as never),
		);
	t.false(store.getSettings().nanocoderBrowserEnabled);
});

test('DEC-50 the always-allowed sites are a bounded list of distinct web origins, kept across reopen', async t => {
	const f = fixture(t);
	const store = await f.open();
	t.deepEqual(store.getSettings().browserAllowedSites, []);
	store.updateSettings({
		browserAllowedSites: [
			'https://docs.example.com',
			'http://intranet.test:8080',
		],
	});
	for (const bad of [
		['https://docs.example.com/path'],
		['ftp://example.com'],
		['https://a.example', 'https://a.example'],
		['not a url'],
		Array.from({length: 201}, (_, i) => `https://s${i}.example`),
	])
		t.throws(
			() => store.updateSettings({browserAllowedSites: bad}),
			undefined,
			JSON.stringify(bad).slice(0, 60),
		);
	store.close();
	t.deepEqual((await f.open()).getSettings().browserAllowedSites, [
		'https://docs.example.com',
		'http://intranet.test:8080',
	]);
});

test('CHAT-23 a thread records whether its session is pinned, and only active threads with an unpinned saved session are listed for the retention warning', async t => {
	const f = fixture(t);
	const store = await f.open();
	const owner = project(f.root);
	const otherRoot = path.join(f.root, 'other-project');
	mkdirSync(otherRoot);
	const other = project(otherRoot);
	store.projects.save(owner);
	store.projects.save(other);
	const open = thread(owner, {title: 'open'});
	const pinned = thread(owner, {title: 'pinned'});
	const archived = thread(owner, {archiveState: 'archived'});
	const viewOnly = thread(owner, {runState: 'view-only'});
	const unsaved = thread(owner, {nanocoderSessionId: null});
	const elsewhere = thread(other, {title: 'elsewhere'});
	for (const row of [open, pinned, archived, viewOnly, unsaved, elsewhere])
		store.threads.save(row);
	store.threads.setSessionPinned(owner.id, pinned.id, true);
	t.deepEqual(
		store.threads
			.listUnpinnedSessions()
			.map(row => row.title)
			.sort(),
		['elsewhere', 'open'],
	);
	t.deepEqual(
		store.threads.listUnpinnedSessions().find(row => row.title === 'open'),
		{
			projectId: owner.id,
			threadId: open.id,
			title: 'open',
			lastActivityAt: open.lastActivityAt,
		},
	);
	t.throws(() => store.threads.setSessionPinned(owner.id, 'missing', true), {
		instanceOf: IpcFailure,
	});
});

test('CHAT-23 a pin belongs to one session: saving the same session keeps it, a replaced session loses it', async t => {
	const f = fixture(t);
	const store = await f.open();
	const owner = project(f.root);
	store.projects.save(owner);
	const row = thread(owner, {title: 'pin me'});
	store.threads.save(row);
	store.threads.setSessionPinned(owner.id, row.id, true);
	store.threads.save({...row, title: 'renamed'});
	t.deepEqual(store.threads.listUnpinnedSessions(), []);
	store.threads.save({...row, nanocoderSessionId: randomUUID()});
	t.is(store.threads.listUnpinnedSessions().length, 1);
	store.threads.setSessionPinned(owner.id, row.id, true);
	store.threads.setSessionPinned(owner.id, row.id, false);
	t.is(store.threads.listUnpinnedSessions().length, 1);
	t.false(store.threads.getSessionPinned(owner.id, row.id));
	store.threads.setSessionPinned(owner.id, row.id, true);
	t.true(store.threads.getSessionPinned(owner.id, row.id));
	t.is(store.threads.getSessionPinned(owner.id, randomUUID()), undefined);
});

test('DEC-45 the retention limits Nanocoder reported are kept across a restart and refuse values it could not have sent', async t => {
	const f = fixture(t);
	const store = await f.open();
	t.is(store.retention.get(), undefined);
	store.retention.set({days: 45, maxSessions: 200});
	t.deepEqual(store.retention.get(), {days: 45, maxSessions: 200});
	store.close();
	const reopened = await f.open();
	t.deepEqual(reopened.retention.get(), {days: 45, maxSessions: 200});
	for (const bad of [
		{days: 0, maxSessions: 100},
		{days: 30, maxSessions: 0},
		{days: 1.5, maxSessions: 100},
		{days: Number.NaN, maxSessions: 100},
		{days: 30, maxSessions: 1e12},
	])
		t.throws(() => reopened.retention.set(bad), {instanceOf: IpcFailure});
	t.deepEqual(reopened.retention.get(), {days: 45, maxSessions: 200});
});
