import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {FakeClock} from '@/main/nanocoder/fixtures/fake-clock';
import {captureLaunchIdentity, launchNanocoder} from '@/main/nanocoder/launch';
import {ProjectSupervisor} from '@/main/nanocoder/supervisor';
import {createTrustPreflight} from '@/main/nanocoder/trust-preflight';
import {isInside} from '@/main/paths';
import type {ProjectInfo} from '@/shared/ipc';

function projectInfo(root: string): ProjectInfo {
	return {
		id: 'preflight-project',
		canonicalRoot: root,
		sessionCwd: root,
		displayName: 'fixture',
		trusted: true,
		defaultMode: 'normal',
		availability: 'available',
		createdAt: '',
		lastOpenedAt: '',
	};
}

function fixture(
	t: ExecutionContext,
	behaviour = 'refuse',
	options: Parameters<typeof createTrustPreflight>[0] = {},
) {
	const work = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-preflight-test-')),
	);
	t.teardown(() => rmSync(work, {recursive: true, force: true}));
	const cli = path.join(work, 'cli.mjs');
	copyFileSync(
		path.join(import.meta.dirname, 'fixtures/fake-trust-preflight.mjs'),
		cli,
	);
	writeFileSync(path.join(work, 'preflight-behaviour'), behaviour);
	const project = path.join(work, 'project');
	mkdirSync(project);
	const launches: Array<{
		root: string;
		env: NodeJS.ProcessEnv;
		args: readonly string[];
	}> = [];
	const clock = new FakeClock();
	const children: ReturnType<typeof launchNanocoder>[] = [];
	let started!: () => void;
	const ready = new Promise<void>(resolve => {
		started = resolve;
	});
	const preflight = createTrustPreflight({
		...options,
		clock,
		launch: (runtime, args, root, env) => {
			launches.push({root, env: env ?? {}, args});
			const child = (options.launch ?? launchNanocoder)(
				runtime,
				args,
				root,
				env,
			);
			children.push(child);
			child.stderr.on('data', (chunk: Buffer) => {
				if (
					chunk.toString().includes('fixture waiting') ||
					chunk.toString().includes(' is not trusted. ')
				)
					started();
			});
			return child;
		},
	});
	const runtime = {
		nodePath: realpathSync.native(process.execPath),
		cliPath: cli,
		version: '1.31.0',
	};
	return {
		work,
		project,
		cli,
		runtime,
		launches,
		clock,
		children,
		ready,
		preflight,
		verify: () => preflight.verify(runtime, project),
		setBehaviour: (next: string) =>
			writeFileSync(path.join(work, 'preflight-behaviour'), next),
		change: (next = 'refuse') => {
			writeFileSync(path.join(work, 'preflight-behaviour'), next);
			writeFileSync(cli, `${readFileSync(cli, 'utf8')}\n// changed fixture\n`);
		},
	};
}

function assertClean(t: ExecutionContext, f: ReturnType<typeof fixture>) {
	for (const launch of f.launches) {
		t.false(existsSync(launch.root));
		t.false(existsSync(launch.env.HOME ?? ''));
		t.false(isInside(launch.root, [f.project], process.platform));
		t.is(launch.env.NANOCODER_TRUST_DIRECTORY, undefined);
	}
	t.is(f.clock.pending, 0);
}

test('timeout then unguarded explicit Retry runs a second unchanged probe and caches only that rejection (ACP-20)', async t => {
	const f = fixture(t, 'timeout');
	const before = captureLaunchIdentity(f.runtime);
	const rejected = t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	await f.ready;
	f.clock.advance(5000);
	await rejected;
	t.is(f.launches.length, 1);
	f.setBehaviour('published');
	await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	t.is(f.launches.length, 2);
	await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	t.is(f.launches.length, 2);
	t.deepEqual(captureLaunchIdentity(f.runtime), before);
	const audit = readFileSync(path.join(f.work, 'preflight-audit'), 'utf8')
		.trim()
		.split('\n')
		.map(line => JSON.parse(line));
	t.is(audit.filter(entry => entry.kind === 'launch').length, 2);
	t.false(
		audit.some(
			entry => entry.isolated === false || entry.trust || entry.session,
		),
	);
	assertClean(t, f);
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {
		resolve = done;
	});
	return {promise, resolve};
}

