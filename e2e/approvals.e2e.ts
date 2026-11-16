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
import {build} from 'vite';
import type {DesktopApi} from '@/shared/desktop-api';
import type {PermissionRequestInfo} from '@/shared/ipc';
import type {approvalHarness} from './qa/approval-harness';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import {createDraftThread} from './qa/new-thread';
import {openFolderFromPalette} from './qa/open-folder';
import {turnCancelled, turnEnded} from './qa/turn-state';

const work = realpathSync.native(
	mkdtempSync(path.join(tmpdir(), 'nd-approvals-')),
);
const cli = path.join(work, 'nanocoder/dist/cli.js');
let app: ElectronApplication;
let page: Page;
let projectCount = 0;
const cards = () => page.getByRole('region', {name: 'permission request'});
const dialogs = () => page.getByRole('alertdialog');
const input = () => page.getByRole('textbox', {name: 'message'});
const paletteKey = process.platform === 'darwin' ? 'Meta+k' : 'Control+k';

test.beforeAll(async () => {
	mkdirSync(path.dirname(cli), {recursive: true});
	copyFileSync('source/main/nanocoder/fixtures/fake-nanocoder.mjs', cli);
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
		args: ['.', `--user-data-dir=${path.join(work, 'profile')}`],
		env: qaEnvironment(process.env, {cliPath: cli, nodePath: process.execPath}),
	});
	page = await app.firstWindow();
});

test.afterAll(async () => {
	await app?.close();
	rmSync(work, {recursive: true, force: true});
});

async function open(mode = 'ok') {
	const folder = path.join(work, `project-${++projectCount}`);
	mkdirSync(folder);
	writeFileSync(path.join(folder, '.fake-nanocoder'), mode);
	await app.evaluate(({dialog}, folder) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [folder],
		})) as typeof dialog.showOpenDialog;
	}, folder);
	await openFolderFromPalette(page, folder);
	await page
		.getByRole('button', {name: 'runtime details', exact: true})
		.click();
	const setup = page.getByRole('dialog', {name: 'runtime details'});
	await expect(setup.locator('.runtime-rows')).toContainText(folder);
	await page.keyboard.press('Escape');
	await expect(setup).toBeHidden();
	await expect(input()).toBeEnabled();
}

async function prompt() {
	await input().fill('fixture approval request');
	await input().focus();
	await page.keyboard.press('Enter');
}

const cancel = () =>
	page.evaluate(async () => {
		const {desktop} = window as unknown as {desktop: DesktopApi};
		const ui = await desktop.getUiState({});
		return desktop.cancelThread({
			projectId:
				(ui.ok && ui.value.activeProjectId) ||
				'11111111-1111-4111-8111-111111111111',
			threadId:
				(ui.ok && ui.value.activeThreadId) ||
				'22222222-2222-4222-8222-222222222222',
		});
	});

test('cancellation refuses an unknown thread and is a clean no-op with no active turn', async () => {
	const unopened = await cancel();
	expect(!unopened.ok && unopened.error.code).toBe('NOT_FOUND');
	await open();
	expect(await cancel()).toEqual({ok: true, value: null});
	await expect(cards()).toHaveCount(0);
	await expect(input()).toBeEnabled();
});

test('cancel closes every pending permission as Interrupted, never allowed, and permits the next turn', async () => {
	await open('two-tools');
	await prompt();
	await expect(cards()).toHaveCount(2);
	await expect(
		page.getByRole('button', {name: 'cancel turn', exact: true}),
	).toBeVisible();
	await page.getByRole('button', {name: 'cancel turn', exact: true}).click();
	await expect(cards()).toHaveCount(0);
	await expect(page.getByText('turn interrupted')).toBeVisible();
	await expect(turnCancelled(page)).toHaveCount(1);
	await expect(page.locator('.ui-badge--interrupted')).toBeVisible();
	await expect(input()).toBeEnabled();
	await expect(input()).toBeFocused();
	await expect(page.locator('.gate-message-tool')).toHaveText([
		/failed execute_bash: echo call_1/,
		/failed execute_bash: echo call_2/,
	]);
	await prompt();
	await expect(cards()).toHaveCount(2);
	await page.getByRole('button', {name: 'cancel turn', exact: true}).click();
	await expect(page.getByText('turn interrupted')).toBeVisible();
	await expect(turnCancelled(page)).toHaveCount(1);
});

