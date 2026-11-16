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
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import {openFolderFromPalette} from './qa/open-folder';
import type {announcementHarness} from './qa/stream-announcement-harness';

interface HarnessWindow extends Window {
	streamAnnouncementFixture: {announcementHarness: typeof announcementHarness};
}

const root = path.resolve(import.meta.dirname, '..');
const work = realpathSync.native(
	mkdtempSync(path.join(tmpdir(), 'nd-announcements-')),
);
let app: ElectronApplication;
let page: Page;
let projects = 0;
const paletteKey = process.platform === 'darwin' ? 'Meta+k' : 'Control+k';
const announcement = () =>
	page.locator('[role="status"][aria-label="stream announcements"]');
const input = () => page.getByRole('textbox', {name: 'message', exact: true});
const palette = () => page.getByRole('dialog', {name: 'command palette'});

test.beforeAll(async () => {
	const cli = path.join(work, 'nanocoder/dist/cli.js');
	mkdirSync(path.dirname(cli), {recursive: true});
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
	const result = await build({
		configFile: false,
		logLevel: 'silent',
		define: {'process.env.NODE_ENV': JSON.stringify('production')},
		resolve: {alias: {'@': path.join(root, 'source')}},
		build: {
			write: false,
			minify: false,
			lib: {
				entry: path.join(root, 'e2e/qa/stream-announcement-harness.ts'),
				name: 'streamAnnouncementFixture',
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
	if (!code) throw new Error('Missing stream announcement fixture');
	app = await electron.launch({
		cwd: root,
		args: [root, `--user-data-dir=${path.join(work, 'profile')}`],
		env: qaEnvironment(process.env, {cliPath: cli, nodePath: process.execPath}),
	});
	page = await app.firstWindow();
	await page.evaluate(code);
});

test.afterAll(async () => {
	await app?.close();
	rmSync(work, {recursive: true, force: true});
});

async function open(mode: string) {
	const project = path.join(work, `project-${++projects}`);
	mkdirSync(project);
	writeFileSync(path.join(project, '.fake-nanocoder'), mode);
	await app.evaluate(({dialog}, folder) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [folder],
		})) as typeof dialog.showOpenDialog;
	}, project);
	await openFolderFromPalette(page, project);
	await expect(input()).toBeEnabled();
	await expect(announcement()).toHaveCount(1);
}

async function accessibleAnnouncement() {
	const session = await app.context().newCDPSession(page);
	try {
		const {nodes} = await session.send('Accessibility.getFullAXTree');
		const regions = nodes.filter(
			node =>
				!node.ignored &&
				node.role?.value === 'status' &&
				node.name?.value === 'stream announcements',
		);
		const ids = [...(regions[0]?.childIds ?? [])];
		const text: string[] = [];
		for (const id of ids) {
			const node = nodes.find(node => node.nodeId === id);
			if (node?.role?.value === 'StaticText')
				text.push(String(node.name?.value ?? ''));
			for (const child of node?.childIds ?? [])
				if (!ids.includes(child)) ids.push(child);
		}
		return {
			count: regions.length,
			text: text.join(' '),
			live: regions[0]?.properties?.find(property => property.name === 'live')
				?.value.value,
		};
	} finally {
		await session.detach();
	}
}

