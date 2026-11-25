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
import type {DesktopApi} from '@/shared/desktop-api';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';

const paletteKey = process.platform === 'darwin' ? 'Meta+k' : 'Control+k';
let work: string;
let app: ElectronApplication;
let page: Page;

const paletteSearch = () =>
	page
		.getByRole('dialog', {name: 'command palette', exact: true})
		.getByRole('combobox');

async function seedThreads() {
	const seeded = await page.evaluate(async () => {
		const {desktop} = window as unknown as {desktop: DesktopApi};
		const ui = await desktop.getUiState({});
		if (!ui.ok || !ui.value.activeProjectId || !ui.value.activeThreadId)
			throw new Error('Expected the initial fake thread');
		const projectId = ui.value.activeProjectId;
		const currentId = ui.value.activeThreadId;
		const current = await desktop.renameThread({
			projectId,
			threadId: currentId,
			title: 'keyboard current',
		});
		const target = await desktop.createThread({projectId});
		if (!target.ok) throw new Error('Expected the target fake thread');
		const renamedTarget = await desktop.renameThread({
			projectId,
			threadId: target.value.id,
			title: 'keyboard target',
		});
		const archived = await desktop.createThread({projectId});
		if (!archived.ok) throw new Error('Expected the archived fake thread');
		const renamedArchived = await desktop.renameThread({
			projectId,
			threadId: archived.value.id,
			title: 'archived keyboard notes',
		});
		const archivedResult = await desktop.archiveThread({
			projectId,
			threadId: archived.value.id,
			archived: true,
		});
		if (
			!current.ok ||
			!renamedTarget.ok ||
			!renamedArchived.ok ||
			!archivedResult.ok
		)
			throw new Error('Expected fake thread metadata updates');
		return {
			projectId,
			currentId,
			targetId: target.value.id,
			archivedId: archived.value.id,
		};
	});
	await expect(
		page.locator(`[data-thread-id="${seeded.currentId}"]`),
	).toContainText('keyboard current');
	await expect(
		page.locator(`[data-thread-id="${seeded.targetId}"]`),
	).toContainText('keyboard target');
	await page
		.locator(`[data-thread-id="${seeded.currentId}"] .thread-open`)
		.click();
	await expect(
		page.locator('.shell-identity h2').filter({hasText: 'keyboard current'}),
	).toBeVisible();
	return seeded;
}

test.beforeEach(async () => {
	work = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nd-palette-')));
	const project = path.join(work, 'project');
	const cli = path.join(work, 'nanocoder/dist/cli.js');
	mkdirSync(path.dirname(cli), {recursive: true});
	mkdirSync(project);
	writeFileSync(path.join(project, '.fake-nanocoder'), 'ok');
	writeFileSync(
		path.join(work, 'nanocoder/package.json'),
		JSON.stringify({
			name: '@nanocollective/nanocoder',
			version: '9.9.9',
			type: 'module',
			bin: {nanocoder: 'dist/cli.js'},
		}),
	);
	copyFileSync('source/main/nanocoder/fixtures/fake-nanocoder.mjs', cli);
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
});

test.afterEach(async () => {
	await app?.close();
	if (work) rmSync(work, {recursive: true, force: true});
});

test('a thread open during a turn keeps the running-turn notice modal and the palette reusable', async () => {
	await seedThreads();
	const composer = page.getByRole('textbox', {name: 'message', exact: true});
	await composer.fill('fake approval turn');
	await composer.press('Enter');
	await expect(page.getByRole('alertdialog')).toBeVisible();
	await page.keyboard.press(paletteKey);
	await paletteSearch().fill('keyboard target');
	await page.keyboard.press('Enter');
	const notice = page.getByRole('dialog', {
		name: 'another thread is running',
		exact: true,
	});
	await expect(notice).toBeVisible();
	await expect(notice).toHaveJSProperty('open', true);
	expect(await notice.evaluate(element => element.matches(':modal'))).toBe(
		true,
	);
	await notice.getByRole('button', {name: 'keep reading', exact: true}).click();
	await expect(notice).toBeHidden();
	await page.keyboard.press(paletteKey);
	await expect(
		page.getByRole('dialog', {name: 'command palette', exact: true}),
	).toBeVisible();
	await page.keyboard.press('Escape');
});

