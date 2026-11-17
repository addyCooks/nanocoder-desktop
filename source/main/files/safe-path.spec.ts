import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {
	contains,
	openVerified,
	relativeFromAbsolute,
	relativeSegments,
	resolveInside,
	windowsRefusesName,
} from '@/main/files/safe-path';
import {displayName} from '@/shared/files';

function project(t: ExecutionContext) {
	const base = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-safe-')),
	);
	t.teardown(() => rmSync(base, {recursive: true, force: true}));
	const root = path.join(base, 'project');
	const outside = path.join(base, 'outside');
	mkdirSync(path.join(root, 'src'), {recursive: true});
	mkdirSync(outside);
	writeFileSync(path.join(root, 'src/a.ts'), 'export {};\n');
	writeFileSync(path.join(outside, 'secret.txt'), 'secret');
	return {base, root, outside};
}

const code = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		return (error as {code?: string}).code;
	}
	return undefined;
};

test('SEC-03 relative paths accept ordinary names and the empty root', t => {
	t.deepEqual(relativeSegments(''), []);
	t.deepEqual(relativeSegments('src/a.ts'), ['src', 'a.ts']);
	t.deepEqual(relativeSegments('caf\u00e9/\u{1f600}.txt'), [
		'caf\u00e9',
		'\u{1f600}.txt',
	]);
});

test('SEC-03 traversal, absolute, empty-segment and NUL paths are refused on every platform', t => {
	for (const platform of ['linux', 'darwin', 'win32'] as const) {
		for (const bad of [
			'..',
			'../x',
			'a/../b',
			'a/..',
			'.',
			'./a',
			'/etc/passwd',
			'a//b',
			'a/',
			'a\u0000b',
		])
			t.is(
				code(() => relativeSegments(bad, platform)),
				'VALIDATION',
				bad,
			);
	}
});

test('SEC-03 Windows drive, UNC, device, stream and trailing-dot forms are refused', t => {
	for (const bad of [
		'C:/Windows',
		'C:foo',
		'//server/share',
		'\\\\server\\share',
		'\\\\?\\C:\\x',
		'src\\a.ts',
		'a.txt:stream',
		'a.txt::$DATA',
		'CON',
		'nul.txt',
		'src/COM1',
		'src/lpt9.log',
		'name.',
		'name ',
		'a<b',
		'a|b',
		'q?',
	])
		t.is(
			code(() => relativeSegments(bad, 'win32')),
			'VALIDATION',
			bad,
		);
	// A name Windows cannot open says so, while traversal keeps the general wording.
	for (const bad of ['src/CON', 'nul.txt', 'name.', 'name '])
		t.throws(() => relativeSegments(bad, 'win32'), {
			message: 'Windows cannot open a file or folder with this name',
		});
	t.throws(() => relativeSegments('a/../b', 'win32'), {
		message: 'That path is not valid inside a project',
	});
	t.true(windowsRefusesName('aux.txt'));
	t.false(windowsRefusesName('console.ts'));
	// The same text is an ordinary name on a POSIX volume.
	t.deepEqual(relativeSegments('a:b', 'linux'), ['a:b']);
	t.deepEqual(relativeSegments('CON', 'linux'), ['CON']);
	t.deepEqual(relativeSegments('config.ts', 'win32'), ['config.ts']);
	t.deepEqual(relativeSegments('console/a', 'win32'), ['console', 'a']);
});

test('SEC-04 over-long paths and names are refused with LIMIT', t => {
	t.is(
		code(() => relativeSegments('a'.repeat(256))),
		'LIMIT',
	);
	t.is(
		code(() => relativeSegments(`${'a/'.repeat(2100)}a`)),
		'LIMIT',
	);
});

test('SEC-03 resolveInside returns the real path of a file in the project', async t => {
	const {root} = project(t);
	const found = await resolveInside(root, 'src/a.ts');
	t.is(found.real, path.join(root, 'src/a.ts'));
	t.is(found.relative, 'src/a.ts');
	t.is((await resolveInside(root, '')).real, root);
});

test('SEC-03 a missing file is NOT_FOUND, never a path outside the root', async t => {
	const {root} = project(t);
	await t.throwsAsync(resolveInside(root, 'src/missing.ts'), {
		code: 'NOT_FOUND',
	});
	await t.throwsAsync(resolveInside(root, 'src/a.ts/child'), {
		code: 'NOT_FOUND',
	});
});

