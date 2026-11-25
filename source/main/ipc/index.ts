import {writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	Notification,
	type OpenDialogOptions,
	shell,
	type WebContents,
} from 'electron';
import {z} from 'zod';
import {createActivityNotifier} from '@/main/activity-notifier';
import {createAgentPolicy} from '@/main/browser/agent-policy';
import {BrowserService} from '@/main/browser/browser-service';
import {
	clearBrowserPartition,
	createElectronViewFactory,
	createSystemOpener,
	isBrowserSession,
} from '@/main/browser/electron-view';
import {BrowserProfiles} from '@/main/browser/profiles';
import {SiteAccess} from '@/main/browser/site-access';
import {browserBrokerTools} from '@/main/browser-control/broker';
import {
	type BrowserMcpServer,
	createBrowserMcpServer,
} from '@/main/browser-control/mcp-server';
import {browserStatusTool} from '@/main/browser-control/status-tool';
import {createWorkspaceControls} from '@/main/controls/workspace-controls';
import {confirmYolo} from '@/main/controls/yolo-consent';
import {resolveAttachments} from '@/main/files/attachments';
import {createFilesRuntime, type FilesRuntime} from '@/main/files/runtime';
import {registerBrowserHandlers} from '@/main/ipc/browser';
import {clipboardWriteSchema, writeClipboard} from '@/main/ipc/clipboard';
import {registerFilesHandlers} from '@/main/ipc/files';
import {IpcFailure} from '@/main/ipc/handle-request';
import {registerHandler} from '@/main/ipc/register';
import {registerTerminalHandlers} from '@/main/ipc/terminal';
import {registerWorkspaceHandlers} from '@/main/ipc/workspace';
import type {WorkspaceServices} from '@/main/ipc/workspace-services';
import {disposeDesktop} from '@/main/lifecycle';
import {untilAborted} from '@/main/nanocoder/abort';
import {NanocoderFailure} from '@/main/nanocoder/acp-client';
import {DiagnosticsExporter} from '@/main/nanocoder/diagnostics';
import {bundledRuntimePaths, resolveNanocoder} from '@/main/nanocoder/runtime';
import {createLookup} from '@/main/nanocoder/runtime-lookup';
import {ProjectSupervisor} from '@/main/nanocoder/supervisor';
import type {TrustRefusal} from '@/main/nanocoder/trust';
import {confirmProjectTrust} from '@/main/projects/project-consent';
import {createProjectService} from '@/main/projects/project-service';
import {isAllowedOrigin} from '@/main/security';
import {AgentCommandObserver} from '@/main/terminal/agent-command';
import {TerminalService} from '@/main/terminal/terminal-service';
import {createUtilityPtyHost} from '@/main/terminal/utility-host';
import {deleteHistoryDialog} from '@/main/threads/delete-history-consent';
import {ProjectActivityTracker} from '@/main/threads/project-activity';
import {createThreadService} from '@/main/threads/thread-service';
import {APP_NAME} from '@/shared/app-info';
import {BROWSER_CHANNELS, type BrowserEvent} from '@/shared/browser';
import {FILES_CHANNELS, type FilesEvent} from '@/shared/files';
import {
	type AppInfo,
	CHANNELS,
	type ConnectResult,
	type NanocoderRuntime,
	type ProjectEvent,
	type ProjectInfo,
} from '@/shared/ipc';
import {TERMINAL_CHANNELS, type TerminalEvent} from '@/shared/terminal';

const runtimeDiscovery = new AbortController();
// A packaged build runs the Node and Nanocoder it ships and never searches PATH (REL-02).
const bundledRuntime = () =>
	app.isPackaged
		? bundledRuntimePaths(process.resourcesPath, process.platform)
		: undefined;