test('opening the current thread waits for pending selection before focusing the composer', async () => {
	await seedThreads();
	await page.keyboard.press(paletteKey);
	await paletteSearch().fill('keyboard current');
	await page.keyboard.press('Enter');
	await expect(
		page.getByRole('textbox', {name: 'message', exact: true}),
	).toBeFocused();
});

test('returning to a pending approval preserves its focus and numbered shortcuts', async () => {
	await seedThreads();
	const composer = page.getByRole('textbox', {name: 'message', exact: true});
	await composer.fill('fake approval turn');
	await composer.press('Enter');
	await expect(page.getByRole('alertdialog')).toBeFocused();
	await page.keyboard.press(paletteKey);
	await paletteSearch().fill('keyboard current');
	await page.keyboard.press('Enter');
	const approval = page.getByRole('alertdialog');
	await expect(approval).toBeFocused();
	await page.keyboard.press('1');
	await expect(approval).toBeHidden();
});

test('a live archive moves the highlighted thread between groups without changing its identity', async () => {
	const seeded = await seedThreads();
	await page.keyboard.press(paletteKey);
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	const input = palette.getByRole('combobox');
	await input.fill('keyboard');
	const target = palette.getByRole('option', {
		name: 'keyboard target',
		exact: true,
	});
	await target.hover();
	const targetId = await target.getAttribute('id');
	if (!targetId) throw new Error('Expected an option id');
	await expect(input).toHaveAttribute('aria-activedescendant', targetId);
	await page.evaluate(async ({projectId, targetId}) => {
		const result = await window.desktop.archiveThread({
			projectId,
			threadId: targetId,
			archived: true,
		});
		if (!result.ok) throw new Error('Expected fake archive');
	}, seeded);
	await expect(
		palette
			.getByRole('group', {name: 'archived threads', exact: true})
			.getByRole('option', {name: 'keyboard target', exact: true}),
	).toHaveAttribute('aria-selected', 'true');
	await expect(input).toHaveAttribute('aria-activedescendant', targetId);
	await expect(palette.getByRole('listbox').getByRole('heading')).toHaveCount(
		0,
	);
});

test('a delayed thread open does not take focus back after the user moves elsewhere', async () => {
	const seeded = await seedThreads();
	const snapshot = await page.evaluate(
		({projectId, targetId}) =>
			window.desktop.getThreadSnapshot({projectId, threadId: targetId}),
		seeded,
	);
	if (!snapshot.ok) throw new Error('Expected fake snapshot');
	await app.evaluate(({ipcMain}, snapshot) => {
		const fixture = globalThis as unknown as {releasePaletteOpen(): void};
		ipcMain.removeHandler('threads:open');
		ipcMain.handle(
			'threads:open',
			() =>
				new Promise(resolve => {
					fixture.releasePaletteOpen = () => resolve(snapshot);
				}),
		);
	}, snapshot);
	await page.keyboard.press(paletteKey);
	await paletteSearch().fill('keyboard target');
	await page.keyboard.press('Enter');
	const outside = page.getByRole('button', {
		name: 'command palette',
		exact: true,
	});
	await outside.click();
	await page.keyboard.press('Escape');
	await outside.focus();
	const focused = await page.evaluateHandle(() => document.activeElement);
	await app.evaluate(() =>
		(
			globalThis as unknown as {releasePaletteOpen(): void}
		).releasePaletteOpen(),
	);
	await expect(page.locator('.shell-identity h2')).toHaveText(
		'keyboard target',
	);
	expect(
		await page.evaluate(element => document.activeElement === element, focused),
	).toBe(true);
	await focused.dispose();
});

