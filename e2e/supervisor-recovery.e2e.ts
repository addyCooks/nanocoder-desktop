import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
import type {ProjectEvent} from '@/shared/ipc';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import {openFolderFromPalette} from './qa/open-folder';
import {turnEnded} from './qa/turn-state';
import {visibleTextContrast} from './qa/ui-contrast';

let work: string;
let root: string;
let app: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
	work = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-recovery-e2e-')),
	);
	root = path.join(work, 'project');
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
	copyFileSync('source/main/nanocoder/fixtures/fake-nanocoder.mjs', cli);
	app = await electron.launch({
		args: ['.', `--user-data-dir=${path.join(work, 'profile')}`],
		env: qaEnvironment(process.env, {cliPath: cli, nodePath: process.execPath}),
	});
	page = await app.firstWindow();
	await app.evaluate(({dialog}, folder) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [folder],
		})) as typeof dialog.showOpenDialog;
	}, root);
	await page.evaluate(() => {
		const state = window as unknown as {
			desktop: DesktopApi;
			recoveryEvents: ProjectEvent[];
		};
		state.recoveryEvents = [];
		state.desktop.onProjectEvent(event => state.recoveryEvents.push(event));
	});
});
test.afterEach(async () => {
	await app?.close();
	rmSync(work, {recursive: true, force: true});
});

async function open(mode = 'ok'): Promise<string> {
	writeFileSync(path.join(root, '.fake-nanocoder'), mode);
	await openFolderFromPalette(page, root);
	await expect(
		page.getByRole('textbox', {name: 'message', exact: true}),
	).toBeEnabled();
	return page.evaluate(() => {
		const events = (window as unknown as {recoveryEvents: ProjectEvent[]})
			.recoveryEvents;
		const event = events.find(
			event => event.type === 'supervisor' && event.state.status === 'ready',
		);
		if (!event) throw new Error('Missing ready state');
		return event.projectId;
	});
}

