import {type ChildProcess, spawn} from 'node:child_process';
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {expect, test} from '@playwright/test';
import {childEnv, waitForExit} from '@/main/nanocoder/launch';
import type {DesktopApi} from '@/shared/desktop-api';
import {electron} from './qa/electron';
import {e2eArguments} from './qa/launch-options';

let profile: string;
test.beforeEach(() => {
	profile = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-store-e2e-')),
	);
});
test.afterEach(() => rmSync(profile, {recursive: true, force: true}));

const launch = () =>
	electron.launch({
		args: ['.', `--user-data-dir=${profile}`],
	});

test('a second instance exits and respects the profile owner window presentation policy', async () => {
	const app = await launch();
	let second: ChildProcess | undefined;
	try {
		await app.firstWindow();
		expect(
			await app.evaluate(({app: main, BrowserWindow}) => {
				const window = BrowserWindow.getAllWindows()[0];
				window.hide();
				const focus = window.focus.bind(window);
				let focused = false;
				window.focus = () => {
					focused = true;
					focus();
				};
				(globalThis as {secondInstance?: Promise<unknown>}).secondInstance =
					new Promise(resolve =>
						main.once('second-instance', () =>
							resolve({focused, visible: window.isVisible()}),
						),
					);
				return main.hasSingleInstanceLock();
			}),
		).toBe(true);
		const executable = await app.evaluate(() => process.execPath);
		const child = spawn(
			executable,
			[
				path.resolve(import.meta.dirname, '..'),
				`--user-data-dir=${profile}`,
				...e2eArguments([]),
			],
			{env: childEnv(process.env), shell: false, stdio: 'ignore'},
		);
		second = child;
		const exit = await waitForExit(child);
		expect(exit).toEqual({code: 0, signal: null});
		expect(
			await app.evaluate(
				() =>
					(globalThis as {secondInstance?: Promise<unknown>}).secondInstance,
			),
		).toEqual({
			focused: process.env.NANOCODER_E2E_VISIBLE === '1',
			visible: process.env.NANOCODER_E2E_VISIBLE === '1',
		});
		expect(app.windows()).toHaveLength(1);
	} finally {
		if (second?.exitCode === null && second.signalCode === null) second.kill();
		await app.close();
	}
});

test('a second instance reopens a windowless macOS owner with working storage IPC', async () => {
	test.skip(
		process.platform !== 'darwin',
		'Closing the last window quits the owner on non-macOS platforms',
	);
	const app = await launch();
	let second: ChildProcess | undefined;
	try {
		const first = await app.firstWindow();
		expect(
			await first.evaluate(() =>
				(window as unknown as {desktop: DesktopApi}).desktop.updateSettings({
					patch: {theme: 'light'},
				}),
			),
		).toMatchObject({ok: true, value: {theme: 'light'}});
		await app.evaluate(
			({app: main, BrowserWindow}) =>
				new Promise<void>(resolve => {
					main.once('window-all-closed', resolve);
					BrowserWindow.getAllWindows()[0].close();
				}),
		);
		expect(
			await app.evaluate(({app: main, BrowserWindow}) => ({
				windows: BrowserWindow.getAllWindows().length,
				ownsProfile: main.hasSingleInstanceLock(),
			})),
		).toEqual({windows: 0, ownsProfile: true});
		const reopened = app.waitForEvent('window');
		const executable = await app.evaluate(() => process.execPath);
		const child = spawn(
			executable,
			[
				path.resolve(import.meta.dirname, '..'),
				`--user-data-dir=${profile}`,
				...e2eArguments([]),
			],
			{env: childEnv(process.env), shell: false, stdio: 'ignore'},
		);
		second = child;
		const exit = await waitForExit(child);
		expect(exit).toEqual({code: 0, signal: null});
		const page = await reopened;
		await expect(page.getByRole('heading', {level: 1})).toHaveText(
			'Nanocoder Desktop',
		);
		expect(
			await page.evaluate(() =>
				(window as unknown as {desktop: DesktopApi}).desktop.getSettings({}),
			),
		).toMatchObject({ok: true, value: {theme: 'light'}});
		if (process.env.NANOCODER_E2E_VISIBLE === '1') {
			await app.evaluate(({BrowserWindow}) => {
				const window = BrowserWindow.getAllWindows()[0];
				if (window.isVisible()) return;
				return new Promise<void>(resolve => window.once('show', resolve));
			});
		}
		expect(
			await app.evaluate(({BrowserWindow}) =>
				BrowserWindow.getAllWindows().map(window => window.isVisible()),
			),
		).toEqual([process.env.NANOCODER_E2E_VISIBLE === '1']);
		expect(app.windows()).toHaveLength(1);
	} finally {
		if (second?.exitCode === null && second.signalCode === null) second.kill();
		await app.close();
	}
});

