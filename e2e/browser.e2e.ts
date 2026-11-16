import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
	type ElectronApplication,
	expect,
	type Page,
	test,
} from '@playwright/test';
import type {BrowserRequests, BrowserResults} from '@/shared/browser';
import type {DesktopApi} from '@/shared/desktop-api';
import type {IpcResult} from '@/shared/ipc';
import {choose, expectValue} from './qa/dropdown';
import {electron} from './qa/electron';
import {qaEnvironment} from './qa/environment';

const probe = `<!doctype html><title>pending</title><script>
document.title = JSON.stringify({
	desktop: typeof window.desktop,
	require: typeof require,
	process: typeof process,
	ipcRenderer: typeof window.ipcRenderer,
	electron: typeof window.electron,
});
</script>`;

let work: string;
let app: ElectronApplication;
let page: Page;
let projectId: string;
let server: Server;
let origin: string;
let port: number;

const PUBLIC_HOST = 'public-site.test';
const publicUrl = (suffix = '/') => `http://${PUBLIC_HOST}:${port}${suffix}`;

function call<K extends keyof BrowserRequests>(
	key: K,
	request: BrowserRequests[K],
): Promise<IpcResult<BrowserResults[K]>> {
	return page.evaluate(
		({key, request}) => {
			const api = (window as unknown as {desktop: DesktopApi}).desktop.browser;
			return (api[key] as (request: unknown) => Promise<IpcResult<never>>)(
				request,
			);
		},
		{key, request},
	);
}