test('cancel also interrupts an active turn with no permission request', async () => {
	await open('wait-for-cancel');
	await prompt();
	await expect(page.locator('.ui-badge--running')).toBeVisible();
	await expect(cards()).toHaveCount(0);
	await expect(
		page.getByRole('button', {name: 'cancel turn', exact: true}),
	).toBeVisible();
	await page.getByRole('button', {name: 'cancel turn', exact: true}).click();
	await expect(page.getByText('turn interrupted')).toBeVisible();
	await expect(turnCancelled(page)).toHaveCount(1);
	await expect(input()).toBeFocused();
});

test('permission takes focus, supports only its offered numbered choices and restores the composer', async () => {
	await open();
	await prompt();
	await expect(dialogs()).toBeFocused();
	await expect(dialogs()).toHaveAccessibleName('approval required');
	await expect(dialogs()).toHaveAccessibleDescription(
		/^Nanocoder · execute_bash · normal mode .+ approval does not guarantee success\.$/,
	);
	await expect(cards().getByRole('button').nth(0)).toHaveAccessibleName(
		'Allow',
	);
	await expect(cards().getByRole('button').nth(1)).toHaveAccessibleName('Deny');
	await expect(cards().locator('kbd')).toHaveText(['1', '2']);
	await page.keyboard.press('9');
	await expect(cards()).toBeVisible();
	await dialogs().dispatchEvent('keydown', {key: '1', repeat: true});
	await expect(cards()).toBeVisible();
	await page
		.getByRole('button', {name: 'command palette', exact: true})
		.focus();
	await page.keyboard.press('1');
	await expect(cards()).toBeVisible();
	await dialogs().focus();
	await page.keyboard.press('2');
	await expect(cards()).toHaveCount(0);
	await expect(turnEnded(page)).toBeVisible();
	await expect(input()).toBeFocused();
});

test('empty or modified key events never select a permission option', async () => {
	await open();
	await prompt();
	await expect(dialogs()).toBeFocused();
	for (const event of [
		{key: ''},
		{key: '12'},
		{key: '1', shiftKey: true},
		{key: '1', altKey: true},
		{key: '1', ctrlKey: true},
		{key: '1', metaKey: true},
		{key: '1', repeat: true},
	]) {
		await dialogs().dispatchEvent('keydown', event);
		await expect(cards()).toBeVisible();
	}
	await dialogs().press('2');
	await expect(cards()).toHaveCount(0);
});

test('all offered permission kinds keep their labels and their reported outcomes', async () => {
	for (const [choice, optionId, allowed] of [
		['Allow once', 'allow', true],
		['Allow always', 'allow-always', true],
		['Reject once', 'deny', false],
		['Reject all', 'deny-always', false],
	] as const) {
		await open('all-permissions');
		await prompt();
		await expect(dialogs()).toBeFocused();
		await expect(cards().getByRole('button')).toHaveCount(4);
		for (const label of [
			'Allow once',
			'Allow always',
			'Reject once',
			'Reject all',
		])
			await expect(
				cards().getByRole('button', {name: label, exact: true}),
			).toBeVisible();
		await cards().getByRole('button', {name: choice, exact: true}).click();
		await expect(cards()).toHaveCount(0);
		await expect(turnEnded(page)).toBeVisible();
		await expect(page.locator('.gate-message-tool')).toContainText(
			allowed ? 'completed' : 'failed',
		);
		await expect(page.locator('.gate-message-tool code')).toHaveText(
			`selected ${optionId}`,
		);
		await expect(input()).toBeFocused();
	}
});

