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
import {openFolderFromPalette} from './qa/open-folder';

// CHAT-22, DEC-46: a turn in another project keeps running, says so in the rail, and quitting
// never ends it silently.
const work = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nd-bg-')));
const fakeCli = path.join(work, 'nanocoder', 'dist', 'cli.js');
let app: ElectronApplication | undefined;
let page: Page;
const profiles: string[] = [];

async function launch(env: Record<string, string> = {}) {
	mkdirSync(path.dirname(fakeCli), {recursive: true});
	writeFileSync(
		path.join(work, 'nanocoder', 'package.json'),
		JSON.stringify({
			name: '@nanocollective/nanocoder',
			version: '9.9.9',
			type: 'module',
			bin: {nanocoder: 'dist/cli.js'},
		}),
	);
	copyFileSync('source/main/nanocoder/fixtures/fake-nanocoder.mjs', fakeCli);
	const profile = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-bg-profile-')),
	);
	profiles.push(profile);
	app = await electron.launch({
		args: ['.', `--user-data-dir=${profile}`],
		env: qaEnvironment(
			{...process.env, ...env},
			{cliPath: fakeCli, nodePath: process.execPath},
		),
	});
	page = await app.firstWindow();
	// The id of every permission request the app is shown, through the real bridge.
	await page.evaluate(() => {
		const seen: string[] = [];
		const state = window as unknown as {
			permissionIds: string[];
			desktop: DesktopApi;
		};
		state.permissionIds = seen;
		state.desktop.onProjectEvent(event => {
			if (event.type !== 'turn') return;
			for (const item of event.events)
				if (item.type === 'permission') seen.push(item.request.id);
		});
	});
}

test.afterEach(async () => {
	await app?.close().catch(() => undefined);
	app = undefined;
});

test.afterAll(() => {
	for (const profile of profiles)
		rmSync(profile, {recursive: true, force: true});
	rmSync(work, {recursive: true, force: true});
});

function project(name: string): string {
	const dir = path.join(work, name);
	mkdirSync(dir, {recursive: true});
	return dir;
}

async function openFolder(folder: string) {
	await app?.evaluate(({dialog}, picked) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [picked],
		})) as typeof dialog.showOpenDialog;
		// The trust prompt: the first button trusts the folder.
		dialog.showMessageBox = (async () => ({
			response: 1,
			checkboxChecked: false,
		})) as typeof dialog.showMessageBox;
	}, folder);
	await openFolderFromPalette(page, folder);
}

async function startTurn() {
	await page.getByRole('textbox', {name: 'message', exact: true}).fill('go');
	await page.getByRole('button', {name: 'send', exact: true}).click();
	await expect(
		page.getByRole('region', {name: 'Permission request'}),
	).toBeVisible();
}

const rail = () =>
	page.getByRole('region', {name: 'projects in the background'});

test('CHAT-22 a turn waiting for approval in another project is marked in the rail, stays unanswered, and the marker opens it', async () => {
	await launch();
	await openFolder(project('alpha-project'));
	await startTurn();
	// The thread's own state still arrives while activity events are published beside it.
	await expect(
		page.locator('.thread-row[data-selected="true"] .thread-state-label'),
	).toContainText('approval required');
	await openFolder(project('beta-project'));
	const marker = rail().getByRole('button', {
		name: 'alpha-project · needs approval · open',
	});
	await expect(marker).toBeVisible();
	await expect(rail()).toContainText('in the background');
	// The new project has no request of its own, and nothing was answered for the old one.
	await expect(
		page.getByRole('region', {name: 'Permission request'}),
	).toHaveCount(0);
	await marker.click();
	await expect(
		page.getByRole('region', {name: 'Permission request'}),
	).toContainText('execute_bash: echo hi');
	await expect(rail()).toHaveCount(0);
});

test('CHAT-22 a turn that finishes in the background leaves a finished marker, and says so once', async () => {
	await launch();
	await openFolder(project('alpha-finish'));
	await startTurn();
	const owner = await page.evaluate(async () => {
		const {desktop} = window as unknown as {desktop: DesktopApi};
		const ui = await desktop.getUiState({});
		return ui.ok
			? {projectId: ui.value.activeProjectId, threadId: ui.value.activeThreadId}
			: null;
	});
	expect(owner?.projectId).toBeTruthy();
	await openFolder(project('beta-finish'));
	await expect(
		rail().getByRole('button', {name: 'alpha-finish · needs approval · open'}),
	).toBeVisible();
	// The user answers from the bridge while looking at the other project.
	const answered = await page.evaluate(async owner => {
		const {desktop, permissionIds} = window as unknown as {
			desktop: DesktopApi;
			permissionIds: string[];
		};
		return desktop.answerThreadPermission({
			projectId: owner?.projectId,
			threadId: owner?.threadId,
			requestId: permissionIds.at(-1),
			optionId: 'allow',
		} as never);
	}, owner);
	expect(answered.ok).toBe(true);
	const finished = rail().getByRole('button', {
		name: 'alpha-finish · finished · open',
	});
	await expect(finished).toBeVisible();
	await expect(page.getByText('alpha-finish finished')).toBeVisible();
	await finished.click();
	await expect(rail()).toHaveCount(0);
});

