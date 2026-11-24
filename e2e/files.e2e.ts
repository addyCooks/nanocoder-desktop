import {execFileSync} from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
	type ElectronApplication,
	expect,
	type Page,
	test,
} from '@playwright/test';
import type {DesktopApi} from '@/shared/desktop-api';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import {visibleTextContrast} from './qa/ui-contrast';

const root = path.resolve(import.meta.dirname, '..');
let work: string;
let project: string;
let profile: string;
let app: ElectronApplication;
let page: Page;

const git = (...args: string[]) =>
	execFileSync('git', ['-c', 'core.hooksPath=', ...args], {
		cwd: project,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Test',
			GIT_AUTHOR_EMAIL: 'test@example.com',
			GIT_COMMITTER_NAME: 'Test',
			GIT_COMMITTER_EMAIL: 'test@example.com',
		},
	});

const put = (name: string, content: string | Buffer) => {
	mkdirSync(path.dirname(path.join(project, name)), {recursive: true});
	writeFileSync(path.join(project, name), content);
};

async function start(
	options: {repository?: boolean; fake?: 'files' | 'files-timeline'} = {},
) {
	work = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nd-files-')));
	project = path.join(work, 'project');
	profile = path.join(work, 'profile');
	const fakeCli = path.join(work, 'nanocoder/dist/cli.js');
	mkdirSync(path.dirname(fakeCli), {recursive: true});
	mkdirSync(project);
	writeFileSync(
		path.join(work, 'nanocoder/package.json'),
		JSON.stringify({
			name: '@nanocollective/nanocoder',
			version: '9.9.9',
			type: 'module',
			bin: {nanocoder: 'dist/cli.js'},
		}),
	);
	copyFileSync(
		path.join(root, 'source/main/nanocoder/fixtures/fake-nanocoder.mjs'),
		fakeCli,
	);
	put('.fake-nanocoder', options.fake ?? 'files');
	put('.gitignore', 'build/\n');
	put('README.md', '# demo\n');
	put('src/a.ts', 'export const a = 1;\n');
	put('src/lib/b.ts', 'export const b = 2;\n');
	put('build/out.js', 'ignored\n');
	put('data/blob.bin', Buffer.from([0, 1, 2, 3]));
	put('data/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
	if (options.repository !== false) {
		git('-c', 'init.defaultBranch=main', 'init', '-q');
		git('config', 'core.autocrlf', 'false');
		// The agent's marker file is test scaffolding, not a change to review.
		mkdirSync(path.join(project, '.git/info'), {recursive: true});
		writeFileSync(path.join(project, '.git/info/exclude'), '.fake-nanocoder\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'initial');
	}
	app = await electron.launch({
		cwd: root,
		args: [root, `--user-data-dir=${path.join(work, 'profile')}`],
		env: qaEnvironment(process.env, {
			cliPath: fakeCli,
			nodePath: process.execPath,
		}),
	});
	page = await app.firstWindow();
	await page.setViewportSize({width: 1240, height: 900});
	await app.evaluate(({dialog, shell}, folder) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [folder],
		})) as typeof dialog.showOpenDialog;
		dialog.showMessageBox = (async () => ({
			response: 0,
			checkboxChecked: false,
		})) as typeof dialog.showMessageBox;
		const state = globalThis as unknown as {
			opened: string[];
			revealed: string[];
		};
		state.opened = [];
		state.revealed = [];
		shell.openPath = async file => {
			state.opened.push(file);
			return '';
		};
		shell.showItemInFolder = file => {
			state.revealed.push(file);
		};
	}, project);
	await page
		.getByRole('button', {name: 'open a project folder', exact: true})
		.click();
	await expect(
		page.getByRole('textbox', {name: 'message', exact: true}),
	).toBeEnabled();
}

test.afterEach(async () => {
	try {
		await app?.close();
	} finally {
		rmSync(work, {recursive: true, force: true});
	}
});

const filesButton = () =>
	page.getByRole('button', {name: 'open project files', exact: true});
const tree = () => page.getByRole('tree', {name: 'project files'});
const item = (name: string | RegExp) => tree().getByRole('treeitem', {name});
const composer = () =>
	page.getByRole('textbox', {name: 'message', exact: true});
const chips = () =>
	page.getByRole('list', {name: 'attached to your next message'});

async function openFiles() {
	await filesButton().click();
	await expect(tree()).toBeVisible();
}

async function send(text: string) {
	await composer().fill(text);
	await page.getByRole('button', {name: 'send', exact: true}).click();
	await expect(page.getByText('files fixture done')).toBeVisible();
}

async function projectId(): Promise<string> {
	return page.evaluate(async () => {
		const result = await (
			window as unknown as {desktop: DesktopApi}
		).desktop.listProjects({});
		if (!result.ok) throw new Error('no projects');
		return result.value[0].id;
	});
}