test('ask_user presents only Nanocoder question options and sends the selected answer', async () => {
	await open('ask-user');
	await prompt();
	const question = page.locator('dialog.question-dialog');
	await expect(question).toBeVisible();
	await expect(question).toHaveJSProperty('open', true);
	await expect(question).toHaveAttribute('role', 'alertdialog');
	await expect(question).toHaveAccessibleName('Nanocoder needs a choice');
	await expect(
		question.getByRole('button', {name: 'close choice', exact: true}),
	).toBeFocused();
	await expect(question).toContainText('Which fixture option?');
	await expect(question).toContainText(
		'ask_user · ACP supports selectable options only. no free-text answer is invented.',
	);
	await expect(question.getByRole('textbox')).toHaveCount(0);
	await expect(question.locator('.question-choice')).toHaveText([
		'1 · First choice',
		'2 · Second choice',
	]);
	await expect(
		question.locator('.question-choice').nth(0),
	).toHaveAccessibleName('First choice');
	await expect(
		question.locator('.question-choice').nth(1),
	).toHaveAccessibleName('Second choice');
	await expect(cards()).toHaveCount(0);
	await page.keyboard.press('9');
	await expect(question).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(question).toHaveCount(0);
	await expect(cards()).toHaveCount(1);
	await expect(dialogs()).toBeFocused();
	await expect(page.getByText('turn ended: end_turn')).toHaveCount(0);
	await expect(page.getByText('selected answer-')).toHaveCount(0);
	await expect(cards()).toContainText('Which fixture option?');
	await expect(cards().getByRole('textbox')).toHaveCount(0);
	await expect(cards().getByRole('button').nth(0)).toHaveAccessibleName(
		'First choice',
	);
	await expect(cards().getByRole('button').nth(1)).toHaveAccessibleName(
		'Second choice',
	);
	await page.keyboard.press('2');
	await expect(cards()).toHaveCount(0);
	await expect(turnEnded(page)).toBeVisible();
	await expect(page.locator('.gate-message-tool code')).toHaveText(
		'selected answer-1',
	);
	await expect(input()).toBeFocused();
});

test('closing an ask_user question with its close control sends no answer and the shelf still answers', async () => {
	await open('ask-user');
	await prompt();
	const question = page.locator('dialog.question-dialog');
	await expect(question).toBeVisible();
	await question
		.getByRole('button', {name: 'close choice', exact: true})
		.click();
	await expect(question).toHaveCount(0);
	await expect(cards()).toHaveCount(1);
	await expect(page.getByText('turn ended: end_turn')).toHaveCount(0);
	await expect(page.getByText('selected answer-')).toHaveCount(0);
	await cards()
		.getByRole('button', {name: 'Second choice', exact: true})
		.click();
	await expect(cards()).toHaveCount(0);
	await expect(page.locator('.gate-message-tool code')).toHaveText(
		'selected answer-1',
	);
	await expect(turnEnded(page)).toBeVisible();
});

test('a question already pending when the shelf mounts returns focus to the composer after answering', async () => {
	await open('ask-user');
	await prompt();
	const question = page.locator('dialog.question-dialog');
	await expect(question).toBeVisible();
	const threadId = await page
		.locator('.thread-row[data-selected="true"]')
		.getAttribute('data-thread-id');
	if (!threadId) throw new Error('Missing the question thread id');
	// The open modal question blocks the rail, so collapse it to the shelf first.
	await page.keyboard.press('Escape');
	await expect(question).toHaveCount(0);
	await expect(cards()).toHaveCount(1);
	await createDraftThread(
		page,
		page.getByRole('button', {name: 'new thread', exact: true}),
	);
	await expect(
		page.locator('.thread-row[data-selected="true"] .thread-title'),
	).toHaveText('new thread');
	await expect(question).toHaveCount(0);
	await page.locator(`[data-thread-id="${threadId}"] .thread-open`).click();
	await expect(question).toBeVisible();
	await expect(
		question.getByRole('button', {name: 'close choice', exact: true}),
	).toBeFocused();
	await page.keyboard.press('2');
	await expect(question).toHaveCount(0);
	await expect(turnEnded(page)).toBeVisible();
	await expect(input()).toBeFocused();
});

