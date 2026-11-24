import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {cpus, release, tmpdir, totalmem} from 'node:os';
import path from 'node:path';
import {
	type ElectronApplication,
	expect,
	type Page,
	test,
} from '@playwright/test';
import {setupProject} from '@/main/nanocoder/fixtures/real-nanocoder';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';
import {turnEnded} from './qa/turn-state';

const root = path.resolve(import.meta.dirname, '..');
const paletteKey = process.platform === 'darwin' ? 'Meta+k' : 'Control+k';
const machine = {
	platform: process.platform,
	arch: process.arch,
	osRelease: release(),
	cpu: cpus()[0]?.model,
	logicalCpus: cpus().length,
	memoryGiB: Math.round(totalmem() / 1024 ** 3),
	node: process.version,
};

async function fixture(
	run: (app: ElectronApplication, page: Page, project: string) => Promise<void>,
	realCli?: string,
) {
	realCli = realCli?.trim() || undefined;
	const work = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), 'nd-exit-checks-')),
	);
	const cli = path.join(work, 'nanocoder/dist/cli.js');
	const project = path.join(work, 'project');
	mkdirSync(path.dirname(cli), {recursive: true});
	mkdirSync(project);
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
	let app: ElectronApplication | undefined;
	let real: Awaited<ReturnType<typeof setupProject>> | undefined;
	try {
		if (realCli) {
			expect(path.isAbsolute(realCli)).toBe(true);
			real = await setupProject(work, 'real', []);
		}
		const start = performance.now();
		app = await electron.launch({
			cwd: root,
			args: [root, `--user-data-dir=${path.join(work, 'profile')}`],
			env: qaEnvironment(real?.env ?? process.env, {
				cliPath: realCli ?? cli,
				nodePath: process.execPath,
			}),
		});
		const page = await app.firstWindow();
		expect(page.url()).toMatch(/^app:\/\/renderer\//);
		await page
			.getByRole('button', {name: 'switch project', exact: true})
			.click();
		const projects = page.getByRole('dialog', {name: 'your projects'});
		await expect(projects).toBeVisible();
		const recents = projects.getByRole('region', {name: 'recent projects'});
		await expect(recents.getByText('no recent projects')).toBeVisible();
		const add = projects.getByRole('button', {name: 'add project folder'});
		await expect(add).toBeEnabled();
		await add.focus();
		await expect(add).toBeFocused();
		const readyMs = performance.now() - start;
		await page.keyboard.press('Escape');
		await expect(projects).toBeHidden();
		await run(app, page, real?.root ?? project);
		return readyMs;
	} finally {
		try {
			await app?.close();
		} finally {
			try {
				await real?.provider.close();
			} finally {
				rmSync(work, {recursive: true, force: true});
			}
		}
	}
}

async function selectFolder(app: ElectronApplication, project: string) {
	await app.evaluate(({dialog}, folder) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [folder],
		})) as typeof dialog.showOpenDialog;
		dialog.showMessageBox = (async () => ({
			response: 0,
			checkboxChecked: false,
		})) as typeof dialog.showMessageBox;
	}, project);
}

async function accessibleControls(page: Page) {
	const session = await page.context().newCDPSession(page);
	try {
		const {nodes} = await session.send('Accessibility.getFullAXTree');
		const roles = new Set([
			'button',
			'textbox',
			'combobox',
			'option',
			'checkbox',
			'radio',
			'tab',
			'DisclosureTriangle',
		]);
		const controls = nodes.filter(
			node => !node.ignored && roles.has(String(node.role?.value)),
		);
		expect(controls.length).toBeGreaterThan(0);
		for (const node of controls)
			expect(String(node.name?.value ?? '').trim()).not.toBe('');
		return nodes.filter(node => !node.ignored);
	} finally {
		await session.detach();
	}
}

test('five fresh processes expose a usable project list within the startup median budget (PERF-01)', async () => {
	test.setTimeout(60_000);
	const samplesMs: number[] = [];
	for (let sample = 0; sample < 5; sample++) {
		samplesMs.push(
			await fixture(async (app, page) => {
				await app.evaluate(({dialog}) => {
					dialog.showOpenDialog = (async () => ({
						canceled: true,
						filePaths: [],
					})) as typeof dialog.showOpenDialog;
				});
				await page
					.getByRole('button', {name: 'switch project', exact: true})
					.click();
				const projects = page.getByRole('dialog', {name: 'your projects'});
				await expect(
					projects.getByRole('region', {name: 'recent projects'}),
				).toContainText('no recent projects');
				const add = projects.getByRole('button', {name: 'add project folder'});
				await add.press('Enter');
				await expect(projects).toBeHidden();
				await expect(page.locator('.footer-acp--success')).toHaveCount(0);
			}),
		);
	}
	const medianMs = [...samplesMs].sort((a, b) => a - b)[2];
	console.info(
		'PERF-01',
		JSON.stringify({
			...machine,
			method: 'fresh process/profile to empty recents and focusable add button',
			build: 'unpackaged production build; OS filesystem cache not flushed',
			nanocoder: 'not started',
			samplesMs,
			medianMs,
		}),
	);
	expect(medianMs).toBeLessThanOrEqual(3000);
});