const lookupRuntime = createLookup(() =>
	resolveNanocoder({
		env: process.env,
		platform: process.platform,
		bundled: bundledRuntime(),
		untrustedRoots:
			workspaceServices.store?.projects
				.list()
				.map(project => project.canonicalRoot) ?? [],
		signal: runtimeDiscovery.signal,
	}),
);
let supervisor: ProjectSupervisor | undefined;
let activeProjectId: string | undefined;
let rendererAttachment = new AbortController();
let connecting: Promise<void> | undefined;
let rendererCleanup: Promise<void> = Promise.resolve();
let threads: ReturnType<typeof createThreadService> | undefined;
let controlRuntime: ReturnType<typeof createWorkspaceControls> | undefined;
let filesRuntime: FilesRuntime | undefined;
let appOrigins: readonly string[] = [];
let workspaceServices: WorkspaceServices = {};
let unsubscribeProjectEvents: (() => void) | undefined;
let terminal: TerminalService | undefined;
let browser: BrowserService | undefined;
let browserServer: BrowserMcpServer | undefined;
let activity: ProjectActivityTracker | undefined;
const agentCommands = new AgentCommandObserver((projectId, command) =>
	terminal?.setAgentCommand(projectId, command),
);

function availableControls() {
	if (!controlRuntime)
		throw new IpcFailure('UNAVAILABLE', 'The project controls are unavailable');
	return controlRuntime;
}

function invalidateControls() {
	for (const project of workspaceServices.store?.projects.list() ?? [])
		controlRuntime?.invalidate(project.id);
}

function stopProject(projectId: string) {
	if (!supervisor)
		throw new IpcFailure('AGENT_UNAVAILABLE', 'The desktop cannot stop now');
	const stopping = supervisor.stop(projectId);
	controlRuntime?.invalidate(projectId, stopping);
	return stopping;
}

// Only windows showing the app get events; the renderer never sees the IPC event object.
function sendProjectEvent(event: ProjectEvent): void {
	agentCommands.observe(event);
	for (const window of BrowserWindow.getAllWindows()) {
		if (
			!window.webContents.isDestroyed() &&
			isAllowedOrigin(window.webContents.getURL(), appOrigins)
		) {
			window.webContents.send(CHANNELS.projectEvent, event);
		}
	}
	// After the send: the activity this event causes carries a later sequence, and the
	// renderer drops anything older than what it has seen, so it must not overtake it.
	activity?.observe(event);
}

function sendFilesEvent(event: FilesEvent): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (
			!window.webContents.isDestroyed() &&
			isAllowedOrigin(window.webContents.getURL(), appOrigins)
		) {
			window.webContents.send(FILES_CHANNELS.event, event);
		}
	}
}

function sendTerminalEvent(event: TerminalEvent): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (
			!window.webContents.isDestroyed() &&
			isAllowedOrigin(window.webContents.getURL(), appOrigins)
		) {
			window.webContents.send(TERMINAL_CHANNELS.event, event);
		}
	}
}

function appWindow(): BrowserWindow | undefined {
	return BrowserWindow.getAllWindows().find(
		window =>
			!window.isDestroyed() &&
			isAllowedOrigin(window.webContents.getURL(), appOrigins),
	);
}

function sendBrowserEvent(event: BrowserEvent): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (
			!window.webContents.isDestroyed() &&
			isAllowedOrigin(window.webContents.getURL(), appOrigins)
		) {
			window.webContents.send(BROWSER_CHANNELS.event, event);
		}
	}
}

async function nanocoderRuntime(): Promise<NanocoderRuntime> {
	const resolution = await lookupRuntime();
	if (!resolution.ok) {
		throw new IpcFailure(resolution.code, resolution.message);
	}
	return resolution.runtime;
}

async function chooseProjectRoot(): Promise<string | undefined> {
	const options: OpenDialogOptions = {
		title: 'Open a project folder',
		properties: ['openDirectory'],
	};
	const window = BrowserWindow.getFocusedWindow();
	const picked = window
		? await dialog.showOpenDialog(window, options)
		: await dialog.showOpenDialog(options);
	const [folder] = picked.filePaths;
	return picked.canceled || !folder ? undefined : folder;
}

