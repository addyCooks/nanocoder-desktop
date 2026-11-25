import {execFileSync} from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {GIT_LIMITS, GitService} from '@/main/git/git-service';
import {IpcFailure} from '@/main/ipc/handle-request';
import type {ProjectInfo} from '@/shared/ipc';

// Test setup uses Git directly; the service under test never does.
const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', ['-c', 'core.hooksPath=', ...args], {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Test',
			GIT_AUTHOR_EMAIL: 'test@example.com',
			GIT_COMMITTER_NAME: 'Test',
			GIT_COMMITTER_EMAIL: 'test@example.com',
		},
	});

function fixture(t: ExecutionContext, options: {repo?: boolean} = {}) {
	const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nd-git-')));
	t.teardown(() => rmSync(base, {recursive: true, force: true}));
	const root = path.join(base, 'project');
	mkdirSync(root);
	if (options.repo !== false) {
		git(root, '-c', 'init.defaultBranch=main', 'init', '-q');
		git(root, 'config', 'core.autocrlf', 'false');
	}
	const project: ProjectInfo = {
		id: 'project',
		canonicalRoot: root,
		sessionCwd: root,
		displayName: 'project',
		trusted: true,
		defaultMode: 'normal',
		availability: 'available',
		createdAt: '',
		lastOpenedAt: '',
	};
	const service = new GitService({
		project: id => (id === project.id ? project : undefined),
		roots: () => [],
		readUntracked: async (_project, file) => {
			const text = readFileSync(path.join(root, file), 'utf8');
			return text.includes('\u0000')
				? {kind: 'other', reason: 'binary'}
				: {kind: 'text', text};
		},
	});
	const write = (name: string, text: string | Buffer) => {
		mkdirSync(path.dirname(path.join(root, name)), {recursive: true});
		writeFileSync(path.join(root, name), text);
	};
	const commit = (message = 'commit') => {
		git(root, 'add', '-A');
		git(root, 'commit', '-q', '-m', message);
	};
	return {base, root, project, service, write, commit};
}

async function status(f: ReturnType<typeof fixture>) {
	f.service.invalidate('project');
	const result = await f.service.status('project');
	if (!result.available) throw new Error(result.reason);
	return result;
}

test('GIT-01 GIT-02 status lists staged, unstaged, untracked and renamed files', async t => {
	const f = fixture(t);
	f.write('keep.ts', 'keep\n');
	f.write('edit.ts', 'one\n');
	f.write('gone.ts', 'bye\n');
	f.write('old name.ts', 'same content here\nmore lines\nand more\n');
	f.commit();
	f.write('edit.ts', 'one\ntwo\n');
	rmSync(path.join(f.root, 'gone.ts'));
	git(f.root, 'mv', 'old name.ts', 'new name.ts');
	f.write('staged.ts', 'new\n');
	git(f.root, 'add', 'staged.ts');
	f.write('untracked.ts', 'u\n');
	const result = await status(f);
	t.is(result.branch, 'main');
	t.regex(result.head ?? '', /^[0-9a-f]{40}/);
	t.regex(result.git.version, /^\d+\.\d+/);
	const by = new Map(result.entries.map(entry => [entry.path, entry]));
	t.is(by.get('edit.ts')?.unstaged, 'modified');
	t.is(by.get('gone.ts')?.unstaged, 'deleted');
	t.is(by.get('staged.ts')?.staged, 'added');
	t.true(by.get('untracked.ts')?.untracked);
	t.is(by.get('new name.ts')?.staged, 'renamed');
	t.is(by.get('new name.ts')?.oldPath, 'old name.ts');
	t.false(by.has('keep.ts'));
});

test('GIT-02 names with spaces and newlines come back exactly', async t => {
	const f = fixture(t);
	f.write('seed', 'x');
	f.commit();
	const names = ['with space.ts', 'café \u{1f600}.ts'];
	if (process.platform !== 'win32') names.push('new\nline.ts');
	for (const name of names) f.write(name, 'x');
	const result = await status(f);
	for (const name of names)
		t.true(
			result.entries.some(entry => entry.path === name && entry.untracked),
			name,
		);
});