test('records open-action to rendered ACP ready without claiming spawn breakdown (PERF-02)', async () => {
	const realCli = process.env.NANOCODER_EXIT_CHECK_CLI?.trim() || undefined;
	await fixture(async (app, page, project) => {
		await selectFolder(app, project);
		const open = page.getByRole('button', {
			name: 'open a project folder',
			exact: true,
		});
		await expect(open).toBeEnabled();
		await open.focus();
		const versions = await app.evaluate(() => ({
			electron: process.versions.electron,
			chromium: process.versions.chrome,
			mainNode: process.versions.node,
		}));
		const start = performance.now();
		await open.press('Enter');
		await expect(page.locator('.footer-acp--success')).toContainText(
			'✓ acp · ready',
		);
		const openToReadyMs = performance.now() - start;
		console.info(
			'PERF-02-proxy',
			JSON.stringify({
				...machine,
				...versions,
				nanocoder: realCli
					? 'real override, isolated scripted config'
					: 'fake 9.9.9',
				method: 'before renderer Enter action to rendered ACP ready badge',
				includes:
					'picker stub, canonical/store/trust work, launch, IPC, render',
				breakdown: 'spawn/initialize and MCP startup not separately measured',
				openToReadyMs,
				investigate: openToReadyMs > 5000,
			}),
		);
		await expect(page.getByRole('textbox', {name: 'message'})).toBeEnabled();
	}, realCli);
});

test('empty and whitespace exit-check overrides select only the fake runtime', async () => {
	for (const realCli of ['', ' \t\r\n ']) {
		await fixture(async (app, page, project) => {
			const cli = path.join(path.dirname(project), 'nanocoder/dist/cli.js');
			await page
				.getByRole('button', {name: 'runtime details', exact: true})
				.click();
			const setup = page.getByRole('dialog', {name: 'runtime details'});
			await expect(setup.locator('.runtime-rows')).toContainText('9.9.9');
			await expect(setup.locator('.runtime-rows')).toContainText(cli);
			await page.keyboard.press('Escape');
			await expect(setup).toBeHidden();
			await selectFolder(app, project);
			await page
				.getByRole('button', {name: 'open a project folder', exact: true})
				.click();
			await expect(page.locator('.footer-acp--success')).toBeVisible();
		}, realCli);
	}
});

test('keyboard project, palette and approval journey exposes named roles and states (A11Y-01/02/03)', async () => {
	await fixture(async (app, page, project) => {
		await accessibleControls(page);
		await selectFolder(app, project);
		await page
			.getByRole('button', {name: 'switch project', exact: true})
			.press('Enter');
		await page
			.getByRole('dialog', {name: 'your projects'})
			.getByRole('button', {name: 'add project folder'})
			.press('Enter');
		const input = page.getByRole('textbox', {name: 'message', exact: true});
		await expect(input).toBeEnabled();
		await input.focus();
		await input.pressSequentially('a');
		await expect(input).toHaveValue('a');
		await input.press('ControlOrMeta+a');
		await input.press('Backspace');
		await page.keyboard.press(paletteKey);
		const palette = page.getByRole('dialog', {
			name: 'command palette',
			exact: true,
		});
		const search = palette.getByRole('combobox', {
			name: 'find a thread or action',
		});
		await expect(search).toBeFocused();
		await search.pressSequentially('theme');
		await expect(palette.getByRole('option')).toHaveCount(1);
		const nodes = await accessibleControls(page);
		const combobox = nodes.find(
			node =>
				node.role?.value === 'combobox' &&
				node.name?.value === 'find a thread or action',
		);
		expect(combobox?.properties).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'expanded',
					value: expect.objectContaining({value: true}),
				}),
				expect.objectContaining({
					name: 'focused',
					value: {type: 'booleanOrUndefined', value: true},
				}),
			]),
		);
		expect(
			nodes.some(
				node =>
					node.role?.value === 'option' &&
					node.properties?.some(
						property =>
							property.name === 'selected' && property.value.value === true,
					),
			),
		).toBe(true);
		await page.keyboard.press('Escape');
		await expect(palette).toBeHidden();
		await expect(input).toBeFocused();
		await input.pressSequentially('synthetic milestone permission');
		await expect(input).toHaveValue('synthetic milestone permission');
		await expect(
			page.getByRole('button', {name: 'send', exact: true}),
		).toBeEnabled();
		await input.press('Enter');
		const approval = page.getByRole('alertdialog');
		await expect(approval).toBeFocused();
		await expect(approval.getByRole('button', {name: 'Allow'})).toBeEnabled();
		await expect(approval.getByRole('button', {name: 'Deny'})).toBeEnabled();
		const waiting = await accessibleControls(page);
		const send = waiting.find(
			node => node.role?.value === 'button' && node.name?.value === 'send',
		);
		expect(
			send?.properties?.some(
				property =>
					property.name === 'disabled' && property.value.value === true,
			),
		).toBe(true);
		await page.keyboard.press('2');
		await expect(approval).toHaveCount(0);
		await expect(input).toBeFocused();
		await expect(turnEnded(page)).toBeVisible();
		await accessibleControls(page);
	});
});
