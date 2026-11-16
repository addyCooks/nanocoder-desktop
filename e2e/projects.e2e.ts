import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
	type ElectronApplication,
	expect,
	type Locator,
	type Page,
	test,
} from '@playwright/test';
import {build} from 'vite';
import {shortRoot} from '@/renderer/recency';
import type {DesktopApi} from '@/shared/desktop-api';
import {
	CHANNELS,
	type IpcResult,
	type ProjectEvent,
	type WorkspaceMethod,
	type WorkspaceRequests,
	type WorkspaceValues,
} from '@/shared/ipc';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import type {projectHydrationHarness} from './qa/project-hydration-harness';
import {openSeededProject} from './qa/seeded-project';
import {visibleTextContrast} from './qa/ui-contrast';

let work: string;
let app: ElectronApplication;
let page: Page;
let hydrationCode: Promise<string> | undefined;

interface HydrationWindow extends Window {
	projectHydrationFixture: {
		projectHydrationHarness: typeof projectHydrationHarness;
	};
}

function hydrationFixtureCode(): Promise<string> {
	hydrationCode ??= build({
		configFile: false,
		logLevel: 'silent',
		define: {
			'process.env.NODE_ENV': JSON.stringify('production'),
			'window.desktop': 'window.projectHydrationBridge',
		},
		resolve: {alias: {'@': path.resolve(import.meta.dirname, '../source')}},
		build: {
			write: false,
			minify: false,
			lib: {
				entry: path.join(
					import.meta.dirname,
					'qa/project-hydration-harness.ts',
				),
				name: 'projectHydrationFixture',
				formats: ['iife'],
			},
		},
	}).then(result => {
		const outputs = Array.isArray(result) ? result : [result];
		const code = outputs
			.flatMap(output => ('output' in output ? output.output : []))
			.filter(chunk => chunk.type === 'chunk')
			.map(chunk => chunk.code)
			.join('\n');
		if (!code) throw new Error('Missing project hydration fixture');
		return code;
	});
	return hydrationCode;
}

async function mountHydrationFixture(code: string, controlled: boolean) {
	await page.evaluate(code);
	await page.evaluate(controlled => {
		(
			window as unknown as HydrationWindow
		).projectHydrationFixture.projectHydrationHarness.mount(controlled);
	}, controlled);
}

async function launch() {
	app = await electron.launch({
		args: ['.', `--user-data-dir=${path.join(work, 'profile')}`],
		env: qaEnvironment(process.env, {
			cliPath: path.join(work, 'nanocoder/dist/cli.js'),
			nodePath: process.execPath,
		}),
	});
	page = await app.firstWindow();
}

test.beforeEach(async () => {
	work = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-project-e2e-')),
	);
	mkdirSync(path.join(work, 'nanocoder/dist'), {recursive: true});
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
		path.resolve(
			import.meta.dirname,
			'../source/main/nanocoder/fixtures/fake-nanocoder.mjs',
		),
		path.join(work, 'nanocoder/dist/cli.js'),
	);
	await launch();
});

test.afterEach(async () => {
	await app.close();
	rmSync(work, {recursive: true, force: true});
});

function call<K extends WorkspaceMethod>(
	method: K,
	request: WorkspaceRequests[K],
): Promise<IpcResult<WorkspaceValues[K]>> {
	return page.evaluate(
		({method, request}) => {
			const api = (window as unknown as {desktop: DesktopApi}).desktop;
			return (api[method] as (request: unknown) => Promise<unknown>)(request);
		},
		{method, request},
	) as Promise<IpcResult<WorkspaceValues[K]>>;
}

