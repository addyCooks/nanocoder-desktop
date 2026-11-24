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
import {decodeText} from '@/main/files/encoding';
import {FileService} from '@/main/files/file-service';
import {FILE_LIMITS} from '@/main/files/limits';
import type {ProjectInfo} from '@/shared/ipc';
import type {ReviewMark} from '@/shared/review';

function fixture(t: ExecutionContext, platform?: NodeJS.Platform) {
	const base = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-files-')),
	);
	t.teardown(() => rmSync(base, {recursive: true, force: true}));
	const root = path.join(base, 'project');
	const outside = path.join(base, 'outside');
	mkdirSync(root);
	mkdirSync(outside);
	writeFileSync(path.join(outside, 'secret.txt'), 'secret');
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
	const marks = new Map<string, ReadonlyMap<string, ReviewMark>>();
	const service = new FileService({
		project: id => (id === project.id ? project : undefined),
		marks: (_project, directory) => marks.get(directory) ?? new Map(),
		platform,
	});
	const link = (target: string, name: string, kind: 'file' | 'junction') => {
		try {
			symlinkSync(target, path.join(root, name), kind);
			return true;
		} catch {
			return false;
		}
	};
	return {base, root, outside, project, service, marks, link};
}

const request = (path: string) => ({projectId: 'project', path});

test('FILE-01 a listing is one directory, folders first, then names without regard to case', async t => {
	const f = fixture(t);
	mkdirSync(path.join(f.root, 'src'));
	mkdirSync(path.join(f.root, 'Docs'));
	for (const name of ['b.txt', 'A.txt', 'a2.txt', 'a10.txt', 'readme.md'])
		writeFileSync(path.join(f.root, name), name);
	writeFileSync(path.join(f.root, 'src/inner.ts'), 'x');
	const listing = await f.service.list(request(''));
	t.deepEqual(
		listing.entries.map(entry => entry.name),
		['Docs', 'src', 'A.txt', 'a2.txt', 'a10.txt', 'b.txt', 'readme.md'],
	);
	t.is(listing.notShown, 0);
	t.false(listing.entries.some(entry => entry.name === 'inner.ts'));
	t.is(listing.entries[2].size, 5);
	t.is((await f.service.list(request('src'))).entries[0].name, 'inner.ts');
});

test('FILE-02 the .git folder is neither listed nor browsable', async t => {
	const f = fixture(t);
	mkdirSync(path.join(f.root, '.git'));
	writeFileSync(path.join(f.root, '.git/config'), '[core]');
	writeFileSync(path.join(f.root, 'a.txt'), 'a');
	t.deepEqual(
		(await f.service.list(request(''))).entries.map(entry => entry.name),
		['a.txt'],
	);
	await t.throwsAsync(f.service.list(request('.git')), {code: 'DENIED'});
	await t.throwsAsync(f.service.preview(request('.git/config')), {
		code: 'DENIED',
	});
	await t.throwsAsync(f.service.list(request('.GIT')), {code: 'DENIED'});
});

test('FILE-01 SEC-04 a huge directory lists the limit and counts the rest', async t => {
	const f = fixture(t);
	const many = path.join(f.root, 'many');
	mkdirSync(many);
	for (let index = 0; index < 2_500; index++)
		writeFileSync(
			path.join(many, `file-${String(index).padStart(5, '0')}`),
			'',
		);
	const listing = await f.service.list(request('many'));
	t.is(listing.entries.length, FILE_LIMITS.listEntries);
	t.is(listing.notShown, 500);
	t.false(listing.incomplete);
	t.is(listing.entries[0].name, 'file-00000');
});

test('PERF-05 a 20,000-entry directory lists within the budget', async t => {
	const f = fixture(t);
	const many = path.join(f.root, 'twenty-thousand');
	mkdirSync(many);
	for (let index = 0; index < 20_000; index++)
		writeFileSync(path.join(many, `f${index}`), '');
	const started = performance.now();
	const listing = await f.service.list(request('twenty-thousand'));
	const elapsed = performance.now() - started;
	t.is(listing.entries.length, FILE_LIMITS.listEntries);
	t.is(listing.notShown, 18_000);
	t.log(`listed 20,000 entries in ${Math.round(elapsed)} ms`);
	t.true(elapsed < 1_500, `took ${elapsed} ms`);
});

