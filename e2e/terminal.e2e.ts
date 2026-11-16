import {
	copyFileSync,
	existsSync,
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
import type {IpcResult} from '@/shared/ipc';
import type {TerminalRequests, TerminalSnapshot} from '@/shared/terminal';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import {openSeededProject} from './qa/seeded-project';
import {visibleTextContrast} from './qa/ui-contrast';

let work: string;
let app: ElectronApplication;
let page: Page;
let projectId: string;

function call<K extends keyof TerminalRequests>(
	key: K,
	request: TerminalRequests[K],
): Promise<IpcResult<TerminalSnapshot>> {
	return page.evaluate(
		({key, request}) => {
			const api = (window as unknown as {desktop: DesktopApi}).desktop.terminal;
			return (
				api[key] as (request: unknown) => Promise<IpcResult<TerminalSnapshot>>
			)(request);
		},
		{key, request},
	);
}

test.beforeEach(async () => {
	work = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nd-terminal-')));
	mkdirSync(path.join(work, 'project'));
	const home = path.join(work, 'home');
	mkdirSync(home);
	for (const profile of ['.zshrc', '.bash_profile', '.bashrc']) {
		writeFileSync(
			path.join(home, profile),
			"PS1='$ '\nPROMPT='$ '\nHISTFILE=/dev/null\n",
		);
	}
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
	app = await electron.launch({
		args: ['.', `--user-data-dir=${path.join(work, 'profile')}`],
		env: qaEnvironment(
			{...process.env, HOME: home},
			{
				cliPath: path.join(work, 'nanocoder/dist/cli.js'),
				nodePath: process.execPath,
			},
		),
	});
	page = await app.firstWindow();
	await app.evaluate(
		({dialog}, root) => {
			dialog.showOpenDialog = (async () => ({
				canceled: false,
				filePaths: [root],
			})) as typeof dialog.showOpenDialog;
		},
		path.join(work, 'project'),
	);
	const added = await page.evaluate(() =>
		(window as unknown as {desktop: DesktopApi}).desktop.addProject({}),
	);
	if (!added.ok || added.value.status !== 'selected')
		throw new Error('Project was not added');
	projectId = added.value.project.id;
	const opened = await page.evaluate(
		projectId =>
			(window as unknown as {desktop: DesktopApi}).desktop.openProject({
				projectId,
			}),
		projectId,
	);
	expect(opened).toMatchObject({ok: true, value: {status: 'opened'}});
});

test.afterEach(async () => {
	await app.close().catch(() => {});
	rmSync(work, {recursive: true, force: true});
});

async function nestedServer(): Promise<number[]> {
	const started = await call('start', {projectId});
	expect(started).toMatchObject({ok: true, value: {status: 'running'}});
	if (!started.ok) throw new Error('Terminal unavailable');
	const child = path.join(work, 'child.cjs');
	const parent = path.join(work, 'parent.cjs');
	writeFileSync(
		child,
		'process.on("SIGTERM",()=>{}); process.on("SIGHUP",()=>{}); require("node:net").createServer().listen(0,"127.0.0.1",()=>console.log("CHILD_PID="+process.pid));',
	);
	writeFileSync(
		parent,
		'process.on("SIGTERM",()=>{}); process.on("SIGHUP",()=>{}); console.log("PARENT_PID="+process.pid); const child=require("node:child_process").spawn(process.execPath,[process.argv[2]],{stdio:["ignore","pipe","inherit"]}); child.stdout.pipe(process.stdout);',
	);
	const prefix =
		process.platform === 'win32' &&
		!started.value.shell?.toLowerCase().endsWith('cmd.exe')
			? '& '
			: '';
	await call('write', {
		projectId,
		data: `${prefix}"${process.execPath}" "${parent}" "${child}"\r`,
	});
	let pids: number[] = [];
	await expect
		.poll(async () => {
			const result = await call('get', {projectId});
			if (!result.ok) return 0;
			pids = [
				...result.value.output.matchAll(/(?:PARENT|CHILD)_PID=(\d+)/gu),
			].map(value => Number(value[1]));
			return pids.length;
		})
		.toBe(2);
	for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();
	return pids;
}

async function expectGone(pids: number[]): Promise<void> {
	await expect
		.poll(() =>
			pids.every(pid => {
				try {
					process.kill(pid, 0);
					return false;
				} catch {
					return true;
				}
			}),
		)
		.toBe(true);
}

test('TERM-07 stop kills a parent node server and its child across process groups', async () => {
	const pids = await nestedServer();
	expect(await call('stop', {projectId})).toMatchObject({
		ok: true,
		value: {status: 'stopped'},
	});
	await expectGone(pids);
});

test('TERM-07 project switch waits for the old server tree to stop', async () => {
	const pids = await nestedServer();
	const oldProjectId = projectId;
	const other = path.join(work, 'other');
	mkdirSync(other);
	await app.evaluate(({dialog}, root) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [root],
		})) as typeof dialog.showOpenDialog;
	}, other);
	const selected = await page.evaluate(async () => {
		const api = (window as unknown as {desktop: DesktopApi}).desktop;
		const added = await api.addProject({});
		if (!added.ok || added.value.status !== 'selected')
			throw new Error('No project');
		return api.openProject({projectId: added.value.project.id});
	});
	expect(selected).toMatchObject({ok: true, value: {status: 'opened'}});
	await expectGone(pids);
	expect(
		await call('write', {projectId: oldProjectId, data: 'never\r'}),
	).toMatchObject({ok: false, error: {code: 'DENIED'}});
});