test('SP-07 FILE-01 FILE-02 the tree lists one folder at a time and never shows .git', async () => {
	await start();
	await openFiles();
	await expect(item('src')).toBeVisible();
	await expect(item('README.md')).toBeVisible();
	await expect(
		tree().getByRole('treeitem', {name: '.git', exact: true}),
	).toHaveCount(0);
	await expect(item('.gitignore')).toBeVisible();
	// Nothing inside a closed folder has been listed yet.
	await expect(item('a.ts')).toHaveCount(0);
	await item('src').click();
	await expect(item('a.ts')).toBeVisible();
	await expect(item('lib')).toBeVisible();
	await expect(item('b.ts')).toHaveCount(0);
	await expect(item('src')).toHaveAttribute('aria-expanded', 'true');
	await expect(item('a.ts')).toHaveAttribute('aria-level', '2');
	await expect(item('src')).toHaveAttribute('aria-level', '1');
	// Folders come before files, and Git's ignored folders are marked.
	const names = await tree().getByRole('treeitem').allInnerTexts();
	expect(
		names
			.slice(0, 3)
			.map(name => name.replace(/[▸▾·]|\s/gu, '').replace(/,.*/u, '')),
	).toEqual(['build', 'data', 'src']);
	await expect(item(/build/)).toContainText('ignored by Git');
});

test('SP-07 FILE-04 a text file previews with highlighting, and binary and non-UTF-8 files give metadata only', async () => {
	await start();
	await openFiles();
	await item('src').click();
	await item('a.ts').click();
	const preview = page.getByRole('region', {name: 'preview of a.ts'});
	await expect(preview).toBeVisible();
	await expect(preview.locator('.cm-content')).toContainText(
		'export const a = 1;',
	);
	// Plain text would pass the check above; a keyword token with its own colour proves highlighting.
	const keyword = preview.locator('.cm-line span', {hasText: /^export$/});
	await expect(keyword.first()).toBeVisible();
	const colours = await keyword.first().evaluate(element => ({
		token: getComputedStyle(element).color,
		line: getComputedStyle(element.closest('.cm-line') as Element).color,
	}));
	expect(colours.token).not.toBe(colours.line);
	await expect(
		preview.getByRole('textbox', {name: 'contents of src/a.ts'}),
	).toHaveAttribute('aria-readonly', 'true');
	// The editor stays inside a shadow root, so the page keeps its strict stylesheet policy.
	await expect(preview.locator('.code-view-host')).toBeVisible();
	expect(
		await page.evaluate(() => document.head.querySelectorAll('style').length),
	).toBe(0);
	await item('data').click();
	await item('blob.bin').click();
	await expect(page.getByText('not previewed: binary file')).toBeVisible();
	await item('latin1.txt').click();
	await expect(
		page.getByText('not previewed: unsupported text encoding'),
	).toBeVisible();
	await expect(page.getByText(/Latin-1/)).toBeVisible();
	await expect(page.locator('.cm-content')).toHaveCount(0);
});

test('SP-07 FILE-11 the tree is fully operable from the keyboard with tree semantics', async () => {
	await start();
	await openFiles();
	await item('build').focus();
	await page.keyboard.press('ArrowDown');
	await expect(item('data')).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(item('src')).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(item('src')).toHaveAttribute('aria-expanded', 'true');
	await expect(item('lib')).toBeVisible();
	await page.keyboard.press('ArrowRight');
	await expect(item('lib')).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(item('a.ts')).toBeFocused();
	await expect(item('a.ts')).toHaveCSS('outline-width', '2px');
	await page.keyboard.press('Enter');
	await expect(
		page.getByRole('region', {name: 'preview of a.ts'}),
	).toBeVisible();
	await page.keyboard.press('ArrowLeft');
	await expect(item('src')).toBeFocused();
	await page.keyboard.press('ArrowLeft');
	await expect(item('src')).toHaveAttribute('aria-expanded', 'false');
	await page.keyboard.press('End');
	await expect(item('README.md')).toBeFocused();
	await page.keyboard.press('Home');
	await expect(item('build')).toBeFocused();
	// Exactly one row is in the tab order at a time (roving tabindex).
	expect(await tree().locator('[role="treeitem"][tabindex="0"]').count()).toBe(
		1,
	);
});