test('queued requests keep focus on the oldest remaining request and restore the original control', async () => {
	await open('two-tools');
	await input().fill('fixture queued requests');
	const origin = page.getByRole('button', {
		name: 'command palette',
		exact: true,
	});
	await origin.focus();
	await page.evaluate(() => {
		const form = document.querySelector<HTMLFormElement>('.gate-composer');
		form?.requestSubmit();
	});
	await expect(dialogs()).toHaveCount(2);
	await expect(dialogs().first()).toBeFocused();
	await cards().last().getByRole('button', {name: 'Deny'}).click();
	await expect(dialogs()).toHaveCount(1);
	await expect(dialogs()).toBeFocused();
	await page.keyboard.press('2');
	await expect(cards()).toHaveCount(0);
	await expect(origin).toBeFocused();
});

test('focused approvals stay fully visible across turns and widths in both themes', async () => {
	await page.emulateMedia({reducedMotion: 'no-preference'});
	await open('all-permissions');
	for (const theme of ['dark', 'light']) {
		for (const width of [1240, 1020, 840]) {
			await page.setViewportSize({width, height: 900});
			await page.evaluate(theme => {
				document.documentElement.dataset.theme = theme;
			}, theme);
			await prompt();
			await expect(dialogs()).toBeFocused();
			await expect
				.poll(() =>
					page.evaluate(() =>
						document
							.getAnimations()
							.filter(animation => animation instanceof CSSTransition)
							.every(animation => animation.playState === 'finished'),
					),
				)
				.toBe(true);
			await expect(cards()).toHaveCSS('animation-name', 'approval-pulse');
			await expect(cards()).toHaveCSS('animation-duration', '2.2s');
			await expect(cards()).toHaveCSS(
				'border-top-color',
				theme === 'dark' ? 'rgb(122, 162, 247)' : 'rgb(0, 0, 238)',
			);
			await expect(cards()).toHaveCSS('outline-width', '2px');
			await input().focus();
			await expect(cards()).toHaveCSS(
				'border-top-color',
				theme === 'dark' ? 'rgb(224, 175, 104)' : 'rgb(118, 81, 11)',
			);
			await expect(cards()).toHaveCSS('outline-style', 'none');
			await dialogs().focus();
			await expect(dialogs()).toBeFocused();
			for (const hint of await cards().locator('kbd').all())
				await expect(hint).toHaveCSS('opacity', '1');
			const geometry = await cards().evaluate(card => {
				const rect = card.getBoundingClientRect();
				const scroll = document
					.querySelector('.shell-conversation-footer')
					?.getBoundingClientRect();
				return {
					left: rect.left,
					right: rect.right,
					top: rect.top,
					bottom: rect.bottom,
					scrollLeft: scroll?.left ?? 0,
					scrollRight: scroll?.right ?? 0,
					scrollTop: scroll?.top ?? 0,
					scrollBottom: scroll?.bottom ?? 0,
					windowHeight: innerHeight,
					overflow: document.documentElement.scrollWidth > innerWidth,
				};
			});
			expect(geometry.overflow).toBe(false);
			expect(geometry.left).toBeGreaterThanOrEqual(0);
			expect(geometry.right).toBeLessThanOrEqual(width);
			expect(geometry.left).toBeGreaterThanOrEqual(geometry.scrollLeft);
			expect(geometry.right).toBeLessThanOrEqual(geometry.scrollRight);
			expect(geometry.top).toBeGreaterThanOrEqual(0);
			expect(geometry.bottom).toBeLessThanOrEqual(geometry.windowHeight);
			expect(geometry.top).toBeGreaterThanOrEqual(geometry.scrollTop);
			expect(geometry.bottom).toBeLessThanOrEqual(geometry.scrollBottom);
			await page.keyboard.press('4');
			await expect(cards()).toHaveCount(0);
			await expect(input()).toBeFocused();
			await expect(page.locator('.gate-composer')).toHaveCSS(
				'border-color',
				theme === 'dark' ? 'rgb(122, 162, 247)' : 'rgb(0, 0, 238)',
			);
			await expect(page.locator('.ui-badge--approval')).toHaveCount(0);
		}
	}
	await page.emulateMedia({reducedMotion: 'reduce'});
	await open();
	await prompt();
	await expect(dialogs()).toBeFocused();
	await expect(cards()).toHaveCSS('animation-name', 'none');
	await expect(dialogs()).toHaveCSS('transition-duration', '0s');
	await page.keyboard.press('2');
	await expect(input()).toBeFocused();
});