test('GIT-04 a staged deletion with an untracked replacement has independent diffs', async t => {
	const f = fixture(t);
	f.write('a.ts', 'old tracked content\n');
	f.commit();
	git(f.root, 'rm', '--cached', 'a.ts');
	f.write('a.ts', 'new untracked content\n');
	await status(f);
	const unstaged = await f.service.diff('project', 'a.ts', false);
	t.is(unstaged.kind, 'text');
	if (unstaged.kind === 'text')
		t.regex(unstaged.diff, /\+new untracked content/);
	const staged = await f.service.diff('project', 'a.ts', true);
	t.is(staged.kind, 'text');
	if (staged.kind === 'text') t.regex(staged.diff, /-old tracked content/);
});

test('GIT-13 a folder that is not a repository, and a missing Git, give a reason', async t => {
	const f = fixture(t, {repo: false});
	const none = await f.service.status('project');
	t.false(none.available);
	if (!none.available) t.regex(none.reason, /not a Git repository/);
	const broken = new GitService({
		project: () => f.project,
		roots: () => [],
		locate: async () => ({
			ok: false,
			reason: 'Git is not installed, so review is unavailable',
		}),
	});
	t.deepEqual(await broken.status('project'), {
		available: false,
		reason: 'Git is not installed, so review is unavailable',
	});
});

test('SEC-17 an untrusted, unknown or moved project never runs Git', async t => {
	const f = fixture(t);
	let ran = 0;
	const service = new GitService({
		project: id => (id === 'project' ? f.project : undefined),
		roots: () => [],
		run: async () => {
			ran++;
			throw new Error('must not run');
		},
		locate: async () => ({
			ok: true,
			git: {path: '/usr/bin/git', version: '2.40.0'},
		}),
	});
	await t.throwsAsync(service.status('other'), {code: 'NOT_FOUND'});
	f.project.trusted = false;
	await t.throwsAsync(service.status('project'), {code: 'DENIED'});
	await t.throwsAsync(service.diff('project', 'a.ts', false), {code: 'DENIED'});
	await t.throwsAsync(service.head('project'), {code: 'DENIED'});
	t.is(ran, 0);
});

test('GIT-03 GIT-04 the unstaged and staged diff of one file are separate and real', async t => {
	const f = fixture(t);
	f.write('a.ts', 'one\ntwo\nthree\n');
	f.commit();
	f.write('a.ts', 'one\nTWO\nthree\n');
	git(f.root, 'add', 'a.ts');
	f.write('a.ts', 'one\nTWO\nthree\nfour\n');
	f.service.invalidate('project');
	const staged = await f.service.diff('project', 'a.ts', true);
	const unstaged = await f.service.diff('project', 'a.ts', false);
	t.is(staged.kind, 'text');
	t.is(unstaged.kind, 'text');
	if (staged.kind === 'text') {
		t.regex(staged.diff, /^diff --git a\/a\.ts b\/a\.ts/m);
		t.regex(staged.diff, /^-two$/m);
		t.regex(staged.diff, /^\+TWO$/m);
		t.is(staged.added, 1);
		t.is(staged.removed, 1);
	}
	if (unstaged.kind === 'text') {
		t.regex(unstaged.diff, /^\+four$/m);
		t.is(unstaged.added, 1);
		t.is(unstaged.removed, 0);
	}
});

test('GIT-04 untracked, binary, unchanged and renamed files have their own states', async t => {
	const f = fixture(t);
	f.write('same.ts', 'same\n');
	f.write('image.bin', Buffer.from([0, 1, 2, 3]));
	f.write('old.ts', 'a\nb\nc\nd\ne\nf\n');
	f.commit();
	f.write('fresh.ts', 'line one\nline two\n');
	f.write('image.bin', Buffer.from([0, 9, 9, 3]));
	git(f.root, 'mv', 'old.ts', 'renamed.ts');
	f.service.invalidate('project');
	const fresh = await f.service.diff('project', 'fresh.ts', false);
	t.is(fresh.kind, 'text');
	if (fresh.kind === 'text') {
		t.is(fresh.added, 2);
		t.regex(fresh.diff, /^\+\+\+ b\/fresh\.ts$/m);
		t.regex(fresh.diff, /^@@ -0,0 \+1,2 @@$/m);
	}
	const binary = await f.service.diff('project', 'image.bin', false);
	t.is(binary.kind, 'binary');
	const none = await f.service.diff('project', 'same.ts', false);
	t.is(none.kind, 'none');
	const renamed = await f.service.diff('project', 'renamed.ts', true);
	t.is(renamed.kind, 'text');
	if (renamed.kind === 'text') t.regex(renamed.diff, /rename from old\.ts/);
});