test('SEC-03 FILE-10 a link that leaves the project is listed as outside and cannot be opened or previewed', async () => {
	await start();
	const outside = path.join(work, 'outside');
	mkdirSync(outside);
	writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
	try {
		symlinkSync(outside, path.join(project, 'escape'), 'junction');
		symlinkSync(
			path.join(outside, 'secret.txt'),
			path.join(project, 'secret-link.txt'),
			'file',
		);
	} catch {
		test.skip(true, 'this account cannot create links');
	}
	await openFiles();
	await expect(item(/^escape/)).toContainText('outside project');
	await item(/^escape/).click();
	await item(/secret-link\.txt/).click();
	await expect(page.getByText('top secret')).toHaveCount(0);
	await expect(item(/^escape/)).not.toHaveAttribute('aria-expanded', 'true');
	// The same refusals hold when the bridge is called directly.
	const id = await projectId();
	const results = await page.evaluate(async id => {
		const files = (window as unknown as {desktop: DesktopApi}).desktop.files;
		return {
			list: await files.list({projectId: id, path: 'escape'}),
			preview: await files.preview({projectId: id, path: 'secret-link.txt'}),
			parent: await files.list({projectId: id, path: '..'}),
			absolute: await files.preview({projectId: id, path: '/etc/passwd'}),
			git: await files.list({projectId: id, path: '.git'}),
		};
	}, id);
	expect(results.list).toMatchObject({
		ok: false,
		error: {code: 'OUTSIDE_ROOT'},
	});
	expect(results.preview).toMatchObject({
		ok: true,
		value: {kind: 'metadata', reason: 'outside-project'},
	});
	expect(results.parent).toMatchObject({
		ok: false,
		error: {code: 'VALIDATION'},
	});
	expect(results.absolute).toMatchObject({
		ok: false,
		error: {code: 'VALIDATION'},
	});
	expect(results.git).toMatchObject({ok: false, error: {code: 'DENIED'}});
	expect(JSON.stringify(results)).not.toContain('top secret');
});

test('FILE-05 files changed outside the app appear without a manual refresh', async () => {
	await start();
	await openFiles();
	await expect(item('README.md')).toBeVisible();
	writeFileSync(path.join(project, 'created-outside.txt'), 'new\n');
	await expect(item('created-outside.txt')).toBeVisible();
	rmSync(path.join(project, 'created-outside.txt'));
	await expect(item('created-outside.txt')).toHaveCount(0);
	// Manual refresh always works as well.
	writeFileSync(path.join(project, 'second.txt'), 'x\n');
	await page.getByRole('button', {name: 'refresh', exact: true}).click();
	await expect(item('second.txt')).toBeVisible();
});

test('FILE-06 FILE-07 open in editor and reveal hand the contained real path to the system', async () => {
	await start();
	await openFiles();
	await item('src').click();
	await item('a.ts').click();
	const preview = page.getByRole('region', {name: 'preview of a.ts'});
	await preview.getByRole('button', {name: 'open in editor'}).click();
	await preview.getByRole('button', {name: 'reveal'}).click();
	await expect
		.poll(() =>
			app.evaluate(() => (globalThis as unknown as {opened: string[]}).opened),
		)
		.toEqual([path.join(project, 'src/a.ts')]);
	await expect
		.poll(() =>
			app.evaluate(
				() => (globalThis as unknown as {revealed: string[]}).revealed,
			),
		)
		.toEqual([path.join(project, 'src/a.ts')]);
	const refused = await page.evaluate(
		async id => {
			const files = (window as unknown as {desktop: DesktopApi}).desktop.files;
			return [
				await files.openInEditor({projectId: id, path: '../outside'}),
				await files.reveal({projectId: id, path: '/etc/hosts'}),
				await files.openInEditor({projectId: id, path: '.git/config'}),
			];
		},
		await projectId(),
	);
	for (const result of refused) expect(result.ok).toBe(false);
	expect(
		await app.evaluate(
			() => (globalThis as unknown as {opened: string[]}).opened,
		),
	).toHaveLength(1);
});

test('SP-09 FILE-08 CHAT-16 an attached file reaches Nanocoder through the checked read and is forgotten after the send', async () => {
	await start();
	await openFiles();
	await item('src').click();
	await item('a.ts').click();
	await page
		.getByRole('region', {name: 'preview of a.ts'})
		.getByRole('button', {name: 'attach to chat'})
		.click();
	await expect(chips().getByText('src/a.ts')).toBeVisible();
	// The same file is not attached twice.
	await item('a.ts').focus();
	await page.keyboard.press('Shift+Enter');
	await expect(chips().getByRole('listitem')).toHaveCount(1);
	await send('please look at this file');
	await expect(
		page.getByText('read src/a.ts: export const a = 1;'),
	).toBeVisible();
	await expect(page.getByText('attached: src/a.ts')).toBeVisible();
	await expect(chips()).toHaveCount(0);
	// Attached context is not stored with the thread.
	const stored = readdirSync(profile)
		.filter(name => name.startsWith('desktop.sqlite'))
		.map(name => readFileSync(path.join(profile, name)).toString('latin1'))
		.join('');
	expect(stored).not.toContain('export const a = 1;');
});

test('SP-09 an attachment can be removed before sending', async () => {
	await start();
	await openFiles();
	await item('README.md').click();
	await page
		.getByRole('region', {name: 'preview of README.md'})
		.getByRole('button', {name: 'attach to chat'})
		.click();
	await expect(chips().getByText('README.md')).toBeVisible();
	await page.getByRole('button', {name: 'remove README.md'}).click();
	await expect(chips()).toHaveCount(0);
	await send('nothing attached');
	await expect(page.getByText(/read README\.md/)).toHaveCount(0);
});