test.beforeEach(async () => {
	server = createServer((request, response) => {
		if (request.url === '/slow') return;
		if (request.url === '/cookie') {
			response.writeHead(200, {
				'Content-Type': 'text/html',
				'Set-Cookie': 'sid=abc123; Path=/; Max-Age=3600',
			});
			response.end('<!doctype html><title>cookie</title>cookie');
			return;
		}
		if (request.url === '/file.txt') {
			response.writeHead(200, {
				'Content-Type': 'text/plain',
				'Content-Disposition': 'attachment; filename="../../report.txt"',
			});
			response.end('hello download');
			return;
		}
		if (request.url === '/downloads') {
			response.writeHead(200, {'Content-Type': 'text/html'});
			response.end(
				`<!doctype html><title>downloads</title><a id="ok" href="/file.txt">file</a><a id="pub" download href="${publicUrl('/file.txt')}">public</a>`,
			);
			return;
		}
		if (request.url === '/mailto') {
			response.writeHead(200, {'Content-Type': 'text/html'});
			response.end(
				'<!doctype html><title>mail</title><a id="m" href="mailto:someone@example.com">mail</a>',
			);
			return;
		}
		if (request.url === '/link') {
			response.writeHead(200, {'Content-Type': 'text/html'});
			response.end(
				`<!doctype html><title>link</title><a id="l" href="${publicUrl('/x')}">go</a>`,
			);
			return;
		}
		if (request.url === '/redirect') {
			response.writeHead(302, {Location: publicUrl('/landing')});
			response.end();
			return;
		}
		response.writeHead(200, {'Content-Type': 'text/html'});
		response.end(probe);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as AddressInfo).port;
	origin = `http://127.0.0.1:${port}`;
	work = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nd-browser-')));
	mkdirSync(path.join(work, 'project'));
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
		args: [
			'.',
			`--user-data-dir=${path.join(work, 'profile')}`,
			`--host-resolver-rules=MAP ${PUBLIC_HOST} 127.0.0.1`,
		],
		env: qaEnvironment(process.env, {
			cliPath: path.join(work, 'nanocoder/dist/cli.js'),
			nodePath: process.execPath,
		}),
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
	server.closeAllConnections();
	await new Promise<void>(resolve => server.close(() => resolve()));
	rmSync(work, {recursive: true, force: true});
});

test('SEC-12 a test page cannot reach any desktop API', async () => {
	const opened = await call('open', {projectId, url: `${origin}/`});
	expect(opened).toMatchObject({ok: true, value: {status: 'ready'}});
	const title = await app.evaluate(({webContents}, prefix) => {
		const contents = webContents
			.getAllWebContents()
			.find(candidate => candidate.getURL().startsWith(prefix));
		return contents?.getTitle() ?? null;
	}, origin);
	expect(title).not.toBeNull();
	expect(JSON.parse(title as string)).toEqual({
		desktop: 'undefined',
		require: 'undefined',
		process: 'undefined',
		ipcRenderer: 'undefined',
		electron: 'undefined',
	});
});

test('BRW-01/BRW-05 browser data is stored apart from the app and per project', async () => {
	await call('open', {projectId, url: `${origin}/`});
	const storage = await app.evaluate(({session, webContents}, prefix) => {
		const contents = webContents
			.getAllWebContents()
			.find(candidate => candidate.getURL().startsWith(prefix));
		return {
			browser: contents?.session.storagePath ?? null,
			app: session.defaultSession.storagePath ?? null,
		};
	}, origin);
	expect(storage.browser).toContain(`browser-${projectId}`);
	expect(storage.browser).not.toBe(storage.app);
	expect(storage.browser).toContain(`${path.sep}Partitions${path.sep}`);
	expect(storage.app).not.toContain(`${path.sep}Partitions${path.sep}`);
});

test('BRW-03 a public address is refused and no view appears', async () => {
	const refused = await call('open', {
		projectId,
		url: 'https://example.com/',
	});
	expect(refused).toMatchObject({ok: false, error: {code: 'DENIED'}});
	const views = await app.evaluate(
		({webContents}) =>
			webContents
				.getAllWebContents()
				.filter(contents => contents.getURL().startsWith('https://')).length,
	);
	expect(views).toBe(0);
});

async function publicBrowsing(enabled: boolean) {
	const saved = await page.evaluate(
		enabled =>
			(window as unknown as {desktop: DesktopApi}).desktop.updateSettings({
				patch: {publicBrowsingEnabled: enabled},
			}),
		enabled,
	);
	expect(saved).toMatchObject({ok: true});
}

const pageHosts = () =>
	app.evaluate(({webContents}) =>
		webContents.getAllWebContents().map(contents => {
			try {
				return new URL(contents.getURL()).hostname;
			} catch {
				return '';
			}
		}),
	);

test('BRW-03 a redirect from localhost to a public site stops and is reported while public browsing is off', async () => {
	const result = await call('open', {projectId, url: `${origin}/redirect`});
	expect(result).toMatchObject({ok: false, error: {code: 'DENIED'}});
	const snapshot = await call('get', {projectId});
	expect(snapshot).toMatchObject({
		ok: true,
		value: {
			status: 'failed',
			blocked: {reason: 'public-off', url: publicUrl('/landing')},
		},
	});
	expect(await pageHosts()).not.toContain(PUBLIC_HOST);
});

test('BRW-03 the same redirect is followed once public browsing is on', async () => {
	await publicBrowsing(true);
	const result = await call('open', {projectId, url: `${origin}/redirect`});
	expect(result).toMatchObject({
		ok: true,
		value: {
			status: 'ready',
			origin: `http://${PUBLIC_HOST}:${port}`,
			security: 'insecure',
			blocked: null,
		},
	});
});

test('BRW-03 a public address is refused until the setting is on', async () => {
	const refused = await call('open', {projectId, url: publicUrl('/a')});
	expect(refused).toMatchObject({ok: false, error: {code: 'DENIED'}});
	await publicBrowsing(true);
	const opened = await call('open', {projectId, url: publicUrl('/a')});
	expect(opened).toMatchObject({ok: true, value: {status: 'ready'}});
});

test('BRW-02 back, forward and reload move through the pages that were opened', async () => {
	await call('open', {projectId, url: `${origin}/a`});
	await call('open', {projectId, url: `${origin}/b`});
	await call('navigate', {projectId, action: 'back'});
	await expect
		.poll(async () => {
			const result = await call('get', {projectId});
			return result.ok ? result.value?.url : null;
		})
		.toBe(`${origin}/a`);
	const back = await call('get', {projectId});
	expect(back).toMatchObject({
		ok: true,
		value: {canGoForward: true, canGoBack: false},
	});
	await call('navigate', {projectId, action: 'forward'});
	await expect
		.poll(async () => {
			const result = await call('get', {projectId});
			return result.ok ? result.value?.url : null;
		})
		.toBe(`${origin}/b`);
	expect(await call('navigate', {projectId, action: 'reload'})).toMatchObject({
		ok: true,
	});
});

const viewBounds = () =>
	app.evaluate(({BrowserWindow}) => {
		const window = BrowserWindow.getAllWindows()[0];
		const view = window.contentView.children[0] as
			| {getBounds(): Electron.Rectangle; getVisible(): boolean}
			| undefined;
		return view ? {...view.getBounds(), visible: view.getVisible()} : null;
	});

async function openBrowserTab() {
	await page.getByRole('button', {name: 'open browser', exact: true}).click();
	await expect(page.getByRole('textbox', {name: 'address'})).toBeVisible();
}

test('BRW-02/BRW-04 the address bar opens a page and shows its origin and security', async () => {
	await openBrowserTab();
	await page
		.getByRole('textbox', {name: 'address'})
		.fill(`127.0.0.1:${port}/a`);
	await page.getByRole('button', {name: 'go', exact: true}).click();
	const status = page.getByRole('status').filter({hasText: 'local'});
	await expect(status).toContainText(origin);
	await expect(page.getByRole('button', {name: 'reload'})).toBeEnabled();
});

test('BRW-03 a public address in the bar stops, asks, and opens after the user turns the setting on', async () => {
	await openBrowserTab();
	await page.getByRole('textbox', {name: 'address'}).fill(publicUrl('/a'));
	await page.getByRole('button', {name: 'go', exact: true}).click();
	const notice = page.getByRole('alert').filter({hasText: 'public site'});
	await expect(notice).toContainText(`${PUBLIC_HOST}:${port}`);
	expect(await viewBounds()).toBeNull();
	await notice
		.getByRole('button', {name: 'turn on public sites and open it'})
		.click();
	await expect(
		page.getByRole('checkbox', {name: 'allow public sites'}),
	).toBeChecked();
	await expect(
		page.getByRole('status').filter({hasText: 'not secure'}),
	).toContainText(`${PUBLIC_HOST}:${port}`);
});

test('BRW-03 staying on localhost dismisses the question and keeps the setting off', async () => {
	await openBrowserTab();
	await page.getByRole('textbox', {name: 'address'}).fill(publicUrl('/a'));
	await page.getByRole('button', {name: 'go', exact: true}).click();
	await page.getByRole('button', {name: 'stay on localhost'}).click();
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(
		page.getByRole('checkbox', {name: 'allow public sites'}),
	).not.toBeChecked();
});

const viewMatchesRegion = async () => {
	const box = await page.getByRole('region', {name: 'web page'}).boundingBox();
	const view = await viewBounds();
	return box && view
		? view.visible &&
				view.x === Math.round(box.x) &&
				view.y === Math.round(box.y) &&
				view.width === Math.round(box.width) &&
				view.height === Math.round(box.height)
		: false;
};

for (const width of [1240, 1020, 840]) {
	test(`BRW-01 the native view follows the panel at ${width}px`, async () => {
		await app.evaluate(({BrowserWindow}, size) => {
			BrowserWindow.getAllWindows()[0].setContentSize(size, 800);
		}, width);
		await openBrowserTab();
		await page
			.getByRole('textbox', {name: 'address'})
			.fill(`127.0.0.1:${port}/a`);
		await page.getByRole('button', {name: 'go', exact: true}).click();
		await expect(
			page.getByRole('status').filter({hasText: 'local'}),
		).toBeVisible();
		await expect.poll(viewMatchesRegion).toBe(true);
	});
}

test('BRW-01 the native view steps aside for an open dialog and returns after it closes', async () => {
	await openBrowserTab();
	await page
		.getByRole('textbox', {name: 'address'})
		.fill(`127.0.0.1:${port}/a`);
	await page.getByRole('button', {name: 'go', exact: true}).click();
	await expect.poll(async () => (await viewBounds())?.visible).toBe(true);
	await page.evaluate(() => {
		const dialog = document.createElement('dialog');
		dialog.id = 'test-modal';
		dialog.textContent = 'modal';
		document.body.appendChild(dialog);
		dialog.showModal();
	});
	await expect.poll(async () => (await viewBounds())?.visible).toBe(false);
	await page.evaluate(() => {
		(document.getElementById('test-modal') as HTMLDialogElement).close();
	});
	await expect.poll(async () => (await viewBounds())?.visible).toBe(true);
});

test('BRW-01 closing the view removes it', async () => {
	await call('open', {projectId, url: `${origin}/`});
	const closed = await call('close', {projectId});
	expect(closed).toMatchObject({ok: true, value: {status: 'closed'}});
	const remaining = await app.evaluate(
		({webContents}, prefix) =>
			webContents
				.getAllWebContents()
				.filter(contents => contents.getURL().startsWith(prefix)).length,
		origin,
	);
	expect(remaining).toBe(0);
});

const loadingStatus = async () => {
	const result = await call('get', {projectId});
	return result.ok ? result.value?.status : null;
};

test('BRW-02 stop cancels a slow load and keeps the page that was showing', async () => {
	await call('open', {projectId, url: `${origin}/a`});
	const slow = call('open', {projectId, url: `${origin}/slow`});
	await expect.poll(loadingStatus).toBe('loading');
	await call('navigate', {projectId, action: 'stop'});
	expect(await slow).toMatchObject({
		ok: true,
		value: {status: 'ready', url: `${origin}/a`, reason: null},
	});
});

test('BRW-02 a second address supersedes a slow load and loads without being reported as failed', async () => {
	const slow = call('open', {projectId, url: `${origin}/slow`});
	await expect.poll(loadingStatus).toBe('loading');
	const fast = await call('open', {projectId, url: `${origin}/b`});
	expect(fast).toMatchObject({
		ok: true,
		value: {status: 'ready', url: `${origin}/b`},
	});
	expect(await slow).toMatchObject({ok: false, error: {code: 'DENIED'}});
	expect(await call('get', {projectId})).toMatchObject({
		ok: true,
		value: {status: 'ready', url: `${origin}/b`, reason: null},
	});
});

test('BRW-03 a refused address entered again after staying on localhost asks again', async () => {
	await openBrowserTab();
	const address = page.getByRole('textbox', {name: 'address'});
	await address.fill(publicUrl('/a'));
	await page.getByRole('button', {name: 'go', exact: true}).click();
	await page.getByRole('button', {name: 'stay on localhost'}).click();
	await expect(page.getByRole('alert')).toHaveCount(0);
	await address.fill(publicUrl('/a'));
	await page.getByRole('button', {name: 'go', exact: true}).click();
	await expect(
		page.getByRole('alert').filter({hasText: 'public site'}),
	).toBeVisible();
});

test('BRW-01 after switching project with the browser tab open the next page is placed and visible', async () => {
	await openBrowserTab();
	const second = path.join(work, 'project-two');
	mkdirSync(second);
	await app.evaluate(({dialog}, root) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [root],
		})) as typeof dialog.showOpenDialog;
	}, second);
	const next = await page.evaluate(async () => {
		const desktop = (window as unknown as {desktop: DesktopApi}).desktop;
		const added = await desktop.addProject({});
		if (!added.ok || added.value.status !== 'selected') return null;
		const opened = await desktop.openProject({
			projectId: added.value.project.id,
		});
		return opened.ok ? added.value.project.id : null;
	});
	expect(next).not.toBeNull();
	const result = await call('open', {
		projectId: next as string,
		url: `${origin}/a`,
	});
	expect(result).toMatchObject({ok: true, value: {status: 'ready'}});
	const region = page.getByRole('region', {name: 'web page'});
	await expect
		.poll(async () => {
			const box = await region.boundingBox();
			const view = await viewBounds();
			return box && view
				? view.visible &&
						view.x === Math.round(box.x) &&
						view.y === Math.round(box.y) &&
						view.width === Math.round(box.width) &&
						view.height === Math.round(box.height)
				: false;
		})
		.toBe(true);
});