test('TERM-07 app quit awaits the whole server tree', async () => {
	const pids = await nestedServer();
	await app.close();
	await expectGone(pids);
});

test('TERM-01 a native utility-process crash leaves main alive and cleans the server tree', async () => {
	const pids = await nestedServer();
	const workerPid = await app.evaluate(
		({app}) =>
			app
				.getAppMetrics()
				.find(
					metric =>
						metric.name === 'Nanocoder project terminal' ||
						metric.serviceName === 'Nanocoder project terminal',
				)?.pid,
	);
	expect(workerPid).toBeTruthy();
	process.kill(workerPid ?? 0, 'SIGKILL');
	await expect
		.poll(async () => {
			const state = await call('get', {projectId});
			return state.ok ? state.value.status : 'unavailable';
		})
		.toBe('failed');
	await expectGone(pids);
	expect(
		await page.evaluate(() =>
			(window as unknown as {desktop: DesktopApi}).desktop.getAppInfo(),
		),
	).toMatchObject({ok: true});
	expect(await call('restart', {projectId})).toMatchObject({
		ok: true,
		value: {status: 'running'},
	});
});

test('TERM-12 agent command approval metadata never starts or writes the user PTY', async () => {
	await openSeededProject(page, path.join(work, 'project'));
	await page.getByRole('button', {name: 'open terminal', exact: true}).click();
	const created = await page.evaluate(
		projectId =>
			(window as unknown as {desktop: DesktopApi}).desktop.createThread({
				projectId,
			}),
		projectId,
	);
	if (!created.ok) throw new Error('No fixture thread');
	const threadId = created.value.id;
	const prompting = page.evaluate(
		({projectId, threadId}) =>
			(window as unknown as {desktop: DesktopApi}).desktop.promptThread({
				projectId,
				threadId,
				text: 'fixture command',
			}),
		{projectId, threadId},
	);
	await expect
		.poll(async () => {
			const state = await call('get', {projectId});
			return state.ok ? state.value.agentCommand?.approval : undefined;
		})
		.toBe('pending');
	const snapshot = await page.evaluate(
		({projectId, threadId}) =>
			(window as unknown as {desktop: DesktopApi}).desktop.getThreadSnapshot({
				projectId,
				threadId,
			}),
		{projectId, threadId},
	);
	if (!snapshot.ok) throw new Error('No fixture snapshot');
	const permission = snapshot.value.events.find(
		event => event.type === 'permission',
	);
	if (!permission || permission.type !== 'permission')
		throw new Error('No fixture permission');
	const optionId = permission.request.options.find(
		option => option.kind === 'allow_once',
	)?.id;
	if (!optionId) throw new Error('No fixture allow option');
	const answer = await page.evaluate(
		request =>
			(
				window as unknown as {desktop: DesktopApi}
			).desktop.answerThreadPermission(request),
		{projectId, threadId, requestId: permission.request.id, optionId},
	);
	expect(answer).toMatchObject({ok: true});
	await prompting;
	expect(await call('get', {projectId})).toMatchObject({
		ok: true,
		value: {
			status: 'stopped',
			shell: null,
			output: '',
			agentCommand: {command: 'echo hi', approval: 'allowed'},
		},
	});
	await expect(page.locator('.terminal-panel')).not.toContainText('echo hi');
	// Preserve cross-platform metadata checks; the printf UI fixture is POSIX.
	if (process.platform === 'win32') return;
	await page.locator(`[data-thread-id="${threadId}"] .thread-open`).click();
	await page.getByRole('button', {name: 'start terminal', exact: true}).click();
	await expect(
		page.getByRole('textbox', {name: 'your terminal input'}),
	).toBeFocused();
	await page.keyboard.insertText(
		"printf '\\165\\163\\145\\162\\040\\164\\145\\162\\155\\151\\156\\141\\154\\040\\162\\145\\141\\144\\171\\n'",
	);
	await page.keyboard.press('Enter');
	await expect(page.locator('.terminal-view')).toContainText(
		'user terminal ready',
	);
	const draft = page.getByRole('textbox', {name: 'message', exact: true});
	await draft.fill('kept terminal QA draft');
	const screenshots = path.resolve('.qa/terminal-ui');
	mkdirSync(screenshots, {recursive: true});
	for (const theme of ['dark', 'light']) {
		await page.evaluate(theme => {
			document.documentElement.dataset.theme = theme;
		}, theme);
		for (const width of [1240, 1020, 840]) {
			await page.setViewportSize({width, height: 900});
			await expect(draft).toBeEditable();
			await draft.fill(`kept ${theme} ${width} terminal QA draft`);
			await expect(draft).toHaveValue(
				`kept ${theme} ${width} terminal QA draft`,
			);
			await expect(
				page.getByRole('button', {name: 'send', exact: true}),
			).toBeEnabled();
			expect(
				await draft.evaluate(input => {
					const rect = input.getBoundingClientRect();
					const dock = document
						.querySelector('.terminal-panel')
						?.getBoundingClientRect();
					return (
						dock !== undefined &&
						rect.top >= 0 &&
						rect.bottom <= dock.top &&
						rect.left >= 0 &&
						rect.right <= innerWidth
					);
				}),
			).toBe(true);
			await expect
				.poll(async () => {
					const state = await call('get', {projectId});
					if (!state.ok) return false;
					return page
						.locator('.xterm-screen')
						.evaluate(
							(screen, cols) =>
								screen.clientWidth > 0 &&
								screen.clientWidth <=
									(screen.parentElement?.clientWidth ?? 0) &&
								cols >= 2,
							state.value.cols,
						);
				})
				.toBe(true);
			expect(await visibleTextContrast(page, theme)).toEqual([]);
			const geometry = await page
				.locator('.terminal-panel')
				.evaluate(element => ({
					width: element.clientWidth,
					scrollWidth: element.scrollWidth,
					height: element.clientHeight,
					ligatures: getComputedStyle(
						element.querySelector('.terminal-view') ?? element,
					).fontVariantLigatures,
				}));
			expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
			expect(geometry.height).toBeGreaterThan(240);
			expect(geometry.ligatures).toBe('none');
			const viewportColors = await page
				.locator('.xterm-viewport')
				.evaluate(viewport => ({
					actual: getComputedStyle(viewport).backgroundColor,
					expected: getComputedStyle(
						viewport.closest('.terminal-panel') ?? viewport,
					).backgroundColor,
					token: getComputedStyle(viewport)
						.getPropertyValue('--colors-surface-panel')
						.trim(),
				}));
			expect(viewportColors.actual).toBe(viewportColors.expected);
			console.info('[terminal-ui] viewport', theme, width, viewportColors);
			await page.screenshot({
				path: path.join(screenshots, `terminal-${theme}-${width}.png`),
			});
		}
	}
});