test('SEC-04 a diff over 1 MiB reports LIMIT instead of a partial result', async t => {
	const f = fixture(t);
	f.write('big.txt', 'seed\n');
	f.commit();
	f.write('big.txt', `${'0123456789abcdef'.repeat(70_000)}\n`);
	f.service.invalidate('project');
	const result = await f.service.diff('project', 'big.txt', false);
	t.is(result.kind, 'too-large');
	t.true(GIT_LIMITS.diffBytes === 1_048_576);
});

test('GIT-04 a path that is invalid or starts with a dash or colon is treated as a plain file name', async t => {
	const f = fixture(t);
	f.write('seed', 'x');
	f.commit();
	await t.throwsAsync(f.service.diff('project', '../x', false), {
		code: 'VALIDATION',
	});
	await t.throwsAsync(f.service.diff('project', '', false), {
		code: 'VALIDATION',
	});
	f.write('-n', 'dash\n');
	// A colon is not allowed in a Windows file name, so only other platforms can have one.
	if (process.platform !== 'win32') f.write(':(top)evil', 'colon\n');
	const dash = await f.service.diff('project', '-n', false);
	t.is(dash.kind, 'text');
	if (process.platform !== 'win32') {
		const colon = await f.service.diff('project', ':(top)evil', false);
		t.is(colon.kind, 'text');
	}
});

test('FILE-02 FILE-03 ignored paths and changed folders are marked for the tree', async t => {
	const f = fixture(t);
	f.write('.gitignore', 'build/\n*.log\n');
	f.write('src/a.ts', 'a\n');
	f.write('src/lib/b.ts', 'b\n');
	f.write('README.md', 'r\n');
	f.commit();
	f.write('src/lib/b.ts', 'changed\n');
	f.write('new.ts', 'n\n');
	f.write('build/out.js', 'x\n');
	f.write('app.log', 'x\n');
	f.service.invalidate('project');
	const root = await f.service.marks(f.project, '');
	t.is(root.get('src'), 'modified');
	t.is(root.get('new.ts'), 'untracked');
	t.is(root.get('build'), 'ignored');
	t.is(root.get('app.log'), 'ignored');
	t.false(root.has('README.md'));
	const lib = await f.service.marks(f.project, 'src/lib');
	t.is(lib.get('b.ts'), 'modified');
	const inside = await f.service.marks(f.project, 'build');
	t.is(inside.get('out.js'), 'ignored');
	t.is(inside.get('anything'), 'ignored');
});

test('GIT-06 status is cached until it is invalidated', async t => {
	const f = fixture(t);
	f.write('a.ts', 'a\n');
	f.commit();
	f.write('a.ts', 'b\n');
	const first = await f.service.status('project');
	f.write('a.ts', 'c\n');
	f.write('extra.ts', 'x\n');
	t.is(await f.service.status('project'), first);
	f.service.invalidate('project');
	const next = await status(f);
	t.not(next, first);
	t.true(next.entries.some(entry => entry.path === 'extra.ts'));
});

test('GIT-12 head and the commits made between two heads are listed', async t => {
	const f = fixture(t);
	t.is(await f.service.head('project'), null);
	f.write('a.ts', 'a\n');
	f.commit('first');
	const before = await f.service.head('project');
	t.regex(before ?? '', /^[0-9a-f]{40}/);
	f.write('b.ts', 'b\n');
	f.commit('second: with | pipes');
	f.write('c.ts', 'c\n');
	f.commit('third');
	const after = await f.service.head('project');
	if (!after) throw new Error('no head');
	const commits = await f.service.commits('project', before, after);
	t.deepEqual(
		commits.map(commit => commit.subject),
		['third', 'second: with | pipes'],
	);
	t.is(commits[0].hash, after);
	t.deepEqual(await f.service.commits('project', after, after), []);
	t.deepEqual(await f.service.commits('project', before, null), []);
	t.is((await f.service.commits('project', null, after)).length, 3);
});