test.describe('approval and overlay focus', () => {
	test.afterEach(async () => {
		if (await page.locator('dialog[open]').count())
			await page.keyboard.press('Escape');
		if (await page.locator('.approval-dialog').count()) await cancel();
	});

	test('explicit overlays return to the exact approval control and Escape never answers', async () => {
		await open('all-permissions');
		await prompt();
		await expect(dialogs()).toBeFocused();
		const origin = cards().getByRole('button', {name: 'Allow always'});
		await origin.focus();
		for (const key of [paletteKey, '?']) {
			await page.keyboard.press(key);
			const overlay = page.locator('dialog[open]');
			await expect(overlay).toBeVisible();
			await expect
				.poll(() =>
					overlay.evaluate(dialog => dialog.contains(document.activeElement)),
				)
				.toBe(true);
			if (key === paletteKey) {
				await overlay.getByRole('combobox').fill('2');
				await expect(page.locator('.approval-dialog')).toHaveCount(1);
			}
			await page.keyboard.press('Escape');
			await expect(overlay).toHaveCount(0);
			await expect(origin).toBeFocused();
			await expect(cards()).toHaveCount(1);
		}
		await page.keyboard.press('Escape');
		await expect(origin).toBeFocused();
		await expect(cards()).toHaveCount(1);
		await expect(input()).toBeEnabled();
		await expect(
			page.getByRole('button', {name: 'send', exact: true}),
		).toBeDisabled();
		await expect(input()).toHaveAccessibleDescription(
			'waiting for your decision · draft is not queued ↵ send · ⇧↵ newline',
		);
		await page.keyboard.press('3');
		await expect(cards()).toHaveCount(0);
		await expect(input()).toBeFocused();
		await expect(input()).not.toHaveAccessibleDescription(
			'waiting for your decision · draft is not queued ↵ send · ⇧↵ newline',
		);
	});

	for (const kind of ['palette', 'shortcuts'] as const) {
		const name = kind === 'palette' ? 'command palette' : 'keyboard shortcuts';
		const focusedControl = () =>
			kind === 'palette'
				? page.getByRole('combobox', {name: 'find a command', exact: true})
				: page.getByRole('button', {name: 'close keyboard shortcuts'});

		test(`an approval arriving during ${kind} is announced without stealing focus and takes focus after Escape`, async () => {
			await open();
			const persistent = page.locator('dialog [aria-label="notification"]');
			await expect(persistent).toHaveCount(1);
			await expect(persistent).toHaveText('');
			const previousRegion = await persistent.elementHandle();
			if (!previousRegion) throw new Error('Missing persistent modal region');
			await input().fill('fixture approval request');
			await input().focus();
			await page.evaluate(kind => {
				document
					.querySelector<HTMLFormElement>('.gate-composer')
					?.requestSubmit();
				const mac = navigator.platform.startsWith('Mac');
				document.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: kind === 'palette' ? 'k' : '?',
						metaKey: kind === 'palette' && mac,
						ctrlKey: kind === 'palette' && !mac,
						bubbles: true,
					}),
				);
			}, kind);
			await expect(page.getByRole('dialog', {name, exact: true})).toBeVisible();
			await expect(page.locator('.approval-dialog')).toHaveCount(1);
			await expect(focusedControl()).toBeFocused();
			const notification = page.getByRole('status', {name: 'notification'});
			await expect(notification).toHaveAttribute('aria-live', 'polite');
			await expect(notification).toHaveText('approval required · 1 waiting');
			expect(
				await notification.evaluate(
					(region, previous) => region === previous,
					previousRegion,
				),
			).toBe(true);
			expect(
				await notification.evaluate(
					region =>
						region.closest('[inert], [aria-hidden="true"]') === null &&
						region.closest('dialog:modal')?.getAttribute('aria-label'),
				),
			).toBe(name);
			await expect(
				page.locator('[aria-label="notification"][aria-live="polite"]'),
			).toHaveCount(1);
			await previousRegion.dispose();
			await page.keyboard.press('Escape');
			await expect(page.locator('dialog[open]')).toHaveCount(0);
			await expect(dialogs()).toBeFocused();
			await expect(cards().getByRole('button')).toHaveCount(2);
			await page.keyboard.press('2');
			await expect(cards()).toHaveCount(0);
			await expect(input()).toBeFocused();
		});

		test(`cancelling approval during ${kind} defers composer focus until Escape`, async () => {
			await open();
			await prompt();
			await expect(dialogs()).toBeFocused();
			await page.keyboard.press(kind === 'palette' ? paletteKey : '?');
			await expect(focusedControl()).toBeFocused();
			expect(await cancel()).toEqual({ok: true, value: null});
			await expect(page.locator('.approval-dialog')).toHaveCount(0);
			await expect(input()).toBeEnabled();
			await expect(focusedControl()).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(page.locator('dialog[open]')).toHaveCount(0);
			await expect(input()).toBeFocused();
			await expect(page.getByText('turn interrupted')).toBeVisible();
			await expect(turnCancelled(page)).toHaveCount(1);
		});
	}
});