async function picker(folder?: string, response = 1) {
	await app.evaluate(
		({dialog}, {folder, response}) => {
			const state = globalThis as {
				projectPrompts?: unknown[];
				projectPickerCalls?: number;
			};
			state.projectPrompts = [];
			state.projectPickerCalls = 0;
			dialog.showOpenDialog = (async () => {
				state.projectPickerCalls = (state.projectPickerCalls ?? 0) + 1;
				return {canceled: !folder, filePaths: folder ? [folder] : []};
			}) as typeof dialog.showOpenDialog;
			dialog.showMessageBox = (async (...args: unknown[]) => {
				(globalThis as {projectPrompts?: unknown[]}).projectPrompts?.push(
					args.at(-1),
				);
				return {response, checkboxChecked: false};
			}) as typeof dialog.showMessageBox;
		},
		{folder, response},
	);
}

async function add(root: string) {
	await picker(root);
	const result = await call('addProject', {});
	expect(result).toMatchObject({ok: true, value: {status: 'selected'}});
	if (!result.ok || result.value.status !== 'selected')
		throw new Error('Expected a selected project');
	return result.value.project;
}

test('direct bridge additions refresh empty recents without reload or project activation (CHAT-01)', async () => {
	const runtime = await openRuntimeDetails();
	await expect(runtime).toContainText('9.9.9');
	await expect(runtime).toContainText(path.join(work, 'nanocoder/dist/cli.js'));
	await closeDialog(runtime);
	await showProjects();
	const recent = projectsRecent();
	await expect(recent).toContainText('no recent projects');
	expect(await call('listProjects', {})).toEqual({ok: true, value: []});
	const root = path.join(work, 'project');
	mkdirSync(root);
	const project = await add(root);
	await expect(
		recent.getByRole('button', {name: 'open project', exact: true}),
	).toBeEnabled();
	await expect(recent.locator('.projects-dialog-meta')).toHaveText(root);
	await expect(recent).not.toContainText('no recent projects');
	await expect(page.locator('.project-switch-root')).toHaveText(
		'open a local folder',
	);
	expect(await call('getUiState', {})).toMatchObject({
		ok: true,
		value: {activeProjectId: null},
	});
	expect(
		await call('getSupervisorState', {projectId: project.id}),
	).toMatchObject({ok: true, value: {status: 'stopped', agent: null}});
	expect(
		await call('listThreads', {projectId: project.id, archiveState: 'active'}),
	).toEqual({
		ok: true,
		value: [],
	});
	expect(await call('openProject', {projectId: project.id})).toMatchObject({
		ok: true,
		value: {status: 'opened'},
	});
	await expect(page.locator('.project-switch-root')).toHaveText(root);
	await showProjects();
	const otherRoot = path.join(work, 'other');
	mkdirSync(otherRoot);
	const other = await add(otherRoot);
	await expect(
		recent.getByRole('button', {name: 'open other', exact: true}),
	).toBeEnabled();
	await expect(recent.locator('.projects-dialog-meta')).toHaveText([
		otherRoot,
		`${root} · selected`,
	]);
	await expect(page.locator('.project-switch-root')).toHaveText(root);
	expect(await call('getUiState', {})).toMatchObject({
		ok: true,
		value: {activeProjectId: project.id},
	});
	expect(await call('getSupervisorState', {projectId: other.id})).toMatchObject(
		{ok: true, value: {status: 'stopped', agent: null}},
	);
	expect(
		await call('listThreads', {projectId: other.id, archiveState: 'active'}),
	).toEqual({
		ok: true,
		value: [],
	});
});

test('preload refuses malformed and unknown project-list notifications without exposing Electron events', async () => {
	await page.evaluate(() => {
		const state = window as unknown as {
			desktop: DesktopApi;
			recentsEvents: unknown[][];
			stopRecentsEvents: () => void;
		};
		state.recentsEvents = [];
		state.stopRecentsEvents = state.desktop.onProjectEvent((...args) => {
			state.recentsEvents.push(args);
		});
	});
	const valid: ProjectEvent = {
		type: 'projects-changed',
		projectId: '11111111-1111-4111-8111-111111111111',
		sequence: 1,
	};
	await app.evaluate(
		({BrowserWindow}, {channel, events}) => {
			for (const event of events)
				BrowserWindow.getAllWindows()[0].webContents.send(channel, event);
		},
		{
			channel: CHANNELS.projectEvent,
			events: [
				{...valid, canonicalRoot: '/not-exposed'},
				{...valid, sequence: 0},
				{...valid, projectId: 'not-an-id'},
				{...valid, type: 'unknown'},
				valid,
			],
		},
	);
	await call('getUiState', {});
	expect(
		await page.evaluate(
			() => (window as unknown as {recentsEvents: unknown[][]}).recentsEvents,
		),
	).toEqual([[valid]]);
	await expect(page.locator('.project-switch-root')).toHaveText(
		'open a local folder',
	);
	await page.evaluate(() =>
		(window as unknown as {stopRecentsEvents: () => void}).stopRecentsEvents(),
	);
});

