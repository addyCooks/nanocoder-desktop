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
import {commandModifier} from '@/renderer/overlay-model';
import type {DesktopApi} from '@/shared/desktop-api';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import {openFolderFromPalette, startFolderFromPalette} from './qa/open-folder';
import type {mountShellFixture} from './qa/shell-harness';
import {turnEnded} from './qa/turn-state';
import {visibleTextContrast} from './qa/ui-contrast';

const work = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nd-shell-')));
const cli = path.join(work, 'nanocoder/dist/cli.js');
let app: ElectronApplication;
let page: Page;

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

function project(name: string, mode = 'ok'): string {
	const folder = path.join(work, name);
	mkdirSync(folder);
	writeFileSync(path.join(folder, '.fake-nanocoder'), mode);
	return folder;
}

async function open(folder: string | null) {
	await app.evaluate(({dialog}, folder) => {
		dialog.showOpenDialog = (async () => ({
			canceled: folder === null,
			filePaths: folder ? [folder] : [],
		})) as typeof dialog.showOpenDialog;
	}, folder);
	if (!folder) return startFolderFromPalette(page);
	await openFolderFromPalette(page, folder);
	await expect(
		page.getByRole('textbox', {name: 'message', exact: true}),
	).toBeEnabled();
	if (folder) await expectConnectedAgent(folder);
}

async function expectConnectedAgent(text: string) {
	await page
		.getByRole('button', {name: 'runtime details', exact: true})
		.click();
	const setup = page.getByRole('dialog', {name: 'runtime details'});
	await expect(setup.locator('.runtime-rows')).toContainText(text);
	await page.keyboard.press('Escape');
	await expect(setup).toBeHidden();
}

test('ACP badge follows child exit, not unrelated provider failure, in both themes', async () => {
	for (const theme of ['dark', 'light']) {
		await page.emulateMedia({reducedMotion: 'reduce'});
		await page.evaluate(theme => {
			document.documentElement.dataset.theme = theme;
		}, theme);
		const folder = project(`exit-${theme}`, 'die-in-turn');
		await open(folder);
		await expect(page.locator('.footer-acp--success')).toBeVisible();
		await page.getByRole('textbox', {name: 'message'}).fill('fixture exit');
		await page.getByRole('button', {name: 'send', exact: true}).click();
		await expect(page.getByRole('alert')).toContainText(
			'Nanocoder stopped during the turn',
		);
		await expect(page.locator('.ui-badge--failed')).toBeVisible();
		await expect(page.locator('.footer-acp--error')).toContainText(
			'× acp · exited (3)',
		);
		await expect(page.locator('.ui-badge--success')).toHaveCount(0);
		await open(project(`provider-${theme}`, 'prompt-error'));
		await page
			.getByRole('textbox', {name: 'message'})
			.fill('fixture provider error');
		await page.getByRole('button', {name: 'send', exact: true}).click();
		await expect(page.getByRole('alert')).toContainText(
			'could not finish the turn',
		);
		await expect(page.locator('.ui-badge--failed')).toBeVisible();
		await expect(page.locator('.footer-acp--success')).toBeVisible();
		await expect(page.locator('.footer-acp--error')).toHaveCount(0);
		writeFileSync(path.join(folder, '.fake-nanocoder'), 'ok');
		await open(folder);
		await expect(page.locator('.footer-acp--success')).toBeVisible();
	}
});

test('ACP badge stays scoped when a picker is cancelled or another project stops', async () => {
	await page.evaluate(() => {
		const roots = new Map<string, string>();
		Object.assign(window, {shellProjectIds: roots});
		(window as unknown as {desktop: DesktopApi}).desktop.onProjectEvent(
			event => {
				if (event.type === 'supervisor' && event.state.agent)
					roots.set(event.state.agent.root, event.projectId);
			},
		);
	});
	const first = project('scoped-a');
	await open(first);
	await expect(page.locator('.footer-acp--success')).toBeVisible();
	await open(null);
	await expectConnectedAgent(first);
	await expect(page.locator('.footer-acp--success')).toBeVisible();
	const second = project('scoped-b');
	await open(second);
	const result = await page.evaluate(async root => {
		const projectId = (
			window as unknown as {shellProjectIds: Map<string, string>}
		).shellProjectIds.get(root);
		if (!projectId) throw new Error('Missing scoped project');
		return (window as unknown as {desktop: DesktopApi}).desktop.stopProject({
			projectId,
		});
	}, first);
	expect(result.ok).toBe(true);
	await expect(page.locator('.footer-acp--success')).toBeVisible();
	await expect(page.locator('.footer-acp--error')).toHaveCount(0);
});