test('TERM-02/04/06/11 mounted terminal types, escapes, restarts, clears and stops without trapping focus', async () => {
	test.skip(
		process.platform === 'win32',
		'POSIX printf fixture; Windows UI acceptance is separate',
	);
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	const step = async (name: string, action: () => Promise<void>) => {
		console.info('[terminal-ui]', name);
		await test.step(name, action);
	};
	const input = page.getByRole('textbox', {name: 'your terminal input'});
	await step('open project and terminal', async () => {
		await openSeededProject(page, path.join(work, 'project'));
		await page
			.getByRole('button', {name: 'open terminal', exact: true})
			.click();
		expect(await call('get', {projectId})).toMatchObject({
			ok: true,
			value: {status: 'stopped'},
		});
	});
	await step('start terminal', async () => {
		const start = page.getByRole('button', {
			name: 'start terminal',
			exact: true,
		});
		await expect(start).toBeVisible();
		await expect(start).toBeEnabled();
		const inspected = await start.evaluate(button => {
			const rect = button.getBoundingClientRect();
			const hit = document.elementFromPoint(
				rect.x + rect.width / 2,
				rect.y + rect.height / 2,
			);
			return {
				hit: hit === button || (hit !== null && button.contains(hit)),
				inViewport: rect.top >= 0 && rect.bottom <= innerHeight,
			};
		});
		expect(inspected).toEqual({hit: true, inViewport: true});
		expect(
			await page.locator('.shell-conversation-footer').evaluate(footer => {
				const dock = document
					.querySelector('.terminal-panel')
					?.getBoundingClientRect();
				return (
					dock !== undefined &&
					footer.getBoundingClientRect().bottom <= dock.top + 1
				);
			}),
		).toBe(true);
		await start.click();
		await expect(input).toBeFocused();
	});
	await step('type UTF-8', async () => {
		await expect(
			page.getByRole('button', {name: 'screen-reader mode off'}),
		).toHaveAttribute('aria-pressed', 'false');
		await page.keyboard.insertText(
			"printf '\\143\\141\\146\\303\\251 UI_READY\\n'",
		);
		await page.keyboard.press('Enter');
		await expect(page.locator('.terminal-view')).toContainText('café UI_READY');
	});
	await step(
		'ANSI colours are painted in both themes although the style policy blocks inline styles',
		async () => {
			await page.keyboard.insertText(
				"printf '\\033[31mRED_TEXT\\033[0m \\033[42mGREEN_BG\\033[0m\\n'",
			);
			await page.keyboard.press('Enter');
			const view = page.locator('.terminal-view');
			const span = (text: string) =>
				view.locator('.xterm-rows').getByText(text, {exact: true});
			// Each element is named, so a failure says which one is absent.
			await expect(span('RED_TEXT')).toBeVisible();
			await expect(span('GREEN_BG')).toBeVisible();
			await expect(view.locator('.xterm-cursor')).toBeVisible();
			// The terminal theme maps ANSI red, ANSI green and the cursor to design tokens.
			const tokens = () =>
				page.evaluate(() => {
					const token = (name: string) => {
						const probe = document.createElement('span');
						probe.style.backgroundColor = `var(${name})`;
						document.body.append(probe);
						const colour = getComputedStyle(probe).backgroundColor;
						probe.remove();
						return colour;
					};
					return {
						red: token('--colors-error'),
						green: token('--colors-success'),
						cursor: token('--colors-primary'),
					};
				});
			const painted = () =>
				view.evaluate(root => {
					const style = (selector: string, text?: string) => {
						const found = [...root.querySelectorAll(selector)].find(
							element => text === undefined || element.textContent === text,
						);
						return found ? getComputedStyle(found) : null;
					};
					return {
						red: style('.xterm-rows span', 'RED_TEXT')?.color,
						green: style('.xterm-rows span', 'GREEN_BG')?.backgroundColor,
						cursor: style('.xterm-cursor')?.backgroundColor,
					};
				});
			const expectTokens = async () => {
				const want = await tokens();
				await expect.poll(painted).toEqual(want);
			};
			await expectTokens();
			// A theme change makes xterm rewrite its own stylesheet, which the mirror must carry over.
			await page.evaluate(() =>
				document.documentElement.setAttribute('data-theme', 'light'),
			);
			await expectTokens();
			await page.evaluate(() =>
				document.documentElement.removeAttribute('data-theme'),
			);
			await expectTokens();
			// Every rule element xterm writes lives inside the terminal and is mirrored,
			// including the selection and scrollbar rules.
			const rules = await page.evaluate(() => ({
				outside: [...document.querySelectorAll('style')].filter(
					style => !style.closest('.terminal-view'),
				).length,
				mirrored: document.adoptedStyleSheets
					.map(sheet =>
						[...sheet.cssRules].map(rule => rule.cssText).join('\n'),
					)
					.join('\n'),
			}));
			expect(rules.outside).toBe(0);
			expect(rules.mirrored).toContain('.scrollbar > .slider');
			expect(rules.mirrored).toContain('xterm-selection');
		},
	);
	await step('keyboard escape and focus return', async () => {
		await input.press('Control+Shift+Tab');
		await expect(
			page.getByRole('button', {name: 'focus your terminal'}),
		).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(input).not.toBeFocused();
		await page.getByRole('button', {name: 'focus your terminal'}).click();
		await expect(input).toBeFocused();
	});
	await step('screen-reader mode', async () => {
		await page.getByRole('button', {name: 'screen-reader mode off'}).click();
		await expect(
			page.getByRole('button', {name: 'screen-reader mode on'}),
		).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('.xterm-accessibility')).toHaveCount(1);
		await expect(page.locator('.xterm-accessibility')).toContainText(
			'café UI_READY',
		);
		expect(await page.locator('.terminal-view').ariaSnapshot()).toContain(
			'café UI_READY',
		);
	});
	await step('clear terminal', async () => {
		await page.getByRole('button', {name: 'clear', exact: true}).click();
		await expect
			.poll(async () => {
				const state = await call('get', {projectId});
				return state.ok ? state.value.output : null;
			})
			.toBe('');
		await expect(page.locator('.terminal-view')).not.toContainText('UI_READY');
	});
	await step('restart terminal', async () => {
		const before = await call('get', {projectId});
		if (!before.ok) throw new Error('No terminal before restart');
		await page.getByRole('button', {name: 'restart', exact: true}).click();
		await expect(input).toBeFocused();
		await expect
			.poll(async () => {
				const current = await call('get', {projectId});
				return (
					current.ok &&
					current.value.status === 'running' &&
					current.value.sequence > before.value.sequence &&
					current.value.output.length > 0
				);
			})
			.toBe(true);
		// Screen-reader mode uses key events, not insertText-only IME events.
		await page.keyboard.type(
			"printf '\\162\\145\\163\\164\\141\\162\\164\\145\\144\\n'",
		);
		await page.keyboard.press('Enter');
		await expect(page.locator('.terminal-view')).toContainText('restarted');
		const current = await call('get', {projectId});
		expect(current.ok && current.value.output.includes('restarted')).toBe(true);
		await expect(page.locator('.terminal-view')).not.toContainText('UI_READY');
	});
	await step('stop terminal', async () => {
		await page.getByRole('button', {name: 'stop', exact: true}).click();
		await expect
			.poll(async () => {
				const state = await call('get', {projectId});
				return state.ok ? state.value.status : null;
			})
			.toBe('stopped');
		await expect(page.locator('.terminal-view')).not.toContainText('restarted');
	});
	await step('close and reopen panel without starting', async () => {
		await page.getByRole('button', {name: 'close terminal panel'}).click();
		await expect(
			page.getByRole('button', {name: 'open terminal', exact: true}),
		).toBeFocused();
		await expect(page.locator('.terminal-panel')).toHaveCount(0);
		await page
			.getByRole('button', {name: 'open terminal', exact: true})
			.click();
		await expect(
			page.getByRole('button', {name: 'start terminal', exact: true}),
		).toBeEnabled();
		expect(await call('get', {projectId})).toMatchObject({
			ok: true,
			value: {status: 'stopped', output: ''},
		});
	});
	expect(errors).toEqual([]);
});

