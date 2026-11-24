import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {promisify} from 'node:util';
import test from 'ava';
import {
	captureTerminalProcesses,
	type ProcessIdentity,
	type ProcessOperations,
	stopPosixTree,
	type TerminalProcesses,
	terminateTree,
	waitForProcessExit,
} from '@/main/terminal/process-tree';

const run = promisify(execFile);

type Row = ProcessIdentity & {parent: number; group: number; state: string};
const first = 'Fri Oct 30 00:00:00 2026';
const later = 'Fri Oct 30 00:00:01 2026';
const make = (
	pid: number,
	parent = 1,
	tty = 'ttys123',
	started = first,
): Row => ({pid, parent, group: pid, tty, started, state: 'S'});
const key = ({pid, started, tty}: ProcessIdentity): ProcessIdentity => ({
	pid,
	started,
	tty,
});
const serialise = (value: Row) =>
	`${value.pid} ${value.parent} ${value.group} ${value.state} ${value.tty} ${value.started}`;
function fixture(root: Row, initial: Row[] = [root], captured: Row[] = [root]) {
	let now = 0;
	let reads = 0;
	const probes = new Map<number, number>();
	const rows = new Map(initial.map(value => [value.pid, {...value}]));
	const signals: [number, NodeJS.Signals][] = [];
	const known: TerminalProcesses = {
		root: key(root),
		members: captured.map(key),
	};
	const hooks = {
		read: (_count: number) => {},
		probe: (_pid: number, _count: number) => {},
		signal: (_pid: number, _signal: NodeJS.Signals) => {},
	};
	const operations: ProcessOperations = {
		read: async () => {
			hooks.read(++reads);
			return ['1 0 1 S ? ' + first, ...[...rows.values()].map(serialise)].join(
				'\n',
			);
		},
		probe: async pid => {
			const count = (probes.get(pid) ?? 0) + 1;
			probes.set(pid, count);
			hooks.probe(pid, count);
			const value = rows.get(pid);
			return value ? serialise(value) : '';
		},
		signal: (pid, signal) => {
			signals.push([pid, signal]);
			hooks.signal(pid, signal);
			const value = rows.get(pid);
			if (!value) throw Object.assign(new Error('gone'), {code: 'ESRCH'});
			if (signal === 'SIGSTOP') value.state = 'T';
			if (signal === 'SIGCONT') value.state = 'S';
			if (signal === 'SIGKILL') rows.delete(pid);
		},
		wait: async ms => {
			now += ms;
		},
		yield: async () => {},
		now: () => now,
	};
	return {
		known,
		operations,
		rows,
		signals,
		hooks,
		stop: () => stopPosixTree(known, operations),
	};
}

test('SEC-05 captured or apparently related main-process PID cannot become a signal target', async t => {
	const root = make(10);
	const main = make(process.pid, 10);
	const value = fixture(root, [root, main], [root, main]);
	await value.stop();
	t.false(value.signals.some(([pid]) => pid === process.pid));
	t.true(value.rows.has(process.pid));
});

test('SEC-05 reused retained PID cannot adopt an unrelated group or its descendants', async t => {
	const root = make(10);
	const old = make(11, 10);
	const replacement = {...make(11, 1, 'ttys999', later), group: 77};
	const value = fixture(
		root,
		[root, replacement, make(12, 11, 'ttys999', later)],
		[root, old],
	);
	await value.stop();
	t.false(value.signals.some(([pid]) => pid === 11 || pid === 12 || pid < 0));
	t.true(value.rows.has(11));
	t.true(value.rows.has(12));
});

test('SEC-05 a captured PID moved to another real tty cannot widen ownership', async t => {
	const root = make(10);
	const value = fixture(
		root,
		[root, make(11, 1, 'ttys999')],
		[root, make(11, 10)],
	);
	await value.stop();
	t.false(value.signals.some(([pid]) => pid === 11));
});

test('SEC-05 every KILL and failure CONT probes identity again, never signalling a replacement', async t => {
	const root = make(10);
	const child = make(11, 10);
	const value = fixture(root, [root, child], [root, child]);
	value.hooks.probe = (pid, count) => {
		if (pid === 11 && count >= 2)
			value.rows.set(11, make(11, 1, 'ttys999', later));
	};
	value.hooks.signal = (_pid, signal) => {
		if (signal === 'SIGKILL')
			throw Object.assign(new Error('denied'), {code: 'EPERM'});
	};
	await t.throwsAsync(value.stop(), {
		message: 'Terminal cleanup deadline exceeded',
	});
	t.deepEqual(
		value.signals.filter(([pid]) => pid === 11),
		[[11, 'SIGSTOP']],
	);
	t.true(
		value.signals.some(([pid, signal]) => pid === 10 && signal === 'SIGCONT'),
	);
});