test('BRW-03 reload of a public page is refused once public browsing is turned off', async () => {
	await publicBrowsing(true);
	await call('open', {projectId, url: publicUrl('/a')});
	await publicBrowsing(false);
	expect(await call('navigate', {projectId, action: 'reload'})).toMatchObject({
		ok: false,
		error: {code: 'DENIED'},
	});
	expect(await call('get', {projectId})).toMatchObject({
		ok: true,
		value: {blocked: {reason: 'public-off'}},
	});
});

test('BRW-01 opening the project that is already open keeps the next page placed and visible', async () => {
	await openBrowserTab();
	const reopened = await page.evaluate(
		id =>
			(window as unknown as {desktop: DesktopApi}).desktop.openProject({
				projectId: id,
			}),
		projectId,
	);
	expect(reopened).toMatchObject({ok: true});
	const result = await call('open', {projectId, url: `${origin}/a`});
	expect(result).toMatchObject({ok: true, value: {status: 'ready'}});
	const region = page.getByRole('region', {name: 'web page'});
	await expect
		.poll(async () => {
			const box = await region.boundingBox();
			const view = await viewBounds();
			return box && view
				? view.visible &&
						view.x === Math.round(box.x) &&
						view.y === Math.round(box.y) &&
						view.width === Math.round(box.width) &&
						view.height === Math.round(box.height)
				: false;
		})
		.toBe(true);
});