test('pending thread results retain an active descendant and unavailable reasons without executing', async () => {
	const seeded = await seedThreads();
	const snapshot = await page.evaluate(
		({projectId, targetId}) =>
			window.desktop.getThreadSnapshot({projectId, threadId: targetId}),
		seeded,
	);
	if (!snapshot.ok) throw new Error('Expected fake snapshot');
	await app.evaluate(({ipcMain}, snapshot) => {
		const fixture = globalThis as unknown as {releasePaletteOpen(): void};
		ipcMain.removeHandler('threads:open');
		ipcMain.handle(
			'threads:open',
			() =>
				new Promise(resolve => {
					fixture.releasePaletteOpen = () => resolve(snapshot);
				}),
		);
	}, snapshot);
	await page.keyboard.press(paletteKey);
	await paletteSearch().fill('keyboard target');
	await page.keyboard.press('Enter');
	await expect(
		page.getByRole('dialog', {name: 'command palette', exact: true}),
	).toBeHidden();
	await page.keyboard.press(paletteKey);
	await paletteSearch().fill('keyboard target');
	const option = page.getByRole('option', {name: /keyboard target/});
	await expect(option).toHaveAttribute('aria-disabled', 'true');
	await expect(option).toHaveAttribute('aria-selected', 'true');
	await expect(option).toContainText('another thread request is pending');
	await expect(paletteSearch()).toHaveAttribute(
		'aria-activedescendant',
		`palette-option-thread-thread-open-${seeded.targetId}`,
	);
	await page.keyboard.press('Enter');
	await option.click({force: true});
	await expect(paletteSearch()).toBeFocused();
	await expect(page.locator('.shell-identity h2')).toHaveText(
		'keyboard current',
	);
	await page.keyboard.press('Escape');
	await app.evaluate(() =>
		(
			globalThis as unknown as {releasePaletteOpen(): void}
		).releasePaletteOpen(),
	);
});

test('removing the highlighted result resets the active descendant to the first remaining result', async () => {
	const seeded = await seedThreads();
	await page.keyboard.press(paletteKey);
	await paletteSearch().fill('keyboard');
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	await palette
		.getByRole('option', {name: 'keyboard target', exact: true})
		.hover();
	await page.evaluate(async ({projectId, targetId}) => {
		const result = await window.desktop.removeThread({
			projectId,
			threadId: targetId,
		});
		if (!result.ok) throw new Error('Expected fake removal');
	}, seeded);
	await expect(
		palette.getByRole('option', {name: 'keyboard target', exact: true}),
	).toHaveCount(0);
	const first = palette.getByRole('option').first();
	await expect(first).toHaveAttribute('aria-selected', 'true');
	await expect(paletteSearch()).toHaveAttribute(
		'aria-activedescendant',
		(await first.getAttribute('id')) ?? 'missing',
	);
});

test('a narrow workbench yields to the thread selected from the palette', async () => {
	await seedThreads();
	await page.setViewportSize({width: 840, height: 900});
	await page
		.getByRole('button', {name: 'open project files', exact: true})
		.click();
	await expect(
		page.getByRole('textbox', {name: 'message', exact: true}),
	).toBeHidden();
	await page.keyboard.press(paletteKey);
	await paletteSearch().fill('keyboard target');
	await page.keyboard.press('Enter');
	await expect(
		page.getByRole('textbox', {name: 'message', exact: true}),
	).toBeFocused();
});

test('long unbroken titles stay inside palette results in both themes', async () => {
	const seeded = await seedThreads();
	await page.evaluate(async ({projectId, targetId}) => {
		await window.desktop.renameThread({
			projectId,
			threadId: targetId,
			title: `keyboard${'x'.repeat(220)}`,
		});
	}, seeded);
	for (const theme of ['dark', 'light']) {
		await page.evaluate(theme => {
			document.documentElement.dataset.theme = theme;
		}, theme);
		await page.keyboard.press(paletteKey);
		await paletteSearch().fill('keyboard');
		const results = page
			.getByRole('dialog', {name: 'command palette', exact: true})
			.getByRole('listbox');
		expect(
			await results.evaluate(
				element => element.scrollWidth <= element.clientWidth,
			),
		).toBe(true);
		await page.keyboard.press('Escape');
	}
});