test('a canonical non-Git project selected in main remains in recents after restart (CHAT-01)', async () => {
	const root = path.join(work, 'project');
	mkdirSync(root);
	const link = path.join(work, 'alias');
	symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
	const project = await add(link);
	expect(project).toMatchObject({
		canonicalRoot: root,
		sessionCwd: root,
		displayName: 'project',
		trusted: false,
		defaultMode: 'normal',
	});
	await app.close();
	await launch();
	expect(await call('listProjects', {})).toMatchObject({
		ok: true,
		value: [project],
	});
});

test('workspace opening uses the native execution summary before granting trust (DEC-30)', async () => {
	const root = path.join(work, 'project');
	mkdirSync(path.join(root, '.nanocoder/plugins'), {recursive: true});
	writeFileSync(path.join(root, '.fake-nanocoder'), 'untrusted');
	writeFileSync(
		path.join(root, '.nanocoder/plugins/example.mjs'),
		'throw new Error("must not execute in desktop");',
	);
	const project = await add(root);
	await picker(root, 0);
	expect(await call('openProject', {projectId: project.id})).toMatchObject({
		ok: true,
		value: {
			status: 'opened',
			project: {trusted: true},
			supervisor: {status: 'ready', activeThreadId: null},
		},
	});
	const prompts = await app.evaluate(
		() =>
			(
				globalThis as {
					projectPrompts?: Array<{detail?: string; defaultId?: number}>;
				}
			).projectPrompts ?? [],
	);
	expect(prompts).toHaveLength(1);
	expect(prompts[0].detail).toContain(root);
	expect(prompts[0].detail).toContain('plugins: 1');
	expect(prompts[0].defaultId).toBe(1);
	expect(existsSync(path.join(root, '.fake-trusted'))).toBe(true);
});

test('native refusal leaves the project untrusted and renderer start remains denied (SEC-17)', async () => {
	const root = path.join(work, 'project');
	mkdirSync(root);
	writeFileSync(path.join(root, '.fake-nanocoder'), 'untrusted');
	const project = await add(root);
	expect(await call('openProject', {projectId: project.id})).toMatchObject({
		ok: true,
		value: {status: 'untrusted'},
	});
	expect(await call('listProjects', {})).toMatchObject({
		ok: true,
		value: [{trusted: false}],
	});
	expect(await call('startProject', {projectId: project.id})).toMatchObject({
		ok: false,
		error: {code: 'DENIED'},
	});
	expect(existsSync(path.join(root, '.fake-trusted'))).toBe(false);
});

test('locating a moved project preserves its id and requires fresh trust (CHAT-01)', async () => {
	const root = path.join(work, 'project');
	mkdirSync(root);
	const project = await add(root);
	const moved = path.join(work, 'moved');
	renameSync(root, moved);
	expect(await call('listProjects', {})).toMatchObject({
		ok: true,
		value: [{availability: 'missing'}],
	});
	await picker(moved);
	expect(await call('locateProject', {projectId: project.id})).toMatchObject({
		ok: true,
		value: {
			status: 'selected',
			project: {
				id: project.id,
				canonicalRoot: moved,
				sessionCwd: moved,
				trusted: false,
			},
		},
	});
});

