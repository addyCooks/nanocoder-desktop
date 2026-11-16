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
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import {openFolderFromPalette} from './qa/open-folder';
import {turnEnded} from './qa/turn-state';

const root = path.resolve(import.meta.dirname, '..');
const work = realpathSync.native(
	mkdtempSync(path.join(tmpdir(), 'nd-palette-editing-')),
);
const cli = path.join(work, 'nanocoder/dist/cli.js');
const paletteKey = process.platform === 'darwin' ? 'Meta+k' : 'Control+k';
let app: ElectronApplication;
let page: Page;
const input = () => page.getByRole('textbox', {name: 'message', exact: true});

test.beforeAll(async () => {
	mkdirSync(path.dirname(cli), {recursive: true});
	copyFileSync(
		path.join(root, 'source/main/nanocoder/fixtures/fake-nanocoder.mjs'),
		cli,
	);
	writeFileSync(
		path.join(work, 'nanocoder/package.json'),
		JSON.stringify({
			name: '@nanocollective/nanocoder',
			version: '9.9.9',
			type: 'module',
			bin: {nanocoder: 'dist/cli.js'},
		}),
	);
	app = await electron.launch({
		cwd: root,
		args: [root, `--user-data-dir=${path.join(work, 'profile')}`],
		env: qaEnvironment(process.env, {cliPath: cli, nodePath: process.execPath}),
	});
	page = await app.firstWindow();
	expect(page.url()).toMatch(/^app:\/\/renderer\//);
	const project = path.join(work, 'project');
	mkdirSync(project);
	await app.evaluate(({dialog}, folder) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [folder],
		})) as typeof dialog.showOpenDialog;
	}, project);
	await openFolderFromPalette(page, project);
	await expect(input()).toBeEnabled();
	await input().evaluate(element => {
		element.dataset.inputEvents = '0';
		element.addEventListener('input', () => {
			element.dataset.inputEvents = String(
				Number(element.dataset.inputEvents) + 1,
			);
		});
	});
});

test.afterAll(async () => {
	try {
		await app?.close();
	} finally {
		rmSync(work, {recursive: true, force: true});
	}
});

const methods = [
	'palette Escape',
	'palette command',
	'shortcuts Escape',
	'shortcuts close button',
] as const;

async function closeOverlay(method: (typeof methods)[number]) {
	await page.keyboard.press(paletteKey);
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	const search = palette.getByRole('combobox');
	await expect(search).toBeFocused();
	if (method.startsWith('shortcuts')) {
		await search.pressSequentially('keyboard shortcuts');
		await search.press('Enter');
		const close = page.getByRole('button', {
			name: 'close keyboard shortcuts',
		});
		await expect(close).toBeFocused();
		await close.press(method.endsWith('Escape') ? 'Escape' : 'Enter');
	} else if (method.endsWith('command')) {
		await search.pressSequentially('theme');
		await search.press('Enter');
	} else {
		await search.press('Escape');
	}
	await expect(page.locator('dialog[open]')).toHaveCount(0);
	await expect(input()).toBeFocused();
}

for (const method of methods) {
	test(`${method} restores actual composer editing, not just DOM focus (A11Y-01/02)`, async () => {
		await input().focus();
		await input().press('ControlOrMeta+a');
		await input().press('Backspace');
		await input().pressSequentially('before');
		await expect(input()).toHaveValue('before');
		await input().press('ControlOrMeta+a');
		await input().press('Backspace');
		await closeOverlay(method);
		const eventsBefore = Number(
			await input().getAttribute('data-input-events'),
		);
		await input().pressSequentially('after overlay');
		await expect(input()).toHaveValue('after overlay');
		expect(
			Number(await input().getAttribute('data-input-events')),
		).toBeGreaterThan(eventsBefore);
		await expect(
			page.getByRole('button', {name: 'send', exact: true}),
		).toBeEnabled();
	});
}

test.describe('existing composer state', () => {
	test.beforeAll(async () => {
		const project = path.join(work, 'stream-project');
		mkdirSync(project);
		writeFileSync(path.join(project, '.fake-nanocoder'), 'streaming');
		await app.evaluate(({dialog}, folder) => {
			dialog.showOpenDialog = (async () => ({
				canceled: false,
				filePaths: [folder],
			})) as typeof dialog.showOpenDialog;
		}, project);
		await openFolderFromPalette(page, project);
		await expect(input()).toBeEnabled();
		await input().fill('synthetic command fixture');
		await input().press('Enter');
		await expect(turnEnded(page)).toBeVisible();
	});

	for (const method of methods) {
		test(`${method} preserves the draft, caret and slash suggestions`, async () => {
			await input().focus();
			await input().press('ControlOrMeta+a');
			await input().press('Backspace');
			await input().pressSequentially('/re');
			const suggestions = page.getByRole('list', {
				name: 'available slash commands',
			});
			await expect(suggestions.getByRole('button')).toHaveCount(1);
			await input().evaluate(element => {
				(element as HTMLTextAreaElement).setSelectionRange(1, 2, 'backward');
			});
			const state = () =>
				input().evaluate(element => {
					const textarea = element as HTMLTextAreaElement;
					return {
						draft: textarea.value,
						start: textarea.selectionStart,
						end: textarea.selectionEnd,
						direction: textarea.selectionDirection,
					};
				});
			const before = await state();
			const beforeSuggestions = await suggestions.allTextContents();
			await closeOverlay(method);
			expect(await state()).toEqual(before);
			await expect(suggestions).toBeVisible();
			expect(await suggestions.allTextContents()).toEqual(beforeSuggestions);
			await input().pressSequentially('x');
			await expect(input()).toHaveValue('/xe');
		});
	}
});