for (const behaviour of [
	'published',
	'non-acp',
	'whitespace',
	'wrong-root',
	'wrong-exit',
]) {
	test(`${behaviour} is a definitive unchanged-identity rejection, not an admission (ACP-20)`, async t => {
		const f = fixture(t, behaviour);
		const before = captureLaunchIdentity(f.runtime);
		await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
		f.setBehaviour('refuse');
		await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
		t.is(f.launches.length, 1);
		t.deepEqual(captureLaunchIdentity(f.runtime), before);
		assertClean(t, f);
	});
}

for (const behaviour of ['unknown', 'exit', 'silent-one', 'truncated']) {
	test(`${behaviour} remains refused but an explicit unchanged-identity Retry probes afresh (ACP-20)`, async t => {
		const f = fixture(t, behaviour);
		const before = captureLaunchIdentity(f.runtime);
		await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
		f.setBehaviour('refuse');
		await f.verify();
		await f.verify();
		t.is(f.launches.length, 2);
		t.deepEqual(captureLaunchIdentity(f.runtime), before);
		assertClean(t, f);
	});
}

test('the exact refusal followed by a stall never verifies or poisons explicit Retry (ACP-20)', async t => {
	const f = fixture(t, 'refusal-stall');
	const rejected = t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	await f.ready;
	f.clock.advance(5000);
	await rejected;
	f.setBehaviour('refuse');
	await f.verify();
	t.is(f.launches.length, 2);
	assertClean(t, f);
});

test('stdout released only after the exact refusal still definitively rejects (ACP-20)', async t => {
	const f = fixture(t, 'refusal-late-output');
	const rejected = t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	await f.ready;
	writeFileSync(path.join(f.work, 'preflight-release'), '');
	await rejected;
	f.setBehaviour('refuse');
	await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	t.is(f.launches.length, 1);
	assertClean(t, f);
});

test('external termination is inconclusive, not a reusable refusal (ACP-20)', async t => {
	const f = fixture(t, 'timeout');
	const rejected = t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	await f.ready;
	f.children[0].kill('SIGKILL');
	await rejected;
	f.setBehaviour('refuse');
	await f.verify();
	t.is(f.launches.length, 2);
	assertClean(t, f);
});

for (const cancellation of ['deadline', 'abort'] as const) {
	test(`${cancellation} takes precedence over observed stdout and leaves no reusable rejection (ACP-20)`, async t => {
		const controller = new AbortController();
		const f = fixture(t, 'non-acp', {
			launch: (...args) => {
				const child = launchNanocoder(...args);
				child.stdout.once('data', () => {
					if (cancellation === 'deadline') f.clock.advance(5000);
					else controller.abort();
				});
				return child;
			},
		});
		await t.throwsAsync(
			f.preflight.verify(f.runtime, f.project, controller.signal),
			cancellation === 'abort' ? {name: 'AbortError'} : {code: 'UNSUPPORTED'},
		);
		f.setBehaviour('refuse');
		await f.verify();
		t.is(f.launches.length, 2);
		assertClean(t, f);
	});
}

for (const behaviour of ['refuse', 'non-acp']) {
	test(`failed cleanup after ${behaviour} refuses and leaves neither cached success nor cached rejection (ACP-20)`, async t => {
		let failed = false;
		let removed = 0;
		const f = fixture(t, behaviour, {
			remove: async (file, options) => {
				await rm(file, options);
				removed++;
				if (!failed) {
					failed = true;
					throw new Error('fixture cleanup failure');
				}
			},
		});
		await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
		t.is(removed, 2);
		f.setBehaviour('refuse');
		await f.verify();
		t.is(f.launches.length, 2);
		assertClean(t, f);
	});
}