test('TERM-01 packaged asar worker loads its native addon and spawn helper without showing a window', async () => {
	test.skip(process.platform !== 'darwin', 'Local macOS packaged-worker proof');
	const workerPath = path.resolve(
		'release/mac-arm64/Nanocoder Desktop.app/Contents/Resources/app.asar/out/main/pty-worker.js',
	);
	test.skip(
		!existsSync(path.dirname(path.dirname(path.dirname(workerPath)))),
		'Run pnpm package:dir first',
	);
	const loaded = await app.evaluate(
		async ({utilityProcess}, {workerPath, root}) => {
			const worker = utilityProcess.fork(workerPath, [], {
				stdio: 'ignore',
				execArgv: [],
				env: {PATH: '/usr/bin:/bin'},
			});
			return new Promise<boolean>((resolve, reject) => {
				let pid: number | undefined;
				let completed = false;
				const finish = (success: boolean) => {
					if (completed) return;
					completed = true;
					clearTimeout(deadline);
					if (pid) {
						try {
							process.kill(pid, 'SIGKILL');
						} catch {}
					}
					worker.kill();
					if (success) resolve(true);
					else
						reject(
							new Error('The packaged PTY did not produce fixture output'),
						);
				};
				const deadline = setTimeout(() => finish(false), 5000);
				worker.once('spawn', () =>
					worker.postMessage({
						type: 'start',
						launch: {
							root,
							roots: [root],
							shell: {file: '/bin/sh', args: ['-i']},
							env: {PATH: '/usr/bin:/bin', TERM: 'xterm-256color'},
							cols: 80,
							rows: 24,
						},
					}),
				);
				worker.on(
					'message',
					(event: {type: string; pid?: number; data?: string}) => {
						if (event.type === 'ready') {
							pid = event.pid;
							worker.postMessage({
								type: 'write',
								data: "printf '\\120\\101\\103\\113\\101\\107\\105\\104\\137\\120\\124\\131\\137\\117\\113\\n'\r",
							});
						} else if (event.type === 'data') {
							if (event.data?.includes('PACKAGED_PTY_OK')) finish(true);
							else worker.postMessage({type: 'ack'});
						} else if (event.type === 'failed') finish(false);
					},
				);
				worker.once('exit', () => finish(false));
			});
		},
		{workerPath, root: path.join(work, 'project')},
	);
	expect(loaded).toBe(true);
});