for (const theme of ['dark', 'light'] as const) {
	for (const action of ['retry', 'new', 'remove', 'view-retry'] as const) {
		test(`CHAT-09 ${theme} keyboard ${action} keeps recovery native, scoped and unqueued`, async () => {
			const projectId = await open('replay-gates');
			await page.emulateMedia({reducedMotion: 'reduce'});
			await page.evaluate(theme => {
				document.documentElement.dataset.theme = theme;
			}, theme);
			const input = page.getByRole('textbox', {name: 'message', exact: true});
			await input.fill('saved recovery fixture');
			await input.press('Enter');
			await expect(turnEnded(page)).toBeVisible();
			const before = await page.evaluate(async projectId => {
				const {desktop} = window as unknown as {desktop: DesktopApi};
				const ui = await desktop.getUiState({});
				if (!ui.ok || !ui.value.activeThreadId)
					throw new Error('Missing fixture');
				const snapshot = await desktop.getThreadSnapshot({
					projectId,
					threadId: ui.value.activeThreadId,
				});
				if (!snapshot.ok) throw new Error(snapshot.error.code);
				return snapshot.value;
			}, projectId);
			await input.fill('retained unqueued recovery draft');
			const scope = {projectId, threadId: before.thread.id};
			await page.evaluate(async projectId => {
				await (window as unknown as {desktop: DesktopApi}).desktop.stopProject({
					projectId,
				});
			}, projectId);
			writeFileSync(
				path.join(root, '.fake-nanocoder'),
				action === 'retry' ? 'resume-fails' : 'missing-session',
			);
			const failed = await page.evaluate(
				scope =>
					(window as unknown as {desktop: DesktopApi}).desktop.openThread(
						scope,
					),
				scope,
			);
			expect(failed.ok).toBe(true);
			if (!failed.ok) throw new Error(failed.error.code);
			expect(failed.value.events).toEqual(before.events);
			expect(failed.value.result).toEqual(before.result);
			expect(failed.value.thread.id).toBe(before.thread.id);
			expect(failed.value.thread.nanocoderSessionId).toBe(
				before.thread.nanocoderSessionId,
			);
			expect(failed.value.thread.title).toBe(before.thread.title);
			expect(failed.value.thread.lastActivityAt).toBe(
				before.thread.lastActivityAt,
			);
			const refused = await page.evaluate(
				scope =>
					(window as unknown as {desktop: DesktopApi}).desktop.promptThread({
						...scope,
						text: 'must not be sent',
					}),
				scope,
			);
			expect(refused.ok).toBe(false);
			const notice = page.getByRole('region', {
				name: action === 'retry' ? 'thread recovery' : 'view-only thread',
				exact: true,
			});
			await expect(notice).toBeVisible();
			await expect(notice).toContainText(before.thread.title);
			await expect(notice.locator('time')).toHaveAttribute(
				'datetime',
				before.thread.lastActivityAt,
			);
			expect(await visibleTextContrast(page, theme)).toEqual([]);
			const diagnostics = await page.evaluate(async projectId => {
				const result = await (
					window as unknown as {desktop: DesktopApi}
				).desktop.getDiagnostics({projectId});
				if (!result.ok) throw new Error(result.error.code);
				return result.value.lines;
			}, projectId);
			if (action === 'retry') {
				await expect(input).toBeEnabled();
				await expect(input).toHaveValue('retained unqueued recovery draft');
				await input.press('Enter');
				await expect(input).toHaveValue('retained unqueued recovery draft');
				await expect(
					page.getByRole('button', {name: 'send', exact: true}),
				).toBeDisabled();
				await page.evaluate(async projectId => {
					await (
						window as unknown as {desktop: DesktopApi}
					).desktop.stopProject({
						projectId,
					});
				}, projectId);
				writeFileSync(path.join(root, '.fake-nanocoder'), 'ok');
				const retry = notice.getByRole('button', {name: 'retry this thread'});
				await retry.focus();
				await expect(retry).toBeFocused();
				await expect(retry).toHaveCSS('outline-width', '2px');
				await retry.press('Enter');
				await expect(notice).toHaveCount(0);
				await expect(input).toBeEnabled();
				await expect(input).toHaveValue('retained unqueued recovery draft');
				const after = await page.evaluate(async scope => {
					const {desktop} = window as unknown as {desktop: DesktopApi};
					const result = await desktop.getThreadSnapshot(scope);
					if (!result.ok) throw new Error(result.error.code);
					const diagnostics = await desktop.getDiagnostics({
						projectId: scope.projectId,
					});
					if (!diagnostics.ok) throw new Error(diagnostics.error.code);
					return {thread: result.value.thread, lines: diagnostics.value.lines};
				}, scope);
				expect(after.thread.id).toBe(before.thread.id);
				expect(after.thread.nanocoderSessionId).toBe(
					before.thread.nanocoderSessionId,
				);
				const count = (lines: string[], method: string) =>
					lines.filter(line => line === `{"method":"session/${method}"}`)
						.length;
				for (const method of ['resume', 'set_mode'])
					expect(count(after.lines, method)).toBe(
						count(diagnostics, method) + 1,
					);
				for (const method of ['new', 'load', 'prompt'])
					expect(count(after.lines, method)).toBe(count(diagnostics, method));
			} else {
				await expect(input).toHaveCount(0);
				const dashed = notice.locator('.thread-view-only-notice');
				await expect(dashed).toHaveCSS('border-top-style', 'dashed');
				await expect(dashed).toHaveCSS(
					'color',
					theme === 'dark' ? 'rgb(168, 168, 168)' : 'rgb(82, 82, 82)',
				);
				await expect(dashed).toContainText(
					"Nanocoder no longer has this chat's history. By default it deletes chats not opened for 30 days, and the oldest once there are more than 100. You can change this in Nanocoder's session settings.",
				);
				const button = notice.getByRole('button', {
					name:
						action === 'new'
							? '＋ new thread in project'
							: action === 'view-retry'
								? 'retry this same thread'
								: 'remove from desktop',
					exact: true,
				});
				await button.focus();
				await expect(button).toBeFocused();
				await expect(button).toHaveCSS('outline-width', '2px');
				await button.press('Enter');
				if (action === 'view-retry') {
					const resumes = (lines: readonly string[]) =>
						lines.filter(line => line === '{"method":"session/resume"}').length;
					await expect
						.poll(async () => {
							const lines = await page.evaluate(async projectId => {
								const result = await (
									window as unknown as {desktop: DesktopApi}
								).desktop.getDiagnostics({projectId});
								if (!result.ok) throw new Error(result.error.code);
								return result.value.lines;
							}, scope.projectId);
							return resumes(lines);
						})
						.toBe(resumes(diagnostics) + 1);
					await expect(button).toBeEnabled();
					await expect(notice).toBeVisible();
					await expect(input).toHaveCount(0);
					const retried = await page.evaluate(async scope => {
						const {desktop} = window as unknown as {desktop: DesktopApi};
						const result = await desktop.getThreadSnapshot(scope);
						if (!result.ok) throw new Error(result.error.code);
						return result.value.thread;
					}, scope);
					expect(retried.id).toBe(scope.threadId);
					expect(retried.runState).toBe('view-only');
					expect(retried.nanocoderSessionId).toBe(
						failed.value.thread.nanocoderSessionId,
					);
				} else {
					const confirmation = page.getByRole('dialog', {
						name: action === 'new' ? 'new thread' : 'remove from desktop',
						exact: true,
					});
					await expect(confirmation).toBeVisible();
					await confirmation
						.getByRole('button', {
							name:
								action === 'new'
									? 'keep as new thread draft'
									: 'remove from desktop',
							exact: true,
						})
						.click();
					await expect(confirmation).toBeHidden();
					await expect(notice).toHaveCount(0);
					const after = await page.evaluate(async scope => {
						const {desktop} = window as unknown as {desktop: DesktopApi};
						const rows = await desktop.listThreads({
							projectId: scope.projectId,
							archiveState: 'active',
						});
						const diagnostics = await desktop.getDiagnostics({
							projectId: scope.projectId,
						});
						if (!rows.ok || !diagnostics.ok)
							throw new Error('Missing fixture state');
						return {threads: rows.value, lines: diagnostics.value.lines};
					}, scope);
					expect(after.lines).toEqual(diagnostics);
					if (action === 'new') {
						expect(
							after.threads.find(row => row.id === scope.threadId),
						).toEqual(failed.value.thread);
						const created = after.threads.filter(
							row => row.id !== scope.threadId,
						);
						expect(created).toHaveLength(1);
						expect(created[0].nanocoderSessionId).toBeNull();
						expect(created[0].runState).toBe('new');
					} else {
						expect(after.threads.some(row => row.id === scope.threadId)).toBe(
							false,
						);
						const removed = await page.evaluate(
							scope =>
								(
									window as unknown as {desktop: DesktopApi}
								).desktop.getThreadSnapshot(scope),
							scope,
						);
						expect(removed).toMatchObject({
							ok: false,
							error: {code: 'NOT_FOUND'},
						});
					}
				}
			}
			expect(
				await app.evaluate(({BrowserWindow}) =>
					BrowserWindow.getAllWindows().some(window => window.isVisible()),
				),
			).toBe(false);
		});
	}
}