test('a synchronous cleanup failure still attempts and awaits every other owned removal (ACP-20)', async t => {
	const entered = deferred();
	const release = deferred();
	t.teardown(release.resolve);
	let calls = 0;
	const f = fixture(t, 'refuse', {
		remove: (file, options) => {
			rmSync(file, options);
			calls++;
			if (calls === 1) throw new Error('fixture synchronous cleanup failure');
			if (calls === 2) {
				entered.resolve();
				return release.promise;
			}
			return Promise.resolve();
		},
	});
	let settled = false;
	const rejected = t.throwsAsync(
		f.verify().finally(() => {
			settled = true;
		}),
		{code: 'UNSUPPORTED'},
	);
	await entered.promise;
	await new Promise(resolve => setImmediate(resolve));
	t.false(settled);
	t.is(calls, 2);
	release.resolve();
	await rejected;
	await f.verify();
	t.is(f.launches.length, 2);
	assertClean(t, f);
});

for (const stream of ['stdin', 'stdout', 'stderr'] as const) {
	test(`${stream} observation errors refuse without retaining a verdict (ACP-20)`, async t => {
		let fail = true;
		const f = fixture(t, 'refuse', {
			launch: (...args) => {
				const child = launchNanocoder(...args);
				if (fail) {
					fail = false;
					child.stderr.once('data', () =>
						child[stream].emit('error', new Error('fixture stream failure')),
					);
				}
				return child;
			},
		});
		await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
		await f.verify();
		t.is(f.launches.length, 2);
		assertClean(t, f);
	});
}

test('a launch failure refuses without caching or leaking owned temporary state (ACP-20)', async t => {
	let fail = true;
	const f = fixture(t, 'refuse', {
		launch: (...args) => {
			if (fail) {
				fail = false;
				throw new Error('fixture launch failure');
			}
			return launchNanocoder(...args);
		},
	});
	await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	await f.verify();
	t.is(f.launches.length, 2);
	assertClean(t, f);
});

for (const otherProject of [false, true]) {
	for (const replacement of ['non-acp', 'unknown']) {
		test(`late verified completion cannot overwrite ${replacement} for ${otherProject ? 'another project sharing the runtime key' : 'the same runtime key'} (ACP-20)`, async t => {
			const entered = deferred();
			const release = deferred();
			t.teardown(release.resolve);
			let held = false;
			const f = fixture(t, 'refuse', {
				remove: async (file, options) => {
					await rm(file, options);
					if (!held) {
						held = true;
						entered.resolve();
						await release.promise;
					}
				},
			});
			const before = captureLaunchIdentity(f.runtime);
			const old = t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
			await entered.promise;
			f.setBehaviour(replacement);
			const secondRoot = path.join(f.work, 'second-project');
			mkdirSync(secondRoot);
			await t.throwsAsync(
				f.preflight.verify(f.runtime, otherProject ? secondRoot : f.project),
				{code: 'UNSUPPORTED'},
			);
			release.resolve();
			await old;
			f.setBehaviour('refuse');
			if (replacement === 'non-acp') {
				await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
				t.is(f.launches.length, 2);
			} else {
				await f.verify();
				await f.verify();
				t.is(f.launches.length, 3);
			}
			t.deepEqual(captureLaunchIdentity(f.runtime), before);
			assertClean(t, f);
		});
	}
}

test('our stdout-triggered pipe shutdown does not erase the definitive stdout violation (ACP-20)', async t => {
	const f = fixture(t, 'non-acp', {
		launch: (...args) => {
			const child = launchNanocoder(...args);
			child.stdin.once('close', () =>
				child.stdin.emit('error', new Error('fixture destroyed pipe')),
			);
			return child;
		},
	});
	await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	f.setBehaviour('refuse');
	await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	t.is(f.launches.length, 1);
	assertClean(t, f);
});

test('truncation takes precedence over an observed stdout violation (ACP-20)', async t => {
	const f = fixture(t, 'non-acp', {
		launch: (...args) => {
			const child = launchNanocoder(...args);
			child.stdout.once('data', () =>
				child.stderr.emit('data', Buffer.from(`${'x'.repeat(8192)}\n`)),
			);
			return child;
		},
	});
	await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	f.setBehaviour('refuse');
	await f.verify();
	t.is(f.launches.length, 2);
	assertClean(t, f);
});