test('GIT-01 a project folder inside a larger repository shows only its own changes', async t => {
	const f = fixture(t);
	mkdirSync(path.join(f.root, 'app'));
	f.write('outside.ts', 'o\n');
	f.write('app/inside.ts', 'i\n');
	f.commit();
	f.write('outside.ts', 'changed\n');
	f.write('app/inside.ts', 'changed\n');
	f.write('app/new.ts', 'n\n');
	const subRoot = path.join(f.root, 'app');
	const sub = new GitService({
		project: () => ({
			...f.project,
			canonicalRoot: subRoot,
			sessionCwd: subRoot,
		}),
		roots: () => [],
	});
	const result = await sub.status('project');
	if (!result.available) throw new Error(result.reason);
	t.deepEqual(result.entries.map(entry => entry.path).sort(), [
		'inside.ts',
		'new.ts',
	]);
	const diff = await sub.diff('project', 'inside.ts', false);
	t.is(diff.kind, 'text');
});

test('SEC-06 GIT-11 a repository that configures fsmonitor, an external diff, text conversion or a clean filter runs none of them', async t => {
	const f = fixture(t);
	const marker = (name: string) => path.join(f.base, `ran-${name}`);
	const script = path.join(f.base, 'record.js');
	writeFileSync(
		script,
		"require('node:fs').writeFileSync(process.argv[2], 'ran');process.stdout.write('')\n",
	);
	const posix = (value: string) => value.replaceAll('\\', '/');
	const command = (name: string) =>
		`"${posix(process.execPath)}" "${posix(script)}" "${posix(marker(name))}"`;
	f.write('doc.ext', 'one\n');
	f.write('conv.up', 'one\n');
	f.write('filt.ext', 'one\n');
	f.write(
		'.gitattributes',
		'doc.ext diff=evil\nconv.up diff=conv\nfilt.ext filter=evil.v2\n',
	);
	f.commit();
	git(f.root, 'config', 'core.fsmonitor', command('fsmonitor'));
	git(f.root, 'config', 'diff.evil.command', command('external'));
	git(f.root, 'config', 'diff.conv.textconv', command('textconv'));
	git(f.root, 'config', 'filter.evil.v2.clean', command('clean'));
	f.write('doc.ext', 'two\n');
	f.write('conv.up', 'two\n');
	// A newer modified time on identical content makes Git run the clean filter to compare it.
	const later = new Date(Date.now() + 60_000);
	utimesSync(path.join(f.root, 'filt.ext'), later, later);
	// Control: plain Git does run the hostile configuration, so this test can fail.
	git(f.root, 'diff', '--', 'doc.ext');
	git(f.root, 'diff', '--textconv', '--', 'conv.up');
	git(f.root, 'status', '--porcelain');
	t.true(existsSync(marker('external')), 'control: external diff runs');
	t.true(existsSync(marker('textconv')), 'control: textconv runs');
	t.true(existsSync(marker('clean')), 'control: clean filter runs');
	for (const name of ['external', 'textconv', 'fsmonitor', 'clean'])
		rmSync(marker(name), {force: true});
	f.service.invalidate('project');
	const result = await status(f);
	t.true(result.entries.some(entry => entry.path === 'doc.ext'));
	const external = await f.service.diff('project', 'doc.ext', false);
	const converted = await f.service.diff('project', 'conv.up', false);
	t.is(external.kind, 'text');
	t.is(converted.kind, 'text');
	if (external.kind === 'text') t.regex(external.diff, /^\+two$/m);
	for (const name of ['external', 'textconv', 'fsmonitor', 'clean'])
		t.false(existsSync(marker(name)), `${name} must not run`);
});