test('BRW-03 the same blocked link clicked again after staying on localhost asks again', async () => {
	await openBrowserTab();
	await page
		.getByRole('textbox', {name: 'address'})
		.fill(`127.0.0.1:${port}/link`);
	await page.getByRole('button', {name: 'go', exact: true}).click();
	await expect.poll(loadingStatus).toBe('ready');
	const click = () =>
		app.evaluate(({webContents}, prefix) => {
			const contents = webContents
				.getAllWebContents()
				.find(candidate => candidate.getURL().startsWith(prefix));
			return contents?.executeJavaScript(
				"document.getElementById('l').click()",
			);
		}, `${origin}/link`);
	const question = page.getByRole('alert').filter({hasText: 'public site'});
	await click();
	await expect(question).toBeVisible();
	await page.getByRole('button', {name: 'stay on localhost'}).click();
	await expect(page.getByRole('alert')).toHaveCount(0);
	await click();
	await expect(question).toBeVisible();
});

const runInView = (prefix: string, code: string) =>
	app.evaluate(
		({webContents}, args) => {
			const contents = webContents
				.getAllWebContents()
				.find(candidate => candidate.getURL().startsWith(args.prefix));
			return contents?.executeJavaScript(args.code, true);
		},
		{prefix, code},
	);

test('BRW-07 SEC-10 camera, location, notifications, popups and the file system pickers are denied without asking', async () => {
	await call('open', {projectId, url: `${origin}/a`});
	const verdicts = JSON.parse(
		(await runInView(
			origin,
			`(async () => {
				const r = {};
				r.popup = window.open('${origin}/b') === null;
				r.notification = await Notification.requestPermission();
				r.geolocation = await new Promise(done =>
					navigator.geolocation.getCurrentPosition(
						() => done('granted'),
						error => done('code' + error.code),
					),
				);
				r.media = await navigator.mediaDevices
					.getUserMedia({video: true})
					.then(() => 'granted', error => error.name);
				r.states = await Promise.all(
					['camera', 'microphone', 'geolocation', 'notifications'].map(
						name =>
							navigator.permissions
								.query({name})
								.then(result => result.state),
					),
				);
				r.pickers = [
					typeof window.showOpenFilePicker,
					typeof window.showSaveFilePicker,
					typeof window.showDirectoryPicker,
				];
				return JSON.stringify(r);
			})()`,
		)) as string,
	);
	expect(verdicts).toMatchObject({
		popup: true,
		notification: 'denied',
		geolocation: 'code1',
		states: ['denied', 'denied', 'denied', 'denied'],
	});
	expect(['NotAllowedError', 'NotFoundError']).toContain(verdicts.media);
	expect(verdicts.pickers).toEqual(['undefined', 'undefined', 'undefined']);
	expect(await call('get', {projectId})).toMatchObject({
		ok: true,
		value: {blocked: {reason: 'popup'}},
	});
	const views = await app.evaluate(
		({webContents}) => webContents.getAllWebContents().length,
	);
	expect(views).toBe(2);
});