test('the existing folder action also records a recent project (CHAT-02)', async () => {
	const root = path.join(work, 'project');
	mkdirSync(root);
	await picker(root);
	const result = await page.evaluate(() =>
		(window as unknown as {desktop: DesktopApi}).desktop.connectNanocoder(),
	);
	expect(result).toMatchObject({ok: true, value: {status: 'connected'}});
	expect(await call('listProjects', {})).toMatchObject({
		ok: true,
		value: [{canonicalRoot: root, trusted: true}],
	});
});

test('workspace and existing folder actions reuse the same canonical project process (CHAT-01)', async () => {
	const root = path.join(work, 'project');
	mkdirSync(root);
	const project = await add(root);
	expect(await call('openProject', {projectId: project.id})).toMatchObject({
		ok: true,
		value: {status: 'opened'},
	});
	await picker(root);
	expect(
		await page.evaluate(() =>
			(window as unknown as {desktop: DesktopApi}).desktop.connectNanocoder(),
		),
	).toMatchObject({ok: true, value: {status: 'connected'}});
	expect(await call('listProjects', {})).toMatchObject({
		ok: true,
		value: [{id: project.id, canonicalRoot: root}],
	});
});

function projectsDialog() {
	return page.getByRole('dialog', {name: 'your projects'});
}

function projectsRecent() {
	return projectsDialog().getByRole('region', {name: 'recent projects'});
}

async function showProjects() {
	const dialog = projectsDialog();
	if (!(await dialog.isVisible()))
		await page
			.getByRole('button', {name: 'switch project', exact: true})
			.click();
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByText('waiting for the project request or native dialog'),
	).toHaveCount(0);
}

async function openRuntimeDetails() {
	await page
		.getByRole('button', {name: 'runtime details', exact: true})
		.click();
	const dialog = page.getByRole('dialog', {name: 'runtime details'});
	await expect(dialog).toBeVisible();
	return dialog;
}

async function closeDialog(dialog: Locator) {
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
}

for (const ordering of ['initial empty', 'delayed empty'] as const) {
	test(`recents stay coherent after ${ordering} hydration and the seeded helper opens a closed compact switcher`, async () => {
		const code = await hydrationFixtureCode();
		await mountHydrationFixture(code, true);
		await page.evaluate(() =>
			(
				window as unknown as HydrationWindow
			).projectHydrationFixture.projectHydrationHarness.waitForEmptyRead(),
		);
		if (ordering === 'initial empty') {
			await page.evaluate(() =>
				(
					window as unknown as HydrationWindow
				).projectHydrationFixture.projectHydrationHarness.releaseEmpty(),
			);
		}
		const root = path.join(work, 'project');
		mkdirSync(root);
		writeFileSync(path.join(root, '.fake-nanocoder'), 'untrusted');
		const project = await add(root);
		await picker(root, 0);
		expect(await call('openProject', {projectId: project.id})).toMatchObject({
			ok: true,
			value: {status: 'opened'},
		});
		const recent = projectsRecent();
		const assertCoherent = async () => {
			expect(await call('listProjects', {})).toMatchObject({
				ok: true,
				value: [{id: project.id, canonicalRoot: root}],
			});
			expect(await call('getUiState', {})).toMatchObject({
				ok: true,
				value: {activeProjectId: project.id},
			});
			expect(
				await call('getSupervisorState', {projectId: project.id}),
			).toMatchObject({ok: true, value: {status: 'ready'}});
			await expect(page.locator('.project-switch-root')).toHaveText(root);
			await showProjects();
			await expect(recent.locator('.projects-dialog-item')).toHaveCount(1);
			await expect(recent.locator('.projects-dialog-row')).toHaveAttribute(
				'aria-current',
				'true',
			);
			await expect(recent.locator('.projects-dialog-root')).toHaveText(root);
			await expect(
				recent.getByRole('button', {name: 'open project', exact: true}),
			).toBeEnabled();
			await expect(recent).not.toContainText('no recent projects');
		};
		await assertCoherent();
		if (ordering === 'delayed empty') {
			await page.evaluate(() =>
				(
					window as unknown as HydrationWindow
				).projectHydrationFixture.projectHydrationHarness.releaseEmpty(
					'settled',
				),
			);
			await assertCoherent();
		}
		await openSeededProject(page, root, async () => {
			await page.reload();
			await mountHydrationFixture(code, false);
			await expect(page.locator('.project-switch-root')).toHaveText(root);
			await expect(projectsDialog()).toBeHidden();
		});
		expect(
			await app.evaluate(
				() => (globalThis as {projectPickerCalls?: number}).projectPickerCalls,
			),
		).toBe(0);
	});
}