test('thread groups share arrow and pointer selection, open an active thread and restore composer focus on Escape', async () => {
	const seeded = await seedThreads();
	await page.keyboard.press(paletteKey);
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	const input = palette.getByRole('combobox');
	await input.fill('keyboard');
	await expect(palette.locator('.palette-group-heading')).toHaveText([
		'active threads',
		'archived threads',
		'actions',
	]);
	const options = palette.getByRole('option');
	await expect(options).toHaveCount(4);
	const optionIds = await options.evaluateAll(rows => rows.map(row => row.id));
	await expect(
		palette
			.getByRole('group', {name: 'active threads', exact: true})
			.getByRole('option'),
	).toHaveCount(2);
	expect(optionIds[2]).toBe(
		`palette-option-thread-thread-open-${seeded.archivedId}`,
	);
	expect(optionIds[3]).toBe('palette-option-action-shortcuts');
	const current = palette.getByRole('option', {
		name: /keyboard current/,
	});
	await expect(current).toContainText('current thread');
	await expect(current).toHaveAttribute('aria-current', 'true');
	const target = palette.getByRole('option', {name: /keyboard target/});
	const targetIndex = optionIds.findIndex(option =>
		option.endsWith(seeded.targetId),
	);
	expect(targetIndex).toBeGreaterThanOrEqual(0);
	await target.hover();
	await expect(target).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('ArrowDown');
	await expect(
		options.nth((targetIndex + 1) % optionIds.length),
	).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('ArrowDown');
	await expect(
		options.nth((targetIndex + 2) % optionIds.length),
	).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('ArrowDown');
	await expect(
		options.nth((targetIndex + 3) % optionIds.length),
	).toHaveAttribute('aria-selected', 'true');
	await target.hover();
	await expect(target).toHaveAttribute('aria-selected', 'true');
	await expect(palette.locator('[aria-selected="true"]')).toHaveCount(1);
	await expect(input).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(palette).toBeHidden();
	const composer = page.getByRole('textbox', {name: 'message', exact: true});
	await expect(composer).toBeFocused();
	await page.keyboard.type('fake draft');
	await expect(composer).toHaveValue('fake draft');
	await expect(page.locator('.shell-identity h2')).toHaveText(
		'keyboard target',
	);
	await page.keyboard.press(paletteKey);
	await input.fill('keyboard');
	await page.keyboard.press('Escape');
	await expect(palette).toBeHidden();
	await expect(composer).toBeFocused();
	await expect(composer).toHaveValue('fake draft');
});

test('opening an archived result preserves its state and focuses the conversation', async () => {
	const seeded = await seedThreads();
	await page.keyboard.press(paletteKey);
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	await palette.getByRole('combobox').fill('archived keyboard');
	const archived = palette.getByRole('option', {
		name: /archived keyboard notes/,
	});
	await expect(archived).toHaveCount(1);
	await expect(
		palette.getByRole('group', {name: 'archived threads', exact: true}),
	).toContainText('archived keyboard notes');
	await page.keyboard.press('Enter');
	await expect(palette).toBeHidden();
	await expect(page.locator('.shell-identity h2')).toHaveText(
		'archived keyboard notes',
	);
	await expect(
		page.getByRole('region', {name: 'conversation', exact: true}),
	).toBeFocused();
	await expect(
		page.getByRole('textbox', {name: 'message', exact: true}),
	).toBeDisabled();
	const archivedRows = await page.evaluate(async projectId => {
		const {desktop} = window as unknown as {desktop: DesktopApi};
		return desktop.listThreads({projectId, archiveState: 'archived'});
	}, seeded.projectId);
	expect(archivedRows.ok).toBe(true);
	if (archivedRows.ok)
		expect(archivedRows.value.map(thread => thread.title)).toContain(
			'archived keyboard notes',
		);
});

test('empty queries hide threads and command names work without selected-title keywords', async () => {
	await seedThreads();
	await page
		.getByRole('button', {name: 'command palette', exact: true})
		.click();
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	const input = palette.getByRole('combobox');
	await expect(palette.getByRole('group')).toHaveCount(0);
	await expect(palette.locator('.palette-group-heading')).toHaveCount(0);
	await expect(palette.getByRole('option').first()).toContainText('new thread');
	await input.fill('keyboard current');
	await expect(palette.getByRole('option')).toHaveCount(1);
	await expect(
		palette.getByRole('option', {name: /keyboard current/}),
	).toBeVisible();
	await expect(
		palette.getByRole('option', {name: /rename thread/}),
	).toHaveCount(0);
	await expect(
		palette.getByRole('option', {name: /archive thread/}),
	).toHaveCount(0);
	await input.fill('rename');
	await expect(
		palette.getByRole('option', {name: /rename thread/}),
	).toBeVisible();
	await input.fill('archive');
	await expect(
		palette.getByRole('option', {name: /archive thread/}),
	).toBeVisible();
	await input.fill('no fake result matches this');
	await expect(
		palette.getByText('no threads or actions found. try a different search.'),
	).toBeVisible();
	await expect(input).toHaveAttribute('aria-expanded', 'false');
	await page.keyboard.press('Escape');
});