test('ACP readiness is replayed on reopening after a renderer reload', async () => {
	const folder = project('replay');
	await open(folder);
	await expect(page.locator('.footer-acp--success')).toBeVisible();
	await page.reload();
	await expect(page.locator('.footer-acp--success')).toHaveCount(0);
	await open(folder);
	await expect(page.locator('.footer-acp--success')).toBeVisible();
});

test('the window will not shrink until the header clips, and a long project name stays out of the header actions (QA-04)', async () => {
	await open(project(`long-${'x'.repeat(120)}`));
	try {
		await app.evaluate(({BrowserWindow}) => {
			BrowserWindow.getAllWindows()[0].setContentSize(320, 700);
		});
		await expect
			.poll(() =>
				page.evaluate(() => {
					const actions = document
						.querySelector('.shell-header-actions')
						?.getBoundingClientRect();
					const name = document.querySelector('.shell-breadcrumb');
					const identity = document.querySelector('.shell-identity');
					if (!actions || !name || !identity)
						throw new Error('Missing header region');
					return {
						narrow: innerWidth < 700,
						actionsFit: actions.right <= innerWidth,
						// A name too long for its line must be clipped, not painted over the actions.
						nameContained:
							name.scrollWidth <= name.clientWidth ||
							getComputedStyle(name).overflowX !== 'visible',
						// The title row keeps room for its title and menu, on its own line if need be.
						identityRoomy: identity.getBoundingClientRect().width >= 176,
						identityClear: [...identity.children].every(part => {
							const box = part.getBoundingClientRect();
							return (
								box.right <= actions.left ||
								box.left >= actions.right ||
								box.bottom <= actions.top ||
								box.top >= actions.bottom
							);
						}),
					};
				}),
			)
			.toEqual({
				narrow: true,
				actionsFit: true,
				nameContained: true,
				identityRoomy: true,
				identityClear: true,
			});
	} finally {
		await app.evaluate(({BrowserWindow}) => {
			BrowserWindow.getAllWindows()[0].setContentSize(1240, 900);
		});
	}
});