test('native quit ignores activation and second-instance requests during disposal', async () => {
	const app = await launch();
	try {
		await app.firstWindow();
		const result = await app.evaluate(
			({app: main, BrowserWindow}) =>
				new Promise(resolve => {
					const scope = globalThis as {
						quitProbe?: {remove(): void};
					};
					const probe = {
						inspecting: false,
						hold(event: {preventDefault(): void}) {
							if (probe.inspecting) event.preventDefault();
						},
						remove() {
							main.removeListener('before-quit', probe.hold);
						},
					};
					scope.quitProbe = probe;
					main.on('before-quit', probe.hold);
					main.once('will-quit', () => {
						probe.inspecting = true;
						const before = BrowserWindow.getAllWindows().length;
						main.emit('activate');
						const afterActivate = BrowserWindow.getAllWindows().length;
						main.emit('second-instance');
						resolve({
							before,
							afterActivate,
							afterSecondInstance: BrowserWindow.getAllWindows().length,
						});
					});
					main.quit();
				}),
		);
		expect(result).toEqual({
			before: 0,
			afterActivate: 0,
			afterSecondInstance: 0,
		});
	} finally {
		try {
			await app.evaluate(() =>
				(
					globalThis as {
						quitProbe?: {remove(): void};
					}
				).quitProbe?.remove(),
			);
		} finally {
			await app.close();
		}
	}
});

test('the built main process persists settings and UI state under userData', async () => {
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const settings = await page.evaluate(() => {
			const desktop = (window as unknown as {desktop: DesktopApi}).desktop;
			return desktop.updateSettings({
				patch: {theme: 'light', editor: 'zed', defaultMode: 'architect'},
			});
		});
		expect(settings).toMatchObject({
			ok: true,
			value: {theme: 'light', editor: 'zed'},
		});
		const state = await page.evaluate(() =>
			(window as unknown as {desktop: DesktopApi}).desktop.updateUiState({
				patch: {
					window: {
						width: 1240,
						height: 840,
						x: null,
						y: null,
						maximised: false,
					},
					inspector: 'review',
					bottomPanel: 'terminal',
				},
			}),
		);
		expect(state).toMatchObject({
			ok: true,
			value: {
				window: {width: 1240, height: 840, x: null, y: null, maximised: false},
				inspector: 'review',
				bottomPanel: 'terminal',
			},
		});
		const location = await app.evaluate(({app: main}) => ({
			path: main.getPath('userData'),
			electron: process.versions.electron,
			node: process.versions.node,
		}));
		expect(realpathSync.native(location.path)).toBe(profile);
		expect(location.electron).toMatch(/^\d+\./);
		expect(location.node).toMatch(/^\d+\./);
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		expect(
			await page.evaluate(() =>
				(window as unknown as {desktop: DesktopApi}).desktop.getSettings({}),
			),
		).toEqual(settings);
		expect(
			await page.evaluate(() =>
				(window as unknown as {desktop: DesktopApi}).desktop.getUiState({}),
			),
		).toEqual(state);
		const db = new DatabaseSync(path.join(profile, 'desktop.sqlite'), {
			readOnly: true,
		});
		try {
			expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(7);
			expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
		} finally {
			db.close();
		}
	} finally {
		await app.close();
	}
});