test('FILE-10 a link outside the project is listed as outside and never followed', async t => {
	const f = fixture(t);
	if (
		!f.link(f.outside, 'escape', 'junction') ||
		!f.link(path.join(f.outside, 'secret.txt'), 'escape.txt', 'file')
	) {
		t.pass('this account cannot create links');
		return;
	}
	mkdirSync(path.join(f.root, 'real'));
	writeFileSync(path.join(f.root, 'real/a.txt'), 'a');
	f.link(path.join(f.root, 'real'), 'inner-link', 'junction');
	const entries = (await f.service.list(request(''))).entries;
	const byName = new Map(entries.map(entry => [entry.name, entry]));
	t.is(byName.get('escape')?.link, 'outside');
	t.is(byName.get('escape')?.kind, 'other');
	t.is(byName.get('escape.txt')?.link, 'outside');
	t.is(byName.get('inner-link')?.link, 'inside');
	t.is(byName.get('inner-link')?.kind, 'directory');
	await t.throwsAsync(f.service.list(request('escape')), {
		code: 'OUTSIDE_ROOT',
	});
	const preview = await f.service.preview(request('escape.txt'));
	t.is(preview.kind, 'metadata');
	if (preview.kind === 'metadata') t.is(preview.reason, 'outside-project');
	t.false(JSON.stringify(preview).includes('secret'));
});

test('SEC-03 traversal and absolute requests are refused before any listing', async t => {
	const f = fixture(t);
	for (const bad of ['..', '../outside', '/etc', 'a/../..', 'a\u0000'])
		await t.throwsAsync(f.service.list(request(bad)), undefined, bad);
	await t.throwsAsync(f.service.preview(request('../outside/secret.txt')), {
		code: 'VALIDATION',
	});
});

test('SEC-03 SEC-17 an untrusted, missing or moved project is never browsed', async t => {
	const f = fixture(t);
	await t.throwsAsync(f.service.list({projectId: 'other', path: ''}), {
		code: 'NOT_FOUND',
	});
	f.project.trusted = false;
	await t.throwsAsync(f.service.list(request('')), {code: 'DENIED'});
	f.project.trusted = true;
	f.project.availability = 'missing';
	await t.throwsAsync(f.service.list(request('')), {code: 'DENIED'});
	f.project.availability = 'available';
	f.project.sessionCwd = path.join(f.root, 'sub');
	await t.throwsAsync(f.service.list(request('')), {code: 'DENIED'});
	f.project.sessionCwd = f.root;
	f.project.canonicalRoot = path.join(f.base, 'gone');
	f.project.sessionCwd = f.project.canonicalRoot;
	await t.throwsAsync(f.service.list(request('')), {code: 'DENIED'});
});

test('FILE-03 Git marks decorate matching entries and ignored ones are marked ignored', async t => {
	const f = fixture(t);
	writeFileSync(path.join(f.root, 'changed.ts'), '1');
	writeFileSync(path.join(f.root, 'skip.log'), '1');
	writeFileSync(path.join(f.root, 'plain.ts'), '1');
	f.marks.set(
		'',
		new Map<string, ReviewMark>([
			['changed.ts', 'modified'],
			['skip.log', 'ignored'],
		]),
	);
	const byName = new Map(
		(await f.service.list(request(''))).entries.map(entry => [
			entry.name,
			entry,
		]),
	);
	t.is(byName.get('changed.ts')?.mark, 'modified');
	t.false(byName.get('changed.ts')?.ignored);
	t.true(byName.get('skip.log')?.ignored);
	t.is(byName.get('plain.ts')?.mark, null);
});