test('shell geometry and pinned composer follow all three widths without an empty inspector', async () => {
	await open(project('layout'));
	const stream = page.locator('main.shell-stream');
	await expect(stream).toHaveAttribute('data-composer-placement', 'centred');
	await page.getByRole('textbox', {name: 'message'}).fill('check the layout');
	await page.getByRole('button', {name: 'send', exact: true}).click();
	const allow = page.getByRole('button', {name: 'Allow', exact: true});
	await expect(allow).toBeVisible();
	await allow.click();
	await expect(turnEnded(page)).toBeVisible();
	await expect(stream).toHaveAttribute('data-composer-placement', 'bottom');
	await page.emulateMedia({reducedMotion: 'reduce'});
	const platform = await page.evaluate(() => navigator.platform);
	await expect(
		page.locator('.shell-header-actions > button:last-child kbd'),
	).toHaveText(`${commandModifier(platform)}K`);
	await page.evaluate(() => {
		const fixture = document.createElement('div');
		fixture.id = 'shell-layout-fixture';
		fixture.style.height = '2000px';
		document.querySelector('.technical-gate')?.append(fixture);
	});
	try {
		for (const theme of ['dark', 'light']) {
			await page.evaluate(theme => {
				document.documentElement.dataset.theme = theme;
			}, theme);
			for (const width of [1240, 1050, 1020, 840, 841, 839]) {
				await page.setViewportSize({width, height: 900});
				await expect(page.locator('.shell-workbench')).toHaveCount(0);
				const geometry = await page.evaluate(() => {
					const measure = (selector: string) => {
						const element = document.querySelector(selector);
						if (!element) throw new Error('Missing shell region');
						const rect = element.getBoundingClientRect();
						return {
							x: rect.x,
							y: rect.y,
							width: rect.width,
							height: rect.height,
							bottom: rect.bottom,
						};
					};
					const padding = (selector: string) => {
						const element = document.querySelector(selector);
						if (!element) throw new Error('Missing shell region');
						const style = getComputedStyle(element);
						return [style.paddingLeft, style.paddingRight];
					};
					const scroll = document.querySelector('.shell-stream-scroll');
					if (!scroll) throw new Error('Missing stream scroll region');
					const firstRow = document.querySelector(
						'.technical-gate > :first-child',
					);
					const readingOffset =
						(firstRow?.getBoundingClientRect().top ?? 0) -
						scroll.getBoundingClientRect().top +
						scroll.scrollTop;
					const chrome = (selector: string) => {
						const element = document.querySelector(selector);
						if (!element) throw new Error('Missing shell region');
						const style = getComputedStyle(element);
						return [
							'padding-left',
							'padding-right',
							'border-left-width',
							'border-right-width',
						].reduce(
							(sum, property) =>
								sum + Number.parseFloat(style.getPropertyValue(property)),
							0,
						);
					};
					const tools =
						document.querySelector('.shell-stream-tools')?.childElementCount ??
						0;
					scroll.scrollTop = scroll.scrollHeight;
					const fixtureBottom =
						document
							.getElementById('shell-layout-fixture')
							?.getBoundingClientRect().bottom ?? 0;
					return {
						readingOffset,
						bottomGap: scroll.getBoundingClientRect().bottom - fixtureBottom,
						tools,
						rail: measure('.shell-project-rail'),
						stream: measure('.shell-stream'),
						composer: measure('.composer-options'),
						header: measure('.shell-title-bar'),
						breadcrumb: measure('.shell-breadcrumb'),
						title: measure('.shell-identity h2'),
						palette: measure('.shell-header-actions > button:last-child'),
						paletteHint: measure(
							'.shell-header-actions > button:last-child kbd',
						).width,
						paletteChrome: chrome('.shell-header-actions > button:last-child'),
						reading: measure('.technical-gate'),
						scrollPadding: padding('.shell-stream-scroll'),
						footerPadding: padding('.shell-conversation-footer'),
						composerGap:
							(document
								.querySelector('.shell-composer')
								?.getBoundingClientRect().top ?? 0) -
							scroll.getBoundingClientRect().bottom,
						scrolls: scroll.scrollHeight > scroll.clientHeight,
						overflows: document.documentElement.scrollWidth > innerWidth,
					};
				});
				const railWidth = width <= 840 ? 212 : width <= 1050 ? 232 : 260;
				expect(geometry.rail.width).toBe(railWidth);
				expect(geometry.stream.x).toBe(railWidth);
				expect(geometry.stream.width).toBe(width - railWidth);
				expect(geometry.composer.bottom).toBe(
					width <= 840 ? 883 : width <= 1050 ? 882 : 880,
				);
				expect(geometry.header.height).toBe(52);
				expect(geometry.breadcrumb.y).toBeCloseTo(15.5, 1);
				expect(geometry.title.y).toBeCloseTo(13.5, 1);
				expect(geometry.palette.width).toBeCloseTo(
					geometry.paletteChrome + geometry.paletteHint,
					0,
				);
				if (width >= 1050) expect(geometry.reading.width).toBeCloseTo(740, 0);
				else expect(geometry.reading.width).toBeLessThanOrEqual(740);
				if (geometry.tools === 0)
					expect(geometry.readingOffset).toBeCloseTo(
						width <= 840 ? 15 : width <= 1050 ? 17 : 20,
						0,
					);
				expect(geometry.bottomGap).toBeCloseTo(24, 0);
				expect(geometry.composerGap).toBeCloseTo(0, 1);
				const reading = width <= 840 ? '24px' : width <= 1050 ? '30px' : '40px';
				const column = width <= 840 ? '27px' : reading;
				expect(geometry.scrollPadding).toEqual([column, column]);
				expect(geometry.footerPadding).toEqual([reading, reading]);
				if (width <= 840)
					expect(geometry.reading.x - geometry.stream.x).toBeCloseTo(27, 0);
				expect(geometry.scrolls).toBe(true);
				expect(geometry.overflows).toBe(false);
				expect(await visibleTextContrast(page, theme)).toEqual([]);
			}
		}
	} finally {
		await page.evaluate(() =>
			document.getElementById('shell-layout-fixture')?.remove(),
		);
	}
});