test('SP-08 GIT-02 GIT-03 the review lists the real work tree, including changes made outside the agent', async () => {
	await start();
	writeFileSync(
		path.join(project, 'README.md'),
		'# demo\nedited by the user\n',
	);
	put('notes.txt', 'untracked\n');
	put('src/lib/b.ts', 'export const b = 22;\n');
	git('add', 'src/lib/b.ts');
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	const list = page.getByRole('list', {name: 'changed files'});
	await expect(list.getByRole('button', {name: /README\.md/})).toContainText(
		'unstaged modified',
	);
	await expect(list.getByRole('button', {name: /notes\.txt/})).toContainText(
		'untracked',
	);
	await expect(list.getByRole('button', {name: /b\.ts/})).toContainText(
		'staged modified',
	);
	await page.getByRole('button', {name: 'staged', exact: true}).click();
	await expect(list.getByRole('listitem')).toHaveCount(1);
	await page.getByRole('button', {name: 'unstaged', exact: true}).click();
	await expect(list.getByRole('listitem')).toHaveCount(2);
	await page.getByRole('button', {name: 'all changes'}).click();
	await list.getByRole('button', {name: /README\.md/}).click();
	await expect(page.getByText('edited by the user')).toBeVisible();
	await expect(page.getByText(/^review is unavailable/)).toHaveCount(0);
	await expect(page.getByText(/git 2\./)).toBeVisible();
});

test('SP-08 GIT-05 GIT-04 after a turn the files its tools edited are labelled, with the real diff', async () => {
	await start();
	writeFileSync(path.join(project, 'README.md'), '# demo\nuser edit\n');
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	await send('please edit src/a.ts now');
	const list = page.getByRole('list', {name: 'changed files'});
	await expect(list.getByRole('button', {name: /src\/a\.ts/})).toContainText(
		'touched in the last turn',
	);
	// The user's own edit is shown too, but is not claimed by the agent.
	await expect(
		list.getByRole('button', {name: /README\.md/}),
	).not.toContainText('touched');
	await page.getByRole('button', {name: 'touched this turn'}).click();
	await expect(list.getByRole('listitem')).toHaveCount(1);
	await list.getByRole('button', {name: /src\/a\.ts/}).click();
	const lines = page.getByRole('listbox', {
		name: /unstaged changes in src\/a\.ts/,
	});
	await expect(
		lines.getByRole('option', {name: /added line 2: agent edit/}),
	).toBeVisible();
	await expect(page.getByText(/the last turn edited 1 file/)).toBeVisible();
});

test('GIT-09 GIT-10 a touched file shows only the agent lines when Nanocoder offers its snapshots, and every change on request', async () => {
	await start({fake: 'files-timeline'});
	writeFileSync(
		path.join(project, 'src/a.ts'),
		'export const a = 1;\nuser edit\n',
	);
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	await send('please edit src/a.ts now');
	const list = page.getByRole('list', {name: 'changed files'});
	await list.getByRole('button', {name: /src\/a\.ts/}).click();
	const agent = page.getByRole('listbox', {
		name: /agent changes in src\/a\.ts/,
	});
	await expect(
		agent.getByRole('option', {name: /added line 3: agent edit/}),
	).toBeVisible();
	await expect(agent.getByRole('option', {name: /added line 2/})).toHaveCount(
		0,
	);
	await page.getByRole('button', {name: 'every change'}).click();
	const all = page.getByRole('listbox', {
		name: /unstaged changes in src\/a\.ts/,
	});
	await expect(
		all.getByRole('option', {name: /added line 2: user edit/}),
	).toBeVisible();
	await page.getByRole('button', {name: 'agent changes'}).click();
	await expect(agent).toBeVisible();
});

test('GIT-10 without the snapshot method the review shows every change and still labels the file', async () => {
	await start({fake: 'files'});
	writeFileSync(
		path.join(project, 'src/a.ts'),
		'export const a = 1;\nuser edit\n',
	);
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	await send('please edit src/a.ts now');
	const list = page.getByRole('list', {name: 'changed files'});
	await list.getByRole('button', {name: /src\/a\.ts/}).click();
	await expect(page.getByRole('button', {name: 'every change'})).toHaveCount(0);
	const all = page.getByRole('listbox', {
		name: /unstaged changes in src\/a\.ts/,
	});
	await expect(
		all.getByRole('option', {name: /added line 2: user edit/}),
	).toBeVisible();
	await expect(
		page.getByText(/did not confirm the timeline\/read extension/),
	).toBeVisible();
});