test('a crashed turn disables the composer and keyboard retry resumes without resending it', async () => {
	const projectId = await open('die-in-turn');
	await page
		.getByRole('textbox', {name: 'message', exact: true})
		.fill('synthetic failed request');
	await page.getByRole('button', {name: 'send', exact: true}).click();
	const recovery = page
		.getByRole('main', {name: 'conversation workspace'})
		.getByRole('region', {name: 'Nanocoder recovery', exact: true});
	await expect(recovery).toContainText('exit code 3');
	await expect(
		page.getByRole('textbox', {name: 'message', exact: true}),
	).toBeDisabled();
	await page.evaluate(async id => {
		await (window as unknown as {desktop: DesktopApi}).desktop.stopProject({
			projectId: id,
		});
	}, projectId);
	writeFileSync(path.join(root, '.fake-nanocoder'), 'ok');
	const retry = recovery.getByRole('button', {
		name: 'retry Nanocoder',
		exact: true,
	});
	await retry.focus();
	await expect(retry).toBeFocused();
	await retry.press('Enter');
	const composer = page.getByRole('textbox', {name: 'message', exact: true});
	await expect(composer).toBeEnabled();
	await expect(composer).toBeFocused();
	await expect(page.getByRole('list', {name: 'conversation'})).toContainText(
		'Earlier answer',
	);
	await expect(
		page
			.locator('.gate-message-user .stream-plain')
			.getByText('synthetic failed request', {exact: true}),
	).toHaveCount(0);
	await expect(page.locator('.ui-badge--failed')).toHaveCount(0);
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.locator('.gate-message-failure')).toContainText(
		'Nanocoder stopped during the turn',
	);
	const snapshot = await page.evaluate(async id => {
		const result = await (
			window as unknown as {desktop: DesktopApi}
		).desktop.getDiagnostics({projectId: id});
		if (!result.ok) throw new Error(result.error.code);
		return result.value;
	}, projectId);
	expect(
		snapshot.lines.filter(line => line === '{"method":"session/prompt"}'),
	).toHaveLength(1);
});

