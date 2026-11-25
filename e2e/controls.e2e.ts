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
import {choose, expectValue} from './qa/dropdown';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import {createDraftThread} from './qa/new-thread';
import {turnEnded} from './qa/turn-state';
import {visibleTextContrast} from './qa/ui-contrast';

let work: string;
let app: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
	work = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-controls-ui-')),
	);
	const root = path.join(work, 'project');
	const cli = path.join(work, 'nanocoder', 'dist', 'cli.js');
	mkdirSync(path.dirname(cli), {recursive: true});
	mkdirSync(root);
	const {writeFileSync} = await import('node:fs');
	writeFileSync(
		path.join(work, 'nanocoder', 'package.json'),
		JSON.stringify({
			name: '@nanocollective/nanocoder',
			version: '9.9.9',
			type: 'module',
			bin: {nanocoder: 'dist/cli.js'},
		}),
	);
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

test('main composition exposes metadata-only controls and an explicit project default without creating a session (CHAT-04 CHAT-11)', async () => {
	const result = await page.evaluate(async () => {
		const {desktop} = window as unknown as {desktop: DesktopApi};
		const ui = await desktop.getUiState({});
		if (!ui.ok || !ui.value.activeProjectId || !ui.value.activeThreadId)
			throw new Error('Expected the fixture thread');
		const projectId = ui.value.activeProjectId;
		const threadId = ui.value.activeThreadId;
		const controls = await desktop.getProjectControls({projectId});
		const mode = await desktop.setThreadMode({
			projectId,
			threadId,
			mode: 'plan',
		});
		const project = await desktop.setProjectDefaultMode({
			projectId,
			mode: 'plan',
		});
		const snapshot = await desktop.getThreadSnapshot({projectId, threadId});
		return {controls, mode, project, snapshot};
	});
	expect(result.controls.ok).toBe(true);
	if (!result.controls.ok) throw new Error(result.controls.error.code);
	expect(result.controls.value.configOptions).toEqual([]);
	expect(result.controls.value.modelGate.enabled).toBe(false);
	expect(result.mode.ok && result.mode.value.mode).toBe('plan');
	expect(result.project.ok && result.project.value.defaultMode).toBe('plan');
	expect(
		result.snapshot.ok && result.snapshot.value.thread.nanocoderSessionId,
	).toBeNull();
});

test('multiline composer keeps drafts, ignores IME Enter and changes mode/default without preparing a session (U.5 CHAT-04 CHAT-11)', async () => {
	const input = page.getByRole('textbox', {name: 'message', exact: true});
	await input.fill('first line');
	await input.press('Shift+Enter');
	await input.pressSequentially('second line');
	await expect(input).toHaveValue('first line\nsecond line');
	await input.dispatchEvent('keydown', {
		key: 'Enter',
		isComposing: true,
		keyCode: 229,
	});
	await choose(
		page.getByRole('combobox', {name: 'mode for this thread', exact: true}),
		'plan',
	);
	await expectValue(
		page.getByRole('combobox', {name: 'mode for this thread', exact: true}),
		'plan',
	);
	await page
		.getByRole('button', {
			name: 'mode and project default details',
			exact: true,
		})
		.click();
	await page
		.getByRole('button', {name: "use as this project's default", exact: true})
		.click();
	await expect(
		page.getByText('project default: plan', {exact: false}),
	).toBeVisible();
	await expect(input).toHaveValue('first line\nsecond line');
	const snapshot = await page.evaluate(async () => {
		const {desktop} = window as unknown as {desktop: DesktopApi};
		const ui = await desktop.getUiState({});
		if (!ui.ok || !ui.value.activeProjectId || !ui.value.activeThreadId)
			throw new Error('fixture scope');
		return desktop.getThreadSnapshot({
			projectId: ui.value.activeProjectId,
			threadId: ui.value.activeThreadId,
		});
	});
	expect(snapshot.ok && snapshot.value.thread.nanocoderSessionId).toBeNull();
	await input.press('Enter');
	await expect(input).toHaveValue('');
	await expect(
		page.getByRole('combobox', {name: /model for every thread in project/}),
	).toBeEnabled();
});

test('typing on the mode dropdown opens it on the matching option without changing the mode until Enter (R2-03)', async () => {
	const mode = page.getByRole('combobox', {
		name: 'mode for this thread',
		exact: true,
	});
	const active = mode
		.locator('xpath=..')
		.locator('[role="option"][data-active]');
	const before = await mode.getAttribute('data-value');
	await mode.focus();
	await page.keyboard.press('p');
	await expect(mode).toHaveAttribute('aria-expanded', 'true');
	await expect(active).toHaveAttribute('data-value', 'plan');
	await expect(mode).toHaveAttribute('data-value', before ?? '');
	await page.keyboard.press('Enter');
	await expectValue(mode, 'plan');
	// Letters typed quickly make one search, so "ar" finds architect and Escape keeps plan.
	// The control is disabled while the change applies, which also drops its focus.
	await expect(mode).toBeEnabled();
	await mode.focus();
	await page.keyboard.type('ar');
	await expect(active).toHaveAttribute('data-value', 'architect');
	await page.keyboard.press('Escape');
	await expectValue(mode, 'plan');
});