test('TERM-07 freeze-then-rediscover captures a late same-PTY job before killing its parent', async t => {
	const root = make(10);
	const value = fixture(root);
	value.hooks.signal = (pid, signal) => {
		if (pid === 10 && signal === 'SIGSTOP') value.rows.set(11, make(11, 10));
		if (pid === 10 && signal === 'SIGKILL') {
			const child = value.rows.get(11);
			if (child) child.parent = 1;
		}
	};
	await value.stop();
	t.false(value.rows.has(11));
	const childKill = value.signals.findIndex(
		([pid, signal]) => pid === 11 && signal === 'SIGKILL',
	);
	const rootKill = value.signals.findIndex(
		([pid, signal]) => pid === 10 && signal === 'SIGKILL',
	);
	t.true(childKill >= 0 && childKill < rootKill);
	t.false(value.signals.some(([, signal]) => signal === 'SIGHUP'));
});

test('TERM-07 retained identities survive reparenting but tty reuse alone grants no ownership', async t => {
	const root = make(10);
	const child = make(11, 10);
	const value = fixture(root, [make(11, 1), make(99, 1)], [root, child]);
	await value.stop();
	t.true(
		value.signals.some(([pid, signal]) => pid === 11 && signal === 'SIGKILL'),
	);
	t.false(value.signals.some(([pid]) => pid === 99));
	t.true(value.rows.has(99));
});

test('TERM-07 hangup-cleared tty permits only a previously captured matching identity', async t => {
	const root = make(10);
	const child = make(11, 10);
	const value = fixture(
		root,
		[make(11, 1, '??'), make(12, 1, '??', later)],
		[root, child],
	);
	await value.stop();
	t.true(
		value.signals.some(([pid, signal]) => pid === 11 && signal === 'SIGKILL'),
	);
	t.false(value.signals.some(([pid]) => pid === 12));
});

test('TERM-07 zombie identities are not signalled; live EPERM survivors fail and are resumed', async t => {
	const root = make(10);
	const zombie = fixture(root, [{...root, state: 'Z'}]);
	zombie.hooks.signal = () => {
		throw Object.assign(new Error('denied'), {code: 'EPERM'});
	};
	await zombie.stop();
	t.deepEqual(zombie.signals, []);
	const value = fixture(root);
	value.hooks.signal = (_pid, signal) => {
		if (signal === 'SIGKILL')
			throw Object.assign(new Error('denied'), {code: 'EPERM'});
	};
	await t.throwsAsync(value.stop(), {
		message: 'Terminal cleanup deadline exceeded',
	});
	t.true(value.signals.some(([, signal]) => signal === 'SIGCONT'));
	t.is(value.rows.get(10)?.state, 'S');
});

test('TERM-07 unreadable or partial snapshots never establish success or authorise an unfrozen parent kill', async t => {
	for (const table of ['', '10 1 10 S ttys123 ' + first + '\npartial']) {
		const value = fixture(make(10));
		value.operations.read = async () => table;
		await t.throwsAsync(value.stop(), {message: 'Invalid process snapshot'});
		t.deepEqual(value.signals, []);
	}
});

test('TERM-07 shell reaping checks start time and waits for actual disappearance', async t => {
	const root = make(10);
	const value = fixture(root, [{...root, state: 'Z'}]);
	value.hooks.probe = (_pid, count) => {
		if (count === 3) value.rows.delete(10);
	};
	await waitForProcessExit(key(root), value.operations);
	t.is(value.operations.now(), 50);
	value.rows.set(10, make(10, 1, 'ttys999', later));
	await waitForProcessExit(key(root), value.operations);
	t.is(value.operations.now(), 50);
	value.rows.set(10, {...root, state: 'Z'});
	value.hooks.probe = () => {};
	await t.throwsAsync(waitForProcessExit(key(root), value.operations), {
		message: 'Terminal cleanup deadline exceeded',
	});
});

test('TERM-07 500/4000 and 1200/6000 graphs yield promptly inside the two-second bound', async t => {
	for (const [ownedCount, total] of [
		[500, 4000],
		[1200, 6000],
	]) {
		const root = make(10_000_000);
		const owned = [
			root,
			...Array.from({length: ownedCount - 1}, (_, index) =>
				make(root.pid + index + 1, root.pid),
			),
		];
		const unrelated = Array.from({length: total - ownedCount}, (_, index) =>
			make(20_000_000 + index, 1, 'ttys999'),
		);
		const value = fixture(root, [...owned, ...unrelated], owned);
		const started = performance.now();
		let firstYield: number | undefined;
		value.operations.now = () => performance.now();
		value.operations.wait = async () => {
			await yieldTurn();
		};
		value.operations.yield = async () => {
			firstYield ??= performance.now() - started;
			await yieldTurn();
		};
		await value.stop();
		t.true((firstYield ?? Infinity) < 1000);
		t.true(performance.now() - started < 2000);
		t.is(
			value.signals.filter(([, signal]) => signal === 'SIGKILL').length,
			ownedCount,
		);
		t.false(value.signals.some(([pid]) => pid >= 20_000_000));
		t.log(
			`${ownedCount}/${total}: first yield ${firstYield?.toFixed(1)} ms, total ${(performance.now() - started).toFixed(1)} ms`,
		);
	}
});

