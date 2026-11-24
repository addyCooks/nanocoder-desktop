import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {expect, test} from '@playwright/test';
import type {DesktopApi} from '@/shared/desktop-api';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import {contrast, visibleTextContrast} from './qa/ui-contrast';

const work = realpathSync.native(
	mkdtempSync(path.join(tmpdir(), 'nd-overlays-')),
);
const cli = path.join(work, 'nanocoder/dist/cli.js');
let app: Awaited<ReturnType<typeof electron.launch>>;
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
});

test.afterAll(async () => {
	await app?.close();
	rmSync(work, {recursive: true, force: true});
});

test('palette shortcut filters, moves selection, runs actions and returns focus', async () => {
	const page = await app.firstWindow();
	const trigger = page.getByRole('button', {name: 'command palette'});
	await trigger.focus();
	await page.keyboard.press(paletteKey);
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	const input = palette.getByRole('combobox');
	await expect(input).toBeFocused();
	await input.fill('theme');
	await expect(palette.getByRole('option')).toHaveCount(1);
	await expect(
		palette.getByRole('option', {name: /switch to light/}),
	).toBeVisible();
	await input.fill('switch to light');
	await page.keyboard.press('Enter');
	await expect(palette).toBeHidden();
	await expect(trigger).toBeFocused();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await expect(page.getByRole('status', {name: 'notification'})).toContainText(
		'light theme',
	);
	await expect(trigger).toBeFocused();
});

test('Escape closes from every overlay control and the shortcut sheet ignores typing', async () => {
	const page = await app.firstWindow();
	const trigger = page.getByRole('button', {name: 'command palette'});
	await trigger.click();
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	await palette.getByRole('combobox').fill('keyboard shortcuts');
	await page.keyboard.press('Enter');
	const sheet = page.getByRole('dialog', {
		name: 'keyboard shortcuts',
		exact: true,
	});
	await expect(sheet).toBeVisible();
	await sheet.getByRole('button', {name: 'close keyboard shortcuts'}).focus();
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await expect(trigger).toBeFocused();
	await page.keyboard.press('?');
	await expect(sheet).toBeVisible();
	await page.keyboard.press('Escape');
	await page.keyboard.press(paletteKey);
	await palette.getByRole('combobox').fill('?');
	await expect(sheet).toBeHidden();
	await page.keyboard.press('Escape');
});

test('no results remain keyboard safe', async () => {
	const page = await app.firstWindow();
	await page.keyboard.press(paletteKey);
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	const input = palette.getByRole('combobox');
	await input.fill('no-matching-action');
	await expect(
		palette.getByText('no threads or actions found. try a different search.'),
	).toBeVisible();
	await expect(input).toHaveAttribute('aria-expanded', 'false');
	await expect(palette.getByRole('listbox')).toHaveCount(0);
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(palette).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(palette).toBeHidden();
});

test('the command palette shell keeps the reference height cap at the default window size', async () => {
	const page = await app.firstWindow();
	await page.keyboard.press(paletteKey);
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	await expect(palette.getByRole('combobox')).toBeFocused();
	await expect(palette.locator('.dialog-shell')).toHaveCSS(
		'max-height',
		'517px',
	);
	await page.keyboard.press('Escape');
	await expect(palette).toBeHidden();
});

test('open-folder command calls the existing picker and cancellation preserves focus', async () => {
	const page = await app.firstWindow();
	await app.evaluate(({dialog}) => {
		dialog.showOpenDialog = (async () => ({
			canceled: true,
			filePaths: [],
		})) as typeof dialog.showOpenDialog;
	});
	const trigger = page.getByRole('button', {name: 'command palette'});
	await trigger.click();
	await page
		.getByRole('combobox', {name: 'find a thread or action', exact: true})
		.fill('open a project folder');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog')).toBeHidden();
	await expect(
		page.getByRole('button', {name: 'open a project folder'}),
	).toBeEnabled();
	await expect(trigger).toBeFocused();
});