test('FILE-04 text previews carry content, encoding and a highlight flag', async t => {
	const f = fixture(t);
	writeFileSync(path.join(f.root, 'a.ts'), 'export const a = 1;\n');
	const preview = await f.service.preview(request('a.ts'));
	t.is(preview.kind, 'text');
	if (preview.kind === 'text') {
		t.is(preview.text, 'export const a = 1;\n');
		t.is(preview.encoding, 'utf-8');
		t.true(preview.highlight);
		t.is(preview.size, 20);
	}
	writeFileSync(
		path.join(f.root, 'big.txt'),
		'x'.repeat(FILE_LIMITS.highlightBytes + 1),
	);
	const big = await f.service.preview(request('big.txt'));
	t.is(big.kind, 'text');
	if (big.kind === 'text') t.false(big.highlight);
});

test('FILE-04 PERF-06 oversized, binary and non-files give metadata and never their content', async t => {
	const f = fixture(t);
	writeFileSync(
		path.join(f.root, 'huge.txt'),
		'x'.repeat(FILE_LIMITS.previewBytes + 1),
	);
	writeFileSync(path.join(f.root, 'blob.bin'), Buffer.from([1, 2, 0, 3, 4]));
	mkdirSync(path.join(f.root, 'folder'));
	for (const [name, reason] of [
		['huge.txt', 'too-large'],
		['blob.bin', 'binary'],
		['folder', 'not-a-file'],
	] as const) {
		const preview = await f.service.preview(request(name));
		t.is(preview.kind, 'metadata', name);
		if (preview.kind === 'metadata') {
			t.is(preview.reason, reason, name);
			t.false('text' in preview, name);
		}
	}
	const exact = path.join(f.root, 'exact.txt');
	writeFileSync(exact, 'y'.repeat(FILE_LIMITS.previewBytes));
	const started = performance.now();
	const preview = await f.service.preview(request('exact.txt'));
	t.is(preview.kind, 'text');
	t.log(`previewed 1 MiB in ${Math.round(performance.now() - started)} ms`);
	t.true(performance.now() - started < 1_000);
});

test('FILE-04 a file that is not UTF-8 is labelled and left unchanged', async t => {
	const f = fixture(t);
	const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
	writeFileSync(path.join(f.root, 'latin1.txt'), latin1);
	const preview = await f.service.preview(request('latin1.txt'));
	t.is(preview.kind, 'metadata');
	if (preview.kind === 'metadata') {
		t.is(preview.reason, 'unsupported-encoding');
		t.regex(preview.detail, /Latin-1/);
	}
});

test('FILE-04 a missing file is NOT_FOUND', async t => {
	const f = fixture(t);
	await t.throwsAsync(f.service.preview(request('nope.txt')), {
		code: 'NOT_FOUND',
	});
});