test('fake stream is rate-limited and one AX-visible node survives palette open/close mid-announcement (A11Y-04/05)', async () => {
	await page.emulateMedia({reducedMotion: 'reduce'});
	const origin = page.getByRole('button', {
		name: 'command palette',
		exact: true,
	});
	await origin.focus();
	await page.evaluate(() =>
		(
			window as unknown as HarnessWindow
		).streamAnnouncementFixture.announcementHarness.render({running: false}),
	);
	await expect(announcement()).toHaveCount(1);
	await page.evaluate(() => {
		const harness = (window as unknown as HarnessWindow)
			.streamAnnouncementFixture.announcementHarness;
		harness.observe();
		for (let index = 0; index < 300; index++)
			harness.render({running: true, text: `fixture token ${index}`});
	});
	await expect(announcement()).toHaveText('turn started');
	await expect(origin).toBeFocused();
	await page.evaluate(() => {
		const harness = (window as unknown as HarnessWindow)
			.streamAnnouncementFixture.announcementHarness;
		harness.render({
			running: false,
			text: 'fixture final answer',
			outcome: 'completed',
		});
		harness.advance(999);
	});
	await page.keyboard.press(paletteKey);
	await expect(palette()).toBeVisible();
	await expect(palette().getByRole('combobox')).toBeFocused();
	await expect(announcement()).toHaveText('turn started');
	expect(await accessibleAnnouncement()).toEqual({
		count: 1,
		text: 'turn started',
		live: 'polite',
	});
	await page.keyboard.press('Escape');
	await expect(palette()).toHaveCount(0);
	expect(await accessibleAnnouncement()).toEqual({
		count: 1,
		text: 'turn started',
		live: 'polite',
	});
	await page.evaluate(isMac => {
		(
			window as unknown as HarnessWindow
		).streamAnnouncementFixture.announcementHarness.advance(1);
		document.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'k',
				metaKey: isMac,
				ctrlKey: !isMac,
				bubbles: true,
				cancelable: true,
			}),
		);
	}, process.platform === 'darwin');
	await expect(palette()).toBeVisible();
	await expect(announcement()).toHaveText(
		'turn completed. response finished: fixture final answer',
	);
	await expect(palette().getByRole('combobox')).toBeFocused();
	expect(await accessibleAnnouncement()).toEqual({
		count: 1,
		text: 'turn completed. response finished: fixture final answer',
		live: 'polite',
	});
	await page.keyboard.press('Escape');
	await expect(palette()).toHaveCount(0);
	const state = await page.evaluate(() =>
		(
			window as unknown as HarnessWindow
		).streamAnnouncementFixture.announcementHarness.state(),
	);
	expect(state).toEqual({
		sameNode: true,
		inModal: false,
		owners: ['turn completed. response finished: fixture final answer'],
		writes: [
			{text: 'turn started', at: 0},
			{
				text: 'turn completed. response finished: fixture final answer',
				at: 1000,
			},
		],
	});
	expect(await announcement().evaluate(node => node.closest('ol'))).toBeNull();
	await page.evaluate(() =>
		(
			window as unknown as HarnessWindow
		).streamAnnouncementFixture.announcementHarness.dispose(),
	);
});

test('unmount/remount removes the old status, cancels clocks/frames and refuses every late callback (A11Y-04/05)', async () => {
	await page.keyboard.press(paletteKey);
	await expect(palette()).toBeVisible();
	const lifecycle = await page.evaluate(() => {
		const harness = (window as unknown as HarnessWindow)
			.streamAnnouncementFixture.announcementHarness;
		harness.render({running: true, manualFrames: true});
		harness.frame();
		harness.frame();
		const beforeClock = harness.resources();
		const clockCleanup = harness.unmount();
		const lateClock = harness.runRetired();
		harness.render({
			running: true,
			text: 'private stale fixture',
			manualFrames: true,
		});
		const beforeFrame = harness.resources();
		const frameCleanup = harness.unmount();
		harness.render({running: false, manualFrames: true});
		const lateFrame = harness.runRetired();
		return {
			beforeClock,
			clockCleanup,
			lateClock,
			beforeFrame,
			frameCleanup,
			lateFrame,
		};
	});
	expect(lifecycle).toEqual({
		beforeClock: {timers: 1, frames: 0},
		clockCleanup: {timers: 0, frames: 0, statuses: 0},
		lateClock: {text: 'turn started', timers: 0, frames: 0},
		beforeFrame: {timers: 0, frames: 1},
		frameCleanup: {timers: 0, frames: 0, statuses: 0},
		lateFrame: {text: '', timers: 0, frames: 0},
	});
	await expect(announcement()).toHaveCount(1);
	await expect(announcement()).toBeEmpty();
	await page.evaluate(() =>
		(
			window as unknown as HarnessWindow
		).streamAnnouncementFixture.announcementHarness.dispose(),
	);
	await expect(announcement()).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(palette()).toHaveCount(0);
});

