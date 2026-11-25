import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AppShell} from '@/renderer/app-shell';
import {ApprovalRequests} from '@/renderer/approval-requests';
import logoUrl from '@/renderer/assets/nano-collective-avatar.png';
import {
	type AttachmentStore,
	addAttachment,
	attachmentKey,
	chips,
	clearAttachments,
	labelFor,
	MAX_ATTACHMENTS,
	removeAttachment,
} from '@/renderer/attachments';
import {BackgroundProjects} from '@/renderer/background-projects';
import {BrowserPanel} from '@/renderer/browser-panel';
import {Composer} from '@/renderer/composer';
import {ConversationStream} from '@/renderer/conversation-stream';
import {copyContent} from '@/renderer/copy-content';
import {Icon} from '@/renderer/icons';
import {
	commandModifier,
	notifyImported,
	type OverlayRequest,
	type WorkspaceDialog,
} from '@/renderer/overlay-model';
import {
	type OverlayHandle,
	OverlayProvider,
	PaletteButton,
	ThemeButton,
} from '@/renderer/overlays';
import {backgroundItems} from '@/renderer/project-activity';
import {controlsForThread} from '@/renderer/project-controls';
import {projectPalette} from '@/renderer/project-palette';
import {ProjectSwitch} from '@/renderer/recent-projects';
import {
	FAILED_STATUSES,
	RecoveryTools,
	TurnFailureNotice,
} from '@/renderer/recovery-tools';
import {
	retentionAnnouncement,
	retentionHint,
} from '@/renderer/retention-notice';
import {stepRetryFocus} from '@/renderer/retry-focus';
import {SessionImportList} from '@/renderer/session-import-list';
import {type FooterAcpState, SidebarFooter} from '@/renderer/sidebar-footer';
import {SidebarRecents} from '@/renderer/sidebar-recents';
import {
	acpBadge,
	observeSupervisor,
	type SupervisorIndex,
} from '@/renderer/supervisor-state';
import {TerminalPanel} from '@/renderer/terminal-panel';
import {threadComposerState} from '@/renderer/thread-composer-state';
import {type ThreadDialogData, ThreadDialogs} from '@/renderer/thread-dialogs';
import {
	importPalette,
	threadPalette,
	threadSearchPalette,
} from '@/renderer/thread-palette';
import {ThreadRail} from '@/renderer/thread-rail';
import {
	ThreadRecoveryNotice,
	ViewOnlyFooter,
} from '@/renderer/thread-recovery-notice';
import {TrustFeedback} from '@/renderer/trust-feedback';
import {Button, Card, StatusBadge} from '@/renderer/ui';
import {useBrowser} from '@/renderer/use-browser';
import {useDiagnosticReview} from '@/renderer/use-diagnostic-review';
import {useFiles} from '@/renderer/use-files';
import {useModalOpen} from '@/renderer/use-modal-open';
import {
	useBackgroundAnnouncements,
	useProjectActivity,
} from '@/renderer/use-project-activity';
import {useProjectControls} from '@/renderer/use-project-controls';
import {useProjects} from '@/renderer/use-projects';
import {useRetentionWarnings} from '@/renderer/use-retention-warnings';
import {useReview} from '@/renderer/use-review';
import {useSessionImports} from '@/renderer/use-session-imports';
import {useTerminal} from '@/renderer/use-terminal';
import {useThreads} from '@/renderer/use-threads';
import {WelcomePage} from '@/renderer/welcome-page';
import {Workbench, type WorkbenchTab} from '@/renderer/workbench';
import {
	WorkspaceDialogs,
	type WorkspaceDialogsProps,
} from '@/renderer/workspace-dialogs';
import {CONFIG_UNCERTAINTY_REASON} from '@/shared/control-reasons';
import type {
	AppInfo,
	CapabilityGates,
	ConnectedAgent,
	ConnectResult,
	IpcResult,
	NanocoderRuntime,
	PromptAttachment,
} from '@/shared/ipc';
import {REPLAY_FAILURE_REASON, REPLAY_REASON} from '@/shared/thread-replay';

// A dialog only needs the current element; the opener is kept across replacements.
function focusedElement(): HTMLElement | null {
	const active = document.activeElement;
	return active instanceof HTMLElement && active !== document.body
		? active
		: null;
}