test('SP-09 GIT-07 CHAT-16 a comment on selected diff lines reaches only the next prompt and is never stored', async () => {
	await start();
	await send('please edit src/a.ts now');
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	await page
		.getByRole('list', {name: 'changed files'})
		.getByRole('button', {name: /src\/a\.ts/})
		.click();
	const lines = page.getByRole('listbox', {name: /changes in src\/a\.ts/});
	await lines.getByRole('option', {name: /unchanged line 1/}).click();
	await lines
		.getByRole('option', {name: /added line 2: agent edit/})
		.click({modifiers: ['Shift']});
	const form = page.getByRole('form', {name: 'review comment'});
	await expect(form.getByText(/lines 1 to 2/)).toBeVisible();
	const secret = 'unique-review-comment-7f3a';
	await form.getByRole('textbox').fill(`${secret}: why this change?`);
	await form.getByRole('button', {name: 'add to next message'}).click();
	await expect(chips().getByText('src/a.ts:1-2 (comment)')).toBeVisible();
	await composer().fill('please address the comment');
	await page.getByRole('button', {name: 'send', exact: true}).click();
	await expect(
		page.getByText(
			new RegExp(
				`comment received: Review comment on src/a\\.ts, lines 1-2 \\(unstaged changes\\)`,
			),
		),
	).toBeVisible();
	await expect(page.getByText(/\+agent edit/).first()).toBeVisible();
	await expect(chips()).toHaveCount(0);
	await app.close();
	const stored = readdirSync(profile)
		.filter(name => name.startsWith('desktop.sqlite'))
		.map(name => readFileSync(path.join(profile, name)).toString('latin1'))
		.join('');
	expect(stored).not.toContain(secret);
});

test('SP-09 GIT-07 a diff line range can be chosen from the keyboard', async () => {
	await start();
	await send('please edit src/a.ts now');
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	await page
		.getByRole('list', {name: 'changed files'})
		.getByRole('button', {name: /src\/a\.ts/})
		.click();
	const lines = page.getByRole('listbox', {name: /changes in src\/a\.ts/});
	await lines.getByRole('option', {name: /unchanged line 1/}).click();
	await page.keyboard.press('Shift+ArrowDown');
	await expect(
		page.getByRole('form', {name: 'review comment'}).getByText(/lines 1 to 2/),
	).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('form', {name: 'review comment'})).toHaveCount(0);
});

test('SP-08 GIT-04 one text change opens with its diff visible and a bounded file list', async () => {
	await start();
	writeFileSync(path.join(project, 'README.md'), '# demo\nvisible now\n');
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	const lines = page.getByRole('listbox', {
		name: /unstaged changes in README\.md/,
	});
	await expect(lines).toBeVisible();
	await expect(lines).toBeInViewport();
	await expect(
		lines.getByRole('option', {name: /added line 2: visible now/}),
	).toBeVisible();
	const sizes = await page.evaluate(() => {
		const panel = document.querySelector('.review-panel') as HTMLElement;
		const list = document.querySelector('.review-list') as HTMLElement;
		const workbench = document.querySelector('.shell-workbench') as HTMLElement;
		return {
			panel: panel.clientHeight,
			list: list.clientHeight,
			workbenchTop: workbench.scrollTop,
		};
	});
	expect(sizes.list).toBeGreaterThan(0);
	expect(sizes.list).toBeLessThanOrEqual(sizes.panel * 0.34);
	expect(sizes.workbenchTop).toBe(0);
});

test('SP-09 GIT-07 file arrows swap the diff without leaving the list and restore each file draft and range', async () => {
	await start();
	writeFileSync(path.join(project, 'README.md'), '# demo\nreadme edit\n');
	writeFileSync(path.join(project, 'src/a.ts'), 'export const a = 2;\n');
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	const list = page.getByRole('list', {name: 'changed files'});
	const readme = list.getByRole('button', {name: /README\.md/});
	const source = list.getByRole('button', {name: /src\/a\.ts/});
	await readme.click();
	await page.getByRole('option', {name: /added line 2: readme edit/}).click();
	await page
		.getByRole('form', {name: 'review comment'})
		.getByRole('textbox')
		.fill('readme draft');
	await readme.focus();
	await page.keyboard.press('ArrowDown');
	await expect(source).toBeFocused();
	await expect(
		page.getByRole('listbox', {name: /unstaged changes in src\/a\.ts/}),
	).toBeVisible();
	await page
		.getByRole('option', {name: /added line 1: export const a = 2;/})
		.click();
	await page
		.getByRole('form', {name: 'review comment'})
		.getByRole('textbox')
		.fill('source draft');
	await source.focus();
	await page.keyboard.press('ArrowUp');
	await expect(readme).toBeFocused();
	await expect(
		page.getByRole('form', {name: 'review comment'}).getByRole('textbox'),
	).toHaveValue('readme draft');
	await expect(
		page
			.getByRole('form', {name: 'review comment'})
			.getByText('comment on README.md, line 2', {exact: true}),
	).toBeVisible();
});