test('BRW-07 an external protocol link is refused and never handed to the system', async () => {
	await app.evaluate(({shell}) => {
		const state = globalThis as unknown as {external: string[]};
		state.external = [];
		shell.openExternal = async url => {
			state.external.push(url);
		};
	});
	await call('open', {projectId, url: `${origin}/mailto`});
	await runInView(origin, "document.getElementById('m').click()");
	await expect
		.poll(async () => {
			const result = await call('get', {projectId});
			return result.ok ? result.value?.blocked?.reason : null;
		})
		.toBe('scheme');
	const handed = await app.evaluate(
		() => (globalThis as unknown as {external: string[]}).external,
	);
	expect(handed).toEqual([]);
});

const downloadList = async () => {
	const result = await call('get', {projectId});
	return result.ok ? (result.value?.downloads ?? []) : [];
};

test('BRW-06 a download asks where to save, is listed, and finishes where the user chose', async () => {
	test.skip(
		process.platform === 'win32',
		'the native save dialog blocks the Windows CI run even with a save path set; cause not yet understood',
	);
	const target = path.join(work, 'chosen', 'report.txt');
	await call('open', {projectId, url: `${origin}/downloads`});
	await expect.poll(loadingStatus).toBe('ready');
	await app.evaluate(
		({session}, args) => {
			const state = globalThis as unknown as {asked: unknown};
			session
				.fromPartition(args.partition)
				.on('will-download', (_event, item) => {
					state.asked = item.getSaveDialogOptions();
					item.setSavePath(args.target);
				});
		},
		{partition: `persist:browser-${projectId}`, target},
	);
	await runInView(origin, "document.getElementById('ok').click()");
	await expect
		.poll(async () => (await downloadList()).map(entry => entry.state))
		.toEqual(['done']);
	const [listed] = await downloadList();
	expect(listed.name).toMatch(/report\.txt$/);
	expect(listed.name).not.toMatch(/[\\/]/);
	expect(readFileSync(target, 'utf8')).toBe('hello download');
	const asked = await app.evaluate(
		() =>
			(globalThis as unknown as {asked: {defaultPath: string}}).asked
				.defaultPath,
	);
	const downloads = await app.evaluate(({app}) => app.getPath('downloads'));
	expect(asked).toBe(path.join(downloads, listed.name));
});