test('TERM-07 a resumed parent is rediscovered and frozen again before any terminating signal', async t => {
	const root = make(10);
	const value = fixture(root);
	value.hooks.probe = (pid, count) => {
		if (pid === 10 && count === 2) {
			const parent = value.rows.get(10);
			if (parent) parent.state = 'S';
			value.rows.set(11, make(11, 10));
		}
	};
	await value.stop();
	t.false(value.rows.has(11));
	const childKill = value.signals.findIndex(
		([pid, signal]) => pid === 11 && signal === 'SIGKILL',
	);
	const rootKill = value.signals.findIndex(
		([pid, signal]) => pid === 10 && signal === 'SIGKILL',
	);
	t.true(childKill >= 0 && childKill < rootKill);
});

test('TERM-07 deadline is enforced during discovery, before large graph work can monopolise main', async t => {
	const root = make(10);
	const rows = Array.from({length: 4000}, (_, index) =>
		make(20_000_000 + index, 1, 'ttys999'),
	);
	const value = fixture(root, [root, ...rows]);
	let now = 0;
	value.operations.now = () => now;
	value.operations.yield = async () => {
		now += 300;
	};
	await t.throwsAsync(value.stop(), {
		message: 'Terminal cleanup deadline exceeded',
	});
	t.true(now < 4000);
	t.false(value.signals.some(([, signal]) => signal === 'SIGSTOP'));
});

async function processRows(): Promise<Map<number, string[]>> {
	const {stdout} = await run('/bin/ps', ['-axo', 'pid=,ppid=,stat=,tty='], {
		env: {PATH: '/usr/bin:/bin', LC_ALL: 'C'},
	});
	return new Map(
		stdout
			.split('\n')
			.map(line => line.trim().split(/\s+/u))
			.filter(fields => fields.length === 4)
			.map(fields => [Number(fields[0]), fields]),
	);
}

test('TERM-07 real POSIX teardown captures a shell and its jobs on a real tty and leaves none alive', async t => {
	if (process.platform === 'win32') {
		t.pass();
		return;
	}
	const job = 'sleep 600 & sleep 601 & wait';
	const host = spawn(
		'/usr/bin/script',
		process.platform === 'darwin'
			? ['-q', '/dev/null', '/bin/sh', '-c', job]
			: ['-q', '-c', job, '/dev/null'],
		{
			shell: false,
			stdio: 'ignore',
			env: {PATH: '/usr/bin:/bin', SHELL: '/bin/sh'},
		},
	);
	const exited = once(host, 'exit');
	t.teardown(() => {
		if (host.exitCode === null) host.kill('SIGKILL');
	});
	let shell: string[] | undefined;
	let known: TerminalProcesses = {root: null, members: []};
	for (let attempt = 0; attempt < 400; ++attempt) {
		const rows = await processRows();
		shell ??= [...rows.values()].find(
			fields => Number(fields[1]) === host.pid && !/^\?+$/u.test(fields[3]),
		);
		if (shell) {
			// A loaded runner can time out one probe; the next attempt retries.
			known = await captureTerminalProcesses(
				Number(shell[0]),
				[],
				`/dev/${shell[3]}`,
				known,
			).catch(() => known);
			if (known.members.length >= 3) break;
		}
		await yieldTurn();
	}
	if (!shell) throw new Error('No shell on a real tty');
	const pid = Number(shell[0]);
	t.is(known.root?.pid, pid);
	t.is(known.root?.tty, shell[3]);
	const members = known.members.map(value => value.pid);
	t.true(members.length >= 3);
	const other = shell[3].startsWith('pts/') ? '/dev/pts/999' : '/dev/ttys999';
	await t.throwsAsync(captureTerminalProcesses(pid, [], other), {
		message: 'Terminal process identity unavailable',
	});
	// No tty never becomes ownership; the probe ends at its deadline or timeout.
	await t.throwsAsync(captureTerminalProcesses(host.pid ?? 0, [], other));
	const stale = {
		root: known.root && {...known.root, started: 'Thu Jan 1 00:00:00 1970'},
		members: [],
	};
	t.is(
		await captureTerminalProcesses(pid, [], `/dev/${shell[3]}`, stale),
		stale,
	);
	// A late reap can exhaust the wait or its final ps probe; still verify every member below.
	await terminateTree(pid, [], `/dev/${shell[3]}`, known).catch(error => {
		const failure = error as Error & {
			killed?: boolean;
			signal?: string;
			cmd?: string;
		};
		const probeTimedOut =
			failure.killed === true &&
			failure.signal === 'SIGTERM' &&
			/^\/\S*\/ps -p \d+ -o pid=,ppid=,pgid=,stat=,tty=,lstart=$/u.test(
				failure.cmd ?? '',
			);
		if (
			failure.message !== 'Terminal cleanup deadline exceeded' &&
			!probeTimedOut
		)
			throw error;
	});
	host.kill('SIGKILL');
	await exited;
	const after = await processRows();
	for (const member of members) {
		const fields = after.get(member);
		t.true(!fields || fields[2].startsWith('Z'), `${member} survived`);
	}
	await t.throwsAsync(terminateTree(pid + 1, [], undefined, known), {
		message: 'Terminal process identity unavailable',
	});
});