test('SEC-06 GIT-11 a filter driver whose name holds an equals sign is refused, never run', async t => {
	const f = fixture(t);
	const marker = path.join(f.base, 'ran-clean');
	const script = path.join(f.base, 'record.js');
	writeFileSync(
		script,
		"require('node:fs').writeFileSync(process.argv[2], 'ran');process.stdout.write('')\n",
	);
	const posix = (value: string) => value.replaceAll('\\', '/');
	f.write('filt.ext', 'one\n');
	f.write('.gitattributes', 'filt.ext filter=a=b\n');
	f.commit();
	git(
		f.root,
		'config',
		'filter.a=b.clean',
		`"${posix(process.execPath)}" "${posix(script)}" "${posix(marker)}"`,
	);
	const later = new Date(Date.now() + 60_000);
	utimesSync(path.join(f.root, 'filt.ext'), later, later);
	// Control: plain Git runs this driver, so the test can fail.
	git(f.root, 'status', '--porcelain');
	t.true(existsSync(marker), 'control: clean filter runs');
	rmSync(marker, {force: true});
	f.service.invalidate('project');
	await t.throwsAsync(status(f), {code: 'DENIED'});
	await t.throwsAsync(f.service.diff('project', 'filt.ext', false), {
		code: 'DENIED',
	});
	t.false(existsSync(marker), 'the clean filter must not run');
});

test('SEC-06 a Git program inside the project is never used', async t => {
	const f = fixture(t);
	const found = {
		ok: true as const,
		git: {path: path.join(f.root, 'tools', 'git'), version: '2.40.0'},
	};
	t.true(found.git.path.startsWith(f.root));
	const refusing = new GitService({
		project: () => f.project,
		roots: () => [f.root],
		locate: async () =>
			(await import('@/main/git/locate')).locateGit({
				roots: () => [f.root],
				run: async () => {
					throw new Error('must not run');
				},
				executable: async candidate =>
					candidate.endsWith('git') ? found.git.path : undefined,
				platform: 'linux',
				env: {PATH: path.join(f.root, 'tools')},
			}),
	});
	const result = await refusing.status('project');
	t.false(result.available);
});

test('GIT-04 a repository mid-merge reports conflicted files', async t => {
	const f = fixture(t);
	f.write('a.ts', 'base\n');
	f.commit('base');
	git(f.root, 'checkout', '-q', '-b', 'other');
	f.write('a.ts', 'other\n');
	f.commit('other');
	git(f.root, 'checkout', '-q', 'main');
	f.write('a.ts', 'main\n');
	f.commit('main');
	try {
		git(f.root, 'merge', 'other');
	} catch {
		// The conflict is the point.
	}
	const result = await status(f);
	const entry = result.entries.find(candidate => candidate.path === 'a.ts');
	t.true(entry?.conflicted);
	t.is((await f.service.marks(f.project, '')).get('a.ts'), 'conflicted');
});

test('GIT-06 a detached HEAD has no branch name', async t => {
	const f = fixture(t);
	f.write('a.ts', 'a\n');
	f.commit();
	git(f.root, 'checkout', '-q', '--detach');
	const result = await status(f);
	t.is(result.branch, null);
	t.truthy(result.head);
});

test('GIT-06 a renamed folder or file is reflected after invalidation', async t => {
	const f = fixture(t);
	f.write('a.ts', 'a\n');
	f.commit();
	renameSync(path.join(f.root, 'a.ts'), path.join(f.root, 'b.ts'));
	const result = await status(f);
	t.deepEqual(
		result.entries
			.map(entry => [entry.path, entry.untracked, entry.unstaged])
			.sort(),
		[
			['a.ts', false, 'deleted'],
			['b.ts', true, 'none'],
		],
	);
});

function stubbed(
	t: ExecutionContext,
	answers: (
		args: string[],
	) => {stdout?: string; stderr?: string; code?: number} | Error,
	readUntracked?: ConstructorParameters<typeof GitService>[0]['readUntracked'],
) {
	const f = fixture(t, {repo: false});
	const calls: string[][] = [];
	const service = new GitService({
		project: () => f.project,
		roots: () => [],
		locate: async () => ({
			ok: true,
			git: {path: '/usr/bin/git', version: '2.40.0'},
		}),
		readUntracked,
		run: async (_run, args) => {
			calls.push(args);
			const answer = answers(args);
			if (answer instanceof Error) throw answer;
			return {
				stdout: Buffer.from(answer.stdout ?? ''),
				stderr: answer.stderr ?? '',
				code: answer.code ?? 0,
			};
		},
	});
	return {f, service, calls};
}

