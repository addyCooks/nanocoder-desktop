import {execFileSync} from 'node:child_process';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {expect, test} from '@playwright/test';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';

const root = path.resolve(import.meta.dirname, '..');

test('GIT-04 measure first render and keyboard scrolling on the 5,000-row fixture', async ({}, testInfo) => {
	const work = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-review-perf-')),
	);
	const project = path.join(work, 'project');
	const cli = path.join(work, 'nanocoder/dist/cli.js');
	mkdirSync(path.dirname(cli), {recursive: true});
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
		cli,
	);
	writeFileSync(path.join(project, '.fake-nanocoder'), 'files');
	writeFileSync(path.join(project, 'README.md'), '# fake fixture\n');
	const oldText = Array.from(
		{length: 2_505},
		(_, index) => `old line ${index + 1}`,
	).join('\n');
	const newText = Array.from(
		{length: 2_505},
		(_, index) => `new line ${index + 1}`,
	).join('\n');
	writeFileSync(path.join(project, 'large.ts'), `${oldText}\n`);
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
	git('-c', 'init.defaultBranch=main', 'init', '-q');
	git('config', 'core.autocrlf', 'false');
	mkdirSync(path.join(project, '.git/info'), {recursive: true});
	writeFileSync(path.join(project, '.git/info/exclude'), '.fake-nanocoder\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'initial fake fixture');
	writeFileSync(path.join(project, 'large.ts'), `${newText}\n`);
	writeFileSync(path.join(project, 'README.md'), '# fake fixture\nedited\n');
	const app = await electron.launch({
		cwd: root,
		args: [root, `--user-data-dir=${path.join(work, 'profile')}`],
		env: qaEnvironment(process.env, {cliPath: cli, nodePath: process.execPath}),
	});
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({width: 1240, height: 900});
		await app.evaluate(({dialog}, folder) => {
			dialog.showOpenDialog = (async () => ({
				canceled: false,
				filePaths: [folder],
			})) as typeof dialog.showOpenDialog;
			dialog.showMessageBox = (async () => ({
				response: 0,
				checkboxChecked: false,
			})) as typeof dialog.showMessageBox;
		}, project);
		await page
			.getByRole('button', {name: 'open a project folder', exact: true})
			.click();
		await expect(
			page.getByRole('textbox', {name: 'message', exact: true}),
		).toBeEnabled();
		await page.getByRole('button', {name: 'open project files'}).click();
		await page.getByRole('tab', {name: 'review'}).click();
		const largeFile = page
			.getByRole('list', {name: 'changed files'})
			.getByRole('button', {name: /large\.ts/});
		await expect(largeFile).toBeVisible();
		const firstRenderStarted = performance.now();
		await largeFile.click();
		const lines = page.getByRole('listbox', {
			name: /unstaged changes in large\.ts/,
		});
		await expect(lines.getByRole('option').first()).toBeVisible();
		const firstRenderMs = performance.now() - firstRenderStarted;
		const mountedRows = await lines.getByRole('option').count();
		await lines.getByRole('option', {name: /removed line 1:/}).focus();
		const scrollStarted = performance.now();
		await page.keyboard.press('End');
		const last = lines.getByRole('option', {
			name: /added line 2490: new line 2490/,
		});
		await expect(last).toBeFocused();
		const scrollToLastMs = performance.now() - scrollStarted;
		const result = {
			fixture: '2,505 replaced lines; 5,015 parsed rows; 5,000-row cap',
			firstRenderMs: Number(firstRenderMs.toFixed(1)),
			scrollToLastMs: Number(scrollToLastMs.toFixed(1)),
			mountedRows,
		};
		console.log(`REVIEW_DIFF_PERFORMANCE ${JSON.stringify(result)}`);
		await testInfo.attach('review-diff-performance.json', {
			body: JSON.stringify(result),
			contentType: 'application/json',
		});
	} finally {
		await app.close();
		rmSync(work, {recursive: true, force: true});
	}
});