test('SP-08 GIT-04 long lines scroll horizontally and binary changes keep their metadata state', async () => {
	await start();
	const marker = 'FAKE_LONG_LINE_END_MARKER';
	writeFileSync(
		path.join(project, 'README.md'),
		`# demo\n${'x'.repeat(500)}${marker}\n`,
	);
	put('data/blob.bin', Buffer.from([9, 0, 8, 1]));
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	const list = page.getByRole('list', {name: 'changed files'});
	await list.getByRole('button', {name: /README\.md/}).click();
	const lines = page.getByRole('listbox', {
		name: /unstaged changes in README\.md/,
	});
	await expect(
		lines.getByRole('option', {name: new RegExp(marker)}),
	).toBeVisible();
	const horizontal = await lines.evaluate(element => {
		const before = element.scrollWidth > element.clientWidth;
		element.scrollLeft = element.scrollWidth;
		return {before, after: element.scrollLeft};
	});
	expect(horizontal.before).toBe(true);
	expect(horizontal.after).toBeGreaterThan(0);
	await list.getByRole('button', {name: /data\/blob\.bin/}).click();
	await expect(page.getByText(/binary file/i)).toBeVisible();
	await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('SP-09 GIT-04 GIT-07 a 5,000-row diff stays virtual and comments use full-model coordinates', async () => {
	await start();
	const oldText = Array.from(
		{length: 2_505},
		(_, index) => `old line ${index + 1}`,
	).join('\n');
	const newText = Array.from(
		{length: 2_505},
		(_, index) => `new line ${index + 1}`,
	).join('\n');
	put('src/large.ts', `${oldText}\n`);
	git('add', 'src/large.ts');
	git('commit', '-q', '-m', 'add large fake fixture');
	put('src/large.ts', `${newText}\n`);
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	const lines = page.getByRole('listbox', {
		name: /unstaged changes in src\/large\.ts/,
	});
	await expect(lines).toBeVisible();
	await expect(lines.getByRole('option').first()).toHaveAttribute(
		'aria-setsize',
		'5000',
	);
	await expect.poll(() => lines.getByRole('option').count()).toBeLessThan(80);
	await expect(lines.locator('[aria-posinset="5000"]')).toHaveCount(0);
	await expect(page.getByText('15 more lines not shown.')).toBeVisible();
	writeFileSync(path.join(project, 'README.md'), '# demo\nsecond change\n');
	writeFileSync(path.join(project, 'src/a.ts'), 'export const a = 2;\n');
	put('notes.txt', 'fourth change\n');
	const changedFiles = page.getByRole('list', {name: 'changed files'});
	await expect(changedFiles.getByRole('listitem')).toHaveCount(4);
	expect((await changedFiles.boundingBox())?.height ?? 0).toBeGreaterThan(40);
	await lines.locator('[aria-posinset="6"]').focus();
	await page.keyboard.press('End');
	const last = lines.locator('[aria-posinset="5000"]');
	await expect(last).toBeFocused();
	await expect(last).toHaveAttribute('aria-posinset', '5000');
	await expect(last).toHaveAttribute('aria-setsize', '5000');
	await expect(last).toHaveAccessibleName(/added line 2490: new line 2490/);
	expect(await lines.getByRole('option').count()).toBeLessThan(80);
	await expect(lines.locator('[aria-posinset="5001"]')).toHaveCount(0);
	await expect(lines.getByRole('option', {name: /new line 2491/})).toHaveCount(
		0,
	);
	await page.keyboard.press('Home');
	await page.keyboard.press('Shift+End');
	const form = page.getByRole('form', {name: 'review comment'});
	await expect(form.getByText(/lines 1 to 2505/)).toBeVisible();
	const submit = form.getByRole('button', {name: 'add to next message'});
	await submit.scrollIntoViewIfNeeded();
	expect(
		await submit.evaluate(element => {
			const rect = element.getBoundingClientRect();
			const hit = document.elementFromPoint(
				rect.x + rect.width / 2,
				rect.y + rect.height / 2,
			);
			return hit === element || element.contains(hit);
		}),
	).toBe(true);
	await form.getByRole('textbox').fill('fake full-range comment');
	await expect(submit).toBeDisabled();
	await expect(form.getByRole('alert')).toContainText('select a smaller range');
	await form.getByRole('alert').scrollIntoViewIfNeeded();
	await expect(form.getByRole('alert')).toBeInViewport();
	await last.focus();
	await lines.evaluate(element => {
		element.scrollTop = 0;
	});
	await page.keyboard.press('Escape');
	await expect(last).toBeFocused();
	await page.keyboard.press('Home');
	await page.keyboard.press('Shift+ArrowDown');
	await expect(
		form.getByText('comment on src/large.ts, lines 1 to 2', {exact: true}),
	).toBeVisible();
	await expect(submit).toBeEnabled();
	await submit.click();
	await expect(chips().getByText('src/large.ts:1-2 (comment)')).toBeVisible();
	await send('review the bounded fake comment');
	await expect(
		page.getByText(
			/comment received: Review comment on src\/large\.ts, lines 1-2/,
		),
	).toBeVisible();
});

test('GIT-04 review remains keyboard reachable above a maximised terminal', async () => {
	await start();
	put('README.md', '# demo\ncompact fake edit\n');
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	await page.getByRole('button', {name: 'open terminal', exact: true}).click();
	await page.setViewportSize({width: 1240, height: 600});
	const resize = page.getByRole('separator', {name: 'resize bottom panel'});
	await resize.focus();
	await page.keyboard.press('End');
	const row = page.getByRole('option', {
		name: /added line 2: compact fake edit/,
	});
	await row.focus();
	await expect(row).toBeFocused();
	await expect(row).toBeInViewport();
	await row.press('Enter');
	await expect(page.getByRole('form', {name: 'review comment'})).toHaveCount(1);
});

test('GIT-07 a one-line excerpt over the IPC character cap cannot attach', async () => {
	await start();
	put('README.md', `# demo\n${'x'.repeat(20_001)}\n`);
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	await page
		.getByRole('listbox')
		.getByRole('option', {name: /^added line 2:/})
		.click();
	const form = page.getByRole('form', {name: 'review comment'});
	await form.getByRole('textbox').fill('fake oversized excerpt');
	await expect(form.getByRole('alert')).toContainText('20,000 characters');
	await expect(
		form.getByRole('button', {name: 'add to next message'}),
	).toBeDisabled();
	await expect(chips()).toHaveCount(0);
});

test('GIT-07 drafts survive tabs while offscreen edits invalidate saved ranges', async () => {
	await start();
	put('README.md', '# demo\nreadme edit\n');
	put('src/a.ts', 'export const a = 2;\n');
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	const list = page.getByRole('list', {name: 'changed files'});
	const readme = list.getByRole('button', {name: /README\.md/});
	const source = list.getByRole('button', {name: /src\/a\.ts/});
	await readme.click();
	await page.getByRole('option', {name: /added line 2: readme edit/}).click();
	const form = page.getByRole('form', {name: 'review comment'});
	await form.getByRole('textbox').fill('keep my fake draft');
	await page.getByRole('tab', {name: 'files', exact: true}).click();
	await page.getByRole('tab', {name: 'review'}).click();
	await expect(form.getByRole('textbox')).toHaveValue('keep my fake draft');
	await source.click();
	put('README.md', '# demo\ninserted above\nreadme edit\n');
	await page
		.getByRole('group', {name: 'filter changes'})
		.getByRole('button', {name: 'refresh', exact: true})
		.click();
	await readme.click();
	await expect(
		page.getByRole('option', {name: /added line 3: readme edit/}),
	).toBeVisible();
	await expect(form).toHaveCount(0);
	await page.getByRole('option', {name: /added line 3: readme edit/}).click();
	await expect(form.getByRole('textbox')).toHaveValue('keep my fake draft');
});

test('GIT-03 mixed staged and unstaged files honour the active filter for click and arrows', async () => {
	await start();
	for (const name of ['README.md', 'src/a.ts']) {
		put(name, 'staged fake line\n');
		git('add', name);
		put(name, 'unstaged fake line\n');
	}
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	const filters = page.getByRole('group', {name: 'filter changes'});
	await filters.getByRole('button', {name: 'staged', exact: true}).click();
	const list = page.getByRole('list', {name: 'changed files'});
	const first = list.getByRole('button').first();
	await first.click();
	await expect(page.getByRole('listbox')).toHaveAccessibleName(
		/^staged changes in README/,
	);
	await first.focus();
	await page.keyboard.press('ArrowDown');
	await expect(list.getByRole('button').last()).toBeFocused();
	await expect(page.getByRole('listbox')).toHaveAccessibleName(
		/^staged changes in src/,
	);
	await filters.getByRole('button', {name: 'refresh', exact: true}).click();
	await expect(page.getByRole('listbox')).toHaveAccessibleName(
		/^staged changes in src/,
	);
});

test('GIT-04 clean Files hydration does not consume the Review-open sole-change selection', async () => {
	await start();
	await openFiles();
	put('README.md', '# demo\nafter files opened\n');
	await page.getByRole('button', {name: 'refresh', exact: true}).click();
	await page.getByRole('tab', {name: 'review'}).click();
	await expect(
		page.getByRole('listbox', {name: /unstaged changes in README/}),
	).toBeVisible();
});

test('GIT-07 same relative paths in different projects never share ranges or drafts', async () => {
	await start();
	put('README.md', '# demo\nfirst project edit\n');
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	await page
		.getByRole('option', {name: /added line 2: first project edit/})
		.click();
	const form = page.getByRole('form', {name: 'review comment'});
	await form.getByRole('textbox').fill('first project draft');
	const second = path.join(work, 'second-project');
	mkdirSync(second);
	writeFileSync(path.join(second, '.fake-nanocoder'), 'files');
	writeFileSync(path.join(second, 'README.md'), '# second\n');
	execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', second]);
	execFileSync('git', ['-C', second, 'config', 'core.autocrlf', 'false']);
	mkdirSync(path.join(second, '.git/info'), {recursive: true});
	writeFileSync(path.join(second, '.git/info/exclude'), '.fake-nanocoder\n');
	execFileSync('git', [
		'-C',
		second,
		'-c',
		'core.hooksPath=',
		'add',
		'README.md',
	]);
	execFileSync('git', [
		'-C',
		second,
		'-c',
		'core.hooksPath=',
		'-c',
		'user.name=Test',
		'-c',
		'user.email=test@example.com',
		'commit',
		'-qm',
		'test: baseline',
	]);
	writeFileSync(
		path.join(second, 'README.md'),
		'# second\nsecond project edit\n',
	);
	await app.evaluate(({dialog}, folder) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [folder],
		})) as typeof dialog.showOpenDialog;
	}, second);
	await page.getByRole('button', {name: 'switch project', exact: true}).click();
	await page.getByRole('button', {name: /add project folder/}).click();
	await expect(
		page.getByRole('option', {name: /added line 2: second project edit/}),
	).toBeVisible();
	await expect(form).toHaveCount(0);
	await page
		.getByRole('option', {name: /added line 2: second project edit/})
		.click();
	await form.getByRole('textbox').fill('second project draft');
	await page.getByRole('button', {name: 'switch project', exact: true}).click();
	await page.getByRole('button', {name: 'open project', exact: true}).click();
	await expect(form.getByRole('textbox')).toHaveValue('first project draft');
	await expect(
		form.getByText('comment on README.md, line 2', {exact: true}),
	).toBeVisible();
});