test('finished turn includes one bounded response and does not move composer focus (A11Y-04/05)', async () => {
	await open('reported-usage');
	await input().fill('fixture completed turn');
	await page.keyboard.press('Enter');
	await expect(announcement()).toHaveText(
		'turn completed. response finished: Reported usage fixture.',
	);
	await expect(input()).toBeFocused();
	expect(await accessibleAnnouncement()).toMatchObject({
		count: 1,
		text: 'turn completed. response finished: Reported usage fixture.',
	});
});

test('the clipped status never creates document overflow or steals shell width in either theme (A11Y-04)', async () => {
	await open('reported-usage');
	await page.emulateMedia({reducedMotion: 'reduce'});
	await page.evaluate(() => {
		const fixture = document.createElement('div');
		fixture.id = 'announcement-overflow-fixture';
		fixture.style.height = '2000px';
		document.querySelector('.technical-gate')?.append(fixture);
	});
	try {
		for (const theme of ['dark', 'light']) {
			await page.evaluate(theme => {
				document.documentElement.dataset.theme = theme;
			}, theme);
			for (const width of [1240, 1020, 840, 841, 839]) {
				await page.setViewportSize({width, height: 900});
				const geometry = await page.evaluate(() => ({
					html: [
						document.documentElement.scrollWidth,
						document.documentElement.scrollHeight,
						document.documentElement.clientWidth,
					],
					body: [document.body.scrollWidth, document.body.scrollHeight],
					stream: document
						.querySelector('.shell-stream')
						?.getBoundingClientRect().width,
				}));
				expect(geometry).toEqual({
					html: [width, 900, width],
					body: [width, 900],
					stream: width - (width <= 840 ? 212 : width <= 1050 ? 232 : 260),
				});
			}
		}
	} finally {
		await page.evaluate(() =>
			document.getElementById('announcement-overflow-fixture')?.remove(),
		);
		await page.setViewportSize({width: 1240, height: 900});
	}
});

test('failed turn is announced without speaking failure payloads or taking focus (A11Y-04)', async () => {
	await open('prompt-error');
	await input().fill('fixture failed turn');
	await page.keyboard.press('Enter');
	await expect(announcement()).toHaveText('turn failed');
	await expect(input()).toBeFocused();
});

test('cancellation is distinct from failure (A11Y-04)', async () => {
	await open('wait-for-cancel');
	await input().fill('fixture cancelled turn');
	await page.keyboard.press('Enter');
	await expect(announcement()).toHaveText('turn started');
	await page.getByRole('button', {name: 'cancel turn', exact: true}).click();
	await expect(announcement()).toHaveText('turn cancelled');
});

test('approval with palette open uses its existing count, without duplicate waiting speech (A11Y-04)', async () => {
	await open('ok');
	await page.evaluate(() =>
		(
			window as unknown as HarnessWindow
		).streamAnnouncementFixture.announcementHarness.observe(),
	);
	await input().fill('fixture approval turn');
	await page.evaluate(isMac => {
		document.querySelector<HTMLFormElement>('.gate-composer')?.requestSubmit();
		document.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'k',
				metaKey: isMac,
				ctrlKey: !isMac,
				bubbles: true,
				cancelable: true,
			}),
		);
	}, process.platform === 'darwin');
	await expect(palette()).toBeVisible();
	await expect(palette()).toContainText('approval required · 1 waiting');
	await expect(palette().getByRole('combobox')).toBeFocused();
	await expect(announcement()).not.toContainText('waiting for approval');
	expect((await accessibleAnnouncement()).count).toBe(1);
	const state = await page.evaluate(() =>
		(
			window as unknown as HarnessWindow
		).streamAnnouncementFixture.announcementHarness.state(),
	);
	expect(state.sameNode).toBe(true);
	expect(state.inModal).toBe(true);
	expect(
		state.writes.some(write => write.text.includes('waiting for approval')),
	).toBe(false);
	await page.keyboard.press('Escape');
	const approval = page.getByRole('alertdialog');
	await expect(approval).toBeFocused();
	await approval.getByRole('button', {name: 'Allow', exact: true}).click();
	await expect(announcement()).toContainText('turn completed');
	await expect(announcement()).toContainText('response finished: Tool ran.');
});