test.describe('approval focus recovery', () => {
	type HarnessWindow = {
		approvalFixture: {approvalHarness: typeof approvalHarness};
	};
	const fixture = () => page.locator('#approval-focus-fixture');
	const request = (id: string): PermissionRequestInfo => ({
		id,
		title: `fixture ${id}`,
		options: [{id: 'allow', name: 'Allow', kind: 'allow_once'}],
	});

	test.beforeAll(async () => {
		const result = await build({
			configFile: false,
			logLevel: 'silent',
			define: {'process.env.NODE_ENV': JSON.stringify('production')},
			resolve: {alias: {'@': path.resolve('source')}},
			build: {
				write: false,
				minify: false,
				lib: {
					entry: path.resolve('e2e/qa/approval-harness.ts'),
					name: 'approvalFixture',
					formats: ['iife'],
				},
			},
		});
		const outputs = Array.isArray(result) ? result : [result];
		const code = outputs
			.flatMap(output =>
				'output' in output
					? output.output.flatMap(file =>
							file.type === 'chunk' ? [file.code] : [],
						)
					: [],
			)
			.join('\n');
		if (!code) throw new Error('Missing component fixture bundle');
		await page.evaluate(code);
	});

	test.afterEach(async () => {
		await page.evaluate(() =>
			(
				window as unknown as HarnessWindow
			).approvalFixture.approvalHarness.dispose(),
		);
	});

	test('a refused answer re-enables choices and recovers focus without consuming the request', async () => {
		const pending = request('failed-answer');
		pending.options[0].id = 'x'.repeat(201);
		await page.evaluate(
			requests =>
				(
					window as unknown as HarnessWindow
				).approvalFixture.approvalHarness.render(requests),
			[pending],
		);
		const dialog = fixture().getByRole('alertdialog');
		await expect(dialog).toBeFocused();
		const option = dialog.getByRole('button', {name: 'Allow'});
		await option.click();
		await expect(dialog.getByRole('alert')).toBeVisible();
		await expect(option).toBeEnabled();
		await expect(dialog).toBeFocused();
		await expect(fixture().getByRole('alertdialog')).toHaveCount(1);
	});

	const question = (id: string): PermissionRequestInfo => ({
		id,
		title: `fixture question ${id}?`,
		question: true,
		options: [
			{id: 'answer-0', name: 'first fixture choice', kind: 'allow_once'},
			{id: 'answer-1', name: 'second fixture choice', kind: 'allow_once'},
		],
	});
	const render = (requests: PermissionRequestInfo[]) =>
		page.evaluate(
			requests =>
				(
					window as unknown as HarnessWindow
				).approvalFixture.approvalHarness.render(requests),
			requests,
		);
	const answers = () =>
		page.evaluate(() =>
			(
				window as unknown as HarnessWindow
			).approvalFixture.approvalHarness.answers(),
		);
	const choice = () => page.locator('dialog.question-dialog');

	for (const dismiss of ['Escape', 'close'] as const) {
		test(`question ${dismiss} collapses to the shelf without answering and keeps the request pending`, async () => {
			await render([question('Q')]);
			await expect(choice()).toBeVisible();
			const close = choice().getByRole('button', {
				name: 'close choice',
				exact: true,
			});
			await expect(close).toBeFocused();
			await expect(
				page.locator('#approval-focus-fixture .ui-card--approval'),
			).toHaveCount(0);
			for (let index = 0; index < 4; index++) {
				await page.keyboard.press(index % 2 ? 'Shift+Tab' : 'Tab');
				expect(
					await choice().evaluate(dialog =>
						dialog.contains(document.activeElement),
					),
				).toBe(true);
			}
			await close.focus();
			if (dismiss === 'Escape') await page.keyboard.press('Escape');
			else await close.click();
			await expect(choice()).toHaveCount(0);
			const card = fixture().getByRole('alertdialog');
			await expect(card).toHaveCount(1);
			await expect(card).toBeFocused();
			await expect(card).toContainText('fixture question Q?');
			await expect(card.getByRole('textbox')).toHaveCount(0);
			expect(await answers()).toEqual([]);
			await page.keyboard.press('2');
			await expect.poll(answers).toEqual(['Q:answer-1']);
		});
	}

	test('question digits answer only offered choices once, keep failures in the dialog and return focus on resolution', async () => {
		// Mount the shelf first so it records the focus origin, as the app does.
		await render([]);
		await render([question('R')]);
		await expect(choice()).toBeVisible();
		for (const key of ['9', '3', '0']) await page.keyboard.press(key);
		await choice().dispatchEvent('keydown', {key: '1', repeat: true});
		await choice().dispatchEvent('keydown', {key: '1', shiftKey: true});
		expect(await answers()).toEqual([]);
		await choice().evaluate(dialog => {
			for (const key of ['1', '2'])
				dialog.dispatchEvent(
					new KeyboardEvent('keydown', {key, bubbles: true}),
				);
		});
		await expect.poll(answers).toEqual(['R:answer-0']);
		await expect(choice().getByRole('alert')).toBeVisible();
		await expect(choice()).toBeVisible();
		await expect(
			choice().getByRole('button', {name: 'first fixture choice'}),
		).toBeEnabled();
		expect(
			await choice().evaluate(dialog =>
				dialog.contains(document.activeElement),
			),
		).toBe(true);
		await render([]);
		await expect(choice()).toHaveCount(0);
		await expect(
			fixture().getByRole('button', {name: 'fixture focus origin'}),
		).toBeFocused();
	});

	test('same-size queue replacement recovers the oldest request when the focused card disappears', async () => {
		await page.evaluate(
			requests =>
				(
					window as unknown as HarnessWindow
				).approvalFixture.approvalHarness.render(requests),
			[request('A'), request('B')],
		);
		const dialogs = fixture().getByRole('alertdialog');
		await expect(dialogs).toHaveCount(2);
		await dialogs.nth(1).getByRole('button').focus();
		await page.evaluate(
			requests =>
				(
					window as unknown as HarnessWindow
				).approvalFixture.approvalHarness.render(requests),
			[request('A'), request('C')],
		);
		await expect(dialogs.nth(1)).toContainText('fixture C');
		await expect(dialogs).toHaveCount(2);
		await expect(dialogs.nth(0)).toBeFocused();
	});
});