test('a failed turn keeps the unsent draft typed while it ran', async () => {
	await open('die-in-held-turn');
	const input = page.getByRole('textbox', {name: 'message', exact: true});
	await input.fill('synthetic failed request');
	await page.getByRole('button', {name: 'send', exact: true}).click();
	await expect(
		page
			.locator('.gate-message-user .stream-plain')
			.getByText('synthetic failed request', {exact: true}),
	).toBeVisible();
	await expect(input).toBeEditable();
	await input.fill('unsent draft kept through failure');
	writeFileSync(path.join(root, '.fake-turn-release'), 'go');
	const recovery = page
		.getByRole('main', {name: 'conversation workspace'})
		.getByRole('region', {name: 'Nanocoder recovery', exact: true});
	await expect(recovery).toContainText('exit code 3');
	await expect(recovery).toContainText('Nanocoder stopped unexpectedly');
	await expect(recovery).toContainText(
		'your thread and unsent draft are still here.',
	);
	await expect(input).toBeDisabled();
	await expect(input).toHaveValue('unsent draft kept through failure');
});

test('ordinary reopen preserves the existing conversation when no replay is produced', async () => {
	const projectId = await open();
	await page
		.getByRole('textbox', {name: 'message', exact: true})
		.fill('fixture conversation');
	await page.getByRole('button', {name: 'send', exact: true}).click();
	await page
		.getByRole('region', {name: 'permission request'})
		.getByRole('button', {name: 'Deny', exact: true})
		.click();
	await expect(turnEnded(page)).toBeVisible();
	const conversation = page.getByRole('list', {name: 'conversation'});
	// The author label is a row of its own, so compare messages, not rows.
	const messages = conversation.locator(':scope > li:not(.gate-message-label)');
	const expected = [
		/fixture conversation$/,
		/^Working on it\.$/,
		/execute_bash: echo hi$/,
		/^Tool denied\.$/,
	];
	const before = await conversation.innerText();
	await expect(messages).toHaveText(expected, {useInnerText: true});
	await page.evaluate(async projectId => {
		await (window as unknown as {desktop: DesktopApi}).desktop.stopProject({
			projectId,
		});
	}, projectId);
	await open();
	await expect(messages).toHaveText(expected, {useInnerText: true});
	await expect(conversation).toHaveText(before, {useInnerText: true});
});