// A native dialog in main, so the renderer can never grant trust on the user's behalf.
async function confirmTrust(
	refusal: TrustRefusal,
	root: string,
): Promise<boolean> {
	return confirmProjectTrust({
		root,
		refusal,
		signal: rendererAttachment.signal,
		ask: async options => {
			const window = BrowserWindow.getFocusedWindow();
			const {response} = window
				? await dialog.showMessageBox(window, options)
				: await dialog.showMessageBox(options);
			return response;
		},
	});
}

async function connect(): Promise<ConnectResult> {
	const {signal} = rendererAttachment;
	await untilAborted(rendererCleanup, signal);
	signal.throwIfAborted();
	const currentSupervisor = supervisor;
	const projects = workspaceServices.projects;
	if (
		runtimeDiscovery.signal.aborted ||
		!currentSupervisor ||
		!threads ||
		!projects
	) {
		throw new IpcFailure(
			'AGENT_UNAVAILABLE',
			'The desktop cannot start a project now',
		);
	}
	if (connecting) {
		throw new IpcFailure('BUSY', 'Already connecting to Nanocoder', true);
	}
	let settle!: () => void;
	const attempt = new Promise<void>(resolve => {
		settle = resolve;
	});
	connecting = attempt;
	try {
		const selected = await untilAborted(
			Promise.resolve(projects.addProject({})),
			signal,
		);
		if (selected.status === 'cancelled') return selected;
		signal.throwIfAborted();
		if (runtimeDiscovery.signal.aborted)
			throw new IpcFailure('AGENT_UNAVAILABLE', 'The desktop is shutting down');
		activeProjectId = undefined;
		agentCommands.reset(null);
		activeProjectId = selected.project.id;
		const opened = await untilAborted(
			Promise.resolve(projects.openProject({projectId: selected.project.id})),
			signal,
		);
		if (opened.status !== 'opened') return opened;
		return connectedProject(opened.project, signal);
	} catch (error) {
		if (error instanceof NanocoderFailure)
			throw new IpcFailure(error.code, error.message);
		throw error;
	} finally {
		if (connecting === attempt) connecting = undefined;
		settle();
	}
}

function connectedProject(
	project: ProjectInfo,
	signal: AbortSignal,
): ConnectResult {
	const currentSupervisor = supervisor;
	if (!currentSupervisor || !threads)
		throw new IpcFailure('AGENT_UNAVAILABLE', 'The desktop cannot connect now');
	const connection = currentSupervisor.getConnection(project.id);
	signal.throwIfAborted();
	if (
		activeProjectId !== project.id ||
		currentSupervisor.getConnection(project.id) !== connection
	)
		throw new IpcFailure(
			'AGENT_UNAVAILABLE',
			'The project process changed while connecting',
		);
	threads.attachProject(project.id);
	currentSupervisor.replayState(project.id);
	return {status: 'connected', agent: connection.agent};
}

// What the exit guard needs to know, without exposing the tracker (CHAT-22).
export const unfinishedWork = {
	projects: (): readonly string[] => activity?.unfinished() ?? [],
	onChange: (listener: () => void): (() => void) =>
		activity?.onChange(() => listener()) ?? (() => undefined),
	name: (projectId: string): string | undefined =>
		workspaceServices.store?.projects.get(projectId)?.displayName,
};

export function closeNanocoder(): Promise<void> {
	runtimeDiscovery.abort();
	rendererAttachment.abort(
		new IpcFailure('AGENT_UNAVAILABLE', 'The desktop is shutting down'),
	);
	return disposeDesktop({
		unsubscribe: unsubscribeProjectEvents,
		cancelPermissions: async () => {
			try {
				await Promise.all([
					terminal?.close(),
					browser?.close(),
					browserServer?.close(),
					rendererCleanup,
					connecting,
					threads?.detach(workspaceServices.store?.projects.list() ?? []),
				]);
			} finally {
				filesRuntime?.dispose();
				controlRuntime?.dispose();
				threads?.dispose();
			}
		},
		supervisor: workspaceServices.supervisor,
		store: workspaceServices.store,
	});
}