test('a recent-project action opens by id without reopening the folder picker (CHAT-02)', async () => {
	const root = path.join(work, 'project');
	mkdirSync(root);
	writeFileSync(path.join(root, '.fake-nanocoder'), 'untrusted');
	const project = await add(root);
	await picker(root, 0);
	await page.reload();
	await showProjects();
	const recent = projectsRecent();
	await expect(recent).toBeVisible();
	await showProjects();
	await recent.getByRole('button', {name: 'open project', exact: true}).click();
	await expect(page.getByLabel('project trust feedback')).toContainText(
		'project ready',
	);
	expect(
		await app.evaluate(
			() => (globalThis as {projectPickerCalls?: number}).projectPickerCalls,
		),
	).toBe(0);
	expect(await call('listProjects', {})).toMatchObject({
		ok: true,
		value: [{id: project.id, trusted: true}],
	});
});

test('missing recent folders explain why they cannot open and offer locate (CHAT-01)', async () => {
	const root = path.join(work, 'project');
	mkdirSync(root);
	const project = await add(root);
	const moved = path.join(work, 'moved');
	renameSync(root, moved);
	await picker(moved);
	await page.reload();
	await showProjects();
	const recent = projectsRecent();
	await showProjects();
	await expect(
		recent.getByRole('button', {name: 'open project', exact: true}),
	).toHaveCount(0);
	await expect(recent.locator('.projects-dialog-meta')).toHaveText(
		`${root} · folder missing`,
	);
	await showProjects();
	await recent
		.getByRole('button', {name: 'locate project', exact: true})
		.click();
	await showProjects();
	await expect(
		recent.getByRole('button', {name: 'open moved', exact: true}),
	).toBeEnabled();
	expect(await call('listProjects', {})).toMatchObject({
		ok: true,
		value: [{id: project.id, canonicalRoot: moved}],
	});
});

test('cancelling the recent-project picker leaves the list unchanged and reports cancellation (CHAT-01)', async () => {
	await picker();
	await showProjects();
	const recent = projectsRecent();
	await expect(recent).toBeVisible();
	await showProjects();
	await projectsDialog()
		.getByRole('button', {name: /add project folder/})
		.click();
	await expect(page.getByLabel('project trust feedback')).toContainText(
		'no folder selected',
	);
	expect(await call('listProjects', {})).toMatchObject({ok: true, value: []});
});

test('a direct supervisor trust refusal revokes the previously recorded desktop trust (SEC-17)', async () => {
	const root = path.join(work, 'project');
	mkdirSync(root);
	writeFileSync(path.join(root, '.fake-nanocoder'), 'untrusted');
	const project = await add(root);
	await picker(root, 0);
	expect(await call('openProject', {projectId: project.id})).toMatchObject({
		ok: true,
		value: {status: 'opened'},
	});
	await call('stopProject', {projectId: project.id});
	rmSync(path.join(root, '.fake-trusted'));
	await picker(root, 1);
	expect(await call('startProject', {projectId: project.id})).toMatchObject({
		ok: true,
		value: {status: 'untrusted'},
	});
	expect(await call('listProjects', {})).toMatchObject({
		ok: true,
		value: [{trusted: false}],
	});
});