test('an invalidated verified entry cannot revive after an inconclusive replacement, even when the old fingerprint returns (ACP-20)', async t => {
	const waiting = deferred();
	const f = fixture(t, 'refuse', {
		launch: (...args) => {
			const child = launchNanocoder(...args);
			child.stderr.on('data', (chunk: Buffer) => {
				if (chunk.toString().includes('fixture waiting')) waiting.resolve();
			});
			return child;
		},
	});
	const seconds = 1_700_000_000;
	utimesSync(f.cli, seconds, seconds);
	const original = readFileSync(f.cli, 'utf8');
	const before = captureLaunchIdentity(f.runtime);
	await f.verify();
	f.change('timeout');
	const rejected = t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	await waiting.promise;
	f.clock.advance(5000);
	await rejected;
	writeFileSync(f.cli, original);
	utimesSync(f.cli, seconds, seconds);
	f.setBehaviour('published');
	t.deepEqual(captureLaunchIdentity(f.runtime), before);
	await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	t.is(f.launches.length, 3);
	assertClean(t, f);
});

for (const behaviour of ['refuse', 'non-acp']) {
	test(`an identity change during ${behaviour} cleanup takes precedence over reusable evidence (ACP-20)`, async t => {
		let swapped = false;
		const f = fixture(t, behaviour, {
			remove: async (file, options) => {
				if (!swapped) {
					swapped = true;
					f.change('refuse');
				}
				await rm(file, options);
			},
		});
		const seconds = 1_700_000_000;
		utimesSync(f.cli, seconds, seconds);
		const original = readFileSync(f.cli, 'utf8');
		const before = captureLaunchIdentity(f.runtime);
		await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
		writeFileSync(f.cli, original);
		utimesSync(f.cli, seconds, seconds);
		t.deepEqual(captureLaunchIdentity(f.runtime), before);
		await f.verify();
		t.is(f.launches.length, 2);
		assertClean(t, f);
	});
}

test('an already aborted request never probes or consumes a positive cached result (ACP-20)', async t => {
	const f = fixture(t);
	await f.verify();
	const controller = new AbortController();
	controller.abort();
	await t.throwsAsync(
		f.preflight.verify(f.runtime, f.project, controller.signal),
		{name: 'AbortError'},
	);
	t.is(f.launches.length, 1);
	assertClean(t, f);
});

test('the memory-only verdict cache remains bounded to 32 runtime keys (ACP-20)', async t => {
	const f = fixture(t);
	for (let version = 0; version < 33; version++)
		await f.preflight.verify(
			{...f.runtime, version: `1.31.${version}`},
			f.project,
		);
	t.is(f.launches.length, 33);
	await f.verify();
	t.is(f.launches.length, 34);
	assertClean(t, f);
});

test('the supervisor coalesces same-project Retry, stays unsupported and never automatically retries a preflight failure (ACP-17 ACP-20)', async t => {
	const entered = deferred();
	const release = deferred();
	t.teardown(release.resolve);
	const f = fixture(t, 'timeout', {
		remove: async (file, options) => {
			await rm(file, options);
			if (f.launches.length === 2) {
				entered.resolve();
				await release.promise;
			}
		},
	});
	let connects = 0;
	let selectedLaunches = 0;
	let consents = 0;
	const supervisor = new ProjectSupervisor({
		clock: f.clock,
		resolveRuntime: async () => ({
			ok: true,
			runtime: {...f.runtime, nodeVersion: process.version, source: 'override'},
		}),
		clientInfo: {name: 'fixture', version: '0'},
		confirmTrust: async () => {
			consents++;
			return false;
		},
		connect: async options => {
			connects++;
			await options.beforeLaunch?.();
			await f.preflight.verify(f.runtime, options.root, options.signal);
			await options.beforeLaunch?.();
			selectedLaunches++;
			throw new Error('fixture must not reach a selected-project launch');
		},
	});
	t.teardown(() => supervisor.close());
	const project = projectInfo(f.project);
	const first = supervisor.ensureProcess(project);
	await f.ready;
	f.clock.advance(5000);
	t.is((await first).status, 'unsupported');
	f.clock.advance(60_000);
	t.is(connects, 1);
	t.is(f.launches.length, 1);
	t.is(f.clock.pending, 0);
	f.setBehaviour('published');
	const retries = [supervisor.restart(project), supervisor.restart(project)];
	await entered.promise;
	t.is(connects, 2);
	t.is(f.launches.length, 2);
	release.resolve();
	t.true(
		(await Promise.all(retries)).every(state => state.status === 'unsupported'),
	);
	f.clock.advance(60_000);
	t.is(f.launches.length, 2);
	t.is((await supervisor.restart(project)).status, 'unsupported');
	t.is(f.launches.length, 2);
	t.is(selectedLaunches, 0);
	t.is(consents, 0);
	t.is(supervisor.getState(project.id).restart.nextAttemptAt, null);
	assertClean(t, f);
});

