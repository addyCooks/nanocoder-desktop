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
import {
	type ElectronApplication,
	expect,
	type Page,
	test,
} from '@playwright/test';
import {choose, expectValue} from './qa/dropdown';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import {createDraftThread} from './qa/new-thread';

let work: string;
let app: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
	work = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-model-scope-')),
	);
	const root = path.join(work, 'project');
	const cli = path.join(work, 'nanocoder', 'dist', 'cli.js');
	mkdirSync(path.dirname(cli), {recursive: true});
	mkdirSync(root);
	writeFileSync(
		path.join(work, 'nanocoder', 'package.json'),
		JSON.stringify({
			name: '@nanocollective/nanocoder',
			version: '9.9.9',
			type: 'module',
			bin: {nanocoder: 'dist/cli.js'},
		}),
	);
	writeFileSync(path.join(root, '.fake-nanocoder'), 'per-session-model');
	copyFileSync(
		'source/main/nanocoder/fixtures/fake-control-nanocoder.mjs',
		cli,
	);
	app = await electron.launch({
		args: ['.', `--user-data-dir=${path.join(work, 'profile')}`],
		env: qaEnvironment(process.env, {cliPath: cli, nodePath: process.execPath}),
	});
	page = await app.firstWindow();
	await app.evaluate(({dialog}, root) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [root],
		})) as typeof dialog.showOpenDialog;
	}, root);
	await page.getByRole('button', {name: 'open a project folder'}).click();
	await expect(
		page.getByRole('textbox', {name: 'message', exact: true}),
	).toBeEnabled();
});

test.afterEach(async () => {
	await app?.close();
	if (work) rmSync(work, {recursive: true, force: true});
});

test('with per-session model state the model control follows the thread in view and changes only that thread (ACP-14 CHAT-10)', async () => {
	const input = page.getByRole('textbox', {name: 'message', exact: true});
	const model = page.getByRole('combobox', {
		name: 'model for this thread in project project',
		exact: true,
	});
	const provider = page.getByRole('combobox', {
		name: 'provider for this thread in project project',
		exact: true,
	});
	await input.fill('first thread request');
	await input.press('Enter');
	await expectValue(model, 'old');
	await expect(
		page.getByText('model applies to this thread only.'),
	).toBeVisible();
	await choose(provider, 'b');
	await expectValue(model, 'confirmed');

	await createDraftThread(
		page,
		page.getByRole('button', {name: 'new thread', exact: true}),
	);
	await expect(
		page.getByRole('button', {
			name: 'model and provider for this thread in project project',
		}),
	).toBeDisabled();
	await input.fill('second thread request');
	await input.press('Enter');
	await expectValue(model, 'old');
	await expectValue(provider, 'a');

	await page.locator('.thread-row[data-selected="false"] .thread-open').click();
	await expectValue(model, 'confirmed');
	await expectValue(provider, 'b');

	await page.locator('.thread-row[data-selected="false"] .thread-open').click();
	await expectValue(model, 'old');
	await expectValue(provider, 'a');
});