test('FILE-04 decodeText recognises UTF-8, byte order marks and UTF-16 in both orders', t => {
	const text = (bytes: number[]) => decodeText(Buffer.from(bytes));
	t.deepEqual(text([0x68, 0x69]), {
		kind: 'text',
		text: 'hi',
		encoding: 'utf-8',
	});
	t.deepEqual(text([0xef, 0xbb, 0xbf, 0x68]), {
		kind: 'text',
		text: 'h',
		encoding: 'utf-8-bom',
	});
	t.deepEqual(text([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), {
		kind: 'text',
		text: 'hi',
		encoding: 'utf-16le',
	});
	t.deepEqual(text([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]), {
		kind: 'text',
		text: 'hi',
		encoding: 'utf-16be',
	});
	t.is(text([0xff, 0xfe, 0x68]).kind, 'unsupported');
	t.is(text([0xfe, 0xff, 0x00]).kind, 'unsupported');
	t.is(text([0xff, 0xfe, 0x00, 0xd8]).kind, 'unsupported');
	t.is(text([0xef, 0xbb, 0xbf, 0xc3]).kind, 'unsupported');
	t.is(text([0x00]).kind, 'binary');
	t.is(text([0x61, 0x00, 0x62]).kind, 'binary');
	t.is(text([0xc3]).kind, 'unsupported');
	t.deepEqual(text([]), {kind: 'text', text: '', encoding: 'utf-8'});
});

test('FILE-01 a file is not a folder, and a broken link is listed as unreadable', async t => {
	const f = fixture(t);
	writeFileSync(path.join(f.root, 'plain.txt'), 'x');
	await t.throwsAsync(f.service.list(request('plain.txt')), {
		code: 'VALIDATION',
	});
	await t.throwsAsync(f.service.list(request('missing')), {code: 'NOT_FOUND'});
	try {
		symlinkSync(
			path.join(f.root, 'does-not-exist'),
			path.join(f.root, 'dangling'),
			'file',
		);
	} catch {
		t.pass('this account cannot create links');
		return;
	}
	const entries = (await f.service.list(request(''))).entries;
	t.true(entries.find(entry => entry.name === 'dangling')?.unreadable);
});

test('FILE-01 FILE-04 a name Windows cannot open is listed as unreadable and says why when opened', async t => {
	if (process.platform !== 'win32') {
		t.pass('only Windows refuses these names');
		return;
	}
	const f = fixture(t);
	// Only a \\?\ path can create them, and only one can remove them.
	const extended = (name: string) => `\\\\?\\${path.join(f.root, name)}`;
	const names = ['CON', 'aux.txt', 'dot.'];
	writeFileSync(path.join(f.root, 'plain.txt'), 'x');
	try {
		for (const name of names) writeFileSync(extended(name), 'x');
		mkdirSync(extended('prn'));
		const entries = (await f.service.list(request(''))).entries;
		for (const name of [...names, 'prn'])
			t.true(entries.find(entry => entry.name === name)?.unreadable, name);
		t.false(entries.find(entry => entry.name === 'plain.txt')?.unreadable);
		await t.throwsAsync(f.service.preview(request('CON')), {
			code: 'VALIDATION',
			message: 'Windows cannot open a file or folder with this name',
		});
	} finally {
		for (const name of [...names, 'prn'])
			rmSync(extended(name), {recursive: true, force: true});
	}
});

test('FILE-01 FILE-04 the Windows name rules flag and refuse the same names on every platform', async t => {
	if (process.platform === 'win32') {
		t.pass(
			'a Windows folder cannot hold these names; the test above covers it',
		);
		return;
	}
	const f = fixture(t, 'win32');
	const names = ['CON', 'aux.txt', 'dot.'];
	writeFileSync(path.join(f.root, 'plain.txt'), 'x');
	for (const name of names) writeFileSync(path.join(f.root, name), 'x');
	mkdirSync(path.join(f.root, 'prn'));
	const entries = (await f.service.list(request(''))).entries;
	for (const name of [...names, 'prn'])
		t.true(entries.find(entry => entry.name === name)?.unreadable, name);
	t.false(entries.find(entry => entry.name === 'plain.txt')?.unreadable);
	await t.throwsAsync(f.service.preview(request('CON')), {
		code: 'VALIDATION',
		message: 'Windows cannot open a file or folder with this name',
	});
	// Without the Windows rules the same names are ordinary entries.
	const own = new FileService({
		project: id => (id === f.project.id ? f.project : undefined),
	});
	const plain = (await own.list(request(''))).entries;
	t.is(plain.length, entries.length);
	t.false(plain.some(entry => entry.unreadable));
});

test('FILE-04 SEC-04 a folder or file the account may not read is refused with its own message', async t => {
	if (process.platform === 'win32' || process.getuid?.() === 0) {
		t.pass('permission bits do not apply here');
		return;
	}
	const f = fixture(t);
	const {chmodSync} = await import('node:fs');
	mkdirSync(path.join(f.root, 'locked'));
	writeFileSync(path.join(f.root, 'locked/a.txt'), 'x');
	writeFileSync(path.join(f.root, 'secret.txt'), 'shh');
	chmodSync(path.join(f.root, 'locked'), 0o000);
	chmodSync(path.join(f.root, 'secret.txt'), 0o000);
	t.teardown(() => {
		chmodSync(path.join(f.root, 'locked'), 0o755);
		chmodSync(path.join(f.root, 'secret.txt'), 0o644);
	});
	await t.throwsAsync(f.service.list(request('locked')), {code: 'DENIED'});
	const preview = await f.service.preview(request('secret.txt'));
	t.is(preview.kind, 'metadata');
	if (preview.kind === 'metadata') t.is(preview.reason, 'unreadable');
	t.false(JSON.stringify(preview).includes('shh'));
});