test('a dropdown list taller than its window scrolls the active option into view (R2-03)', async () => {
	// The mode list is short, so a smaller window is set through the stylesheet object (the CSP refuses a style tag).
	await page.evaluate(() => {
		const sheet = [...document.styleSheets].find(candidate => {
			try {
				return candidate.cssRules.length > 0;
			} catch {
				return false;
			}
		});
		sheet?.insertRule(
			'.dropdown-list { max-height: 76px !important; }',
			sheet.cssRules.length,
		);
	});
	await page
		.getByRole('combobox', {name: 'mode for this thread', exact: true})
		.focus();
	await page.keyboard.type('ar');
	await expect
		.poll(() =>
			page.evaluate(() => {
				const list = document.querySelector('.composer-mode .dropdown-list');
				const active = list?.querySelector('[data-active]');
				if (!list || !active) return false;
				const box = list.getBoundingClientRect();
				const row = active.getBoundingClientRect();
				return row.top >= box.top - 1 && row.bottom <= box.bottom + 1;
			}),
		)
		.toBe(true);
	await page.keyboard.press('Escape');
});

test('the mode and project default disclosure is a button that reveals its body (C-05)', async () => {
	const toggle = page.getByRole('button', {
		name: 'mode and project default details',
		exact: true,
	});
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	const controls = await toggle.getAttribute('aria-controls');
	expect(controls).toBeTruthy();
	const body = page.locator(`[id="${controls}"]`);
	await expect(body).toBeHidden();
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(body).toBeVisible();
	await expect(
		page.getByRole('button', {
			name: "use as this project's default",
			exact: true,
		}),
	).toBeVisible();
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(body).toBeHidden();
});

test('model controls use the confirmed provider response and remain available on a new draft-only thread (CHAT-10 ACP-14)', async () => {
	const input = page.getByRole('textbox', {name: 'message', exact: true});
	await input.fill('fixture request');
	await input.press('Enter');
	const provider = page.getByRole('combobox', {
		name: /provider for every thread in project/,
	});
	const model = page.getByRole('combobox', {
		name: /model for every thread in project/,
	});
	await expect(provider).toBeEnabled();
	await choose(provider, 'b');
	await expectValue(provider, 'b');
	await expectValue(model, 'confirmed');
	await createDraftThread(
		page,
		page.getByRole('button', {name: 'new thread', exact: true}),
	);
	await expect(model).toBeEnabled();
	await expectValue(model, 'confirmed');
	const threads = await page.evaluate(async () => {
		const {desktop} = window as unknown as {desktop: DesktopApi};
		const ui = await desktop.getUiState({});
		if (!ui.ok || !ui.value.activeProjectId) throw new Error('fixture scope');
		return desktop.listThreads({
			projectId: ui.value.activeProjectId,
			archiveState: 'active',
		});
	});
	expect(
		threads.ok &&
			threads.value.filter(thread => thread.nanocoderSessionId !== null).length,
	).toBe(1);
});

test('native yolo cancellation is the default and accepted pending yolo is never restored on restart (DEC-31)', async () => {
	await app.evaluate(({dialog}) => {
		const state = globalThis as unknown as {
			acceptYolo: boolean;
			yoloCalls: Array<{defaultId?: number; cancelId?: number}>;
		};
		state.acceptYolo = false;
		state.yoloCalls = [];
		dialog.showMessageBox = (async (...args: unknown[]) => {
			state.yoloCalls.push(
				args.at(-1) as {defaultId?: number; cancelId?: number},
			);
			return {response: state.acceptYolo ? 1 : 0, checkboxChecked: false};
		}) as typeof dialog.showMessageBox;
	});
	const mode = page.getByRole('combobox', {
		name: 'mode for this thread',
		exact: true,
	});
	const input = page.getByRole('textbox', {name: 'message', exact: true});
	await input.fill('preserved fixture draft');
	await choose(mode, 'yolo');
	await expect(mode).toBeEnabled();
	await expectValue(mode, 'normal');
	await expect(input).toHaveValue('preserved fixture draft');
	await app.evaluate(() => {
		(globalThis as unknown as {acceptYolo: boolean}).acceptYolo = true;
	});
	await choose(mode, 'yolo');
	await expectValue(mode, 'yolo');
	await expect(
		page.getByText('yolo · pending first message.', {exact: false}),
	).toBeAttached();
	await page
		.getByRole('button', {
			name: 'mode and project default details',
			exact: true,
		})
		.click();
	await expect(
		page.getByRole('button', {
			name: "use as this project's default",
			exact: true,
		}),
	).toBeDisabled();
	await input.press('Enter');
	await expect(input).toHaveValue('');
	await expect(turnEnded(page)).toBeVisible();
	const restarted = await page.evaluate(async () => {
		const {desktop} = window as unknown as {desktop: DesktopApi};
		const ui = await desktop.getUiState({});
		if (!ui.ok || !ui.value.activeProjectId) throw new Error('fixture scope');
		return desktop.restartProject({projectId: ui.value.activeProjectId});
	});
	expect(
		restarted.ok && restarted.value.status,
		restarted.ok
			? undefined
			: `restartProject error code: ${restarted.error.code}`,
	).toBe('ready');
	await expectValue(mode, 'normal');
	const calls = await app.evaluate(
		() =>
			(
				globalThis as unknown as {
					yoloCalls: Array<{defaultId?: number; cancelId?: number}>;
				}
			).yoloCalls,
	);
	expect(calls).toHaveLength(2);
	for (const call of calls)
		expect([call.defaultId, call.cancelId]).toEqual([0, 0]);
});