for (const action of ['removal', 'root change', 'disposal'] as const) {
	test(`${action} cancels a real preflight during cleanup with no late readiness, cached success or selected launch (ACP-20)`, async t => {
		const entered = deferred();
		const release = deferred();
		t.teardown(release.resolve);
		let held = false;
		const f = fixture(t, 'refuse', {
			remove: async (file, options) => {
				await rm(file, options);
				if (!held) {
					held = true;
					entered.resolve();
					await release.promise;
				}
			},
		});
		let selectedLaunches = 0;
		let ready = false;
		const supervisor = new ProjectSupervisor({
			clock: f.clock,
			resolveRuntime: async () => ({
				ok: true,
				runtime: {
					...f.runtime,
					nodeVersion: process.version,
					source: 'override',
				},
			}),
			clientInfo: {name: 'fixture', version: '0'},
			confirmTrust: async () => false,
			connect: async options => {
				await options.beforeLaunch?.();
				await f.preflight.verify(f.runtime, options.root, options.signal);
				await options.beforeLaunch?.();
				selectedLaunches++;
				throw new Error('fixture must not reach a selected-project launch');
			},
		});
		t.teardown(() => supervisor.close());
		supervisor.subscribe(event => {
			if (event.type === 'supervisor' && event.state.status === 'ready')
				ready = true;
		});
		const project = projectInfo(f.project);
		const starting = supervisor.ensureProcess(project);
		await entered.promise;
		const stopping =
			action === 'disposal' ? supervisor.close() : supervisor.stop(project.id);
		const nextRoot = path.join(f.work, 'next-project');
		if (action === 'root change') renameSync(f.project, nextRoot);
		else {
			if (action === 'removal')
				rmSync(f.project, {recursive: true, force: true});
			mkdirSync(nextRoot);
		}
		release.resolve();
		await stopping;
		await starting;
		t.false(ready);
		t.is(selectedLaunches, 0);
		t.is(supervisor.getState(project.id).status, 'stopped');
		await f.preflight.verify(f.runtime, nextRoot);
		t.is(f.launches.length, 2);
		assertClean(t, f);
	});
}

test('abort during awaited cleanup discards an otherwise verified result without changing the executable (ACP-20)', async t => {
	const controller = new AbortController();
	let aborted = false;
	const f = fixture(t, 'refuse', {
		remove: async (file, options) => {
			if (!aborted) {
				aborted = true;
				controller.abort();
			}
			await rm(file, options);
		},
	});
	const before = captureLaunchIdentity(f.runtime);
	await t.throwsAsync(
		f.preflight.verify(f.runtime, f.project, controller.signal),
		{name: 'AbortError'},
	);
	await f.verify();
	t.is(f.launches.length, 2);
	t.deepEqual(captureLaunchIdentity(f.runtime), before);
	assertClean(t, f);
});