test('GIT-04 virtual scrolling preserves tab entry, DOM order and horizontal extent without a selection', async () => {
	await start();
	put(
		'src/large.ts',
		`fake long line ${'x'.repeat(800)}\n${Array.from({length: 1_000}, (_, index) => `fake line ${index}`).join('\n')}\n`,
	);
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	const lines = page.getByRole('listbox');
	await expect(lines).toBeVisible();
	const width = await lines.evaluate(element => element.scrollWidth);
	await lines.evaluate(element => {
		element.scrollTop = element.scrollHeight;
	});
	await expect.poll(() => lines.getByRole('option').count()).toBeLessThan(80);
	await expect(lines.locator('[tabindex="0"]')).toHaveCount(1);
	expect(await lines.evaluate(element => element.scrollWidth)).toBe(width);
	const order = await lines
		.getByRole('option')
		.evaluateAll(elements =>
			elements.map(element => Number(element.getAttribute('aria-posinset'))),
		);
	expect(order).toEqual([...order].sort((a, b) => a - b));
	await page.getByRole('button', {name: 'open in editor', exact: true}).focus();
	await page.keyboard.press('Tab');
	await expect(lines.locator('[tabindex="0"]')).toBeFocused();
});

test('GIT-13 a project that is not a Git repository shows review as unavailable while files still work', async () => {
	await start({repository: false});
	await filesButton().click();
	await expect(item('README.md')).toBeVisible();
	await page.getByRole('tab', {name: 'review'}).click();
	await expect(
		page.getByText('review is unavailable', {exact: true}),
	).toBeVisible();
	await expect(page.getByText(/not a Git repository/)).toBeVisible();
	await page.getByRole('tab', {name: 'files'}).click();
	await expect(item('README.md')).toBeVisible();
});