test('GIT-13 Git refusing a folder for ownership reasons is explained, not hidden', async t => {
	const {service} = stubbed(t, () => ({
		code: 128,
		stderr: "fatal: detected dubious ownership in repository at '/x'",
	}));
	const result = await service.status('project');
	t.false(result.available);
	if (!result.available)
		t.regex(result.reason, /does not trust this folder's owner/);
});

test('GIT-13 a folder outside any work tree, and a status that fails, give their own reasons', async t => {
	const bare = stubbed(t, () => ({stdout: 'false\n'}));
	const outside = await bare.service.status('project');
	t.false(outside.available);
	if (!outside.available) t.regex(outside.reason, /not inside a Git work tree/);
	const failing = stubbed(t, args =>
		args[0] === 'rev-parse'
			? {stdout: 'true\n'}
			: {code: 1, stderr: 'fatal: unsafe repository'},
	);
	const result = await failing.service.status('project');
	t.false(result.available);
	if (!result.available)
		t.regex(result.reason, /does not trust this folder's owner/);
	const plain = stubbed(t, args =>
		args[0] === 'rev-parse' ? {stdout: 'true\n'} : {code: 2},
	);
	const unreadable = await plain.service.status('project');
	if (!unreadable.available)
		t.is(unreadable.reason, 'Git could not read the repository status');
	else t.fail();
});

test('SEC-04 a status that runs out of time reports LIMIT as retryable', async t => {
	const {service} = stubbed(t, args =>
		args[0] === 'rev-parse'
			? {stdout: 'true\n'}
			: new IpcFailure('LIMIT', 'Git took too long to answer'),
	);
	const error = await t.throwsAsync(service.status('project'), {code: 'LIMIT'});
	t.true((error as IpcFailure).retryable);
	t.is(error?.message, 'The repository is too large to scan');
});

test('GIT-04 a diff Git cannot produce, an unreadable new file and a missing reader are reported', async t => {
	const status = `# branch.oid ${'a'.repeat(40)}\u0000# branch.head main\u0000? new.bin\u0000? gone.ts\u00001 .M N... 100644 100644 100644 ${'a'.repeat(40)} ${'a'.repeat(40)} tracked.ts\u0000`;
	const answers = (args: string[]) =>
		args[0] === 'rev-parse'
			? {stdout: 'true\n'}
			: args[0] === 'status'
				? {stdout: status}
				: {code: 1};
	const {service} = stubbed(t, answers, async (_project, file) =>
		file === 'new.bin'
			? {kind: 'other', reason: 'binary'}
			: {kind: 'text', text: 'x\n'},
	);
	await t.throwsAsync(service.diff('project', 'tracked.ts', false), {
		code: 'UNAVAILABLE',
	});
	const binary = await service.diff('project', 'new.bin', false);
	t.is(binary.kind, 'binary');
	const absent = stubbed(t, answers);
	const none = await absent.service.diff('project', 'gone.ts', false);
	t.is(none.kind, 'none');
	const missing = await absent.service.diff(
		'project',
		'never-listed.ts',
		false,
	);
	t.is(missing.kind, 'none');
});

test('GIT-12 head and commit lookups that fail or return nonsense degrade to nothing', async t => {
	const garbage = stubbed(t, () => ({stdout: 'not-a-hash\n'}));
	t.is(await garbage.service.head('project'), null);
	const failing = stubbed(t, () => ({code: 128}));
	t.is(await failing.service.head('project'), null);
	t.deepEqual(
		await failing.service.commits('project', 'a'.repeat(40), 'b'.repeat(40)),
		[],
	);
	const broken = stubbed(t, () => new Error('spawn failed'));
	t.is(await broken.service.head('project'), null);
	t.deepEqual(
		await broken.service.commits('project', null, 'b'.repeat(40)),
		[],
	);
});

test('GIT-01 a lookup that failed is retried soon, and one that worked is kept', async t => {
	const f = fixture(t, {repo: false});
	let lookups = 0;
	let clock = 0;
	const service = new GitService({
		project: () => f.project,
		roots: () => [],
		now: () => clock,
		locate: async () => {
			lookups++;
			return lookups === 1
				? {
						ok: false as const,
						reason: 'Git is not installed, so review is unavailable',
					}
				: {ok: true as const, git: {path: '/usr/bin/git', version: '2.40.0'}};
		},
		run: async () => ({stdout: Buffer.from('false\n'), stderr: '', code: 0}),
	});
	t.false((await service.git()).ok);
	t.false((await service.git()).ok);
	t.is(lookups, 1);
	clock = 31_000;
	t.true((await service.git()).ok);
	clock = 10_000_000;
	t.true((await service.git()).ok);
	t.is(lookups, 2);
});

test('GIT-06 two reads of the same project at once share one run', async t => {
	let statusRuns = 0;
	const {service} = stubbed(t, args => {
		if (args[0] === 'rev-parse') return {stdout: 'true\n'};
		statusRuns++;
		return {
			stdout: `# branch.oid ${'a'.repeat(40)}\u0000# branch.head main\u0000`,
		};
	});
	const [one, two] = await Promise.all([
		service.status('project'),
		service.status('project'),
	]);
	t.is(one, two);
	t.is(statusRuns, 1);
});

test('GIT-09 compare shows only the lines that differ from the before-image, with project paths in the headers', async t => {
	const f = fixture(t);
	f.write('notes.txt', 'agent one\nuser line\n');
	const result = await f.service.compare(
		'project',
		'notes.txt',
		'user edit\nuser line\n',
	);
	t.is(result.kind, 'text');
	if (result.kind !== 'text') return;
	t.is(result.added, 1);
	t.is(result.removed, 1);
	t.true(result.diff.startsWith('diff --git a/notes.txt b/notes.txt\n'));
	t.true(result.diff.includes('\n--- a/notes.txt\n+++ b/notes.txt\n'));
	t.false(result.diff.includes('index '));
	t.false(result.diff.includes(f.root));
	t.true(result.diff.includes('-user edit\n+agent one\n user line\n'));
});

test('GIT-09 compare treats a missing before-image as a new file and a missing file as deleted', async t => {
	const f = fixture(t);
	f.write('fresh.txt', 'new\n');
	const created = await f.service.compare('project', 'fresh.txt', null);
	t.like(created, {kind: 'text', added: 1, removed: 0});
	if (created.kind === 'text')
		t.true(created.diff.includes('--- /dev/null\n+++ b/fresh.txt\n'));
	const deleted = await f.service.compare('project', 'gone.txt', 'was here\n');
	t.like(deleted, {kind: 'text', added: 0, removed: 1});
	if (deleted.kind === 'text')
		t.true(deleted.diff.includes('--- a/gone.txt\n+++ /dev/null\n'));
});

test('GIT-09 compare reports no net change, binary content and an oversized before-image', async t => {
	const f = fixture(t);
	f.write('same.txt', 'same\n');
	t.like(await f.service.compare('project', 'same.txt', 'same\n'), {
		kind: 'none',
	});
	f.write('bin.dat', Buffer.from([0, 1, 2, 3]));
	t.like(await f.service.compare('project', 'bin.dat', 'text\n'), {
		kind: 'binary',
	});
	f.write('big.txt', 'x\n');
	t.like(await f.service.compare('project', 'big.txt', 'y'.repeat(1_048_577)), {
		kind: 'too-large',
	});
});

test('SEC-03 GIT-09 compare refuses paths that leave the project, reach .git or are linked outside', async t => {
	const f = fixture(t);
	writeFileSync(path.join(f.base, 'outside.txt'), 'secret\n');
	symlinkSync(path.join(f.base, 'outside.txt'), path.join(f.root, 'link.txt'));
	for (const input of ['../outside.txt', '.git/config', 'link.txt', ''])
		await t.throwsAsync(f.service.compare('project', input, 'x\n'), {
			instanceOf: IpcFailure,
		});
});

test('GIT-14 compare never writes the before-image to disk', async t => {
	const f = fixture(t);
	f.write('notes.txt', 'now\n');
	const before = readdirSync(f.root).sort();
	await f.service.compare('project', 'notes.txt', 'before\n');
	t.deepEqual(readdirSync(f.root).sort(), before);
});