test('TERM-01/04/07 built main hosts a real UTF-8 PTY and stop leaves no nested server', async () => {
	test.skip(
		process.platform === 'win32',
		'POSIX shell fixture; Windows tree coverage requires its PowerShell fixture',
	);
	expect(await call('start', {projectId})).toMatchObject({
		ok: true,
		value: {status: 'running'},
	});
	const server = path.join(work, 'server.cjs');
	writeFileSync(
		server,
		'process.on("SIGTERM",()=>{}); process.on("SIGHUP",()=>{}); require("node:net").createServer().listen(0,"127.0.0.1",()=>process.stdout.write("SERVER_PID="+process.pid+"\\n"));',
	);
	await call('write', {projectId, data: `"${process.execPath}" "${server}"\r`});
	let serverPid = 0;
	await expect
		.poll(async () => {
			const result = await call('get', {projectId});
			if (!result.ok) return false;
			const match = /SERVER_PID=(\d+)/u.exec(result.value.output);
			if (match) serverPid = Number(match[1]);
			return !!match;
		})
		.toBe(true);
	expect(() => process.kill(serverPid, 0)).not.toThrow();
	expect(await call('stop', {projectId})).toMatchObject({
		ok: true,
		value: {status: 'stopped', output: ''},
	});
	await expect
		.poll(() => {
			try {
				process.kill(serverPid, 0);
				return true;
			} catch {
				return false;
			}
		})
		.toBe(false);
	expect(await call('restart', {projectId})).toMatchObject({
		ok: true,
		value: {status: 'running'},
	});
	await call('write', {
		projectId,
		data: "printf '\\143\\141\\146\\303\\251 😀\\n'\r",
	});
	await expect
		.poll(async () => {
			const result = await call('get', {projectId});
			return result.ok && result.value.output.includes('café 😀');
		})
		.toBe(true);
});