test('BRW-06 BRW-03 a download from a public site is cancelled while public browsing is off', async () => {
	const target = path.join(work, 'chosen', 'public.txt');
	await call('open', {projectId, url: `${origin}/downloads`});
	await expect.poll(loadingStatus).toBe('ready');
	await app.evaluate(
		({session}, args) => {
			session
				.fromPartition(args.partition)
				.on('will-download', (_event, item) => item.setSavePath(args.target));
		},
		{partition: `persist:browser-${projectId}`, target},
	);
	await runInView(origin, "document.getElementById('pub').click()");
	await expect
		.poll(async () => {
			const result = await call('get', {projectId});
			return result.ok ? result.value?.blocked?.reason : null;
		})
		.toBe('public-off');
	expect(await downloadList()).toEqual([]);
	expect(existsSync(target)).toBe(false);
});

const cookiesIn = (partition: string) =>
	app.evaluate(
		({session}, name) =>
			session
				.fromPartition(name)
				.cookies.get({})
				.then(list => list.map(cookie => cookie.name)),
		partition,
	);

const setProfile = (profile: string) =>
	call('setProfile', {projectId, profile});

test('BRW-08 clearing a profile removes its cookies and closes the page that was using them', async () => {
	const own = `persist:browser-${projectId}`;
	await call('open', {projectId, url: `${origin}/cookie`});
	expect(await cookiesIn(own)).toEqual(['sid']);
	const cleared = await call('clearData', {projectId, profile: 'project'});
	expect(cleared).toMatchObject({
		ok: true,
		value: {status: 'closed', url: null, canGoBack: false},
	});
	expect(await cookiesIn(own)).toEqual([]);
});

test('BRW-05 each profile keeps its own cookies and clearing one leaves the others alone', async () => {
	const own = `persist:browser-${projectId}`;
	await call('open', {projectId, url: `${origin}/cookie`});
	expect(await setProfile('default')).toMatchObject({
		ok: true,
		value: {status: 'closed'},
	});
	expect(await cookiesIn('persist:browser-default')).toEqual([]);
	await call('open', {projectId, url: `${origin}/cookie`});
	expect(await cookiesIn('persist:browser-default')).toEqual(['sid']);
	expect(
		await call('clearData', {projectId, profile: 'default'}),
	).toMatchObject({ok: true});
	expect(await cookiesIn('persist:browser-default')).toEqual([]);
	expect(await cookiesIn(own)).toEqual(['sid']);
});