test('opening a recent project exposes only its own thread and restores each project draft on return (CHAT-02, CHAT-03)', async () => {
	const first = path.join(work, 'first-project');
	const second = path.join(work, 'second-project');
	mkdirSync(first);
	mkdirSync(second);
	await add(first);
	await add(second);
	await picker(first);
	await page
		.getByRole('button', {name: 'open a project folder', exact: true})
		.click();
	await expect(page.getByRole('textbox', {name: 'message'})).toBeVisible();
	const input = page.getByRole('textbox', {name: 'message'});
	await input.fill('first project private draft');
	const selected = page.locator('.thread-row[data-selected="true"]');
	const firstThreadId = await selected.getAttribute('data-thread-id');
	expect(firstThreadId).not.toBeNull();
	if (!firstThreadId) throw new Error('Expected the first selected thread');
	await showProjects();
	const recent = projectsRecent();
	await showProjects();
	await recent
		.getByRole('button', {name: 'open second-project', exact: true})
		.click();
	await expect(page.getByLabel('project trust feedback')).toContainText(
		'project ready: second-project',
	);
	await expect(input).toBeEnabled();
	await expect(input).toHaveValue('');
	await expect(selected).not.toHaveAttribute('data-thread-id', firstThreadId);
	const secondRuntime = await openRuntimeDetails();
	await expect(secondRuntime.locator('.runtime-rows')).toContainText(second);
	await closeDialog(secondRuntime);
	await input.fill('second project private draft');
	await showProjects();
	await recent
		.getByRole('button', {name: 'open first-project', exact: true})
		.click();
	await expect(input).toHaveValue('first project private draft');
	await expect(selected).toHaveAttribute('data-thread-id', firstThreadId);
	const firstRuntime = await openRuntimeDetails();
	await expect(firstRuntime.locator('.runtime-rows')).toContainText(first);
	await closeDialog(firstRuntime);
	await showProjects();
	await recent
		.getByRole('button', {name: 'open second-project', exact: true})
		.click();
	await expect(input).toHaveValue('second project private draft');
	await expect(selected).not.toHaveAttribute('data-thread-id', firstThreadId);
	await expect(page.locator('.footer-acp--success')).toBeVisible();
	await showProjects();
	await expect(recent.locator('[aria-current="true"]')).toContainText(
		'second-project',
	);
	await expect(
		page
			.locator('[data-shell-slot="stream-tools"]')
			.getByLabel('project trust feedback'),
	).toBeVisible();
	await page.emulateMedia({reducedMotion: 'reduce'});
	for (const [theme, color] of [
		['dark', 'rgb(230, 230, 230)'],
		['light', 'rgb(10, 10, 10)'],
	]) {
		await page.evaluate(theme => {
			document.documentElement.dataset.theme = theme;
		}, theme);
		await expect(
			recent.locator('[aria-current="true"] .projects-dialog-name').first(),
		).toHaveCSS('color', color);
	}
});

test('opening a folder through the legacy action refreshes the active recent project (CHAT-02)', async () => {
	const root = path.join(work, 'current-project');
	mkdirSync(root);
	await picker(root);
	await page
		.getByRole('button', {name: 'open a project folder', exact: true})
		.click();
	await expect(page.getByRole('textbox', {name: 'message'})).toBeVisible();
	await showProjects();
	await expect(projectsRecent().locator('[aria-current="true"]')).toContainText(
		'current-project',
	);
});

test('welcome keeps runtime details quiet and keyboard inspectable before any project starts', async () => {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate(theme => {
			document.documentElement.dataset.theme = theme;
		}, theme);
		for (const width of [1240, 1020, 840]) {
			await page.setViewportSize({width, height: 900});
			await expect(
				page.getByRole('region', {name: 'get started'}),
			).toBeVisible();
			const trigger = page.getByRole('button', {
				name: 'runtime details',
				exact: true,
			});
			const dialog = page.getByRole('dialog', {name: 'runtime details'});
			await expect(dialog).toBeHidden();
			await trigger.focus();
			await page.keyboard.press('Tab');
			await page.keyboard.press('Shift+Tab');
			await expect(trigger).toBeFocused();
			await expect(trigger).toHaveCSS('outline-width', '2px');
			await page.keyboard.press('Enter');
			await expect(dialog).toBeVisible();
			await expect(dialog).toContainText('9.9.9');
			await page.keyboard.press('Escape');
			await expect(dialog).toBeHidden();
			await expect(trigger).toBeFocused();
			const row = page.getByRole('button', {
				name: 'runtime and setup details',
				exact: true,
			});
			await row.focus();
			await page.keyboard.press('Enter');
			await expect(dialog).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(dialog).toBeHidden();
			await expect(row).toBeFocused();
			expect(await visibleTextContrast(page, theme)).toEqual([]);
		}
	}
	expect(await call('listProjects', {})).toEqual({ok: true, value: []});
});

