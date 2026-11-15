import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {app, BrowserWindow, dialog, net, protocol, session} from 'electron';
import {isBrowserSession} from '@/main/browser/electron-view';
import {createExitGuard} from '@/main/exit-guard';
import {createExitPrompt} from '@/main/exit-prompt';
import {closeNanocoder, registerIpcHandlers, unfinishedWork} from '@/main/ipc';
import {IpcFailure} from '@/main/ipc/handle-request';
import {createQuitHandler, createWindowRequestHandler} from '@/main/lifecycle';
import {checkPackagedRuntime} from '@/main/nanocoder/runtime-check';
import {
	APP_ORIGIN,
	APP_SCHEME,
	contentSecurityPolicy,
	isAllowedOrigin,
	resolveRendererFile,
} from '@/main/security';
import {desktopStoreFactory} from '@/main/store';
import {createNodeSqliteDriver} from '@/main/store/node-sqlite';
import {hiddenTestWindows, presentWindow} from '@/main/window-presentation';
import {APP_NAME} from '@/shared/app-info';

const devServerUrl = process.env.ELECTRON_RENDERER_URL;
// Used by the packaged-app smoke test in CI: start, then exit.
const smokeTest = process.argv.includes('--smoke-test');
const smokeResult = process.argv
	.find(arg => arg.startsWith('--smoke-result='))
	?.slice('--smoke-result='.length);
const hiddenWindows = hiddenTestWindows(app.isPackaged, process.argv);
const rendererRoot = path.join(import.meta.dirname, '../renderer');
const preloadPath = path.join(import.meta.dirname, '../preload/index.cjs');
const allowedOrigins = devServerUrl
	? [new URL(devServerUrl).origin]
	: [APP_ORIGIN];

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
	{
		scheme: APP_SCHEME,
		privileges: {standard: true, secure: true, supportFetchAPI: true},
	},
]);
app.enableSandbox();
if (hiddenWindows && process.platform === 'darwin') {
	app.setActivationPolicy('prohibited');
	app.dock?.hide();
}
const primaryInstance = app.requestSingleInstanceLock();
const windowRequests = createWindowRequestHandler(() => {
	const window = BrowserWindow.getAllWindows()[0];
	if (!window) {
		createWindow();
		return;
	}
	presentWindow(window, hiddenWindows);
});
app.on('second-instance', windowRequests.request);
app.on('activate', windowRequests.request);
// An unfinished turn is never ended silently (CHAT-22). Hidden test runs skip the question
// unless a test asks for it; a packaged app ignores the hidden switch and always asks.
const exitGuard = createExitGuard({
	enabled: () =>
		!hiddenWindows || process.env.NANOCODER_E2E_EXIT_PROMPT === '1',
	unfinished: unfinishedWork.projects,
	onChange: unfinishedWork.onChange,
	confirm: createExitPrompt({
		showMessageBox: options => {
			const [window] = BrowserWindow.getAllWindows();
			return window
				? dialog.showMessageBox(window, options)
				: dialog.showMessageBox(options);
		},
		projectName: unfinishedWork.name,
	}),
});
app.on('before-quit', event => {
	exitGuard.check(event, () => app.quit(), 'quit');
	if (!event.defaultPrevented) windowRequests.stop();
});
app.on('will-quit', windowRequests.stop);
if (!primaryInstance) app.quit();

function serveRenderer(): void {
	protocol.handle(APP_SCHEME, async request => {
		const filePath = resolveRendererFile(request.url, rendererRoot);
		if (!filePath) {
			return new Response('Not found', {status: 404});
		}
		const response = await net.fetch(pathToFileURL(filePath).toString());
		const headers = new Headers(response.headers);
		headers.set('Content-Security-Policy', contentSecurityPolicy());
		return new Response(response.body, {status: response.status, headers});
	});
}