test('SEC-03 FILE-10 a link that resolves outside the root is refused', async t => {
	const {root, outside} = project(t);
	try {
		symlinkSync(outside, path.join(root, 'escape'), 'junction');
		symlinkSync(
			path.join(outside, 'secret.txt'),
			path.join(root, 'secret-link.txt'),
			'file',
		);
	} catch {
		t.pass('this account cannot create links');
		return;
	}
	await t.throwsAsync(resolveInside(root, 'escape'), {code: 'OUTSIDE_ROOT'});
	await t.throwsAsync(resolveInside(root, 'escape/secret.txt'), {
		code: 'OUTSIDE_ROOT',
	});
	await t.throwsAsync(resolveInside(root, 'secret-link.txt'), {
		code: 'OUTSIDE_ROOT',
	});
});

test('SEC-03 a link inside the root that stays inside is followed', async t => {
	const {root} = project(t);
	try {
		symlinkSync(path.join(root, 'src'), path.join(root, 'alias'), 'junction');
	} catch {
		t.pass('this account cannot create links');
		return;
	}
	const found = await resolveInside(root, 'alias/a.ts');
	t.is(found.real, path.join(root, 'src/a.ts'));
});

test('SEC-03 containment treats a sibling with the same prefix as outside', t => {
	t.true(contains('/work/app', '/work/app'));
	t.true(contains('/work/app', '/work/app/src'));
	t.false(contains('/work/app', '/work/app-evil'));
	t.false(contains('/work/app', '/work'));
	t.true(contains('/work/caf\u00e9', '/work/cafe\u0301/x'));
});

test('ACP-11 absolute paths are checked against the root before any filesystem access', t => {
	const root = path.join(path.parse(process.cwd()).root, 'project-root');
	t.is(relativeFromAbsolute(root, path.join(root, 'src', 'a.ts')), 'src/a.ts');
	t.is(relativeFromAbsolute(root, root), '');
	for (const bad of [
		path.join(path.dirname(root), 'other', 'a.ts'),
		`${root}-evil/a.ts`,
		path.join(root, '..', 'escape.txt'),
	])
		t.is(
			code(() => relativeFromAbsolute(root, bad)),
			'OUTSIDE_ROOT',
			bad,
		);
	for (const bad of ['src/a.ts', '', './a', 'a\u0000b'])
		t.is(
			code(() => relativeFromAbsolute(root, bad)),
			'VALIDATION',
			bad,
		);
});

test('ACP-11 Windows absolute paths outside the root or on another drive are refused', t => {
	t.is(
		relativeFromAbsolute('C:\\work\\app', 'C:\\work\\app\\src\\a.ts', 'win32'),
		'src/a.ts',
	);
	t.is(
		relativeFromAbsolute('C:\\work\\app', 'c:\\WORK\\APP\\src\\a.ts', 'win32'),
		'src/a.ts',
	);
	for (const bad of [
		'D:\\work\\app\\a.ts',
		'C:\\work\\app-evil\\a.ts',
		'C:\\work\\app\\..\\x',
	])
		t.is(
			code(() => relativeFromAbsolute('C:\\work\\app', bad, 'win32')),
			'OUTSIDE_ROOT',
			bad,
		);
});

test('SEC-03 openVerified opens a regular file and refuses a link', async t => {
	const {root, outside} = project(t);
	const handle = await openVerified(path.join(root, 'src/a.ts'));
	const {bytesRead, buffer} = await handle.read(Buffer.alloc(4), 0, 4, 0);
	await handle.close();
	t.is(buffer.subarray(0, bytesRead).toString(), 'expo');
	try {
		symlinkSync(
			path.join(outside, 'secret.txt'),
			path.join(root, 'late-link'),
			'file',
		);
	} catch {
		t.pass('this account cannot create links');
		return;
	}
	await t.throwsAsync(openVerified(path.join(root, 'late-link')), {
		code: 'OUTSIDE_ROOT',
	});
});

test('SEC-04 display names make reordering and control characters visible', t => {
	t.is(displayName('plain.ts'), 'plain.ts');
	t.is(displayName('a\u202eb'), 'a\u2039U+202E\u203ab');
	t.is(displayName('x\ny'), 'x\u2039U+000A\u203ay');
	t.is(displayName('caf\u00e9'), 'caf\u00e9');
});