function watchRenderer(contents: WebContents): void {
	if (isBrowserSession(contents.session)) return;
	let attached = false;
	const detach = () => {
		if (!attached) return;
		const attempt = connecting;
		rendererAttachment.abort(
			new IpcFailure('AGENT_UNAVAILABLE', 'The app renderer detached'),
		);
		rendererAttachment = new AbortController();
		activeProjectId = undefined;
		agentCommands.reset(null);
		activity?.reset();
		invalidateControls();
		rendererCleanup = Promise.allSettled([
			terminal?.activate(null),
			browser?.activate(null),
			rendererCleanup,
			threads?.detach(
				runtimeDiscovery.signal.aborted
					? []
					: (workspaceServices.store?.projects.list() ?? []),
			),
			attempt,
		]).then(() => {});
	};
	contents.on('did-finish-load', () => {
		attached = isAllowedOrigin(contents.getURL(), appOrigins);
	});
	contents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
		if (isMainFrame && !isInPlace) {
			detach();
			attached = isAllowedOrigin(url, appOrigins);
		}
	});
	contents.on('render-process-gone', detach);
	contents.once('destroyed', detach);
}

export function registerIpcHandlers(
	allowedOrigins: readonly string[],
	services: WorkspaceServices = {},
): void {
	appOrigins = allowedOrigins;
	if (services.store) {
		const store = services.store;
		const sites = new SiteAccess({
			get: () => store.getSettings().browserAllowedSites,
			set: list => {
				store.updateSettings({browserAllowedSites: list});
			},
		});
		terminal = new TerminalService({
			project: id => store.projects.get(id),
			projects: () => store.projects.list(),
			createHost: createUtilityPtyHost,
			emit: sendTerminalEvent,
		});
		browser = new BrowserService({
			project: id => store.projects.get(id),
			emit: sendBrowserEvent,
			publicSites: () => store.getSettings().publicBrowsingEnabled,
			downloadsPath: () => app.getPath('downloads'),
			profiles: new BrowserProfiles({
				get: () => {
					const settings = store.getSettings();
					return {
						profiles: settings.browserProfiles,
						assignments: settings.browserAssignments,
					};
				},
				set: data => {
					store.updateSettings({
						browserProfiles: data.profiles,
						browserAssignments: data.assignments,
					});
				},
			}),
			clearData: clearBrowserPartition,
			openExternal: createSystemOpener(appWindow),
			createView: createElectronViewFactory(appWindow),
			sites,
			// Questions join the approval shelf of the chat whose turn asked; no turn, no answer (DEC-50).
			policy: createAgentPolicy({
				publicSites: () => store.getSettings().publicBrowsingEnabled,
				mode: context =>
					context.sessionId === null
						? undefined
						: supervisor?.sessionMode(context.projectId, context.sessionId),
				ask: async (context, question, signal) =>
					context.sessionId === null || !supervisor
						? null
						: supervisor.askDesktop(
								context.projectId,
								context.sessionId,
								question,
								signal,
							),
				sites,
			}),
		});
		const pages = browser;
		browserServer = createBrowserMcpServer({
			version: app.getVersion(),
			tools: [
				browserStatusTool(projectId => pages.pageFor(projectId)),
				...browserBrokerTools(pages),
			],
		});
		// Until it listens, sessions get no server and the gate says why (BRW-17).
		void browserServer.start().catch(() => undefined);
	}
	supervisor = services.supervisor
		? undefined
		: new ProjectSupervisor({
				resolveRuntime: (root, signal) =>
					resolveNanocoder({
						env: process.env,
						platform: process.platform,
						bundled: bundledRuntime(),
						untrustedRoots: [root],
						signal,
					}),
				clientInfo: {
					name: 'nanocoder-desktop',
					title: APP_NAME,
					version: app.getVersion(),
				},
				homeDir: homedir(),
				confirmTrust,
				mcpServers: projectId => browserServer?.forProject(projectId),
				// Without a store to say otherwise, Nanocoder's own browser stays off (DEC-48).
				disabledTools: () =>
					services.store?.getSettings().nanocoderBrowserEnabled === true
						? []
						: ['browser'],
				activity: projectId =>
					threads?.activity(projectId) ?? {
						runningTurn: false,
						openSessions: 0,
						preparing: false,
						lastActivityAt: 0,
					},
				recover: async (project, connection, signal) => {
					await threads?.restore(project, connection, signal);
				},
			});
	const ownedSupervisor = supervisor;
	activity = new ProjectActivityTracker({
		active: () => activeProjectId,
		publish: (projectId, status) =>
			ownedSupervisor?.publishProjectActivity(projectId, status),
	});
	const quiet = services.quiet === true;
	activity.onChange(
		createActivityNotifier({
			// Hidden test runs never raise real operating system notifications.
			supported: () => !quiet && Notification.isSupported(),
			windowFocused: () =>
				BrowserWindow.getAllWindows().some(
					window => window.isFocused() && !window.isMinimized(),
				),
			active: () => activeProjectId,
			projectName: id => services.store?.projects.get(id)?.displayName,
			show: ({title, body}, onClick) => {
				const notification = new Notification({title, body});
				notification.on('click', onClick);
				notification.show();
			},
			open: projectId => {
				const [window] = BrowserWindow.getAllWindows();
				if (!window) return;
				if (window.isMinimized()) window.restore();
				window.show();
				window.focus();
				ownedSupervisor?.publishProjectRequested(projectId);
			},
		}),
	);
	workspaceServices = {
		...services,
		supervisor: services.supervisor ?? supervisor,
		stopProject: services.stopProject ?? (supervisor ? stopProject : undefined),
		restartProject:
			services.restartProject ??
			(supervisor
				? async projectId => {
						const chosen = workspaceServices.store?.projects.get(projectId);
						if (!chosen || !supervisor)
							throw new IpcFailure('NOT_FOUND', 'Project not found');
						if (connecting)
							throw new IpcFailure(
								'BUSY',
								'Already connecting to Nanocoder',
								true,
							);
						if (threads?.projectOperations.isBusy(projectId))
							throw new IpcFailure(
								'BUSY',
								'Stop the current operation first',
								true,
							);
						controlRuntime?.invalidate(projectId);
						const {signal} = rendererAttachment;
						const state = await untilAborted(
							supervisor.restart(chosen),
							signal,
						);
						if (
							state.status === 'ready' &&
							activeProjectId === projectId &&
							workspaceServices.projects
						) {
							const opened = await untilAborted(
								Promise.resolve(
									workspaceServices.projects.openProject({projectId}),
								),
								signal,
							);
							if (opened.status === 'opened') {
								try {
									connectedProject(opened.project, signal);
								} catch (error) {
									if (error instanceof NanocoderFailure)
										throw new IpcFailure(error.code, error.message);
									throw error;
								}
							}
						}
						return supervisor.getState(projectId);
					}
				: undefined),
		diagnostics:
			services.diagnostics ??
			(supervisor
				? new DiagnosticsExporter({
						read: (projectId, snapshotId) => {
							if (!supervisor)
								throw new IpcFailure('NOT_FOUND', 'Project not found');
							return supervisor.getCapturedDiagnostics(projectId, snapshotId);
						},
						review: async snapshot => {
							const {response} = await dialog.showMessageBox({
								type: 'question',
								title: 'Review redacted diagnostics',
								message: 'Review these diagnostics before exporting',
								detail:
									snapshot.lines.join('\n') || 'No diagnostics were captured.',
								buttons: ['Choose destination', 'Cancel'],
								defaultId: 1,
								cancelId: 1,
								noLink: true,
							});
							return response === 0;
						},
						chooseDestination: async () => {
							const chosen = await dialog.showSaveDialog({
								title: 'Export redacted diagnostics',
								defaultPath: 'nanocoder-diagnostics.txt',
								filters: [{name: 'Text', extensions: ['txt']}],
							});
							return chosen.canceled ? undefined : chosen.filePath;
						},
						write: (destination, contents) =>
							writeFile(destination, contents, {mode: 0o600, flag: 'wx'}),
					})
				: undefined),
		projects:
			services.projects ??
			(services.store && ownedSupervisor
				? createProjectService({
						store: services.store,
						chooseRoot: chooseProjectRoot,
						supervisor: {
							probeProject: project => ownedSupervisor.probeProject(project),
							stop: stopProject,
						},
						signal: () => rendererAttachment.signal,
						beforeOpenProject: async project => {
							agentCommands.reset(project.id);
							await terminal?.activate(project.id);
							browser?.activate(project.id);
						},
						projectsChanged: projectId =>
							ownedSupervisor.publishProjectsChanged(projectId),
						announceProject: project => {
							activeProjectId = project.id;
							activity?.activate(project.id);
							threads?.attachProject(project.id);
							supervisor?.announceProject(project);
						},
					})
				: undefined),
	};
	const store = services.store;
	const snapshotSupervisor = supervisor;
	filesRuntime = store
		? createFilesRuntime({
				projects: () => store.projects.list(),
				project: projectId => store.projects.get(projectId),
				editor: () => store.getSettings().editor,
				send: sendFilesEvent,
				openPath: file => shell.openPath(file),
				showItemInFolder: file => shell.showItemInFolder(file),
				agentChanges: snapshotSupervisor
					? {
							gate: projectId => {
								try {
									return snapshotSupervisor.getCapabilityGates(projectId)
										.features.agentChanges;
								} catch {
									return {
										enabled: false,
										reason: 'Nanocoder is not connected for this project.',
									};
								}
							},
							snapshots: (projectId, threadId) => {
								const sessionId = store.threads.get(
									projectId,
									threadId,
								)?.nanocoderSessionId;
								if (!sessionId) return undefined;
								try {
									const connection =
										snapshotSupervisor.getConnection(projectId);
									return {
										list: () => connection.listTimeline(sessionId),
										read: (checkpointId, path) =>
											connection.readTimeline(sessionId, checkpointId, path),
									};
								} catch {
									return undefined;
								}
							},
						}
					: undefined,
			})
		: undefined;
	threads =
		!services.threads && services.store && supervisor
			? createThreadService({
					store: services.store,
					supervisor,
					onEvent: event => {
						sendProjectEvent(event);
						filesRuntime?.tracker.observe(event);
					},
					resolveAttachments: (project, attachments) => {
						const runtime = filesRuntime;
						if (!runtime)
							throw new IpcFailure(
								'UNAVAILABLE',
								'Attachments are unavailable',
							);
						let embedded = false;
						try {
							embedded =
								supervisor?.getConnection(project.id).agent.capabilities.prompt
									.embeddedContext === true;
						} catch {
							embedded = false;
						}
						return resolveAttachments(
							runtime.files,
							project,
							attachments,
							embedded,
							{
								current: projectId => {
									try {
										return browser?.currentPage({projectId}) ?? null;
									} catch {
										return null;
									}
								},
							},
						);
					},
					onSessionPrepared: context =>
						availableControls().hooks.onSessionPrepared(context),
					onThreadSelected: (projectId, threadId) =>
						controlRuntime?.hooks.onThreadSelected(projectId, threadId),
					beforeFirstPrompt: context =>
						availableControls().hooks.beforeFirstPrompt(context),
					validateBeforePrepare: (lease, thread, reason) =>
						availableControls().hooks.validateBeforePrepare(
							lease,
							thread,
							reason,
						),
					resolveLiveMode: (...args) =>
						availableControls().hooks.resolveLiveMode(...args),
					confirmDeleteHistory: async ({project, thread}) => {
						const options = deleteHistoryDialog({project, thread});
						const window = BrowserWindow.getFocusedWindow();
						const {response} = window
							? await dialog.showMessageBox(window, options)
							: await dialog.showMessageBox(options);
						return response === 0;
					},
				})
			: undefined;
	workspaceServices.threads = services.threads ?? threads;
	if (threads && services.store && ownedSupervisor) {
		controlRuntime = createWorkspaceControls({
			store: services.store,
			threads,
			getConnection: threads.getControlConnection,
			publishControls: controls => ownedSupervisor.publishControls(controls),
			publishThread: thread => ownedSupervisor.publishThread(thread),
			publishProject: project => ownedSupervisor.announceProject(project),
			confirmYolo: snapshot =>
				confirmYolo({
					...snapshot,
					ask: async options => {
						const window = BrowserWindow.getFocusedWindow();
						const {response} = window
							? await dialog.showMessageBox(window, options)
							: await dialog.showMessageBox(options);
						return response;
					},
				}),
		});
		workspaceServices.controls = services.controls ?? controlRuntime.controls;
		const owned = threads;
		workspaceServices.threads = {
			...owned,
			setThreadMode: controlRuntime.setThreadMode,
			// Record HEAD around the turn and which files it edited (GIT-05, GIT-12).
			// None of it runs ahead of the prompt, so a cancel always finds the turn.
			promptThread: async request => {
				const tracker = filesRuntime?.tracker;
				const tracking = tracker?.begin(request.projectId, request.threadId);
				let succeeded = false;
				try {
					const result = await owned.promptThread(request);
					succeeded = true;
					return result;
				} finally {
					void tracking
						?.then(started =>
							started
								? tracker?.end(request.projectId, request.threadId, succeeded)
								: undefined,
						)
						.catch(() => undefined);
				}
			},
		};
		if (workspaceServices.projects)
			workspaceServices.projects = {
				...workspaceServices.projects,
				setProjectDefaultMode: controlRuntime.setProjectDefaultMode,
			};
	}
	const commandThreads = workspaceServices.threads;
	if (commandThreads)
		workspaceServices.threads = {
			...commandThreads,
			answerThreadPermission: async request => {
				const accepted = agentCommands.capture(request);
				const result = await commandThreads.answerThreadPermission(request);
				accepted?.();
				return result;
			},
		};
	app.on('web-contents-created', (_event, contents) => watchRenderer(contents));
	for (const window of BrowserWindow.getAllWindows())
		watchRenderer(window.webContents);
	registerWorkspaceHandlers(registerHandler, allowedOrigins, workspaceServices);
	registerFilesHandlers(registerHandler, allowedOrigins, filesRuntime);
	registerTerminalHandlers(registerHandler, allowedOrigins, terminal);
	registerBrowserHandlers(registerHandler, allowedOrigins, browser);
	unsubscribeProjectEvents = workspaceServices.supervisor?.subscribe(event => {
		if (event.type === 'supervisor' && event.state.status === 'untrusted') {
			const store = workspaceServices.store;
			const project = store?.projects.get(event.projectId);
			if (project?.trusted) store?.projects.save({...project, trusted: false});
		}
		if (event.type !== 'turn') sendProjectEvent(event);
		if (
			event.type === 'project-removed' ||
			(event.type === 'project' && !event.project.trusted)
		)
			filesRuntime?.closeProject(event.projectId);
		if (
			(event.type === 'supervisor' &&
				event.state.status !== 'ready' &&
				event.state.status !== 'starting') ||
			event.type === 'project-removed' ||
			(event.type === 'project' && !event.project.trusted)
		)
			controlRuntime?.invalidate(event.projectId);
		else if (event.type === 'thread-removed')
			controlRuntime?.invalidateThread(event.projectId, event.threadId);
	});
	registerHandler(
		CHANNELS.getAppInfo,
		z.strictObject({}),
		(): AppInfo => ({
			name: APP_NAME,
			version: app.getVersion(),
			...(workspaceServices.store?.recoveredFrom
				? {recoveredDatabase: workspaceServices.store.recoveredFrom}
				: {}),
		}),
		allowedOrigins,
	);
	registerHandler(
		CHANNELS.writeClipboard,
		clipboardWriteSchema,
		request => writeClipboard(request, text => clipboard.writeText(text)),
		allowedOrigins,
	);
	registerHandler(
		CHANNELS.getNanocoderRuntime,
		z.strictObject({}),
		nanocoderRuntime,
		allowedOrigins,
	);
	registerHandler(
		CHANNELS.connectNanocoder,
		z.strictObject({}),
		connect,
		allowedOrigins,
	);
}