test('disabled actions keep a visible reason and cannot run with Enter or pointer', async () => {
	const unavailableWork = mkdtempSync(
		path.join(tmpdir(), 'nd-overlays-unavailable-'),
	);
	const unavailable = await electron.launch({
		args: ['.', `--user-data-dir=${path.join(unavailableWork, 'profile')}`],
		env: qaEnvironment(process.env, {
			cliPath: path.join(unavailableWork, 'missing/cli.js'),
			nodePath: process.execPath,
		}),
	});
	try {
		const page = await unavailable.firstWindow();
		await page.getByRole('button', {name: 'command palette'}).click();
		await page
			.getByRole('combobox', {name: 'find a thread or action', exact: true})
			.fill('open');
		const option = page.getByRole('option', {name: /open a project folder/});
		await expect(option).toHaveAttribute('aria-disabled', 'true');
		await expect(option).toContainText(
			'unavailable: Nanocoder runtime is not available',
		);
		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog')).toBeVisible();
		await option.click({force: true});
		await expect(page.getByRole('dialog')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toBeHidden();
	} finally {
		await unavailable.close();
		rmSync(unavailableWork, {recursive: true, force: true});
	}
});

test('overlays match both themes at every width and retain visible keyboard focus', async () => {
	const page = await app.firstWindow();
	await page.emulateMedia({reducedMotion: 'reduce'});
	await expect(page.locator('.overlay-toast')).toHaveCount(0);
	for (const theme of ['dark', 'light']) {
		await page.evaluate(theme => {
			document.documentElement.dataset.theme = theme;
		}, theme);
		for (const width of [1240, 1020, 840]) {
			await page.setViewportSize({width, height: 900});
			await page.keyboard.press(paletteKey);
			const palette = page.getByRole('dialog', {
				name: 'command palette',
				exact: true,
			});
			await expect(palette).toHaveCSS('width', '520px');
			const bounds = await palette.boundingBox();
			expect(bounds?.y).toBeGreaterThanOrEqual(40);
			expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(860);
			expect(
				Math.abs((bounds?.y ?? 0) + (bounds?.height ?? 0) / 2 - 450),
			).toBeLessThan(1);
			await expect(palette.locator('.dialog-shell')).toHaveCSS(
				'box-shadow',
				'none',
			);
			await expect(
				page.getByRole('combobox', {
					name: 'find a thread or action',
					exact: true,
				}),
			).toBeFocused();
			await expect(
				page.getByRole('combobox', {
					name: 'find a thread or action',
					exact: true,
				}),
			).toHaveCSS('outline-width', '2px');
			expect(await visibleTextContrast(page, theme)).toEqual([]);
			await page.keyboard.press('Tab');
			await page.keyboard.press('Escape');
			await expect(palette).toBeHidden();
			await page.keyboard.press('?');
			const sheet = page.getByRole('dialog', {
				name: 'keyboard shortcuts',
				exact: true,
			});
			await expect(sheet).toHaveCSS('width', '520px');
			await expect(
				sheet.getByRole('button', {name: 'close keyboard shortcuts'}),
			).toBeFocused();
			expect(await visibleTextContrast(page, theme)).toEqual([]);
			await page.keyboard.press('Escape');
		}
	}
});

test('contrast sampler excludes zero-opacity text but still catches visible bad colours', async () => {
	const page = await app.firstWindow();
	await expect(page.locator('.overlay-toast')).toHaveCount(0);
	await page.evaluate(() => {
		document.documentElement.dataset.theme = 'light';
		const fixture = document.createElement('div');
		fixture.id = 'contrast-visibility-fixture';
		fixture.style.backgroundColor = 'white';
		fixture.style.color = 'white';
		for (const [text, opacity] of [
			['zero-opacity text', '0'],
			['opaque low-contrast control', '1'],
			['partly transparent low-contrast control', '0.55'],
		]) {
			const element = document.createElement('span');
			element.textContent = text;
			element.style.opacity = opacity;
			fixture.append(element);
		}
		const ancestor = document.createElement('div');
		ancestor.style.opacity = '0';
		const child = document.createElement('span');
		child.textContent = 'text inside a zero-opacity ancestor';
		ancestor.append(child);
		fixture.append(ancestor);
		const readable = document.createElement('span');
		readable.textContent = 'readable control';
		readable.style.color = 'black';
		fixture.append(readable);
		document.body.append(fixture);
	});
	try {
		await expect(page.locator('#contrast-visibility-fixture span')).toHaveCount(
			5,
		);
		expect(
			(await visibleTextContrast(page, 'light')).map(sample => sample.text),
		).toEqual([
			'opaque low-contrast control',
			'partly transparent low-contrast control',
		]);
	} finally {
		await page.evaluate(() =>
			document.getElementById('contrast-visibility-fixture')?.remove(),
		);
	}
});

test('settled toast contrast passes in both themes and active hosts without focusing or overstaying', async () => {
	const page = await app.firstWindow();
	const trigger = page.getByRole('button', {name: 'command palette'});
	await page.emulateMedia({reducedMotion: 'reduce'});
	const region = page.getByRole('status', {name: 'notification'});
	const toast = page.locator('.overlay-toast');
	await expect(toast).toHaveCount(0);
	await page.evaluate(() => {
		document.documentElement.dataset.theme = 'dark';
	});
	for (const theme of ['light', 'dark']) {
		await trigger.click();
		await page
			.getByRole('combobox', {name: 'find a thread or action', exact: true})
			.fill(`switch to ${theme}`);
		await page.keyboard.press('Enter');
		await expect(toast).toContainText(`switched to ${theme} theme`);
		await expect(trigger).toBeFocused();
		for (const host of ['closed', 'palette']) {
			if (host === 'palette') await trigger.click();
			const focused =
				host === 'closed'
					? trigger
					: page.getByRole('combobox', {
							name: 'find a thread or action',
							exact: true,
						});
			await expect(region).toHaveAttribute('aria-live', 'polite');
			await expect(region).toHaveAttribute('aria-atomic', 'true');
			await expect(toast).toHaveAttribute('data-exiting', 'false');
			await expect(toast).toHaveCSS('opacity', '1');
			await expect(toast).toHaveCSS('transition-duration', '0s');
			await expect(toast).toHaveCSS('border-left-width', '1px');
			expect(
				await toast.evaluate(element =>
					element.closest('dialog:modal')?.getAttribute('aria-label'),
				),
			).toBe(host === 'palette' ? 'command palette' : undefined);
			const rendered = await toast.evaluate(element => {
				const style = getComputedStyle(element);
				const rgb = (color: string) =>
					color
						.match(/[\d.]+/g)
						?.slice(0, 3)
						.map(Number) as [number, number, number];
				return {
					foreground: rgb(style.color),
					background: rgb(style.backgroundColor),
					opacity: style.opacity,
					exiting: element.getAttribute('data-exiting'),
				};
			});
			expect(rendered.opacity).toBe('1');
			expect(rendered.exiting).toBe('false');
			expect(
				contrast(rendered.foreground, rendered.background),
			).toBeGreaterThanOrEqual(4.5);
			expect(await visibleTextContrast(page, theme)).toEqual([]);
			await expect(focused).toBeFocused();
		}
		await expect(toast).toHaveCount(0);
		await expect(
			page.getByRole('combobox', {
				name: 'find a thread or action',
				exact: true,
			}),
		).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(trigger).toBeFocused();
	}
	const setting = await page.evaluate(() =>
		(window as unknown as {desktop: DesktopApi}).desktop.getSettings({}),
	);
	expect(setting.ok && setting.value.theme).toBe('dark');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('projects dialog adds and the palette opens and locates projects through the existing project controls', async () => {
	const page = await app.firstWindow();
	const folder = path.join(work, 'palette-project');
	const moved = path.join(work, 'palette-project-moved');
	mkdirSync(folder);
	writeFileSync(path.join(folder, '.fake-nanocoder'), 'ok');
	const picker = async (folder: string) => {
		await app.evaluate(({dialog}, folder) => {
			dialog.showOpenDialog = (async () => ({
				canceled: false,
				filePaths: [folder],
			})) as typeof dialog.showOpenDialog;
		}, folder);
	};
	const command = async (label: string) => {
		await page.getByRole('button', {name: 'command palette'}).click();
		await page
			.getByRole('combobox', {name: 'find a thread or action', exact: true})
			.fill(label);
		await expect(
			page
				.getByRole('dialog', {name: 'command palette', exact: true})
				.getByRole('option')
				.first(),
		).toContainText(label);
		await page.keyboard.press('Enter');
	};
	const projects = () => page.getByRole('dialog', {name: 'your projects'});
	const showProjects = async () => {
		if (!(await projects().isVisible()))
			await page
				.getByRole('button', {name: 'switch project', exact: true})
				.click();
		await expect(projects()).toBeVisible();
	};
	const hideProjects = async () => {
		await page.keyboard.press('Escape');
		await expect(projects()).toBeHidden();
	};
	await picker(folder);
	await showProjects();
	await projects()
		.getByRole('button', {name: /add project folder/})
		.click();
	// Adding closes the projects dialog first, so it is reopened to read the list.
	await expect(projects()).toBeHidden();
	await showProjects();
	await expect(
		projects().getByRole('region', {name: 'recent projects'}),
	).toContainText(folder);
	await expect(
		projects().getByRole('button', {name: /add project folder/}),
	).toBeEnabled();
	await hideProjects();
	await expect(
		page.getByRole('status', {name: 'project trust feedback'}),
	).toContainText('project ready: palette-project');
	await command('open project palette-project');
	await showProjects();
	await expect(
		projects().getByRole('button', {name: /add project folder/}),
	).toBeEnabled();
	await hideProjects();
	await expect(
		page.getByRole('status', {name: 'project trust feedback'}),
	).toContainText('project ready: palette-project');
	await expect(page.getByRole('dialog')).toBeHidden();
	if (process.platform === 'win32') {
		const projectId = await page.evaluate(async root => {
			const result = await (
				window as unknown as {desktop: DesktopApi}
			).desktop.listProjects({});
			if (!result.ok) throw new Error('Expected saved projects');
			const project = result.value.find(
				project => project.canonicalRoot === root,
			);
			if (!project) throw new Error('Expected the opened project');
			return project.id;
		}, folder);
		const stopped = await page.evaluate(
			projectId =>
				(window as unknown as {desktop: DesktopApi}).desktop.stopProject({
					projectId,
				}),
			projectId,
		);
		expect(stopped).toMatchObject({
			ok: true,
			value: {projectId, status: 'stopped'},
		});
	}
	renameSync(folder, moved);
	await page.reload();
	await showProjects();
	await expect(
		projects().getByRole('region', {name: 'recent projects'}),
	).toContainText('folder missing');
	await hideProjects();
	await page.getByRole('button', {name: 'command palette'}).click();
	await page
		.getByRole('combobox', {name: 'find a thread or action', exact: true})
		.fill('open project palette-project');
	await expect(
		page
			.getByRole('dialog', {name: 'command palette', exact: true})
			.getByRole('option')
			.first(),
	).toHaveAttribute('aria-disabled', 'true');
	await expect(
		page
			.getByRole('dialog', {name: 'command palette', exact: true})
			.getByRole('option')
			.first(),
	).toContainText('folder missing');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.keyboard.press('Escape');
	await picker(moved);
	await command('locate project palette-project');
	await expect(
		page.getByRole('status', {name: 'project trust feedback'}),
	).toContainText('project ready: palette-project-moved');
	await showProjects();
	await expect(
		projects().getByRole('region', {name: 'recent projects'}),
	).toContainText(moved);
	await hideProjects();
});

test('keyboard selection stays visible when recent projects overflow the palette', async () => {
	const page = await app.firstWindow();
	for (let index = 0; index < 12; index++) {
		const folder = path.join(work, `scroll-project-${index}`);
		mkdirSync(folder);
		await app.evaluate(({dialog}, folder) => {
			dialog.showOpenDialog = (async () => ({
				canceled: false,
				filePaths: [folder],
			})) as typeof dialog.showOpenDialog;
		}, folder);
		await page.evaluate(() =>
			(window as unknown as {desktop: DesktopApi}).desktop.addProject({}),
		);
	}
	await page.reload();
	await page.setViewportSize({width: 840, height: 700});
	await page.getByRole('button', {name: 'command palette'}).click();
	await page.keyboard.press('ArrowUp');
	await expect(
		page.getByRole('option', {name: /keyboard shortcuts/}),
	).toHaveAttribute('aria-selected', 'true');
	const visible = await page.evaluate(() => {
		const option = document.querySelector(
			'[role="option"][aria-selected="true"]',
		);
		const dialog = document.querySelector('dialog[open]');
		if (!option || !dialog) return false;
		const row = option.getBoundingClientRect();
		const bounds = dialog.getBoundingClientRect();
		return row.top >= bounds.top && row.bottom <= bounds.bottom;
	});
	expect(visible).toBe(true);
	await expect(
		page.getByRole('combobox', {name: 'find a thread or action', exact: true}),
	).toBeFocused();
	await expect(
		page.getByRole('combobox', {name: 'find a thread or action', exact: true}),
	).toBeInViewport({ratio: 1});
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	const listbox = palette.getByRole('listbox');
	expect(
		await listbox.evaluate(
			element => element.scrollHeight > element.clientHeight,
		),
	).toBe(true);
	const list = await listbox.boundingBox();
	const row = await page
		.getByRole('option', {name: /keyboard shortcuts/})
		.boundingBox();
	expect(list).not.toBeNull();
	expect(row).not.toBeNull();
	expect(row?.y ?? 0).toBeGreaterThanOrEqual(list?.y ?? 0);
	// One pixel allows for subpixel scroll alignment at the list's bottom edge.
	expect((row?.y ?? 0) + (row?.height ?? 0)).toBeLessThanOrEqual(
		(list?.y ?? 0) + (list?.height ?? 0) + 1,
	);
	const shell = await palette.locator('.dialog-shell').boundingBox();
	expect(shell?.height ?? 0).toBeLessThanOrEqual(517);
	await page.keyboard.press('Escape');
});

test('composing Escape cancels neither the palette nor its search focus', async () => {
	const page = await app.firstWindow();
	for (const composing of [{isComposing: true}, {keyCode: 229}]) {
		await page.getByRole('button', {name: 'command palette'}).click();
		const input = page.getByRole('combobox', {
			name: 'find a thread or action',
			exact: true,
		});
		await input.fill('theme');
		await input.evaluate((input, composing) => {
			input.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
					...composing,
				}),
			);
		}, composing);
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(input).toBeFocused();
		await expect(input).toHaveValue('theme');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toBeHidden();
	}
});

