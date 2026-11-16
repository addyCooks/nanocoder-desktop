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
import {expect, test} from '@playwright/test';
import type {DesktopApi} from '@/shared/desktop-api';
import type {IpcResult, SupervisorState, ThreadReplay} from '@/shared/ipc';
import {choose, expectValue} from './qa/dropdown';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import {turnEnded} from './qa/turn-state';

const restoring =
	'restoring saved history; sending and controls will be available when it finishes';
const failed = 'Nanocoder could not resume the session';
const missing =
	"Nanocoder no longer has this chat's history. By default it deletes chats not opened for 30 days, and the oldest once there are more than 100. You can change this in Nanocoder's session settings.";
const missingNotice =
	"Nanocoder no longer has this chat's history. By default it deletes chats not opened for 30 days, and the oldest once there are more than 100. You can change this in Nanocoder's session settings.";
interface GateWindow {
	desktop: DesktopApi;
	replayRestart?: Promise<IpcResult<SupervisorState>>;
	probe: {
		events: Array<ThreadReplay & {sequence: number}>;
		end?: number;
		prefix?: number;
		usable?: number;
		inputMs: number[];
	};
}

for (const outcome of ['complete', 'fail', 'missing'] as const) {
	test(`CHAT-08 PERF-03 mounted replay ${outcome} gates controls and ${outcome === 'missing' ? 'hides the retained draft' : 'keeps the draft editable without queuing'}`, async () => {
		const root = path.resolve(import.meta.dirname, '..');
		const work = realpathSync.native(
			mkdtempSync(path.join(tmpdir(), 'nd-replay-gates-')),
		);
		const project = path.join(work, 'project');
		const cli = path.join(work, 'nanocoder/dist/cli.js');
		mkdirSync(project);
		mkdirSync(path.dirname(cli), {recursive: true});
		writeFileSync(path.join(project, '.fake-nanocoder'), 'replay-gates');
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
		const app = await electron.launch({
			cwd: root,
			args: [root, `--user-data-dir=${path.join(work, 'profile')}`],
			env: qaEnvironment(process.env, {
				cliPath: cli,
				nodePath: process.execPath,
			}),
		});
		try {
			const page = await app.firstWindow();
			expect(page.url()).toMatch(/^app:\/\/renderer\//);
			await app.evaluate(({dialog}, project) => {
				dialog.showOpenDialog = (async () => ({
					canceled: false,
					filePaths: [project],
				})) as typeof dialog.showOpenDialog;
			}, project);
			await page
				.getByRole('button', {name: 'open a project folder', exact: true})
				.click();
			const input = page.getByRole('textbox', {name: 'message', exact: true});
			await expect(input).toBeEnabled();
			await input.fill('initial replay gate fixture');
			await input.press('Enter');
			await expect(turnEnded(page)).toBeVisible();
			const model = page.getByRole('combobox', {
				name: /model for every thread in project/,
			});
			const mode = page.getByRole('combobox', {
				name: 'mode for this thread',
				exact: true,
			});
			const send = page.getByRole('button', {name: 'send', exact: true});
			await expect(model).toBeEnabled();
			const scope = await page.evaluate(async () => {
				const {desktop} = window as unknown as GateWindow;
				const ui = await desktop.getUiState({});
				if (!ui.ok || !ui.value.activeProjectId || !ui.value.activeThreadId)
					throw new Error('Missing fixture scope');
				const projectId = ui.value.activeProjectId;
				const controls = await desktop.getProjectControls({projectId});
				if (!controls.ok) throw new Error(controls.error.code);
				return {
					projectId,
					threadId: ui.value.activeThreadId,
					revision: controls.value.revision,
				};
			});
			await input.fill('draft before replay');
			await page.evaluate(scope => {
				const state = window as unknown as GateWindow;
				state.probe = {events: [], inputMs: []};
				state.desktop.onProjectEvent(event => {
					if (
						event.type !== 'turn' ||
						event.projectId !== scope.projectId ||
						event.threadId !== scope.threadId ||
						!event.replay
					)
						return;
					state.probe.events.push({...event.replay, sequence: event.sequence});
					if (event.replay.phase === 'complete')
						state.probe.end = performance.now();
				});
				document.querySelector('textarea')?.addEventListener('input', () => {
					if (state.probe.end === undefined) return;
					const at = performance.now();
					requestAnimationFrame(() =>
						state.probe.inputMs.push(performance.now() - at),
					);
				});
				const frame = () => {
					if (state.probe.usable !== undefined) return;
					if (state.probe.end !== undefined) {
						const users =
							document.querySelectorAll('.gate-message-user').length;
						const agents = document.querySelectorAll(
							'.gate-message-agent',
						).length;
						const input =
							document.querySelector<HTMLTextAreaElement>('textarea');
						const send = document.querySelector<HTMLButtonElement>(
							'button[aria-label="send"]',
						);
						const mode = document.querySelector<HTMLButtonElement>(
							'[role="combobox"][aria-label="mode for this thread"]',
						);
						const model = document.querySelector<HTMLButtonElement>(
							'[role="combobox"][aria-label^="model for every thread"]',
						);
						if (users === 100 && agents === 100) {
							state.probe.prefix ??= performance.now();
							if (
								input &&
								!input.disabled &&
								send &&
								!send.disabled &&
								mode &&
								!mode.disabled &&
								model &&
								!model.disabled
							) {
								state.probe.usable = performance.now();
								return;
							}
						}
					}
					requestAnimationFrame(frame);
				};
				requestAnimationFrame(frame);
				state.replayRestart = state.desktop.restartProject({
					projectId: scope.projectId,
				});
			}, scope);
			await expect
				.poll(() =>
					page.evaluate(() =>
						(window as unknown as GateWindow).probe.events.map(
							event => event.phase,
						),
					),
				)
				.toContain('begin');
			await expect(page.locator('.composer-hint-row')).toContainText(restoring);
			await expect(input).toBeEnabled();
			await input.fill('editable memory-only draft');
			await input.press('Enter');
			await expect(input).toHaveValue('editable memory-only draft');
			await expect(send).toBeDisabled();
			await expect(mode).toBeDisabled();
			await expect(
				page.locator(
					'[role="combobox"][aria-label^="model for every thread"]:enabled',
				),
			).toHaveCount(0);
			const refusals = await page.evaluate(async scope => {
				const {desktop} = window as unknown as GateWindow;
				const results = await Promise.all([
					desktop.promptThread({
						projectId: scope.projectId,
						threadId: scope.threadId,
						text: 'must not queue',
					}),
					desktop.setThreadMode({
						projectId: scope.projectId,
						threadId: scope.threadId,
						mode: 'plan',
					}),
					desktop.setProjectConfigOption({
						projectId: scope.projectId,
						revision: scope.revision,
						configId: 'model',
						value: 'confirmed',
					}),
					desktop.answerThreadPermission({
						projectId: scope.projectId,
						threadId: scope.threadId,
						requestId: 'unoffered',
						optionId: 'allow',
					}),
				]);
				return results.map(result =>
					result.ok ? 'accepted' : result.error.code,
				);
			}, scope);
			expect(refusals).toEqual(['BUSY', 'BUSY', 'BUSY', 'DENIED']);
			const before = await page.evaluate(async scope => {
				const result = await (
					window as unknown as GateWindow
				).desktop.getThreadSnapshot({
					projectId: scope.projectId,
					threadId: scope.threadId,
				});
				if (!result.ok) throw new Error(result.error.code);
				return result.value;
			}, scope);
			writeFileSync(path.join(project, '.fake-replay-release'), outcome);
			const restarted = await page.evaluate(
				() => (window as unknown as GateWindow).replayRestart,
			);
			expect(restarted?.ok).toBe(true);
			expect(restarted?.ok && restarted.value.status).toBe(
				outcome === 'complete' ? 'ready' : 'failed',
			);
			if (outcome !== 'complete') {
				if (outcome === 'missing') {
					const notice = page.getByRole('region', {name: 'view-only thread'});
					await expect(notice).toContainText(missingNotice);
					await expect(input).toHaveCount(0);
					await expect(send).toHaveCount(0);
					await expect(mode).toHaveCount(0);
					await expect(
						notice.getByRole('button', {
							name: '＋ new thread in project',
							exact: true,
						}),
					).toBeEnabled();
					await expect(
						notice.getByRole('button', {
							name: 'remove from desktop',
							exact: true,
						}),
					).toBeEnabled();
				} else {
					await expect(page.locator('.composer-hint-row')).toContainText(
						failed,
					);
					await expect(input).toBeEnabled();
					await input.fill('draft after replay failure');
					await input.press('Enter');
					await expect(input).toHaveValue('draft after replay failure');
					await expect(send).toBeDisabled();
					await expect(mode).toBeDisabled();
				}
				await expect(
					page.locator(
						'[role="combobox"][aria-label^="model for every thread"]:enabled',
					),
				).toHaveCount(0);
				const phases = await page.evaluate(
					() => (window as unknown as GateWindow).probe.events,
				);
				expect(phases.map(event => event.phase)).toEqual(['begin', 'failed']);
				expect(new Set(phases.map(event => event.epoch)).size).toBe(1);
				const refusal = await page.evaluate(async scope => {
					const {desktop} = window as unknown as GateWindow;
					const results = await Promise.all([
						desktop.promptThread({
							projectId: scope.projectId,
							threadId: scope.threadId,
							text: 'must remain refused',
						}),
						desktop.setThreadMode({
							projectId: scope.projectId,
							threadId: scope.threadId,
							mode: 'plan',
						}),
						desktop.setProjectConfigOption({
							projectId: scope.projectId,
							revision: scope.revision,
							configId: 'model',
							value: 'confirmed',
						}),
						desktop.answerThreadPermission({
							projectId: scope.projectId,
							threadId: scope.threadId,
							requestId: 'unoffered',
							optionId: 'allow',
						}),
					]);
					return results.map(result => result.ok);
				}, scope);
				expect(refusal).toEqual([false, false, false, false]);
				const after = await page.evaluate(async scope => {
					const result = await (
						window as unknown as GateWindow
					).desktop.getThreadSnapshot({
						projectId: scope.projectId,
						threadId: scope.threadId,
					});
					if (!result.ok) throw new Error(result.error.code);
					return result.value;
				}, scope);
				expect(after.events).toEqual(before.events);
				expect(after.result).toEqual(before.result);
				expect(after.thread.id).toBe(before.thread.id);
				expect(after.thread.nanocoderSessionId).toBe(
					before.thread.nanocoderSessionId,
				);
				expect(after.thread.title).toBe(before.thread.title);
				expect(after.thread.lastActivityAt).toBe(before.thread.lastActivityAt);
				expect(after.thread.viewOnlyReason).toBe(
					outcome === 'missing' ? missing : failed,
				);
				await expect(
					page
						.locator('.gate-message-user .stream-plain')
						.getByText('initial replay gate fixture', {exact: true}),
				).toHaveCount(1);
				return;
			}
			await page.waitForFunction(
				() => (window as unknown as GateWindow).probe.usable !== undefined,
			);
			await expect(input).toHaveValue('editable memory-only draft');
			await input.pressSequentially('x');
			await page.waitForFunction(
				() => (window as unknown as GateWindow).probe.inputMs.length > 0,
			);
			const metrics = await page.evaluate(async () => {
				const probe = (window as unknown as GateWindow).probe;
				if (
					probe.end === undefined ||
					probe.usable === undefined ||
					probe.prefix === undefined
				)
					throw new Error('Missing replay timing');
				const scroller = document.querySelector<HTMLElement>(
					'.shell-stream-scroll',
				);
				if (!scroller || scroller.scrollHeight <= scroller.clientHeight)
					throw new Error('Expected scrollable restored history');
				const scrollMs = await new Promise<number>(resolve => {
					const at = performance.now();
					scroller.addEventListener(
						'scroll',
						() => requestAnimationFrame(() => resolve(performance.now() - at)),
						{once: true},
					);
					scroller.scrollTop =
						scroller.scrollTop > 0 ? 0 : scroller.scrollHeight;
				});
				const frameMs = await new Promise<number>(resolve =>
					requestAnimationFrame(first =>
						requestAnimationFrame(second => resolve(second - first)),
					),
				);
				const eventLoopMs = await new Promise<number>(resolve => {
					const channel = new MessageChannel();
					const at = performance.now();
					channel.port1.onmessage = () => {
						channel.port1.close();
						channel.port2.close();
						resolve(performance.now() - at);
					};
					channel.port2.postMessage(null);
				});
				return {
					messages: 200,
					prefixMs: probe.prefix - probe.end,
					usableMs: probe.usable - probe.end,
					inputMs: Math.max(...probe.inputMs),
					scrollMs,
					frameMs,
					eventLoopMs,
				};
			});
			console.info('PERF-03', JSON.stringify(metrics));
			writeFileSync(
				test.info().outputPath('perf03.json'),
				JSON.stringify(metrics, null, 2),
			);
			expect(metrics.usableMs).toBeLessThanOrEqual(2000);
			for (const response of [
				metrics.inputMs,
				metrics.scrollMs,
				metrics.frameMs,
				metrics.eventLoopMs,
			])
				expect(response).toBeLessThanOrEqual(100);
			await test.step('apply an actual post-replay mode and model', async () => {
				await choose(mode, 'plan');
				await expectValue(mode, 'plan');
				await choose(model, 'confirmed');
				await expectValue(model, 'confirmed');
			});
			await test.step('send the retained draft only after explicit click', async () => {
				await send.click();
				await expect(input).toHaveValue('');
				await expect(turnEnded(page)).toBeVisible();
			});
		} finally {
			await test.step('settle and close the owned Electron process', () =>
				app.close());
			rmSync(work, {recursive: true, force: true});
		}
	});
}