test('a CLI swapped between identity capture and probe spawn refuses before executing and caches nothing (ACP-20)', async t => {
	let swap = true;
	let spawned = 0;
	const f = fixture(t, 'refuse', {
		launch: (...args) => {
			if (swap) {
				swap = false;
				f.change('refuse');
			}
			const child = launchNanocoder(...args);
			spawned++;
			return child;
		},
	});
	await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	t.is(spawned, 0);
	await f.verify();
	t.is(spawned, 1);
	assertClean(t, f);
});

test('timeout then valid explicit Retry verifies unchanged identity and reuses only the positive cache (ACP-20)', async t => {
	const f = fixture(t, 'timeout');
	const before = captureLaunchIdentity(f.runtime);
	const rejected = t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	await f.ready;
	f.clock.advance(5000);
	await rejected;
	f.setBehaviour('refuse');
	t.deepEqual(await f.verify(), f.runtime);
	t.is(f.launches.length, 2);
	await f.verify();
	t.is(f.launches.length, 2);
	t.deepEqual(captureLaunchIdentity(f.runtime), before);
	assertClean(t, f);
});

test('a CLI swapped during awaited cleanup cannot carry a successful verdict into a project launch (ACP-20)', async t => {
	let swapped = false;
	const f = fixture(t, 'refuse', {
		remove: async (file, options) => {
			if (!swapped) {
				swapped = true;
				f.change('published');
			}
			await rm(file, options);
		},
	});
	await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	t.true(swapped);
	t.is(f.launches.length, 1);
	t.false(existsSync(f.launches[0].root));
});

test('the exact refusal with the distinct trust exit code 3 passes, and any other code does not (ACP-20)', async t => {
	const passing = fixture(t, 'refuse-code-3');
	await passing.verify();
	t.is(passing.launches.length, 1);
	assertClean(t, passing);
	const failing = fixture(t, 'wrong-exit');
	await t.throwsAsync(failing.verify(), {code: 'UNSUPPORTED'});
	assertClean(t, failing);
});