export function App() {
	const [info, setInfo] = useState<AppInfo | null>(null);
	const [runtime, setRuntime] = useState<IpcResult<NanocoderRuntime> | null>(
		null,
	);
	const [connecting, setConnecting] = useState(false);
	const [opened, setOpened] = useState<IpcResult<ConnectResult> | null>(null);
	const projectControls = useProjects(() => setOpened(null));
	const [agents, setAgents] = useState<Record<string, ConnectedAgent>>({});
	const [gates, setGates] = useState<Record<string, CapabilityGates>>({});
	const [supervisors, setSupervisors] = useState<SupervisorIndex>({});
	const supervisorIndex = useRef<SupervisorIndex>({});
	const [attemptedProjectId, setAttemptedProjectId] = useState<string | null>(
		null,
	);
	const selectedProject = useRef<string | null>(null);
	const projectId = attemptedProjectId ?? projectControls.activeProjectId;
	const terminal = useTerminal(projectId);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const terminalTrigger = useRef<HTMLButtonElement>(null);
	const selected = supervisors[projectId ?? ''];
	const processState = selected?.state ?? null;
	const controls = useThreads(projectId, processState?.status === 'ready');
	const {workspace, conversation} = controls;
	const sessionImports = useSessionImports(
		projectId,
		processState?.status === 'ready' &&
			processState.gates?.features.list.enabled === true,
		workspace.threads,
	);
	const [importFor, setImportFor] = useState<string | null>(null);
	const importOpen =
		sessionImports.ready && importFor !== null && importFor === projectId;
	const [importFocus, setImportFocus] = useState(0);
	const thread =
		workspace.threads.find(row => row.id === workspace.activeThreadId) ?? null;
	const {transcript, draft, turn, cancellation} = conversation;
	const agent = agents[projectId ?? ''];
	const outcome =
		opened?.ok && opened.value.status !== 'cancelled'
			? opened.value
			: agent
				? {status: 'connected' as const, agent}
				: null;
	const accepting =
		processState?.status === 'ready' &&
		processState.agent?.root === agent?.root &&
		!connecting &&
		!projectControls.pending;
	const rootBusy =
		workspace.promptingThreadId !== null ||
		workspace.cancellingThreadIds.length > 0 ||
		(processState?.activeThreadId ?? null) !== null;
	const sending =
		thread !== null &&
		(workspace.promptingThreadId === thread.id ||
			(thread.nanocoderSessionId !== null &&
				thread.nanocoderSessionId === processState?.activeThreadId));
	const stopping =
		thread !== null && workspace.cancellingThreadIds.includes(thread.id);
	const activeReplay = workspace.replay?.[thread?.id ?? ''];
	const replayReason =
		activeReplay === 'failed'
			? (thread?.viewOnlyReason ?? REPLAY_FAILURE_REASON)
			: Object.values(workspace.replay ?? {}).includes('replaying')
				? processState?.status === 'failed'
					? REPLAY_FAILURE_REASON
					: REPLAY_REASON
				: null;
	const composerState = threadComposerState({
		thread,
		accepting,
		replay: activeReplay,
		pending: workspace.loading || workspace.pending,
	});
	const editable = composerState.editable;
	const centredComposer =
		composerState.visible &&
		activeReplay === undefined &&
		transcript.items.length === 0 &&
		!sending;
	const rootControlReason =
		replayReason ??
		(rootBusy
			? 'model + mode locked until the project turn stops'
			: !accepting
				? 'Nanocoder is not ready'
				: workspace.loading || workspace.pending
					? 'another thread request is pending'
					: null);
	const modelControls = useProjectControls(
		projectId,
		rootControlReason,
		processState?.status === 'ready',
	);
	const currentProject = projectControls.projects.find(
		project => project.id === projectId,
	);
	const configUncertain =
		modelControls.controls?.modelGate.reason === CONFIG_UNCERTAINTY_REASON;
	const [inspector, setInspector] = useState<WorkbenchTab | null>(null);
	const inspectorLoaded = useRef(false);
	const filesTrigger = useRef<HTMLButtonElement>(null);
	const browserTrigger = useRef<HTMLButtonElement>(null);
	const browserTabOpen = inspector === 'browser' && projectId !== null;
	const filesTabOpen =
		inspector !== null &&
		inspector !== 'browser' &&
		projectId !== null &&
		currentProject?.trusted === true;
	const inspectorOpen = browserTabOpen || filesTabOpen;
	const files = useFiles(projectId, filesTabOpen);
	const reviewPanel = useReview(
		projectId,
		filesTabOpen,
		inspector === 'review',
	);
	const browser = useBrowser(projectId);
	const modalOpen = useModalOpen();
	const [attachments, setAttachments] = useState<AttachmentStore>({});
	const attachKey =
		projectId && thread ? attachmentKey(projectId, thread.id) : null;
	const attached: PromptAttachment[] = attachKey
		? (attachments[attachKey] ?? [])
		: [];
	const attachReason = !thread
		? 'open or create a thread first'
		: thread.archiveState === 'archived'
			? 'this thread is archived'
			: thread.runState === 'view-only'
				? 'this thread is view-only'
				: attached.length >= MAX_ATTACHMENTS
					? 'remove an attachment before adding another (20 maximum)'
					: null;
	const failed =
		thread?.runState === 'failed' ||
		(turn !== null && !turn.ok && thread?.runState !== 'ready');
	const processBadge = acpBadge(supervisors, selected?.root ?? '');
	const turnStatus = transcript.permissions.length
		? 'approval'
		: sending
			? 'running'
			: failed || (opened && !opened.ok)
				? 'failed'
				: thread?.runState === 'interrupted'
					? 'interrupted'
					: thread?.runState === 'view-only'
						? 'view-only'
						: 'ready';
	const footerAcp: FooterAcpState =
		processBadge ??
		(processState?.status === 'starting'
			? {status: 'acp-starting'}
			: processState?.status === 'failed'
				? {status: 'acp-exited'}
				: null);
	const composerInput = useRef<HTMLTextAreaElement>(null);
	const retryFocus = useRef(false);
	const retryScope = useRef<string | null>(null);
	const retrying = useRef(false);
	const [overlayOpen, setOverlayOpen] = useState(false);
	const paletteFocus = useRef<{
		projectId: string | null;
		threadId: string;
		settled: boolean;
	} | null>(null);
	const [, setPaletteFocusRevision] = useState(0);
	const overlays = useRef<OverlayHandle>(null);
	// What is happening in other projects, kept apart from the one in view (CHAT-22).
	const activity = useProjectActivity(id => void projectControls.onOpen(id));
	const background = useMemo(
		() => backgroundItems(activity, projectControls.projects, projectId),
		[activity, projectControls.projects, projectId],
	);
	useBackgroundAnnouncements(background, message =>
		overlays.current?.notify(message),
	);
	const retention = useRetentionWarnings(
		`${projectId ?? ''}:${workspace.activeThreadId ?? ''}`,
	);
	const retentionView = useMemo(
		() =>
			retention && retention.threads.length > 0
				? {
						hint: retentionHint(retention),
						byThread: new Map(
							retention.threads.map(item => [item.threadId, item]),
						),
					}
				: undefined,
		[retention],
	);
	const announcedRetention = useRef('');
	useEffect(() => {
		const next = retentionAnnouncement(retention, announcedRetention.current);
		announcedRetention.current = next.key;
		if (next.message) overlays.current?.notify(next.message);
	}, [retention]);
	const review = useDiagnosticReview(projectId, {
		capture: id => window.desktop.getDiagnostics({projectId: id}),
		exportSnapshot: request => window.desktop.exportDiagnostics(request),
	});
	// The shared overlay keeps the first opener as the return target across replacements.
	const openDialog = (kind: WorkspaceDialog, opener = focusedElement()) =>
		overlays.current?.open(kind, opener);
	const captureDiagnostics = () => {
		const opener = focusedElement();
		void review.capture().then(captured => {
			if (captured) openDialog('diagnostics', opener);
		});
	};
	useEffect(() => {
		if (!review.snapshot) overlays.current?.closeIf('diagnostics');
	}, [review.snapshot]);

	const openOverlay = (request: OverlayRequest, opener?: HTMLElement | null) =>
		overlays.current?.open(request, opener);

	useEffect(() => {
		if (
			!sending &&
			cancellation?.ok &&
			(document.activeElement === document.body ||
				document.activeElement?.matches('.subagent-run-card'))
		)
			composerInput.current?.focus();
	}, [sending, cancellation]);

	const scopeKey = `${projectId ?? ''}\n${workspace.activeThreadId ?? ''}`;
	useEffect(() => {
		const request = paletteFocus.current;
		if (!request) return;
		if (request.projectId !== projectId) {
			paletteFocus.current = null;
			return;
		}
		if (
			!request.settled ||
			overlayOpen ||
			document.querySelector('dialog:modal')
		)
			return;
		if (
			request.threadId !== workspace.activeThreadId ||
			transcript.permissions.length
		) {
			paletteFocus.current = null;
			return;
		}
		if (workspace.pending || workspace.loading) return;
		const target = editable
			? composerInput.current
			: document.querySelector<HTMLElement>('.shell-stream-scroll');
		if (
			!target ||
			!target.getClientRects().length ||
			(target instanceof HTMLTextAreaElement && target.disabled)
		)
			return;
		target.focus();
		if (document.activeElement === target) paletteFocus.current = null;
	});
	useEffect(() => {
		const cancel = () => {
			paletteFocus.current = null;
		};
		document.addEventListener('pointerdown', cancel, true);
		document.addEventListener('keydown', cancel, true);
		return () => {
			document.removeEventListener('pointerdown', cancel, true);
			document.removeEventListener('keydown', cancel, true);
		};
	}, []);
	useEffect(() => {
		if (!retryFocus.current) return;
		const composer = composerInput.current;
		const active = document.activeElement;
		const step = stepRetryFocus({
			intent: retryFocus.current,
			retrying: retrying.current,
			sameScope: retryScope.current === scopeKey,
			dialogOpen: document.querySelector('dialog[open]') !== null,
			composer: !composer
				? 'missing'
				: composer.disabled
					? 'disabled'
					: 'enabled',
			active:
				active === null || active === document.body
					? 'body'
					: active === composer
						? 'composer'
						: 'other',
		});
		retryFocus.current = step.intent;
		if (step.focus) composer?.focus();
	});

	useEffect(() => {
		const endRetryFocus = () => {
			retryFocus.current = false;
		};
		document.addEventListener('pointerdown', endRetryFocus, true);
		return () =>
			document.removeEventListener('pointerdown', endRetryFocus, true);
	}, []);

	useEffect(() => {
		return window.desktop.onProjectEvent(event => {
			const previous = supervisorIndex.current;
			const next = observeSupervisor(previous, event);
			if (next === previous) return;
			supervisorIndex.current = next;
			setSupervisors(next);
			if (event.type === 'project') {
				selectedProject.current = event.projectId;
				setAttemptedProjectId(event.projectId);
			} else if (event.type === 'project-removed') {
				if (selectedProject.current === event.projectId) {
					selectedProject.current = null;
					setAttemptedProjectId(null);
					setOpened(null);
				}
				void projectControls.refresh();
			} else if (event.type === 'supervisor') {
				const {agent, gates} = event.state;
				if (agent)
					setAgents(current => ({...current, [event.projectId]: agent}));
				if (gates)
					setGates(current => ({...current, [event.projectId]: gates}));
				if (
					event.state.status === 'ready' &&
					previous[event.projectId]?.state?.status === 'starting'
				)
					void controls.reload(event.projectId);
			}
		});
	}, [controls.reload, projectControls.refresh]);

	const checkRuntime = useCallback(() => {
		void window.desktop.getNanocoderRuntime().then(setRuntime);
	}, []);
	useEffect(() => {
		void window.desktop.getAppInfo().then(result => {
			if (result.ok) setInfo(result.value);
		});
		checkRuntime();
	}, [checkRuntime]);
	const connect = async () => {
		setConnecting(true);
		setOpened(null);
		try {
			const result = await window.desktop.connectNanocoder();
			if (!result.ok || result.value.status !== 'cancelled') setOpened(result);
		} finally {
			setConnecting(false);
			void projectControls.refresh();
		}
	};
	const send = () => {
		if (
			editable &&
			!replayReason &&
			!rootBusy &&
			!modelControls.pending &&
			!configUncertain &&
			draft.trim()
		) {
			const key = attachKey;
			void controls
				.send(attached.length ? attached : undefined)
				.then(result => {
					// Attached context goes with one message only, then it is forgotten.
					if (result?.ok && key)
						setAttachments(current => clearAttachments(current, key));
				});
		}
	};
	const attach = (item: PromptAttachment) => {
		if (!attachKey) return;
		setAttachments(current => addAttachment(current, attachKey, item));
		overlays.current?.notify(`attached ${labelFor(item)} to your next message`);
	};
	const copy = useCallback((text: string) => {
		void copyContent(
			text,
			async value => {
				const result = await window.desktop.writeClipboard({text: value});
				if (!result.ok) throw new Error('clipboard unavailable');
			},
			message => overlays.current?.notify(message),
		);
	}, []);
	const openInBrowser = (url: string) => {
		showPanel('browser');
		void browser.open(url);
	};
	const editorFailure = async (
		work: Promise<{ok: boolean; error?: {message: string}}>,
	): Promise<string | null> => {
		const result = await work.catch(() => null);
		if (!result) return 'the request could not finish';
		return result.ok ? null : (result.error?.message ?? 'the request failed');
	};
	const openInEditor = (path: string, line?: number) =>
		projectId
			? editorFailure(
					window.desktop.files.openInEditor({
						projectId,
						path,
						...(line ? {line} : {}),
					}),
				)
			: Promise.resolve('open a project first');
	const reveal = (path: string) =>
		projectId
			? editorFailure(window.desktop.files.reveal({projectId, path}))
			: Promise.resolve('open a project first');
	const showPanel = (tab: WorkbenchTab) => setInspector(tab);
	const hidePanel = () => {
		const was = inspector;
		setInspector(null);
		(was === 'browser' ? browserTrigger : filesTrigger).current?.focus();
	};
	useEffect(() => {
		void window.desktop.getUiState({}).then(result => {
			if (result.ok && result.value.inspector)
				setInspector(result.value.inspector);
			inspectorLoaded.current = true;
		});
	}, []);
	useEffect(() => {
		if (inspectorLoaded.current)
			void window.desktop.updateUiState({patch: {inspector}});
	}, [inspector]);
	const cancel = async () => {
		if (thread) await controls.cancel(thread.id);
	};
	const runningThreadId =
		workspace.promptingThreadId ??
		workspace.cancellingThreadIds[0] ??
		workspace.threads.find(
			row =>
				row.nanocoderSessionId !== null &&
				row.nanocoderSessionId === processState?.activeThreadId,
		)?.id ??
		null;
	const newShortcut = `${commandModifier(navigator.platform)}N`;
	const openThread = (id: string) => {
		if (
			runningThreadId &&
			id !== runningThreadId &&
			id !== workspace.activeThreadId
		)
			openOverlay({kind: 'other-thread', threadId: runningThreadId});
		setImportFor(null);
		return controls.open(id);
	};
	const openPaletteThread = (id: string) => {
		const target = workspace.threads.find(row => row.id === id);
		if (!target) return;
		if (window.matchMedia('(max-width: 840px)').matches) setInspector(null);
		const request = {
			projectId,
			threadId: id,
			settled: false,
		};
		paletteFocus.current = request;
		void openThread(id).then(opened => {
			if (paletteFocus.current !== request) return;
			if (!opened) paletteFocus.current = null;
			else {
				request.settled = true;
				setPaletteFocusRevision(revision => revision + 1);
			}
		});
	};
	const onNew = () => {
		setImportFor(null);
		openOverlay({kind: 'new-thread'});
	};
	const onRename = (threadId: string) =>
		openOverlay({kind: 'rename', threadId});
	const onArchive = (threadId: string, archived: boolean) => {
		if (archived) openOverlay({kind: 'archive', threadId});
		else void controls.archive(threadId, false);
	};
	const onRemove = (threadId: string) =>
		openOverlay({kind: 'remove', threadId});
	const importSession = notifyImported(sessionImports.importSession, message =>
		overlays.current?.notify(message),
	);
	const openImportPage = () => {
		setImportFocus(request => request + 1);
		setImportFor(projectId);
	};
	const renameGate = gates[projectId ?? '']?.features.rename;
	const deleteGate = gates[projectId ?? '']?.features.delete;
	const renameDisabledReason = renameGate?.enabled
		? undefined
		: (renameGate?.reason ?? 'Nanocoder is not ready');
	const deleteHistoryDisabledReason = deleteGate?.enabled
		? undefined
		: (deleteGate?.reason ?? 'Nanocoder is not ready');
	const pending =
		workspace.loading ||
		workspace.pending ||
		connecting ||
		projectControls.pending ||
		modelControls.pending;
	const waitingForDecision = transcript.permissions.length > 0;
	const processFailed =
		processState !== null && FAILED_STATUSES.includes(processState.status);
	const notReadyReason = processFailed
		? 'retry this thread before sending'
		: 'Nanocoder is not ready. retry before sending.';
	const sendReason =
		replayReason ??
		(!accepting
			? notReadyReason
			: thread?.archiveState === 'archived'
				? 'this thread is archived; unarchive it before sending'
				: sending
					? waitingForDecision
						? 'waiting for your decision · draft is not queued'
						: 'turn in progress · draft is not queued'
					: rootBusy
						? 'another thread is running'
						: modelControls.pending
							? 'a project control change is pending'
							: configUncertain
								? CONFIG_UNCERTAINTY_REASON
								: null);

	const turnFailure = turn && !turn.ok && failed ? turn.error.message : null;
	// The failed turn's row carries the recovery card, below the user message.
	const recoveryInFailure =
		!importOpen &&
		processState?.status !== 'ready' &&
		turnFailure !== null &&
		transcript.items.some(item => item.kind === 'failure');
	const recoveryTools = (
		<RecoveryTools
			state={processState}
			turnFailure={processState?.status === 'ready' ? null : turnFailure}
			onRetry={async id => {
				retryFocus.current = true;
				retryScope.current = scopeKey;
				retrying.current = true;
				const result = await window.desktop
					.restartProject({projectId: id})
					.finally(() => {
						retrying.current = false;
					});
				if (!result.ok || result.value.status !== 'ready')
					retryFocus.current = false;
				if (
					selectedProject.current === id &&
					result.ok &&
					result.value.status === 'ready' &&
					result.value.agent
				) {
					setOpened(null);
					projectControls.clearFeedback();
					void projectControls.refresh();
					await controls.reload(id);
				}
				return result;
			}}
			onDiagnostics={captureDiagnostics}
			diagnosticsBusy={review.busy}
			diagnosticsMessage={overlayOpen ? '' : review.message}
			onNew={onNew}
			newPending={workspace.pending}
		/>
	);

	const threadDialogData: ThreadDialogData = {
		threads: workspace.threads,
		projectId,
		projectName: currentProject?.displayName ?? 'selected project',
		defaultMode: currentProject?.defaultMode,
		pending,
		projectBusy: rootBusy,
		renameDisabledReason,
		deleteHistoryDisabledReason,
		actions: {
			create: controls.create,
			setDraft: controls.setDraft,
			open: controls.open,
			rename: controls.rename,
			archive: controls.archive,
			remove: controls.remove,
			deleteHistory: controls.deleteHistory,
		},
	};
	const workspaceDialogData: Omit<WorkspaceDialogsProps, 'kind' | 'onClose'> = {
		projects: {
			projects: projectControls.projects,
			activeProjectId: projectId,
			pending: connecting || projectControls.pending,
			onAdd: () => {
				overlays.current?.closeIf('projects');
				projectControls.onAdd();
			},
			onOpen: id => {
				overlays.current?.closeIf('projects');
				projectControls.onOpen(id);
			},
			onLocate: id => {
				overlays.current?.closeIf('projects');
				projectControls.onLocate(id);
			},
		},
		runtime: {
			runtime,
			processState,
			projectRoot: currentProject?.canonicalRoot ?? null,
			gates: gates[projectId ?? ''] ?? null,
			diagnosticsBusy: review.busy,
			diagnosticsMessage: review.message,
			onCheckAgain: checkRuntime,
			onCapabilities: () => openDialog('capabilities'),
			onDiagnostics: captureDiagnostics,
		},
		capabilities: {
			gates: gates[projectId ?? ''] ?? null,
			modelGate: modelControls.controls?.modelGate ?? null,
			agent: agent ?? null,
			thread,
		},
		archives: {
			threads: workspace.threads.filter(row => row.archiveState === 'archived'),
			projectName: currentProject?.displayName,
			now: new Date(),
			pending,
			onUnarchive: id => {
				void controls.archive(id, false);
			},
		},
		diagnostics: review.snapshot
			? {
					snapshot: review.snapshot,
					busy: review.busy,
					message: review.message,
					onExport: review.exportSnapshot,
				}
			: null,
	};

	return (
		<OverlayProvider
			ref={overlays}
			pendingApprovalCount={transcript.permissions.length}
			canClose={request => request !== 'diagnostics' || !review.busy}
			onClosed={request => {
				if (request === 'diagnostics') review.close();
			}}
			onOpenChange={setOverlayOpen}
			renderDialog={(request, api) =>
				typeof request === 'string' ? (
					<WorkspaceDialogs
						kind={request}
						onClose={api.close}
						{...workspaceDialogData}
					/>
				) : (
					<ThreadDialogs request={request} data={threadDialogData} api={api} />
				)
			}
			threads={threadSearchPalette({
				projectId,
				threads: workspace.threads,
				activeThreadId: workspace.activeThreadId,
				pending,
				onOpen: openPaletteThread,
			})}
			actions={[
				...threadPalette({
					projectId,
					projectName: currentProject?.displayName,
					newShortcut,
					thread,
					pending,
					projectBusy: rootBusy,
					renameDisabledReason: thread?.nanocoderSessionId
						? renameDisabledReason
						: undefined,
					onNew,
					onRename,
					onArchive,
				}),
				...importPalette({
					ready: sessionImports.ready,
					onImport: openImportPage,
				}),
				...(['files', 'review'] as const).map(tab => ({
					id: `panel-${tab}`,
					label:
						inspectorOpen && inspector === tab
							? `hide ${tab === 'files' ? 'project files' : 'review of changes'}`
							: `show ${tab === 'files' ? 'project files' : 'review of changes'}`,
					glyph: tab === 'files' ? '▤' : '±',
					keywords:
						tab === 'files'
							? 'browse tree folder preview'
							: 'git diff changes staged unstaged comment',
					disabledReason:
						projectId && currentProject?.trusted
							? undefined
							: 'open a trusted project first',
					run: () =>
						inspectorOpen && inspector === tab ? hidePanel() : showPanel(tab),
				})),
				{
					id: 'panel-browser',
					label: browserTabOpen
						? 'hide the in-app browser'
						: 'show the in-app browser',
					glyph: '◫',
					keywords: 'preview localhost web page url address',
					disabledReason: projectId ? undefined : 'open a project first',
					run: () => (browserTabOpen ? hidePanel() : showPanel('browser')),
				},
				...projectPalette({
					...projectControls,
					pending: connecting || projectControls.pending,
				}),
				{
					id: 'open-terminal',
					label: 'open your project terminal',
					glyph: '$_',
					keywords: 'shell pty',
					disabledReason: projectId ? undefined : 'open a project first',
					run: () => setTerminalOpen(true),
				},
				{
					id: 'open-folder',
					label: 'open a project folder',
					glyph: '⌗',
					keywords: 'add directory',
					disabledReason:
						connecting || projectControls.pending
							? 'another project request or native dialog is pending'
							: !runtime?.ok
								? 'Nanocoder runtime is not available'
								: undefined,
					run: () => {
						void connect();
					},
				},
			]}
		>
			<AppShell
				logoSrc={logoUrl}
				title={
					<>
						Nanocoder <span className="brand-desktop">Desktop</span>
					</>
				}
				threadTitle={importOpen ? 'saved sessions' : thread?.title}
				onOpenThreadMenu={
					thread
						? () => openOverlay({kind: 'thread-menu', threadId: thread.id})
						: undefined
				}
				projectName={
					importOpen && currentProject
						? `${currentProject.displayName} / saved sessions`
						: currentProject?.displayName
				}
				sidebarFooter={
					<SidebarFooter
						acp={footerAcp}
						nanocoderVersion={
							agent?.version ?? (runtime?.ok ? runtime.value.version : null)
						}
						notice={
							gates[projectId ?? '']?.versionPolicy.status === 'untested'
								? 'untested'
								: gates[projectId ?? '']?.versionPolicy.status === 'refused'
									? 'not supported'
									: undefined
						}
						desktopVersion={info?.version ?? 'pre-v0.1'}
						runtimeError={
							runtime && !runtime.ok ? runtime.error.message : undefined
						}
						onCheckRuntime={checkRuntime}
						onOpenRuntime={opener => openDialog('runtime', opener)}
						onOpenShortcuts={opener => openOverlay('shortcuts', opener)}
					/>
				}
				palette={
					<>
						{projectId && currentProject?.trusted && (
							<Button
								ref={filesTrigger}
								aria-label="open project files"
								aria-expanded={filesTabOpen}
								onClick={() =>
									filesTabOpen
										? hidePanel()
										: showPanel(
												inspector && inspector !== 'browser'
													? inspector
													: 'files',
											)
								}
							>
								<Icon name="files" size={16} />
								files
							</Button>
						)}
						{projectId && (
							<Button
								ref={browserTrigger}
								aria-label="open browser"
								aria-expanded={browserTabOpen}
								onClick={() =>
									browserTabOpen ? hidePanel() : showPanel('browser')
								}
							>
								browser
							</Button>
						)}
						{projectId && (
							<Button
								ref={terminalTrigger}
								aria-label="open terminal"
								aria-expanded={terminalOpen}
								onClick={() => setTerminalOpen(value => !value)}
							>
								terminal
							</Button>
						)}
						<ThemeButton />
						<PaletteButton />
					</>
				}
				bottomPanel={
					terminalOpen &&
					projectId && (
						<TerminalPanel
							key={projectId}
							{...terminal}
							projectName={currentProject?.displayName ?? 'selected project'}
							disabledReason={
								!currentProject?.trusted ||
								currentProject.availability !== 'available'
									? 'trust and open the project before starting its terminal'
									: null
							}
							onAction={terminal.action}
							onData={terminal.write}
							onResize={terminal.resize}
							onOpenUrl={openInBrowser}
							onClose={() => {
								setTerminalOpen(false);
								terminalTrigger.current?.focus();
							}}
						/>
					)
				}
				workbench={
					inspectorOpen && inspector
						? {
								title: inspector === 'browser' ? 'browser' : 'files and review',
								onClose: hidePanel,
								children: (
									<Workbench
										tab={inspector}
										onTab={showPanel}
										files={files}
										review={reviewPanel}
										attachReason={attachReason}
										onAttachFile={path => attach({kind: 'file', path})}
										onComment={attach}
										onOpenEditor={openInEditor}
										onReveal={reveal}
										browser={
											<BrowserPanel
												projectName={
													currentProject?.displayName ?? 'selected project'
												}
												snapshot={browser.snapshot}
												publicSites={browser.publicSites}
												nanocoderBrowser={browser.nanocoderBrowser}
												sites={browser.snapshot?.agent.sites ?? []}
												profiles={browser.profiles}
												loading={browser.loading}
												pending={browser.pending}
												error={browser.error}
												suspended={modalOpen}
												onOpen={browser.open}
												onNavigate={browser.navigate}
												onBounds={browser.setBounds}
												onPublicSites={browser.setPublicSites}
												onNanocoderBrowser={browser.setNanocoderBrowser}
												onAgentPaused={browser.setAgentPaused}
												onInterruptAgent={browser.interruptAgent}
												onForgetSite={browser.forgetSite}
												onAllowAndOpen={browser.allowAndOpen}
												onProfile={browser.setProfile}
												onCreateProfile={browser.createProfile}
												onDeleteProfile={browser.deleteProfile}
												onClearData={browser.clearData}
												onOpenExternal={browser.openExternal}
												attachReason={attachReason}
												onSendToChat={url =>
													attach({kind: 'browser-page', url})
												}
											/>
										}
									/>
								),
							}
						: undefined
				}
				projectRail={
					<ProjectSwitch
						selected={currentProject}
						onOpen={() => openDialog('projects')}
					/>
				}
				threadRail={
					<>
						<ThreadRail
							key={`threads:${projectId}`}
							projectId={projectId}
							threads={workspace.threads}
							activeThreadId={workspace.activeThreadId}
							pending={pending}
							now={new Date()}
							importCount={
								sessionImports.ready ? sessionImports.sessions.length : null
							}
							retention={retentionView}
							newThreadShortcut={newShortcut}
							onNew={onNew}
							onOpen={id => {
								void openThread(id);
							}}
							onOpenArchives={opener => openDialog('archives', opener)}
							onOpenImport={openImportPage}
						/>
						{projectId && (
							<BackgroundProjects
								items={background}
								pending={connecting || projectControls.pending}
								onOpen={projectControls.onOpen}
							/>
						)}
						{!projectId && (
							<SidebarRecents
								projects={projectControls.projects}
								pending={connecting || projectControls.pending}
								now={new Date()}
								onOpen={projectControls.onOpen}
								onLocate={projectControls.onLocate}
							/>
						)}
					</>
				}
				statusBadges={thread && <StatusBadge status={turnStatus} />}
				streamTools={
					<>
						<TrustFeedback feedback={projectControls.feedback} />
						{processState?.status !== 'ready' &&
							!recoveryInFailure &&
							recoveryTools}
						{!thread && !importOpen && (
							<WelcomePage
								logoSrc={logoUrl}
								projects={projectControls.projects}
								busy={connecting || projectControls.pending}
								connecting={connecting}
								runtime={runtime}
								recoveredFrom={info?.recoveredDatabase}
								onConnect={() => {
									void connect();
								}}
								onOpen={projectControls.onOpen}
								onLocate={projectControls.onLocate}
								onRuntime={() => openDialog('runtime')}
							/>
						)}
						{workspace.error && <p role="alert">{workspace.error}</p>}
					</>
				}
				composerPlacement={
					centredComposer && !importOpen ? 'centred' : 'bottom'
				}
				followKey={
					thread && !importOpen ? `${projectId ?? ''}:${thread.id}` : undefined
				}
				followContent={transcript.items}
				approvalShelf={
					thread && (
						<ApprovalRequests
							key={`${projectId}:${thread.id}`}
							requests={transcript.permissions}
							mode={thread.mode}
							busy={sending}
							fallbackFocus={composerInput}
							onAnswer={(id, optionId) =>
								controls.answer(thread.id, id, optionId)
							}
						/>
					)
				}
				composer={
					importOpen ? null : thread?.runState === 'view-only' ? (
						<ViewOnlyFooter />
					) : (
						outcome?.status === 'connected' &&
						thread &&
						composerState.visible && (
							<Composer
								draft={draft}
								editable={editable}
								sendReason={sendReason}
								controlReason={
									rootControlReason ??
									(modelControls.pending
										? 'a project control change is pending'
										: null)
								}
								projectName={currentProject?.displayName ?? 'selected project'}
								projectControls={controlsForThread(
									modelControls.controls,
									workspace.activeThreadId,
								)}
								mode={thread.mode}
								defaultMode={currentProject?.defaultMode ?? 'normal'}
								modePending={thread.nanocoderSessionId === null}
								running={sending}
								stopping={connecting || stopping}
								error={
									modelControls.error ??
									(cancellation && !cancellation.ok
										? cancellation.error.message
										: null)
								}
								commands={transcript.commands ?? []}
								context={transcript.context}
								attachments={chips(attached)}
								onRemoveAttachment={id => {
									if (attachKey)
										setAttachments(current =>
											removeAttachment(current, attachKey, id),
										);
								}}
								inputRef={composerInput}
								onDraft={controls.setDraft}
								onSend={send}
								onCancel={() => {
									void cancel();
								}}
								onMode={mode => {
									void controls.setMode(thread.id, mode);
								}}
								onDefault={mode => {
									void modelControls.setDefault(mode).then(result => {
										if (result) void projectControls.refresh();
									});
								}}
								onConfig={(id, value) => {
									void modelControls.setConfig(id, value);
								}}
							/>
						)
					)
				}
			>
				{importOpen && (
					<SessionImportList
						key={projectId}
						{...sessionImports}
						active
						focusRequest={importFocus}
						projectName={currentProject?.displayName}
						disabledReason={
							rootBusy
								? 'stop the project turn before importing'
								: (replayReason ??
									(!accepting
										? 'Nanocoder is not ready'
										: pending
											? 'another thread request is pending'
											: undefined))
						}
						backLabel={thread ? 'back to selected thread' : 'back to start'}
						onBack={() => setImportFor(null)}
						onRefresh={sessionImports.refresh}
						onImport={importSession}
					/>
				)}
				{!importOpen && thread && (
					<ConversationStream
						key={`${projectId}:${thread.id}`}
						transcript={transcript}
						failureNotice={
							recoveryInFailure ? (
								recoveryTools
							) : processState?.status === 'ready' && turnFailure ? (
								<TurnFailureNotice reason={turnFailure} />
							) : undefined
						}
						running={sending}
						onOpenLocalUrl={openInBrowser}
						onCopy={copy}
						onStopTurn={cancel}
						stopping={stopping}
						stopReason={turn?.ok ? turn.value.stopReason : undefined}
						outcome={
							turn?.ok
								? turn.value.stopReason === 'cancelled'
									? 'cancelled'
									: 'completed'
								: turn
									? 'failed'
									: undefined
						}
					/>
				)}
				{!importOpen && thread && (
					<ThreadRecoveryNotice
						thread={thread}
						projectName={currentProject?.displayName}
						pending={workspace.pending}
						onRetry={() => void controls.open(thread.id)}
						onNew={onNew}
						onRemove={() => onRemove(thread.id)}
					/>
				)}
				{outcome?.status === 'untrusted' && (
					<Card variant="failure" role="alert">
						<span>not opened. {outcome.message}</span>
					</Card>
				)}
				{opened && !opened.ok && (
					<Card variant="failure" role="alert">
						<span>{opened.error.message}</span>
					</Card>
				)}
			</AppShell>
		</OverlayProvider>
	);
}