async function stubQuitQuestion(response: number) {
	await app?.evaluate(({dialog}, answer) => {
		const state = globalThis as {exitQuestions?: unknown[]};
		state.exitQuestions = [];
		dialog.showMessageBox = (async (...args: unknown[]) => {
			state.exitQuestions?.push(args.at(-1));
			return {response: answer, checkboxChecked: false};
		}) as typeof dialog.showMessageBox;
	}, response);
}

const quitQuestions = () =>
	app?.evaluate(
		() =>
			(globalThis as {exitQuestions?: Array<{message: string}>})
				.exitQuestions ?? [],
	) ?? Promise.resolve([]);

// Answers the first question with the first value, and so on. Any later question keeps working.
async function stubQuitAnswers(...answers: number[]) {
	await app?.evaluate(({dialog}, list) => {
		const state = globalThis as {exitQuestions?: unknown[]};
		state.exitQuestions = [];
		dialog.showMessageBox = (async (...args: unknown[]) => {
			const index = state.exitQuestions?.length ?? 0;
			state.exitQuestions?.push(args.at(-1));
			return {response: list[index] ?? 0, checkboxChecked: false};
		}) as typeof dialog.showMessageBox;
	}, answers);
}

const closeWindow = () =>
	app
		?.evaluate(({BrowserWindow}) => {
			BrowserWindow.getAllWindows()[0]?.close();
		})
		.catch(() => undefined);

const quit = () =>
	app
		?.evaluate(({app: electronApp}) => {
			electronApp.quit();
		})
		.catch(() => undefined);

test('CHAT-22 quitting with an unfinished turn asks first, keeps working when told to, and ends it only when told to', async () => {
	await launch({NANOCODER_E2E_EXIT_PROMPT: '1'});
	await openFolder(project('alpha-quit'));
	await startTurn();
	await stubQuitQuestion(0);
	await quit();
	await expect.poll(async () => (await quitQuestions()).length).toBe(1);
	expect((await quitQuestions())[0].message).toBe(
		'alpha-quit still has a turn that is running or waiting for you.',
	);
	// Still there, with its request still waiting.
	await expect(
		page.getByRole('region', {name: 'Permission request'}),
	).toBeVisible();
	await stubQuitQuestion(2);
	const closed = app?.waitForEvent('close');
	await quit();
	await closed;
	app = undefined;
});

test('CHAT-22 waiting before quitting lets the turn finish, then the app quits by itself', async () => {
	await launch({NANOCODER_E2E_EXIT_PROMPT: '1'});
	await openFolder(project('alpha-wait'));
	await startTurn();
	await stubQuitQuestion(1);
	await quit();
	await expect.poll(async () => (await quitQuestions()).length).toBe(1);
	await expect(
		page.getByRole('region', {name: 'Permission request'}),
	).toBeVisible();
	const closed = app?.waitForEvent('close');
	await page
		.getByRole('region', {name: 'Permission request'})
		.getByRole('button', {name: 'Allow'})
		.click();
	await closed;
	app = undefined;
});

test('CHAT-22 closing the window with an unfinished turn asks first, keeps it when told to, and does not ask again on the way out', async () => {
	await launch({NANOCODER_E2E_EXIT_PROMPT: '1'});
	await openFolder(project('alpha-close'));
	await startTurn();
	await stubQuitAnswers(0, 2);
	await closeWindow();
	await expect.poll(async () => (await quitQuestions()).length).toBe(1);
	// The window is still open and its request is still waiting.
	expect(page.isClosed()).toBe(false);
	await expect(
		page.getByRole('region', {name: 'Permission request'}),
	).toBeVisible();
	const windowClosed = page.waitForEvent('close');
	// On Windows and Linux the app quits behind the last window. A second question would be
	// answered with keep working and stop that, so the app closing proves it was not asked.
	const appClosed =
		process.platform === 'darwin' ? undefined : app?.waitForEvent('close');
	await closeWindow();
	await windowClosed;
	if (appClosed) {
		await appClosed;
		app = undefined;
	} else {
		expect((await quitQuestions()).length).toBe(2);
	}
});