function lockDownSession(): void {
	const {defaultSession} = session;
	defaultSession.setPermissionRequestHandler((_contents, _permission, done) =>
		done(false),
	);
	defaultSession.setPermissionCheckHandler(() => false);

	if (devServerUrl) {
		defaultSession.webRequest.onHeadersReceived(
			{urls: [`${devServerUrl}/*`]},
			(details, done) => {
				done({
					responseHeaders: {
						...details.responseHeaders,
						'Content-Security-Policy': [contentSecurityPolicy(devServerUrl)],
					},
				});
			},
		);
	}
}

app.on('web-contents-created', (_event, contents) => {
	contents.setWindowOpenHandler(() => ({action: 'deny'}));
	contents.on('will-attach-webview', event => event.preventDefault());
	// The browser view applies its own loopback rule where it is created.
	if (isBrowserSession(contents.session)) return;
	contents.on('will-navigate', (event, url) => {
		if (!isAllowedOrigin(url, allowedOrigins)) {
			event.preventDefault();
		}
	});
	contents.on('will-redirect', (event, url) => {
		if (!isAllowedOrigin(url, allowedOrigins)) {
			event.preventDefault();
		}
	});
});

// A packaged smoke test also proves the shipped Node and Nanocoder run (REL-02, REL-04, SEC-05).
async function finishSmokeTest(): Promise<void> {
	if (!app.isPackaged) {
		app.exit(0);
		return;
	}
	// Let the window settle, then take the working set of every Electron process, no project open (PERF-09).
	await new Promise(resolve => setTimeout(resolve, 3_000));
	const idleMemoryMb = Math.round(
		app
			.getAppMetrics()
			.reduce((total, metric) => total + metric.memory.workingSetSize, 0) /
			1024,
	);
	const workDir = mkdtempSync(path.join(tmpdir(), 'nd-smoke-'));
	let result: Awaited<ReturnType<typeof checkPackagedRuntime>>;
	try {
		result = await checkPackagedRuntime({
			resourcesPath: process.resourcesPath,
			platform: process.platform,
			env: process.env,
			workDir,
		});
	} catch {
		result = {ok: false, reason: 'The runtime check failed'};
	}
	rmSync(workDir, {recursive: true, force: true});
	const text = JSON.stringify({...result, idleMemoryMb});
	if (smokeResult && path.isAbsolute(smokeResult))
		writeFileSync(smokeResult, text);
	else process.stdout.write(`${text}\n`);
	app.exit(result.ok ? 0 : 1);
}

function createWindow(): void {
	const window = new BrowserWindow({
		title: APP_NAME,
		// Below about 560px the header actions leave the window.
		minWidth: 640,
		show: false,
		webPreferences: {
			preload: preloadPath,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
		},
	});
	// Closing the window detaches the renderer, which stops running turns, so it asks too.
	const scope = `window-${window.id}`;
	window.on('close', event =>
		exitGuard.check(event, () => window.close(), scope),
	);
	window.once('closed', () => exitGuard.release(scope));
	window.once('ready-to-show', () => {
		if (windowRequests.stopped) return;
		if (smokeTest) {
			void finishSmokeTest();
			return;
		}
		presentWindow(window, hiddenWindows);
	});
	window.webContents.once('did-fail-load', () => {
		if (smokeTest) {
			app.exit(1);
		}
	});
	void window.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`);
}

void app
	.whenReady()
	.then(async () => {
		if (!primaryInstance || windowRequests.stopped) return;
		const store = await desktopStoreFactory.open({
			databasePath: path.join(app.getPath('userData'), 'desktop.sqlite'),
			driver: createNodeSqliteDriver(),
		});
		if (windowRequests.stopped) {
			store.close();
			return;
		}
		serveRenderer();
		lockDownSession();
		registerIpcHandlers(allowedOrigins, {store, quiet: hiddenWindows});
		windowRequests.ready();
	})
	.catch((error: unknown) => {
		if (windowRequests.stopped) return;
		if (!hiddenWindows) {
			dialog.showErrorBox(
				'Cannot open Nanocoder Desktop',
				error instanceof IpcFailure
					? error.message
					: 'The desktop could not start',
			);
		}
		app.quit();
	});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on(
	'will-quit',
	createQuitHandler(closeNanocoder, () => app.quit()),
);