test('cancelling yolo preserves an earlier pending plan and its draft through first send (DEC-31 CHAT-04)', async () => {
	await app.evaluate(({dialog}) => {
		dialog.showMessageBox = (async () => ({
			response: 0,
			checkboxChecked: false,
		})) as typeof dialog.showMessageBox;
	});
	const mode = page.getByRole('combobox', {
		name: 'mode for this thread',
		exact: true,
	});
	const input = page.getByRole('textbox', {name: 'message', exact: true});
	await input.fill('fixture plan after cancelled yolo');
	await choose(mode, 'plan');
	await expectValue(mode, 'plan');
	await expect(mode).toBeEnabled();
	await choose(mode, 'yolo');
	await expect(mode).toBeEnabled();
	await expectValue(mode, 'plan');
	await expect(input).toHaveValue('fixture plan after cancelled yolo');
	const before = await page.evaluate(async () => {
		const {desktop} = window as unknown as {desktop: DesktopApi};
		const ui = await desktop.getUiState({});
		if (!ui.ok || !ui.value.activeProjectId) throw new Error('fixture scope');
		return desktop.listThreads({
			projectId: ui.value.activeProjectId,
			archiveState: 'active',
		});
	});
	expect(
		before.ok &&
			before.value.every(thread => thread.nanocoderSessionId === null),
	).toBe(true);
	await input.press('Enter');
	await expect(input).toHaveValue('');
	await expectValue(mode, 'plan');
});

test('inactive composer controls and reasons retain readable contrast in both themes (U.5)', async () => {
	await page.emulateMedia({reducedMotion: 'reduce'});
	const input = page.getByRole('textbox', {name: 'message', exact: true});
	await page.evaluate(async () => {
		const {desktop} = window as unknown as {desktop: DesktopApi};
		const ui = await desktop.getUiState({});
		if (!ui.ok || !ui.value.activeProjectId) throw new Error('fixture scope');
		await desktop.stopProject({projectId: ui.value.activeProjectId});
	});
	await expect(input).toBeDisabled();
	await expect(input).toHaveCSS('opacity', '1');
	for (const theme of ['dark', 'light']) {
		await page.evaluate(value => {
			document.documentElement.dataset.theme = value;
		}, theme);
		await expect(
			page
				.locator('.composer-hint-row')
				.getByText('Nanocoder is not ready. retry before sending.', {
					exact: true,
				}),
		).toHaveCSS('opacity', '1');
		expect(await visibleTextContrast(page, theme)).toEqual([]);
	}
});

test('an unprompted current config notification updates the mounted selection and revision without another read (ACP-14)', async () => {
	await page.evaluate(() => {
		const state = window as unknown as {
			desktop: DesktopApi;
			revisions: string[];
		};
		state.revisions = [];
		state.desktop.onProjectEvent(event => {
			if (event.type === 'project-controls')
				state.revisions.push(event.controls.revision);
		});
	});
	const input = page.getByRole('textbox', {name: 'message', exact: true});
	await input.fill('fixture session before unprompted config');
	await input.press('Enter');
	await expect(input).toHaveValue('');
	const model = page.getByRole('combobox', {
		name: 'model for every thread in project project',
		exact: true,
	});
	await expectValue(model, 'old');
	const revision = await page.evaluate(() =>
		(window as unknown as {revisions: string[]}).revisions.at(-1),
	);
	expect(revision).toBeTruthy();
	await app.evaluate(({ipcMain}) => {
		const state = globalThis as unknown as {unexpectedControlReads: number};
		state.unexpectedControlReads = 0;
		ipcMain.removeHandler('projects:get-controls');
		ipcMain.handle('projects:get-controls', () => {
			state.unexpectedControlReads++;
			return {
				ok: false,
				error: {code: 'UNAVAILABLE', message: 'fixture forbids another read'},
			};
		});
	});
	writeFileSync(
		path.join(work, 'project', '.fake-control-notification'),
		'fixture',
	);
	await expectValue(model, 'confirmed');
	expect(
		await page.evaluate(() =>
			(window as unknown as {revisions: string[]}).revisions.at(-1),
		),
	).not.toBe(revision);
	expect(
		await app.evaluate(
			() =>
				(globalThis as unknown as {unexpectedControlReads: number})
					.unexpectedControlReads,
		),
	).toBe(0);
});