test('the compact shell exposes real controls and omits unused later surfaces', async () => {
	await page.setViewportSize({width: 1240, height: 900});
	await expect(page.getByRole('banner')).not.toContainText('not built yet');
	const crumb = page.locator('.shell-breadcrumb');
	await expect(crumb).toHaveCSS('line-height', '20px');
	expect((await crumb.boundingBox())?.height).toBeCloseTo(20, 0);
	await expect(
		page.getByRole('banner').getByRole('button', {name: 'command palette'}),
	).toBeVisible();
	const threads = page.getByRole('region', {name: 'project threads'});
	await expect(
		threads.getByRole('button', {name: 'new thread', exact: true}),
	).toBeEnabled();
	await expect(
		threads.locator('.thread-open[aria-current="true"]'),
	).toHaveCount(1);
	await expect(
		page.locator('.shell-workbench,.shell-bottom-panel,.shell-placeholder'),
	).toHaveCount(0);
	const switcher = page.getByRole('button', {
		name: 'switch project',
		exact: true,
	});
	const projects = page.getByRole('dialog', {name: 'your projects'});
	await switcher.click();
	await expect(
		projects.getByRole('region', {name: 'recent projects'}),
	).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(projects).toBeHidden();
});
test('keyboard controls remain reachable and visibly focused inside the stream in both themes and all widths', async () => {
	for (const theme of ['dark', 'light']) {
		await page.evaluate(theme => {
			document.documentElement.dataset.theme = theme;
		}, theme);
		for (const width of [1240, 1020, 840]) {
			await page.setViewportSize({width, height: 900});
			const input = page.getByRole('textbox', {name: 'message'});
			const palette = page.getByRole('button', {
				name: 'command palette',
				exact: true,
			});
			await palette.focus();
			await page.keyboard.press('Tab');
			await page.keyboard.press('Shift+Tab');
			await expect(palette).toBeFocused();
			await expect(palette).toHaveCSS('outline-width', '2px');
			const switcher = page.getByRole('button', {
				name: 'switch project',
				exact: true,
			});
			const projects = page.getByRole('dialog', {name: 'your projects'});
			await switcher.focus();
			await page.keyboard.press('Enter');
			await expect(projects).toBeVisible();
			const rows = projects
				.getByRole('region', {name: 'recent projects'})
				.getByRole('listitem');
			await expect(rows.first()).toBeVisible();
			const dialogOrder = [
				projects.getByRole('button', {name: 'dismiss dialog', exact: true}),
				...(await rows.all()).map(row => row.locator('button')),
				projects.getByRole('button', {name: /add project folder/}),
			];
			await dialogOrder[0].focus();
			for (const [index, control] of dialogOrder.entries()) {
				if (index > 0) await page.keyboard.press('Tab');
				await expect(control).toBeFocused();
				await expect(control).toHaveCSS('outline-width', '2px');
			}
			await page.keyboard.press('Escape');
			await expect(projects).toBeHidden();
			await expect(switcher).toBeFocused();
			const rail = page.getByRole('region', {name: 'project threads'});
			const send = page.getByRole('button', {name: 'send', exact: true});
			const stream = page.getByRole('region', {
				name: 'conversation',
				exact: true,
			});
			await expect(
				rail.locator('.sidebar-link', {hasText: 'import sessions'}),
			).toBeVisible();
			const mode = page.getByRole('combobox', {
				name: 'mode for this thread',
				exact: true,
			});
			const focusOrder = [
				switcher,
				rail.getByRole('button', {name: 'new thread', exact: true}),
				...(await rail.locator('.thread-open').all()),
				rail.locator('.sidebar-link', {hasText: 'archived'}),
				rail.locator('.sidebar-link', {hasText: 'import sessions'}),
				page.getByRole('button', {name: 'runtime details', exact: true}),
				page.getByRole('button', {name: 'keyboard shortcuts', exact: true}),
				page.getByRole('button', {name: 'thread actions', exact: true}),
				page.getByRole('button', {name: 'open project files', exact: true}),
				page.getByRole('button', {name: 'open browser', exact: true}),
				page.getByRole('button', {name: 'open terminal', exact: true}),
				page.getByRole('button', {name: /^switch to (light|dark) theme$/}),
				palette,
				stream,
				...(await stream
					.getByRole('button', {name: 'copy text', exact: true})
					.all()),
				input,
				mode,
				page.getByRole('button', {
					name: 'mode and project default details',
					exact: true,
				}),
				send,
			];
			await expect(stream).toHaveAccessibleName('conversation');
			await focusOrder[0].focus();
			for (const [index, control] of focusOrder.entries()) {
				if (index > 0) await page.keyboard.press('Tab');
				if (control === input) {
					const latest = page.getByRole('button', {
						name: 'latest',
						exact: true,
					});
					if (
						await latest.evaluateAll(elements =>
							elements.some(element => element === document.activeElement),
						)
					) {
						await expect(latest).toHaveCSS('outline-width', '2px');
						await page.keyboard.press('Tab');
					}
				}
				await expect(control).toBeFocused();
				if (control === input) {
					await expect(input).toHaveCSS('outline-style', 'none');
				} else {
					await expect(control).toHaveCSS('outline-width', '2px');
				}
				if (control === input) {
					await expect(page.locator('.gate-composer')).toHaveCSS(
						'border-color',
						theme === 'dark' ? 'rgb(122, 162, 247)' : 'rgb(0, 0, 238)',
					);
					await input.fill('fixture keyboard check');
				}
			}
			const atEnd = () =>
				stream.evaluate(
					element =>
						element.scrollHeight - element.scrollTop - element.clientHeight <=
						2,
				);
			const latest = page.getByRole('button', {name: 'latest', exact: true});
			if (await latest.count()) await latest.click();
			await expect.poll(atEnd).toBe(true);
			await page.keyboard.press('Enter');
			const permission = page.getByRole('region', {name: 'permission request'});
			const allow = permission.getByRole('button', {
				name: 'Allow',
				exact: true,
			});
			const deny = permission.getByRole('button', {name: 'Deny', exact: true});
			await expect(allow).toBeVisible();
			await expect.poll(atEnd).toBe(true);
			await allow.focus();
			await page.keyboard.press('Tab');
			await expect(deny).toBeFocused();
			await expect(deny).toHaveCSS('outline-width', '2px');
			await page.keyboard.press('Enter');
			await expect(permission).toHaveCount(0);
			await expect(turnEnded(page)).toBeVisible();
			await expect(page.locator('.footer-acp--success')).toBeVisible();
		}
	}
});