test('the built app quarantines a corrupt store and keeps starting', async () => {
	const corrupt = Buffer.from('fixture corrupt SQLite database');
	writeFileSync(path.join(profile, 'desktop.sqlite'), corrupt);
	const app = await launch();
	try {
		const page = await app.firstWindow();
		await expect(page.getByRole('heading', {level: 1})).toHaveText(
			'Nanocoder Desktop',
		);
		expect(
			await page.evaluate(() =>
				(window as unknown as {desktop: DesktopApi}).desktop.getSettings({}),
			),
		).toMatchObject({ok: true, value: {defaultMode: 'normal'}});
		const quarantine = readdirSync(profile).filter(name =>
			name.startsWith('desktop.sqlite.corrupt-'),
		);
		expect(quarantine).toHaveLength(1);
		expect(
			readFileSync(path.join(profile, quarantine[0], 'desktop.sqlite')),
		).toEqual(corrupt);
		// The user is told the saved data was set aside, and where (P4-02).
		const info = (await page.evaluate(() =>
			(window as unknown as {desktop: DesktopApi}).desktop.getAppInfo(),
		)) as {ok: true; value: {recoveredDatabase?: string}};
		expect(path.basename(info.value.recoveredDatabase ?? '')).toBe(
			quarantine[0],
		);
		await expect(
			page.getByRole('status').filter({hasText: 'could not be read'}),
		).toContainText(quarantine[0]);
	} finally {
		await app.close();
	}
});

test('a healthy store gives no notice that saved data was set aside', async () => {
	const app = await launch();
	try {
		const page = await app.firstWindow();
		await expect(page.getByRole('heading', {level: 1})).toHaveText(
			'Nanocoder Desktop',
		);
		await expect(
			page.getByRole('status').filter({hasText: 'could not be read'}),
		).toHaveCount(0);
		expect(
			await page.evaluate(() =>
				(window as unknown as {desktop: DesktopApi}).desktop.getAppInfo(),
			),
		).toEqual({
			ok: true,
			value: {name: 'Nanocoder Desktop', version: expect.any(String)},
		});
	} finally {
		await app.close();
	}
});

test('Electron backs up the previous schema before upgrading it', async () => {
	const {migrations} = await import('@/main/store/migrations');
	const db = new DatabaseSync(path.join(profile, 'desktop.sqlite'));
	db.exec(migrations[0].sql);
	db.prepare('INSERT INTO schema_migration VALUES (?, ?)').run(
		1,
		'2026-10-28T12:00:00.000Z',
	);
	db.prepare('INSERT INTO setting VALUES (?, ?)').run('theme', '"light"');
	db.exec('PRAGMA user_version = 1');
	db.close();
	const app = await launch();
	try {
		const page = await app.firstWindow();
		expect(
			await page.evaluate(() =>
				(window as unknown as {desktop: DesktopApi}).desktop.getSettings({}),
			),
		).toMatchObject({ok: true, value: {theme: 'light'}});
		const backups = readdirSync(profile).filter(name =>
			name.startsWith('desktop.sqlite.backup-'),
		);
		expect(backups).toHaveLength(1);
		const backup = new DatabaseSync(path.join(profile, backups[0]), {
			readOnly: true,
		});
		try {
			expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
			expect(
				backup
					.prepare(
						"SELECT count(*) AS n FROM sqlite_schema WHERE name = 'ui_state'",
					)
					.get()?.n,
			).toBe(0);
		} finally {
			backup.close();
		}
	} finally {
		await app.close();
	}
});

test('the store bridge refuses secret/content patches and runtime paths without persisting them', async () => {
	const app = await launch();
	const marker = 'fixture-never-persist-e2e-content';
	try {
		const page = await app.firstWindow();
		const results = await page.evaluate(async value => {
			const desktop = (window as unknown as {desktop: DesktopApi}).desktop;
			return Promise.all([
				desktop.updateSettings({patch: {apiKey: value}} as never),
				desktop.updateSettings({
					patch: {nanocoderOverridePath: value},
				} as never),
				desktop.updateSettings({patch: {defaultMode: 'yolo'}} as never),
				desktop.updateSettings({
					patch: {browserProfiles: [], browserAssignments: {}},
				} as never),
				desktop.updateUiState({patch: {draft: value}} as never),
				desktop.updateUiState({patch: {toolOutput: value}} as never),
			]);
		}, marker);
		for (const result of results)
			expect(result).toMatchObject({ok: false, error: {code: 'VALIDATION'}});
	} finally {
		await app.close();
	}
	for (const name of readdirSync(profile).filter(name =>
		/^desktop\.sqlite(?:-(?:wal|shm))?$/.test(name),
	)) {
		expect(readFileSync(path.join(profile, name)).includes(marker)).toBe(false);
	}
});