test('BRW-05 a named profile is created, used, listed and removed with its data', async () => {
	const created = await call('createProfile', {projectId, name: 'Docs'});
	expect(created).toMatchObject({
		ok: true,
		value: {profiles: [{name: 'Docs'}], current: 'project'},
	});
	const id = (created as {value: {profiles: Array<{id: string}>}}).value
		.profiles[0].id;
	await setProfile(id);
	expect(await call('profiles', {projectId})).toMatchObject({
		ok: true,
		value: {current: id},
	});
	await call('open', {projectId, url: `${origin}/cookie`});
	const named = `persist:browser-profile-${id}`;
	expect(await cookiesIn(named)).toEqual(['sid']);
	const removed = await call('deleteProfile', {projectId, id});
	expect(removed).toMatchObject({
		ok: true,
		value: {profiles: [], current: 'project'},
	});
	expect(await cookiesIn(named)).toEqual([]);
	expect(await call('get', {projectId})).toMatchObject({
		ok: true,
		value: {status: 'closed'},
	});
});

test('BRW-05 incognito keeps nothing on disk and is wiped when the page closes', async () => {
	await setProfile('incognito');
	await call('open', {projectId, url: `${origin}/cookie`});
	const incognito = `browser-incognito-${projectId}`;
	expect(await cookiesIn(incognito)).toEqual(['sid']);
	const storage = await app.evaluate(
		({session}, name) => session.fromPartition(name).storagePath ?? null,
		incognito,
	);
	expect(storage).toBeNull();
	await call('close', {projectId});
	await expect.poll(() => cookiesIn(incognito)).toEqual([]);
});

test('BRW-05 a profile that is not known is refused', async () => {
	expect(
		await setProfile('0c7b2a54-1d6e-4f8a-9b3c-5e2d1a0f9c88'),
	).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
	expect(await setProfile('shared')).toMatchObject({
		ok: false,
		error: {code: 'VALIDATION'},
	});
});

test('BRW-09 SEC-16 the page opens in the system browser only after the user confirms its exact address', async () => {
	await app.evaluate(({dialog, shell}) => {
		const state = globalThis as unknown as {
			external: string[];
			asked: string[];
			answer: number;
		};
		state.external = [];
		state.asked = [];
		state.answer = 1;
		dialog.showMessageBox = (async (...args: unknown[]) => {
			const options = args[args.length - 1] as {detail: string};
			state.asked.push(options.detail);
			return {response: state.answer, checkboxChecked: false};
		}) as unknown as typeof dialog.showMessageBox;
		shell.openExternal = async url => {
			state.external.push(url);
		};
	});
	expect(await call('openExternal', {projectId})).toMatchObject({
		ok: false,
		error: {code: 'UNAVAILABLE'},
	});
	await call('open', {projectId, url: `${origin}/a`});
	expect(await call('openExternal', {projectId})).toMatchObject({
		ok: true,
		value: {opened: true},
	});
	await app.evaluate(() => {
		(globalThis as unknown as {answer: number}).answer = 0;
	});
	expect(await call('openExternal', {projectId})).toMatchObject({
		ok: true,
		value: {opened: false},
	});
	const seen = await app.evaluate(
		() => globalThis as unknown as {external: string[]; asked: string[]},
	);
	expect(seen.asked).toEqual([`${origin}/a`, `${origin}/a`]);
	expect(seen.external).toEqual([`${origin}/a`]);
});

async function openAddress(url: string) {
	await page.getByRole('textbox', {name: 'address'}).fill(url);
	await page.getByRole('button', {name: 'go', exact: true}).click();
	await expect.poll(loadingStatus).toBe('ready');
}

test('BRW-05 the profile chosen in the panel decides where the page keeps its cookies', async () => {
	await openBrowserTab();
	const picker = page.getByRole('combobox', {name: 'browser profile'});
	await expectValue(picker, 'project');
	await choose(picker, 'incognito');
	await expectValue(picker, 'incognito');
	await openAddress(`127.0.0.1:${port}/cookie`);
	expect(await cookiesIn(`browser-incognito-${projectId}`)).toEqual(['sid']);
	expect(await cookiesIn(`persist:browser-${projectId}`)).toEqual([]);
	await choose(picker, 'project');
	await expectValue(picker, 'project');
	await expect(page.getByText('no page open')).toBeVisible();
	await openAddress(`127.0.0.1:${port}/cookie`);
	expect(await cookiesIn(`persist:browser-${projectId}`)).toEqual(['sid']);
});