test('an exact not-trusted refusal passes, uses only isolated state and removes both temporary roots (ACP-20)', async t => {
	const previous = process.env.NANOCODER_TRUST_DIRECTORY;
	const api = process.env.OPENAI_API_KEY;
	const compileCache = process.env.NODE_DISABLE_COMPILE_CACHE;
	const compileCachePath = process.env.NODE_COMPILE_CACHE;
	process.env.NANOCODER_TRUST_DIRECTORY = '1';
	process.env.OPENAI_API_KEY = 'fixture-only-no-key';
	process.env.NODE_DISABLE_COMPILE_CACHE = '0';
	process.env.NODE_COMPILE_CACHE = 'fixture-only-cache-not-forwarded';
	t.teardown(() => {
		if (previous === undefined) delete process.env.NANOCODER_TRUST_DIRECTORY;
		else process.env.NANOCODER_TRUST_DIRECTORY = previous;
		if (api === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = api;
		if (compileCache === undefined)
			delete process.env.NODE_DISABLE_COMPILE_CACHE;
		else process.env.NODE_DISABLE_COMPILE_CACHE = compileCache;
		if (compileCachePath === undefined) delete process.env.NODE_COMPILE_CACHE;
		else process.env.NODE_COMPILE_CACHE = compileCachePath;
	});
	const f = fixture(t);
	await f.verify();
	t.is(f.launches.length, 1);
	const launch = f.launches[0];
	t.deepEqual(launch.args, ['--acp']);
	t.deepEqual(
		Object.keys(launch.env).sort(),
		[
			'HOME',
			'NANOCODER_CONFIG_DIR',
			'NANOCODER_DATA_DIR',
			'USERPROFILE',
			...(process.platform === 'win32'
				? ['SystemRoot', 'NODE_DISABLE_COMPILE_CACHE']
				: []),
		].sort(),
	);
	t.is(launch.env.HOME, launch.env.USERPROFILE);
	t.is(
		launch.env.NODE_DISABLE_COMPILE_CACHE,
		process.platform === 'win32' ? '1' : undefined,
	);
	t.true(path.isAbsolute(launch.root));
	t.is(
		realpathSync.native(path.dirname(launch.root)),
		realpathSync.native(tmpdir()),
	);
	t.false(existsSync(launch.root));
	t.false(existsSync(launch.env.HOME ?? ''));
	t.is(f.clock.pending, 0);
});

for (const behaviour of [
	'published',
	'unknown',
	'wrong-root',
	'wrong-exit',
	'exit',
	'non-acp',
	'whitespace',
]) {
	test(`${behaviour} trust preflight refuses rather than trusting an unsafe 1.31.x build (ACP-04 ACP-20)`, async t => {
		const f = fixture(t, behaviour);
		await t.throwsAsync(f.verify(), {
			code: 'UNSUPPORTED',
			message: /could not verify.*directory trust check/i,
		});
		t.is(f.launches.length, 1);
		t.false(existsSync(f.launches[0].root));
		t.false(existsSync(f.launches[0].env.HOME ?? ''));
		t.is(f.clock.pending, 0);
	});
}

test('a silent preflight times out with the injected clock and cleans up without sleeps (ACP-20)', async t => {
	const f = fixture(t, 'timeout');
	const rejected = t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	await f.ready;
	f.clock.advance(5000);
	await rejected;
	t.false(existsSync(f.launches[0].root));
	t.false(existsSync(f.launches[0].env.HOME ?? ''));
	t.is(f.clock.pending, 0);
});

test('preflight refuses an OS temp root inside the selected project before launching (ACP-20)', async t => {
	const f = fixture(t);
	await t.throwsAsync(
		f.preflight.verify(f.runtime, realpathSync.native(tmpdir())),
		{code: 'UNSUPPORTED'},
	);
	t.is(f.launches.length, 0);
});

test('only an unchanged realpath, file identity and version can reuse a memory-only preflight verdict (ACP-20)', async t => {
	const f = fixture(t);
	await f.verify();
	await f.verify();
	t.is(f.launches.length, 1);
	f.change();
	await f.verify();
	t.is(f.launches.length, 2);
	const seconds = Date.now() / 1000 + 100;
	utimesSync(f.cli, seconds, seconds);
	await f.verify();
	t.is(f.launches.length, 3);
	const replacement = `${f.cli}.new`;
	copyFileSync(f.cli, replacement);
	renameSync(replacement, f.cli);
	await f.verify();
	t.is(f.launches.length, 4);
	await f.preflight.verify({...f.runtime, version: '1.31.1'}, f.work);
	t.is(f.launches.length, 5);
	const other = path.join(f.work, 'other-cli.mjs');
	copyFileSync(f.cli, other);
	await f.preflight.verify({...f.runtime, cliPath: other}, f.work);
	t.is(f.launches.length, 6);
});

test('a refused verdict is cached only in memory and a changed binary must be checked again (ACP-20)', async t => {
	const f = fixture(t, 'published');
	await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	await t.throwsAsync(f.verify(), {code: 'UNSUPPORTED'});
	t.is(f.launches.length, 1);
	f.change('refuse');
	await f.verify();
	t.is(f.launches.length, 2);
});

test('an aborted preflight is cleaned up and never leaves a cached success (ACP-20)', async t => {
	const f = fixture(t, 'timeout');
	const controller = new AbortController();
	const rejected = t.throwsAsync(
		f.preflight.verify(f.runtime, f.work, controller.signal),
		{name: 'AbortError'},
	);
	await f.ready;
	controller.abort();
	await rejected;
	t.false(existsSync(f.launches[0].root));
	t.false(existsSync(f.launches[0].env.HOME ?? ''));
	t.is(f.clock.pending, 0);
	f.change();
	await f.verify();
	t.is(f.launches.length, 2);
});

test('a CLI whose identity cannot be read is refused before launching (ACP-20)', async t => {
	const f = fixture(t);
	await t.throwsAsync(
		f.preflight.verify(
			{...f.runtime, cliPath: `${f.runtime.cliPath}.missing`},
			path.join(path.parse(tmpdir()).root, 'nd-unrelated-project'),
		),
		{code: 'UNSUPPORTED'},
	);
	t.is(f.launches.length, 0);
});