for (const {failure, action} of [
	{failure: 'untrusted', action: 'open a project folder'},
	{failure: 'crash', action: 'open a project folder'},
	{failure: 'untrusted', action: 'add project folder'},
	{failure: 'crash', action: 'add project folder'},
]) {
	test(`retry after an initial ${failure} via ${action} prepares a usable session without reopening the picker`, async () => {
		writeFileSync(path.join(root, '.fake-nanocoder'), failure);
		await app.evaluate(({dialog}, root) => {
			const state = globalThis as {recoveryPickerCalls?: number};
			state.recoveryPickerCalls = 0;
			dialog.showOpenDialog = (async () => {
				state.recoveryPickerCalls = (state.recoveryPickerCalls ?? 0) + 1;
				return {canceled: false, filePaths: [root]};
			}) as typeof dialog.showOpenDialog;
			dialog.showMessageBox = (async () => ({
				response: 1,
				checkboxChecked: false,
			})) as typeof dialog.showMessageBox;
		}, root);
		if (action === 'add project folder') {
			await page
				.getByRole('button', {name: 'switch project', exact: true})
				.click();
			await page
				.getByRole('dialog', {name: 'your projects'})
				.getByRole('button', {name: /add project folder/})
				.click();
		} else {
			await page.getByRole('button', {name: action, exact: true}).click();
		}
		await expect(
			page
				.getByRole('main', {name: 'conversation workspace'})
				.getByRole('region', {name: 'Nanocoder recovery'}),
		).toContainText('Nanocoder is not ready');
		writeFileSync(
			path.join(root, '.fake-nanocoder'),
			failure === 'untrusted' ? 'untrusted' : 'ok',
		);
		await app.evaluate(({dialog}) => {
			dialog.showMessageBox = (async () => ({
				response: 0,
				checkboxChecked: false,
			})) as typeof dialog.showMessageBox;
		});
		await page
			.getByRole('button', {name: 'retry Nanocoder', exact: true})
			.click();
		const input = page.getByRole('textbox', {name: 'message', exact: true});
		await expect(input).toBeEnabled();
		await expect(page.locator('.ui-badge--failed')).toHaveCount(0);
		await input.fill('synthetic first retry turn');
		await page.getByRole('button', {name: 'send', exact: true}).click();
		await expect(
			page.getByRole('region', {name: 'permission request'}),
		).toBeVisible();
		await page
			.getByRole('region', {name: 'permission request'})
			.getByRole('button', {name: 'Deny', exact: true})
			.click();
		await expect(turnEnded(page)).toBeVisible();
		await expect(page.getByRole('alert')).toHaveCount(0);
		expect(
			await app.evaluate(
				() =>
					(globalThis as {recoveryPickerCalls?: number}).recoveryPickerCalls,
			),
		).toBe(1);
		const projects = await page.evaluate(() =>
			(window as unknown as {desktop: DesktopApi}).desktop.listProjects({}),
		);
		expect(projects).toMatchObject({
			ok: true,
			value: [{canonicalRoot: root, trusted: true}],
		});
	});
}

test('recovery remains bound to the failed attempted project when another project emits ready', async () => {
	const firstId = await open();
	const other = path.join(work, 'failed-project');
	mkdirSync(other);
	writeFileSync(path.join(other, '.fake-nanocoder'), 'untrusted');
	await app.evaluate(({dialog}, other) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [other],
		})) as typeof dialog.showOpenDialog;
		dialog.showMessageBox = (async () => ({
			response: 1,
			checkboxChecked: false,
		})) as typeof dialog.showMessageBox;
	}, other);
	await openFolderFromPalette(page, other, 'refused');
	await expect(page.getByRole('alert')).toContainText('not opened');
	await page.evaluate(async firstId => {
		const api = (window as unknown as {desktop: DesktopApi}).desktop;
		await api.stopProject({projectId: firstId});
		const started = await api.startProject({projectId: firstId});
		if (!started.ok || started.value.status !== 'ready')
			throw new Error('Expected the other project to be ready');
	}, firstId);
	await expect(
		page.getByRole('button', {name: 'retry Nanocoder', exact: true}),
	).toBeVisible();
	await page
		.getByRole('button', {name: 'review diagnostics', exact: true})
		.click();
	const review = page.getByRole('dialog', {
		name: 'review captured diagnostics',
	});
	await expect(
		review.getByRole('region', {name: 'captured diagnostics'}),
	).toContainText(JSON.stringify(other).slice(1, -1));
	await expect(
		review.getByRole('region', {name: 'captured diagnostics'}),
	).not.toContainText(JSON.stringify(root).slice(1, -1));
});