test('welcome with two recent projects fits an 800 px window without a scrollbar', async () => {
	for (const name of ['tide', 'atlas-notes']) {
		const root = path.join(work, name);
		mkdirSync(root);
		await add(root);
	}
	await page.reload();
	await expect(
		page.getByRole('region', {name: 'get started', exact: true}),
	).toBeVisible();
	await expect(
		page
			.getByRole('region', {name: 'recent folders on welcome', exact: true})
			.getByRole('button', {name: /^open recent project/}),
	).toHaveCount(2);
	const scroll = page.getByRole('region', {name: 'conversation', exact: true});
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate(theme => {
			document.documentElement.dataset.theme = theme;
		}, theme);
		for (const width of [1240, 1020, 840]) {
			await page.setViewportSize({width, height: 800});
			const metrics = await scroll.evaluate(element => ({
				scrollHeight: element.scrollHeight,
				clientHeight: element.clientHeight,
			}));
			expect
				.soft(metrics.scrollHeight, `${theme} ${width}x800 scroll height`)
				.toBeLessThanOrEqual(metrics.clientHeight);
		}
	}
	await page.setViewportSize({width: 1240, height: 560});
	expect(
		await scroll.evaluate(
			element => element.scrollHeight > element.clientHeight,
		),
	).toBe(true);
});

test('long welcome recent paths give actions their full width without dropping project identity', async () => {
	const root = path.join(
		work,
		'long-project-folder-for-the-welcome-recent-project-row-with-a-readable-action',
	);
	mkdirSync(root);
	await add(root);
	await page.reload();
	const recents = page.getByRole('region', {
		name: 'recent folders on welcome',
		exact: true,
	});
	const action = recents.getByRole('button', {name: /^open recent project/});
	const savedPath = recents.locator('small');
	// The row shows the home-shortened path (for example ~\AppData on Windows);
	// the full canonical root stays in the title.
	await expect(savedPath).toHaveText(shortRoot(root));
	await expect(savedPath).toHaveAttribute('title', root);
	for (const theme of ['dark', 'light']) {
		await page.evaluate(theme => {
			document.documentElement.dataset.theme = theme;
		}, theme);
		for (const width of [1240, 1020, 840]) {
			await page.setViewportSize({width, height: 900});
			await expect(action).toHaveCSS('white-space', 'nowrap');
			await expect(action).toHaveCSS('flex-shrink', '0');
			await expect(savedPath).toHaveCSS('white-space', 'nowrap');
			await expect(savedPath).toHaveCSS('text-overflow', 'ellipsis');
			await expect(savedPath).toHaveCSS('overflow', 'hidden');
			await expect(savedPath).toHaveAttribute('title', root);
			expect(
				await savedPath.evaluate(
					element => element.scrollWidth > element.clientWidth,
				),
			).toBe(true);
			expect(
				await recents.evaluate(
					element => element.scrollWidth <= element.clientWidth,
				),
			).toBe(true);
			expect(
				await action.evaluate(
					element => element.scrollWidth <= element.clientWidth,
				),
			).toBe(true);
			expect(
				await action.evaluate(element => {
					const button = element.getBoundingClientRect();
					const row = element.closest('li')?.getBoundingClientRect();
					const list = element.closest('ul')?.getBoundingClientRect();
					return (
						!!row &&
						!!list &&
						Math.abs(button.width - list.width) < 1 &&
						button.right <= list.right + 0.5
					);
				}),
			).toBe(true);
		}
	}
});