test('BRW-05 a profile is added and removed from the panel, and removing asks first', async () => {
	await openBrowserTab();
	await page.getByText('manage profiles and data').click();
	await page.getByRole('textbox', {name: 'new profile name'}).fill('Docs');
	await page.getByRole('button', {name: 'add profile'}).click();
	const picker = page.getByRole('combobox', {name: 'browser profile'});
	await expect(
		picker
			.locator('xpath=..')
			.getByRole('option', {name: 'Docs', includeHidden: true}),
	).toHaveCount(1);
	await choose(picker, {label: 'Docs'});
	await openAddress(`127.0.0.1:${port}/cookie`);
	await page.getByRole('button', {name: 'remove this profile'}).click();
	await expect(page.getByRole('alert')).toContainText(
		'remove the Docs profile',
	);
	await page.getByRole('button', {name: 'keep it'}).click();
	await expect(
		picker
			.locator('xpath=..')
			.getByRole('option', {name: 'Docs', includeHidden: true}),
	).toHaveCount(1);
	await page.getByRole('button', {name: 'remove this profile'}).click();
	await page.getByRole('button', {name: 'yes, remove it'}).click();
	await expect(
		picker
			.locator('xpath=..')
			.getByRole('option', {name: 'Docs', includeHidden: true}),
	).toHaveCount(0);
	await expectValue(picker, 'project');
});

test('BRW-08 clearing data from the panel asks first, then empties the profile and closes the page', async () => {
	await openBrowserTab();
	await openAddress(`127.0.0.1:${port}/cookie`);
	expect(await cookiesIn(`persist:browser-${projectId}`)).toEqual(['sid']);
	await page.getByText('manage profiles and data').click();
	await page.getByRole('button', {name: 'clear data for this profile'}).click();
	await expect(page.getByRole('alert')).toContainText('cannot be undone');
	expect(await cookiesIn(`persist:browser-${projectId}`)).toEqual(['sid']);
	await page.getByRole('button', {name: 'yes, clear it'}).click();
	await expect
		.poll(() => cookiesIn(`persist:browser-${projectId}`))
		.toEqual([]);
	await expect(page.getByText('no page open')).toBeVisible();
});

test('BRW-09 the panel opens the current page in the system browser after the native question', async () => {
	await app.evaluate(({dialog, shell}) => {
		const state = globalThis as unknown as {opened: string[]};
		state.opened = [];
		dialog.showMessageBox = (async () => ({
			response: 1,
			checkboxChecked: false,
		})) as unknown as typeof dialog.showMessageBox;
		shell.openExternal = async url => {
			state.opened.push(url);
		};
	});
	await openBrowserTab();
	const button = page.getByRole('button', {name: 'open in system browser'});
	await expect(button).toBeDisabled();
	await openAddress(`127.0.0.1:${port}/a`);
	await button.click();
	await expect
		.poll(() =>
			app.evaluate(() => (globalThis as unknown as {opened: string[]}).opened),
		)
		.toEqual([`${origin}/a`]);
});

test('BRW-06 a finished download shows in the panel list with its state', async () => {
	test.skip(
		process.platform === 'win32',
		'the native save dialog blocks the Windows CI run even with a save path set; cause not yet understood',
	);
	const target = path.join(work, 'chosen', 'listed.txt');
	await openBrowserTab();
	await openAddress(`127.0.0.1:${port}/downloads`);
	await app.evaluate(
		({session}, args) => {
			session
				.fromPartition(args.partition)
				.on('will-download', (_event, item) => item.setSavePath(args.target));
		},
		{partition: `persist:browser-${projectId}`, target},
	);
	await runInView(origin, "document.getElementById('ok').click()");
	const list = page.getByRole('list', {name: 'downloads'});
	await expect(list).toContainText('report.txt');
	await expect(list).toContainText('saved');
});