test('GIT-14 the page can only read from Git, so no destructive action is reachable', async () => {
	await start();
	await filesButton().click();
	await page.getByRole('tab', {name: 'review'}).click();
	// The proof: the review namespace is the page's only route to Git, and it
	// has three read methods. Main refuses every other Git subcommand as well
	// (source/main/git/run.spec.ts), so a new write method would fail both.
	const keys = await page.evaluate(() =>
		Object.keys(
			(window as unknown as {desktop: {review: object}}).desktop.review,
		),
	);
	expect(keys.sort()).toEqual(['agentDiff', 'diff', 'status']);
	// A smoke check only, not proof: no control is labelled with an obvious write verb.
	const labels = (await page.getByRole('button').allInnerTexts())
		.join('\n')
		.toLowerCase();
	for (const word of [
		'stage',
		'discard',
		'commit',
		'reset',
		'checkout',
		'stash',
		'push',
	])
		expect(labels, word).not.toMatch(new RegExp(`(^|\\n)${word}\\b`));
});

test('A11Y-01 the panels have no contrast gaps in either theme', async () => {
	await start();
	await send('please edit src/a.ts now');
	await openFiles();
	await item('src').click();
	await item('a.ts').click();
	for (const theme of ['dark', 'light']) {
		await page.evaluate(theme => {
			document.documentElement.dataset.theme = theme;
		}, theme);
		expect(await visibleTextContrast(page, theme)).toEqual([]);
		await page.getByRole('tab', {name: 'review'}).click();
		await page
			.getByRole('list', {name: 'changed files'})
			.getByRole('button', {name: /src\/a\.ts/})
			.click();
		await expect(page.getByRole('listbox')).toBeVisible();
		expect(await visibleTextContrast(page, theme)).toEqual([]);
		await page.getByRole('tab', {name: 'files'}).click();
	}
	expect(existsSync(project)).toBe(true);
});