test('Ctrl+K opens the palette on non-Mac platforms', async () => {
	const page = await app.firstWindow();
	const platform = await page.evaluate(() => navigator.platform);
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'platform', {
			value: 'Linux x86_64',
			configurable: true,
		});
	});
	await page.reload();
	try {
		await page.getByRole('button', {name: 'command palette'}).focus();
		await page.keyboard.press('Control+k');
		await expect(
			page.getByRole('dialog', {name: 'command palette', exact: true}),
		).toBeVisible();
		await page.keyboard.press('Escape');
	} finally {
		// Init scripts persist across reloads, so restore the real platform for later tests.
		await page.addInitScript((value: string) => {
			Object.defineProperty(navigator, 'platform', {
				value,
				configurable: true,
			});
		}, platform);
		await page.reload();
	}
});

test('pointer and keyboard keep exactly one palette result active without taking search focus', async () => {
	const page = await app.firstWindow();
	await page
		.getByRole('button', {name: 'command palette', exact: true})
		.click();
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	const input = palette.getByRole('combobox');
	await input.fill('thread');
	const options = palette.getByRole('option');
	await options.nth(1).hover();
	await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
	await expect(
		palette.locator('[role="option"][aria-selected="true"]'),
	).toHaveCount(1);
	await expect(input).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
	await expect(input).toBeFocused();
	await page.keyboard.press('Escape');
});
for (const modal of ['closed', 'palette', 'shortcuts'] as const) {
	test(`an async theme-save failure is announced once in the active layer with ${modal}`, async () => {
		const page = await app.firstWindow();
		await page.reload();
		type FailureMain = {
			themeSaveRequested?: boolean;
			failThemeSave?: () => void;
		};
		try {
			await app.evaluate(({ipcMain}) => {
				const state = globalThis as FailureMain;
				state.themeSaveRequested = false;
				state.failThemeSave = undefined;
				ipcMain.removeHandler('store:update-settings');
				ipcMain.handle(
					'store:update-settings',
					() =>
						new Promise(resolve => {
							state.themeSaveRequested = true;
							state.failThemeSave = () =>
								resolve({
									ok: false,
									error: {
										code: 'INTERNAL',
										message: 'fixture save failure',
										retryable: true,
									},
								});
						}),
				);
			});
			const trigger = page.getByRole('button', {name: 'command palette'});
			const notifications = page.locator('.toast-region');
			await expect(notifications).toHaveCount(2);
			const previousRegion = await notifications
				.nth(modal === 'closed' ? 1 : 0)
				.elementHandle();
			if (!previousRegion) throw new Error('Missing persistent notification');
			await trigger.click();
			await page
				.getByRole('combobox', {name: 'find a thread or action', exact: true})
				.fill('switch to light theme');
			await page.keyboard.press('Enter');
			await expect(page.locator('dialog[open]')).toHaveCount(0);
			await expect
				.poll(() =>
					app.evaluate(() => (globalThis as FailureMain).themeSaveRequested),
				)
				.toBe(true);
			if (modal !== 'closed') {
				await trigger.click();
				if (modal === 'shortcuts') {
					await page
						.getByRole('combobox', {
							name: 'find a thread or action',
							exact: true,
						})
						.fill('keyboard shortcuts');
					await page.keyboard.press('Enter');
				}
			}
			const focused =
				modal === 'closed'
					? trigger
					: modal === 'palette'
						? page.getByRole('combobox', {
								name: 'find a thread or action',
								exact: true,
							})
						: page.getByRole('button', {name: 'close keyboard shortcuts'});
			await expect(focused).toBeFocused();
			await app.evaluate(() => (globalThis as FailureMain).failThemeSave?.());
			const notification = page.getByRole('status', {name: 'notification'});
			const message = 'theme could not be saved. try again.';
			await expect(notification).toHaveText(message);
			await expect(notification).toHaveAttribute('aria-live', 'polite');
			await expect(page.getByText(message, {exact: true})).toHaveCount(1);
			await expect(page.getByRole('alert')).toHaveCount(0);
			await expect(
				page.locator('[aria-label="notification"][aria-live="polite"]'),
			).toHaveCount(1);
			expect(
				await notification.evaluate(
					(region, previous) => region === previous,
					previousRegion,
				),
			).toBe(true);
			expect(
				await notification.evaluate(
					region => region.closest('[inert], [aria-hidden="true"]') === null,
				),
			).toBe(true);
			if (modal !== 'closed') {
				expect(
					await notification.evaluate(region =>
						region.closest('dialog:modal')?.getAttribute('aria-label'),
					),
				).toBe(modal === 'palette' ? 'command palette' : 'keyboard shortcuts');
			}
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
			await expect(focused).toBeFocused();
			await previousRegion.dispose();
		} finally {
			await app.evaluate(() => (globalThis as FailureMain).failThemeSave?.());
			await page.keyboard.press('Escape');
		}
	});
}