test('the mounted workbench takes the narrow canvas and returns to the same chat draft', async () => {
	page.setDefaultTimeout(5000);
	const fixtureErrors: string[] = [];
	page.on('pageerror', error => fixtureErrors.push(error.message));
	const result = await build({
		configFile: false,
		logLevel: 'silent',
		define: {'process.env.NODE_ENV': JSON.stringify('production')},
		resolve: {alias: {'@': path.resolve('source')}},
		build: {
			write: false,
			minify: false,
			lib: {
				entry: path.resolve('e2e/qa/shell-harness.ts'),
				name: 'shellFixture',
				formats: ['iife'],
			},
		},
	});
	const outputs = Array.isArray(result) ? result : [result];
	const code = outputs
		.flatMap(output => ('output' in output ? output.output : []))
		.filter(chunk => chunk.type === 'chunk')
		.map(chunk => chunk.code)
		.join('\n');
	await page.evaluate(code);
	await page.evaluate(() => {
		const state = window as unknown as {
			shellFixture: {mountShellFixture: typeof mountShellFixture};
			unmountShell: () => void;
		};
		state.unmountShell = state.shellFixture.mountShellFixture();
	});
	try {
		for (const theme of ['dark', 'light']) {
			await page.evaluate(theme => {
				document.documentElement.dataset.theme = theme;
			}, theme);
			expect(
				await page.getByRole('button', {name: 'open fixture panel'}).count(),
				fixtureErrors.join('\n'),
			).toBe(1);
			for (const width of [1240, 1020, 841, 840, 839]) {
				await page.setViewportSize({width, height: 900});
				const typedDraft = `typed ${theme} ${width} draft`;
				await page
					.getByRole('textbox', {name: 'fixture draft'})
					.fill(typedDraft);
				const opener = page.getByRole('button', {name: 'open fixture panel'});
				await opener.focus();
				await page.keyboard.press('Enter');
				const panel = page.getByRole('complementary', {
					name: 'fixture workbench',
				});
				await expect(panel).toBeVisible();
				const chat = page.getByRole('main', {name: 'conversation workspace'});
				const draft = page.getByRole('textbox', {
					name: 'fixture draft',
					includeHidden: true,
				});
				await expect(draft).toHaveValue(typedDraft);
				if (width <= 840) {
					await expect(chat).toBeHidden();
					const railWidth = 212;
					expect((await panel.boundingBox())?.width).toBe(width - railWidth);
				} else await expect(chat).toBeVisible();
				const close = panel.getByRole('button', {
					name: width <= 840 ? 'back to chat' : 'close panel',
					exact: true,
				});
				await close.focus();
				await expect(close).toHaveCSS('outline-width', '2px');
				await page.keyboard.press('Enter');
				await expect(panel).toHaveCount(0);
				await expect(opener).toBeFocused();
				await expect(chat).toBeVisible();
				await expect(draft).toHaveValue(typedDraft);
				expect(await visibleTextContrast(page, theme)).toEqual([]);
			}
		}
	} finally {
		await page.evaluate(() =>
			(window as unknown as {unmountShell(): void}).unmountShell(),
		);
	}
});