test('diagnostics export reviews the exact snapshot and cancellation never writes', async () => {
	await open();
	const target = path.join(work, 'reviewed.txt');
	await app.evaluate(({dialog}, target) => {
		const state = globalThis as {reviewed?: string[]; exports?: number};
		state.reviewed = [];
		state.exports = 0;
		dialog.showMessageBox = (async (...args: unknown[]) => {
			const options = args.at(-1) as {detail?: string};
			state.reviewed?.push(options.detail ?? '');
			return {
				response: state.reviewed?.length === 1 ? 1 : 0,
				checkboxChecked: false,
			};
		}) as typeof dialog.showMessageBox;
		dialog.showSaveDialog = (async () => {
			state.exports = (state.exports ?? 0) + 1;
			return {canceled: false, filePath: target};
		}) as typeof dialog.showSaveDialog;
	}, target);
	await page
		.getByRole('button', {name: 'runtime details', exact: true})
		.click();
	await page
		.getByRole('dialog', {name: 'runtime details'})
		.getByRole('button', {name: 'review diagnostics', exact: true})
		.click();
	const diagnostics = page.getByRole('dialog', {
		name: 'review captured diagnostics',
	});
	await expect(diagnostics).toBeVisible();
	await expect(
		diagnostics.getByRole('region', {name: 'redacted diagnostics'}),
	).toBeVisible();
	const captured = await diagnostics.locator('pre').innerText();
	await diagnostics
		.getByRole('button', {name: 'choose export destination…', exact: true})
		.click();
	await expect(diagnostics).toContainText('export cancelled');
	expect(
		await app.evaluate(() => (globalThis as {exports?: number}).exports),
	).toBe(0);
	await diagnostics
		.getByRole('button', {name: 'choose export destination…', exact: true})
		.click();
	await expect(diagnostics).toContainText('diagnostics exported');
	expect(readFileSync(target, 'utf8')).toBe(captured);
	expect(
		await app.evaluate(() => (globalThis as {reviewed?: string[]}).reviewed),
	).toEqual([captured, captured]);
});

test('failed resume preserves the visible failed turn and cannot accept another prompt', async () => {
	const projectId = await open('die-in-turn');
	await page
		.getByRole('textbox', {name: 'message', exact: true})
		.fill('synthetic failed request');
	await page.getByRole('button', {name: 'send', exact: true}).click();
	const recovery = page
		.getByRole('main', {name: 'conversation workspace'})
		.getByRole('region', {name: 'Nanocoder recovery'});
	await expect(recovery).toContainText('exit code 3');
	await expect(page.locator('.composer-hint-row')).toContainText(
		'retry this thread before sending',
	);
	await page.evaluate(async projectId => {
		await (window as unknown as {desktop: DesktopApi}).desktop.stopProject({
			projectId,
		});
	}, projectId);
	writeFileSync(path.join(root, '.fake-nanocoder'), 'missing-session');
	await recovery
		.getByRole('button', {name: 'retry Nanocoder', exact: true})
		.click();
	await expect(recovery).toContainText('no longer has this session');
	await expect(
		page.getByRole('textbox', {name: 'message', exact: true}),
	).toHaveCount(0);
	const notice = page.getByRole('region', {name: 'view-only thread'});
	await expect(notice).toContainText(
		"Nanocoder no longer has this chat's history. By default it deletes chats not opened for 30 days, and the oldest once there are more than 100. You can change this in Nanocoder's session settings.",
	);
	await expect(
		notice.getByRole('button', {
			name: '＋ new thread in project',
			exact: true,
		}),
	).toBeEnabled();
	await expect(
		notice.getByRole('button', {name: 'remove from desktop', exact: true}),
	).toBeEnabled();
	await expect(
		page
			.locator('.gate-message-user .stream-plain')
			.getByText('synthetic failed request', {exact: true}),
	).toHaveCount(1);
});

test('repeated fake-child signal exits exhaust automatic recovery until explicit retry', async () => {
	const projectId = await open();
	const getState = () =>
		page.evaluate(async projectId => {
			const result = await (
				window as unknown as {desktop: DesktopApi}
			).desktop.getSupervisorState({projectId});
			if (!result.ok) throw new Error(result.error.code);
			return result.value;
		}, projectId);
	for (let attempt = 1; attempt <= 4; attempt++) {
		const child = await page.evaluate(async projectId => {
			const result = await (
				window as unknown as {desktop: DesktopApi}
			).desktop.getDiagnostics({projectId});
			if (!result.ok) throw new Error(result.error.code);
			return result.value.lines
				.flatMap(line => {
					try {
						return [
							JSON.parse(line) as {
								started?: boolean;
								pid?: number;
								cwd?: string;
							},
						];
					} catch {
						return [];
					}
				})
				.reverse()
				.find(event => event.started);
		}, projectId);
		if (!child?.pid || child.cwd !== root)
			throw new Error('Missing isolated fake child');
		process.kill(child.pid, 'SIGTERM');
		await expect
			.poll(async () => {
				const state = await getState();
				return {status: state.status, attempt: state.restart.attempt};
			})
			.toEqual({status: 'failed', attempt: Math.min(attempt, 3)});
		if (attempt <= 3)
			await expect
				.poll(async () => (await getState()).status, {timeout: 10_000})
				.toBe('ready');
	}
	const recovery = page
		.getByRole('main', {name: 'conversation workspace'})
		.getByRole('region', {name: 'Nanocoder recovery'});
	await expect(recovery).toContainText(
		'automatic recovery stopped after 3 attempts',
	);
	expect((await getState()).restart.nextAttemptAt).toBeNull();
	await recovery
		.getByRole('button', {name: 'retry Nanocoder', exact: true})
		.click();
	await expect(
		page.getByRole('textbox', {name: 'message', exact: true}),
	).toBeEnabled();
	expect((await getState()).restart.attempt).toBe(0);
});

test('built main refuses unknown recovery handles and renderer-supplied paths or diagnostics lines', async () => {
	const projectId = await open();
	const results = await page.evaluate(async projectId => {
		const desktop = (window as unknown as {desktop: DesktopApi}).desktop;
		return [
			await desktop.restartProject({
				projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			}),
			await desktop.restartProject({
				projectId,
				canonicalRoot: '/renderer-path',
			} as {projectId: string}),
			await desktop.exportDiagnostics({
				projectId,
				snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				path: '/renderer-path',
				lines: ['unreviewed'],
			} as {projectId: string; snapshotId: string}),
		];
	}, projectId);
	expect(
		results.map(result =>
			result.ok ? 'unexpected-success' : result.error.code,
		),
	).toEqual(['NOT_FOUND', 'VALIDATION', 'VALIDATION']);
});

test('runtime details reviews diagnostics with computed presentation in both themes and widths', async () => {
	await open();
	const runtime = page.getByRole('button', {
		name: 'runtime details',
		exact: true,
	});
	for (const theme of ['dark', 'light']) {
		await page.evaluate(theme => {
			document.documentElement.dataset.theme = theme;
		}, theme);
		for (const width of [1240, 1020, 840]) {
			await page.setViewportSize({width, height: 900});
			await runtime.click();
			const details = page.getByRole('dialog', {name: 'runtime details'});
			await expect(details.locator('.dialog-shell')).toHaveCSS(
				'border-radius',
				'15px',
			);
			await expect(
				details.getByRole('button', {name: 'review diagnostics', exact: true}),
			).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(details).toBeHidden();
			await expect(runtime).toBeFocused();
		}
	}
	await runtime.click();
	await page
		.getByRole('dialog', {name: 'runtime details'})
		.getByRole('button', {name: 'review diagnostics', exact: true})
		.click();
	const diagnostics = page.getByRole('dialog', {
		name: 'review captured diagnostics',
		exact: true,
	});
	await expect(diagnostics.locator('.dialog-shell')).toHaveCSS(
		'border-radius',
		'15px',
	);
	await expect(
		diagnostics.getByRole('region', {name: 'captured diagnostics'}),
	).toHaveCSS('font-size', '13px');
});
