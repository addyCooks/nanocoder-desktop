import {randomUUID} from 'node:crypto';
import type {ResolvedAttachments} from '@/main/files/attachments';
import {IpcFailure} from '@/main/ipc/handle-request';
import type {ThreadService} from '@/main/ipc/workspace-services';
import {untilAborted} from '@/main/nanocoder/abort';
import {
	type NanocoderConnection,
	NanocoderFailure,
} from '@/main/nanocoder/acp-client';
import {type SupervisorClock, systemClock} from '@/main/nanocoder/clock';
import {redact} from '@/main/nanocoder/stderr-ring';
import type {
	ProjectActivity,
	ProjectSupervisor,
} from '@/main/nanocoder/supervisor';
import {canonicalPath} from '@/main/paths';
import type {DesktopStore} from '@/main/store/contracts';
import type {
	ThreadHistory,
	ThreadHistoryScope,
} from '@/main/store/thread-execution-identities';
import {
	nanocoderSessionIdSchema,
	threadTitlePatch,
	validate,
} from '@/main/store/validation';
import {
	createProjectOperations,
	type MetadataOperationLease,
	type ProjectOperationLease,
} from '@/main/threads/project-operations';
import {retentionWarningsFromStore} from '@/main/threads/retention';
import {
	type DiscoveredSessionProof,
	sessionDiscovery,
} from '@/main/threads/session-discovery';
import {mapThreadReplay} from '@/main/threads/thread-history-mapping';
import {createThreadHistoryObserver} from '@/main/threads/thread-history-observer';
import {mapThreadLive} from '@/main/threads/thread-live-mapping';
import {createThreadSequence} from '@/main/threads/thread-sequence';
import type {
	DiscoveredSession,
	IpcResult,
	NanocoderMode,
	ProjectEvent,
	ProjectInfo,
	PromptAttachment,
	SessionInfo,
	ThreadInfo,
	ThreadReplay,
	ThreadRequest,
	ThreadSnapshot,
	TurnEvent,
	TurnResult,
} from '@/shared/ipc';
import {missingSessionReason} from '@/shared/retention';
import {
	REPLAY_FAILURE_REASON,
	threadReplaySchema,
} from '@/shared/thread-replay';

export interface OwnedSessionContext {
	lease: ProjectOperationLease;
	thread: ThreadInfo;
	connection: NanocoderConnection;
	session: SessionInfo;
	source: 'new' | 'resume';
	requestedMode: NanocoderMode;
}

// A title is stored and listed, so it is redacted, stripped of control, zero-width and
// bidi characters, and cut on a character boundary rather than inside a surrogate pair.
// The zero-width and bidi characters go first, so one hidden inside a secret cannot stop
// it from being recognised. The first prompt gives 80 characters. A title Nanocoder sends
// keeps its own 500.
const SESSION_TITLE_LIMIT = 500;
const titleFrom = (text: string, limit = 80): string =>
	Array.from(
		redact(
			text.replace(/[\u200b\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, ''),
		)
			.replace(/[\s\p{Cc}]+/gu, ' ')
			.trim(),
	)
		.slice(0, limit)
		.join('');

function assertResumedIdentity(expected: string, session: SessionInfo): void {
	const id = validate(nanocoderSessionIdSchema, session.id);
	if (id !== expected)
		throw new IpcFailure('DENIED', 'The resumed session changed');
}

// `open` is an explicit same-thread open or retry; `restore` is automatic recovery.
export type ThreadPrepareReason = 'open' | 'restore' | 'prompt';

interface ThreadOptions {
	store: DesktopStore;
	supervisor: Pick<
		ProjectSupervisor,
		| 'ensureProcess'
		| 'getState'
		| 'getConnection'
		| 'getCapabilityGates'
		| 'prompt'
		| 'cancel'
		| 'answerPermission'
		| 'subscribe'
		| 'subscribeTitles'
		| 'publishThread'
		| 'publishThreadRemoved'
		| 'stop'
	>;
	now?(): Date;
	clock?: Pick<SupervisorClock, 'now'>;
	onEvent?(event: ProjectEvent): void;
	onSessionPrepared?(context: OwnedSessionContext): void | Promise<void>;
	onThreadSelected?(projectId: string, threadId: string): void;
	beforeFirstPrompt?(context: OwnedSessionContext): void | Promise<void>;
	resolveLiveMode?(
		projectId: string,
		threadId: string,
		sessionId: string | null,
		connection: NanocoderConnection | undefined,
	): NanocoderMode | undefined;
	validateBeforePrepare?(
		lease: ProjectOperationLease,
		thread: ThreadInfo,
		reason: ThreadPrepareReason,
	): void;
	confirmDeleteHistory?(snapshot: {
		project: ProjectInfo;
		thread: ThreadInfo;
	}): Promise<boolean>;
	// Turns validated attachments into prompt content for this turn only (CHAT-16).
	resolveAttachments?(
		project: ProjectInfo,
		attachments: PromptAttachment[],
	): Promise<ResolvedAttachments>;
}

type AsyncThreadService = {
	[K in keyof ThreadService]: (
		...args: Parameters<ThreadService[K]>
	) => Promise<Awaited<ReturnType<ThreadService[K]>>>;
};
type ThreadRuntimeService = AsyncThreadService & {
	getControlConnection(projectId: string): NanocoderConnection | undefined;
	readonly projectOperations: ReturnType<typeof createProjectOperations>;
	runProjectOperation: ReturnType<
		typeof createProjectOperations
	>['runProjectOperation'];
	settlePins(): Promise<void>;
	dispose(): void;
	attachProject(projectId: string): void;
	activity(projectId: string): ProjectActivity;
	restore(
		project: ProjectInfo,
		connection: NanocoderConnection,
		signal: AbortSignal,
	): Promise<void>;
	detach(projects: Iterable<ProjectInfo>): Promise<void>;
};

class PreparationCancelled extends IpcFailure {
	constructor() {
		super('AGENT_UNAVAILABLE', 'The thread preparation was cancelled');
	}
}

interface DiscoverySnapshot {
	connection: NanocoderConnection;
	canonicalRoot: string;
	sessionCwd: string;
	signal: AbortSignal;
	candidates: Map<string, DiscoveredSessionProof>;
}

export function createThreadService(
	options: ThreadOptions,
): ThreadRuntimeService {
	const recoveringConnections = new Map<
		string,
		{connection: NanocoderConnection; signal: AbortSignal}
	>();
	const connectionBinding = (projectId: string) => {
		const recovery = recoveringConnections.get(projectId);
		if (recovery?.signal.aborted) return undefined;
		if (
			recovery &&
			options.supervisor.getState(projectId).status === 'starting'
		)
			return recovery.connection;
		try {
			return options.supervisor.getConnection(projectId);
		} catch {
			return undefined;
		}
	};
	const projectOperations = createProjectOperations({
		getProject: projectId => options.store.projects.get(projectId),
		getThread: (projectId, threadId) =>
			options.store.threads.get(projectId, threadId),
		getConnection: connectionBinding,
	});
	const snapshots = new Map<
		string,
		Pick<ThreadSnapshot, 'sequence' | 'events' | 'result'>
	>();
	const replays = new Map<
		string,
		ThreadReplay & {
			threadId: string;
			sessionId: string;
			lease: ProjectOperationLease;
		}
	>();
	const historyObservers = new Map<
		string,
		{
			sessionId: string;
			observer: ReturnType<typeof createThreadHistoryObserver>;
		}
	>();
	const liveTurns = new Map<
		string,
		{
			lease: ProjectOperationLease;
			scope: ThreadHistoryScope;
			turnId: string;
			history?: ThreadHistory;
			complete: boolean;
			accepted: boolean;
			observer: ReturnType<typeof createThreadHistoryObserver>;
			failure?: IpcFailure;
			outcome?: 'failed' | 'cancelled';
		}
	>();
	const prepared = new Map<string, NanocoderConnection>();
	const preparedSessions = new Map<
		string,
		Pick<OwnedSessionContext, 'session' | 'source'>
	>();
	const prompted = new Map<string, NanocoderConnection>();
	const pinning = new Set<Promise<void>>();
	const activeLeases = new Map<
		string,
		{lease: ProjectOperationLease; threadId?: string}
	>();
	const pending = new Map<string, string>();
	const preparationAborts = new Map<
		string,
		{threadId: string; abort: AbortController; turnStarted: boolean}
	>();
	const mutations = new Set<string>();
	const permissionIds = new Map<string, Set<string>>();
	const attached = new Set<string>();
	const lastActivity = new Map<string, number>();
	const currentSessions = new Map<
		string,
		{thread: ThreadInfo; connection: NanocoderConnection}
	>();
	const restoring = new Map<string, AbortSignal>();
	const operations = new Map<string, Set<Promise<unknown>>>();
	const discoveries = new Map<string, DiscoverySnapshot>();
	let attachment = new AbortController();
	let disposed = false;
	const finishPreparation = (
		thread: ThreadInfo,
		abort: AbortController,
		scope: AbortSignal,
	) => {
		if (
			!scope.aborted &&
			preparationAborts.get(thread.projectId)?.abort === abort
		) {
			preparationAborts.delete(thread.projectId);
			pending.delete(thread.projectId);
			permissionIds.delete(thread.id);
		}
	};
	const trackOperation = <T>(projectId: string, task: Promise<T>) => {
		const tasks = operations.get(projectId) ?? new Set<Promise<unknown>>();
		tasks.add(task);
		operations.set(projectId, tasks);
		const finished = () => {
			tasks.delete(task);
			if (!tasks.size && operations.get(projectId) === tasks)
				operations.delete(projectId);
		};
		void task.then(finished, finished);
		return task;
	};
	const operation = <T>(
		projectId: string,
		work: (signal: AbortSignal) => Promise<T>,
	): Promise<T> => {
		const {signal} = attachment;
		const task = Promise.resolve().then(() => {
			signal.throwIfAborted();
			return work(signal);
		});
		return trackOperation(projectId, task);
	};
	const runProjectOperation: ThreadRuntimeService['runProjectOperation'] = (
		projectId,
		kind,
		work,
		scope = {},
	) => {
		const signal = scope.signal
			? AbortSignal.any([attachment.signal, scope.signal])
			: attachment.signal;
		const task = projectOperations.runProjectOperation(
			projectId,
			kind,
			async lease => {
				const replay = replays.get(projectId);
				if (
					(kind === 'mode' || kind === 'config') &&
					replay &&
					replay.phase !== 'complete'
				)
					throw new IpcFailure('UNAVAILABLE', REPLAY_FAILURE_REASON);
				const active = {lease, threadId: scope.threadId};
				activeLeases.set(projectId, active);
				try {
					return await work(lease);
				} finally {
					if (activeLeases.get(projectId) === active)
						activeLeases.delete(projectId);
				}
			},
			{...scope, signal},
		);
		return trackOperation(projectId, task);
	};
	const runMetadataOperation: typeof projectOperations.runMetadataOperation = (
		projectId,
		kind,
		work,
		scope = {},
	) =>
		trackOperation(
			projectId,
			projectOperations.runMetadataOperation(projectId, kind, work, {
				...scope,
				signal: scope.signal
					? AbortSignal.any([attachment.signal, scope.signal])
					: attachment.signal,
			}),
		);
	const runConfirmationOperation: typeof projectOperations.runConfirmationOperation =
		(projectId, kind, work, scope = {}) =>
			trackOperation(
				projectId,
				projectOperations.runConfirmationOperation(projectId, kind, work, {
					...scope,
					signal: scope.signal
						? AbortSignal.any([attachment.signal, scope.signal])
						: attachment.signal,
				}),
			);
	const now = () => (options.now?.() ?? new Date()).toISOString();
	const presentThread = (thread: ThreadInfo) => {
		const connection = connectionBinding(thread.projectId);
		const acknowledged =
			prepared.get(thread.id) === connection
				? preparedSessions.get(thread.id)?.session
				: undefined;
		const mode = options.resolveLiveMode
			? options.resolveLiveMode(
					thread.projectId,
					thread.id,
					thread.nanocoderSessionId,
					connection,
				)
			: acknowledged?.id === thread.nanocoderSessionId
				? acknowledged.mode
				: undefined;
		return {...thread, ...(mode && {mode})};
	};
	const publishThread = (thread: ThreadInfo) => {
		const replay = replays.get(thread.projectId);
		if (
			replay?.threadId === thread.id &&
			replay.phase === 'begin' &&
			thread.runState === 'ready'
		)
			return thread;
		options.supervisor.publishThread(presentThread(thread));
		return thread;
	};
	const saveThread = (thread: ThreadInfo) => {
		options.store.threads.save(thread);
		return publishThread(thread);
	};
	const getProject = (projectId: string) => {
		if (disposed)
			throw new IpcFailure('AGENT_UNAVAILABLE', 'The thread service stopped');
		const project = options.store.projects.get(projectId);
		if (!project) throw new IpcFailure('NOT_FOUND', 'Project not found');
		return project;
	};
	const currentDiscovery = (
		projectId: string,
		discovery: DiscoverySnapshot,
	): boolean => {
		if (
			disposed ||
			discovery.signal.aborted ||
			discovery.signal !== attachment.signal ||
			discoveries.get(projectId) !== discovery
		)
			return false;
		try {
			const project = getProject(projectId);
			return (
				project.canonicalRoot === discovery.canonicalRoot &&
				project.sessionCwd === discovery.sessionCwd &&
				project.sessionCwd === project.canonicalRoot &&
				discovery.connection.agent.root === project.canonicalRoot &&
				options.supervisor.getState(projectId).status === 'ready' &&
				options.supervisor.getConnection(projectId) === discovery.connection &&
				options.supervisor.getCapabilityGates(projectId).features.list.enabled
			);
		} catch {
			return false;
		}
	};
	const attachProject = (projectId: string) => {
		getProject(projectId);
		attached.add(projectId);
		lastActivity.set(projectId, (options.clock ?? systemClock).now());
	};
	const remember = (thread: ThreadInfo, connection: NanocoderConnection) => {
		if (replays.get(thread.projectId)?.threadId !== thread.id)
			replays.delete(thread.projectId);
		prepared.set(thread.id, connection);
		currentSessions.set(thread.projectId, {
			thread: structuredClone(thread),
			connection,
		});
		attachProject(thread.projectId);
	};
	const unavailable = async (): Promise<never> => {
		throw new IpcFailure('UNAVAILABLE', 'This feature is not available yet');
	};
	const getThread = ({projectId, threadId}: ThreadRequest) => {
		getProject(projectId);
		const thread = options.store.threads.get(projectId, threadId);
		if (!thread) throw new IpcFailure('NOT_FOUND', 'Thread not found');
		return thread;
	};
	const updateThread = (
		expected: ThreadInfo,
		changes: (
			current: ThreadInfo,
		) => Partial<
			Pick<
				ThreadInfo,
				| 'nanocoderSessionId'
				| 'title'
				| 'mode'
				| 'runState'
				| 'viewOnlyReason'
				| 'lastActivityAt'
			>
		>,
	) => {
		const owner = getProject(expected.projectId);
		const current = getThread({
			projectId: expected.projectId,
			threadId: expected.id,
		});
		if (
			current.nanocoderSessionId !== expected.nanocoderSessionId ||
			current.sessionCwd !== expected.sessionCwd ||
			owner.canonicalRoot !== expected.sessionCwd ||
			owner.sessionCwd !== expected.sessionCwd
		)
			throw new IpcFailure('DENIED', 'The thread session changed');
		return saveThread({...current, ...changes(current)});
	};
	const assertMutable = (thread: ThreadInfo) => {
		const active = options.supervisor.getState(thread.projectId).activeThreadId;
		if (
			mutations.has(thread.id) ||
			(restoring.has(thread.projectId) &&
				currentSessions.get(thread.projectId)?.thread.id === thread.id) ||
			pending.get(thread.projectId) === thread.id ||
			(thread.nanocoderSessionId !== null &&
				active === thread.nanocoderSessionId)
		)
			throw new IpcFailure('BUSY', 'Wait for this thread to finish', true);
	};
	const snapshot = (request: ThreadRequest) => {
		const thread = presentThread(getThread(request));
		const candidate = replays.get(request.projectId);
		const replay =
			candidate?.threadId === thread.id &&
			candidate.sessionId === thread.nanocoderSessionId
				? candidate
				: undefined;
		return {
			thread,
			...(snapshots.get(request.threadId) ?? {sequence: 0, events: []}),
			replaying: replay ? replay.phase !== 'complete' : false,
			...(replay && {replayEpoch: replay.epoch}),
		};
	};
	const append = (
		thread: ThreadInfo,
		events: TurnEvent[],
		result?: IpcResult<TurnResult>,
		persist = true,
		cancelledOwner?: ProjectOperationLease,
		replay?: ThreadReplay,
	) => {
		const live = liveTurns.get(thread.id);
		const cancelling =
			live &&
			cancelledOwner === live.lease &&
			result?.ok === true &&
			result.value.stopReason === 'cancelled' &&
			events.length === 0;
		if (cancelledOwner && !cancelling)
			throw new IpcFailure('DENIED', 'The cancelled turn changed');
		if (live && !cancelling) projectOperations.assertCurrent(live.lease);
		const state: Pick<ThreadSnapshot, 'sequence' | 'events' | 'result'> =
			snapshots.get(thread.id) ?? {sequence: 0, events: []};
		const allocator = createThreadSequence({
			sequence: state.sequence,
			highWaterMark: live?.history?.sequence,
		});
		const batches = allocator.reserve(events.length);
		let offset = 0;
		for (const [index, batch] of batches.entries()) {
			const chunk = events.slice(offset, offset + batch.count);
			offset += batch.count;
			const terminal = index === batches.length - 1 ? result : undefined;
			if (live && !live.outcome)
				for (const event of chunk)
					if (
						event.type === 'metadata' &&
						(event.metadata.outcome === 'failed' ||
							event.metadata.outcome === 'cancelled')
					) {
						live.outcome = event.metadata.outcome;
						break;
					}
			if (
				persist &&
				live &&
				(live.accepted || chunk.some(event => event.type === 'user')) &&
				(terminal || chunk.some(event => ['user', 'tool'].includes(event.type)))
			) {
				const mapped = mapThreadLive({
					scope: live.scope,
					history: live.history,
					turnId: live.turnId,
					complete: live.complete,
					firstSequence: batch.firstSlot,
					highWaterMark: batch.highWaterMark,
					events: chunk,
					outcome: terminal
						? terminal.ok
							? (live.outcome ??
								(terminal.value.stopReason === 'cancelled'
									? 'cancelled'
									: 'completed'))
							: 'failed'
						: undefined,
				});
				if (!cancelling) projectOperations.assertCurrent(live.lease);
				const revision = live.observer.commitLive(
					mapped.patch,
					mapped.observations,
					mapped.terminal,
				);
				live.history = {...mapped.history, revision};
				live.accepted = true;
				const previous = historyObservers.get(thread.id);
				if (previous?.observer !== live.observer) previous?.observer.dispose();
				historyObservers.set(thread.id, {
					sessionId: live.scope.sessionId,
					observer: live.observer,
				});
			}
			if (chunk.some(event => event.type === 'user')) delete state.result;
			if (terminal) state.result = structuredClone(terminal);
			state.events.push(...structuredClone(chunk));
			state.sequence = batch.sequence;
			snapshots.set(thread.id, state);
			options.onEvent?.({
				type: 'turn',
				projectId: thread.projectId,
				threadId: thread.id,
				sequence: state.sequence,
				events: structuredClone(chunk),
				...(terminal && {result: structuredClone(terminal)}),
				...(replay && {replay: threadReplaySchema.parse(replay)}),
			});
		}
	};
	const beginReplay = (thread: ThreadInfo, lease: ProjectOperationLease) => {
		projectOperations.assertCurrent(lease);
		if (!thread.nanocoderSessionId)
			throw new IpcFailure('AGENT_UNAVAILABLE', 'No saved session is ready');
		if (!snapshots.has(thread.id)) {
			const history = options.store.threadHistory.read({
				projectId: thread.projectId,
				threadId: thread.id,
				sessionId: thread.nanocoderSessionId,
			});
			const allocator = createThreadSequence({
				highWaterMark: history?.sequence,
			});
			projectOperations.assertCurrent(lease);
			snapshots.set(thread.id, {sequence: allocator.current(), events: []});
		}
		const replay = {
			epoch: randomUUID(),
			phase: 'begin' as ThreadReplay['phase'],
			threadId: thread.id,
			sessionId: thread.nanocoderSessionId,
			lease,
		};
		replays.set(thread.projectId, replay);
		append(thread, [], undefined, false, undefined, {
			epoch: replay.epoch,
			phase: 'begin',
		});
		return replay;
	};
	const finishReplay = (
		thread: ThreadInfo,
		replay: ReturnType<typeof beginReplay>,
		phase: 'complete' | 'failed',
	) => {
		if (replays.get(thread.projectId) !== replay) return;
		replay.phase = phase;
		if (phase === 'failed') {
			prepared.delete(thread.id);
			preparedSessions.delete(thread.id);
			prompted.delete(thread.id);
		}
		try {
			projectOperations.assertCurrent(replay.lease);
		} catch (error) {
			if (phase === 'complete') throw error;
			return;
		}
		append(thread, [], undefined, false, undefined, {
			epoch: replay.epoch,
			phase,
		});
	};
	const unsubscribe = options.supervisor.subscribe(event => {
		if (event.type === 'supervisor') {
			const discovery = discoveries.get(event.projectId);
			if (discovery && !currentDiscovery(event.projectId, discovery))
				discoveries.delete(event.projectId);
			return;
		}
		if (event.type !== 'turn') return;
		const thread = [
			...options.store.threads.list(event.projectId, 'active'),
			...options.store.threads.list(event.projectId, 'archived'),
		].find(thread => thread.nanocoderSessionId === event.threadId);
		if (!thread) return;
		const live = liveTurns.get(thread.id);
		if (!live || live.failure) return;
		try {
			projectOperations.assertCurrent(live.lease);
		} catch {
			return;
		}
		if (
			(pending.get(event.projectId) === thread.id &&
				options.supervisor.getState(event.projectId).activeThreadId !==
					thread.nanocoderSessionId) ||
			(restoring.has(event.projectId) &&
				currentSessions.get(event.projectId)?.thread.id === thread.id)
		)
			return;
		const ids = permissionIds.get(thread.id) ?? new Set<string>();
		let changed = false;
		for (const item of event.events) {
			if (item.type === 'permission' && !ids.has(item.request.id)) {
				ids.add(item.request.id);
				changed = true;
			} else if (item.type === 'permission-closed' && ids.delete(item.id)) {
				changed = true;
			}
		}
		if (changed) {
			if (ids.size) permissionIds.set(thread.id, ids);
			else permissionIds.delete(thread.id);
			const runState = ids.size ? 'waiting-approval' : 'running';
			if (thread.runState !== runState)
				saveThread({...thread, runState, lastActivityAt: now()});
		}
		try {
			append(thread, event.events);
		} catch (error) {
			live.failure = requestFailure(error);
			live.complete = false;
			const cancelled = projectOperations.runCancellationStep(live.lease, () =>
				options.supervisor.cancel(thread.projectId, live.scope.sessionId),
			);
			void trackOperation(thread.projectId, cancelled).catch(() => undefined);
		}
	});
	const unsubscribeTitles = options.supervisor.subscribeTitles(change => {
		const thread = [
			...options.store.threads.list(change.projectId, 'active'),
			...options.store.threads.list(change.projectId, 'archived'),
		].find(thread => thread.nanocoderSessionId === change.sessionId);
		const title = titleFrom(change.title, SESSION_TITLE_LIMIT);
		if (
			thread &&
			title &&
			thread.title !== title &&
			options.store.threads.getTitleManuallySet(thread.projectId, thread.id) ===
				false
		)
			publishThread(
				options.store.threads.setTitle({
					projectId: thread.projectId,
					threadId: thread.id,
					title,
					manuallySet: false,
				}),
			);
	});
	const validateProject = async (thread: ThreadInfo) => {
		const project = getProject(thread.projectId);
		if (!project.trusted)
			throw new IpcFailure(
				'DENIED',
				'Trust this project before sending a prompt',
			);
		try {
			if (
				(await canonicalPath(project.canonicalRoot)) !==
					project.canonicalRoot ||
				project.sessionCwd !== project.canonicalRoot ||
				thread.sessionCwd !== project.sessionCwd
			)
				throw new Error();
		} catch {
			throw new IpcFailure(
				'DENIED',
				'The project root changed; locate and trust the folder again',
			);
		}
		return project;
	};
	const removeMetadata = (
		request: ThreadRequest,
		lease: ProjectOperationLease | MetadataOperationLease,
	) => {
		projectOperations.removeOwnedThread(lease, () => {
			options.store.threads.remove(request.projectId, request.threadId);
		});
		projectOperations.invalidateThread(request.projectId, request.threadId);
		if (currentSessions.get(request.projectId)?.thread.id === request.threadId)
			currentSessions.delete(request.projectId);
		snapshots.delete(request.threadId);
		if (replays.get(request.projectId)?.threadId === request.threadId)
			replays.delete(request.projectId);
		const history = historyObservers.get(request.threadId);
		history?.observer.forgetThread(request.threadId);
		history?.observer.dispose();
		historyObservers.delete(request.threadId);
		liveTurns.delete(request.threadId);
		prepared.delete(request.threadId);
		preparedSessions.delete(request.threadId);
		prompted.delete(request.threadId);
		permissionIds.delete(request.threadId);
		const ui = options.store.getUiState();
		options.store.updateUiState({
			activeThreadId:
				ui.activeThreadId === request.threadId ? null : ui.activeThreadId,
			openThreadIds: ui.openThreadIds.filter(id => id !== request.threadId),
		});
		options.supervisor.publishThreadRemoved(
			request.projectId,
			request.threadId,
		);
	};
	const requestFailure = (error: unknown): IpcFailure => {
		if (error instanceof IpcFailure) return error;
		if (error instanceof NanocoderFailure)
			return new IpcFailure(error.code, error.message);
		return new IpcFailure(
			'AGENT_UNAVAILABLE',
			'The thread request could not finish',
		);
	};
	const failure = (error: unknown): never => {
		throw requestFailure(error);
	};
	const select = (request: ThreadRequest) => {
		attachProject(request.projectId);
		const ids = options.store.getUiState().openThreadIds;
		options.store.updateUiState({
			activeProjectId: request.projectId,
			activeThreadId: request.threadId,
			openThreadIds: ids.includes(request.threadId)
				? ids
				: [...ids.slice(-99), request.threadId],
		});
		options.onThreadSelected?.(request.projectId, request.threadId);
	};
	const startingMode = (thread: ThreadInfo, project: ProjectInfo) =>
		thread.mode === 'yolo' ? project.defaultMode : thread.mode;
	const hasReadyOffers = (
		connection: NanocoderConnection,
		sessionId: string,
	) => {
		if (!('getSessionOffers' in connection)) return true;
		const getter = connection.getSessionOffers;
		return (
			typeof getter === 'function' &&
			getter.call(connection, sessionId) !== undefined
		);
	};
	const sessionReady = (
		thread: ThreadInfo,
		connection: NanocoderConnection,
	) => {
		const sessionId = thread.nanocoderSessionId;
		if (!sessionId || !hasReadyOffers(connection, sessionId)) return false;
		return (
			!options.resolveLiveMode ||
			options.resolveLiveMode(
				thread.projectId,
				thread.id,
				sessionId,
				connection,
			) !== undefined
		);
	};
	const sessionContext = (
		lease: ProjectOperationLease,
		thread: ThreadInfo,
		connection: NanocoderConnection,
		session: SessionInfo,
		source: OwnedSessionContext['source'],
		requestedMode: NanocoderMode,
	): OwnedSessionContext => ({
		lease,
		thread: structuredClone(
			getThread({projectId: thread.projectId, threadId: thread.id}),
		),
		connection,
		session: structuredClone(session),
		source,
		requestedMode,
	});
	// Nanocoder keeps a pinned session out of its retention. This runs after the turn or the resume has
	// finished, outside its lease, and a failure leaves the thread marked unpinned (CHAT-23).
	const keepSession = (
		thread: ThreadInfo,
		connection: () => NanocoderConnection,
		sessionId: string,
	): Promise<void> => {
		const attempt = async () => {
			if (
				disposed ||
				options.store.threads.getSessionPinned(thread.projectId, thread.id) !==
					false ||
				!options.supervisor.getCapabilityGates(thread.projectId).features
					.pinSession.enabled
			)
				return;
			await connection().pinSession(sessionId, true);
			if (
				!disposed &&
				options.store.threads.get(thread.projectId, thread.id)
					?.nanocoderSessionId === sessionId
			)
				options.store.threads.setSessionPinned(
					thread.projectId,
					thread.id,
					true,
				);
		};
		const done = attempt().catch(() => {});
		pinning.add(done);
		void done.finally(() => pinning.delete(done));
		return done;
	};
	// The limits Nanocoder reports feed the early warning and the view-only notice (DEC-45).
	const rememberRetention = (connection: NanocoderConnection) => {
		const reported = connection.agent?.capabilities?.retention;
		if (!reported) return;
		const known = options.store.retention.get();
		if (
			known?.days === reported.days &&
			known.maxSessions === reported.maxSessions
		)
			return;
		try {
			options.store.retention.set(reported);
		} catch {}
	};
	const handoffSession = async (
		lease: ProjectOperationLease,
		thread: ThreadInfo,
		connection: NanocoderConnection,
		session: SessionInfo,
		source: OwnedSessionContext['source'],
		requestedMode: NanocoderMode,
	) => {
		projectOperations.bindConnection(lease, connection);
		if (!hasReadyOffers(connection, session.id))
			throw new IpcFailure('AGENT_UNAVAILABLE', 'The session is not ready');
		rememberRetention(connection);
		if (options.onSessionPrepared)
			await projectOperations.runOwnedStep(lease, async () => {
				await options.onSessionPrepared?.(
					sessionContext(
						lease,
						thread,
						connection,
						session,
						source,
						requestedMode,
					),
				);
			});
		preparedSessions.set(thread.id, {
			session: structuredClone(session),
			source,
		});
		prompted.delete(thread.id);
		if (source === 'resume')
			void keepSession(thread, () => connection, session.id);
	};
	const commitHistory = (
		thread: ThreadInfo,
		events: TurnEvent[],
		lease: ProjectOperationLease,
		epoch: string,
	) => {
		projectOperations.assertCurrent(lease);
		const sessionId = thread.nanocoderSessionId;
		if (!sessionId)
			throw new IpcFailure('AGENT_UNAVAILABLE', 'No session is ready');
		const scope = {projectId: thread.projectId, threadId: thread.id, sessionId};
		const owner = historyObservers.get(thread.id);
		let observer: ReturnType<typeof createThreadHistoryObserver> | undefined;
		try {
			const previous = options.store.threadHistory.read(scope);
			observer =
				owner?.sessionId === sessionId
					? owner.observer
					: createThreadHistoryObserver({
							scope,
							history: options.store.threadHistory,
							runs: options.store.agentRuns,
						});
			const allocator = createThreadSequence({
				sequence: snapshots.get(thread.id)?.sequence ?? 0,
				highWaterMark: previous?.sequence,
			});
			const batches = allocator.reserve(events.length);
			const mapped = mapThreadReplay({
				scope,
				history: previous,
				generation: (previous?.generation ?? 0) + 1,
				firstSequence: batches[0].firstSlot,
				epoch,
				events,
			});
			projectOperations.assertCurrent(lease);
			observer.commitReplay(mapped.patch, mapped.observations);
			if (owner?.observer !== observer) owner?.observer.dispose();
			historyObservers.set(thread.id, {sessionId, observer});
			snapshots.set(thread.id, {
				sequence: allocator.current(),
				events: structuredClone(mapped.events),
			});
		} catch (error) {
			if (observer && owner?.observer !== observer) observer.dispose();
			prepared.delete(thread.id);
			preparedSessions.delete(thread.id);
			prompted.delete(thread.id);
			throw error;
		}
	};
	const resume = async (
		thread: ThreadInfo,
		connection: NanocoderConnection,
		project: ProjectInfo,
		signal: AbortSignal,
		lease: ProjectOperationLease,
		requestedMode: NanocoderMode,
	) => {
		const sessionId = thread.nanocoderSessionId;
		if (!sessionId) return;
		const replay = beginReplay(thread, lease);
		try {
			const restored = await projectOperations.runOwnedStep(lease, () =>
				connection.resumeSession(sessionId, startingMode(thread, project)),
			);
			signal.throwIfAborted();
			assertResumedIdentity(sessionId, restored.session);
			const request = {projectId: thread.projectId, threadId: thread.id};
			const current = getThread(request);
			if (current.nanocoderSessionId !== sessionId)
				throw new IpcFailure('DENIED', 'The thread session changed');
			await validateProject(current);
			signal.throwIfAborted();
			if (options.supervisor.getConnection(project.id) !== connection)
				throw new IpcFailure(
					'AGENT_UNAVAILABLE',
					'The project process changed',
				);
			const fresh = getThread(request);
			if (
				fresh.nanocoderSessionId !== sessionId ||
				fresh.sessionCwd !== current.sessionCwd
			)
				throw new IpcFailure('DENIED', 'The thread session changed');
			const acknowledged = updateThread(fresh, () => ({
				mode: restored.session.mode,
			}));
			await handoffSession(
				lease,
				acknowledged,
				connection,
				restored.session,
				'resume',
				requestedMode,
			);
			signal.throwIfAborted();
			commitHistory(acknowledged, restored.history, lease, replay.epoch);
			finishReplay(acknowledged, replay, 'complete');
			const ready = updateThread(acknowledged, () => ({
				runState: 'ready',
				viewOnlyReason: null,
			}));
			remember(ready, connection);
		} catch (error) {
			finishReplay(thread, replay, 'failed');
			throw error;
		}
	};
	const markResumeFailure = (request: ThreadRequest, error: unknown) => {
		const current = getThread(request);
		const missing =
			error instanceof NanocoderFailure && error.code === 'NOT_FOUND';
		const reason = missing
			? missingSessionReason(options.store.retention.get())
			: error instanceof IpcFailure || error instanceof NanocoderFailure
				? error.message
				: 'Nanocoder could not resume this thread';
		// Only `failed` accepts prompts, so a view-only thread keeps its reason.
		if (current.runState === 'view-only') {
			saveThread({
				...current,
				viewOnlyReason: current.viewOnlyReason ?? reason,
			});
			return;
		}
		saveThread({
			...current,
			runState: missing ? 'view-only' : 'failed',
			viewOnlyReason: reason,
		});
	};
	return {
		getControlConnection: projectId => {
			if (disposed) return undefined;
			const active = activeLeases.get(projectId);
			const replay = replays.get(projectId);
			if (
				replay?.phase === 'failed' &&
				(!active ||
					active.lease.kind !== 'prompt' ||
					!active.threadId ||
					active.threadId === replay.threadId)
			)
				return undefined;
			if (active) {
				try {
					projectOperations.assertCurrent(active.lease);
				} catch {
					return undefined;
				}
			}
			return connectionBinding(projectId);
		},
		projectOperations,
		runProjectOperation,
		attachProject,
		activity: (projectId: string) => ({
			runningTurn:
				options.supervisor.getState(projectId).activeThreadId !== null,
			openSessions: attached.has(projectId) ? 1 : 0,
			preparing:
				pending.has(projectId) ||
				restoring.has(projectId) ||
				projectOperations.isBusy(projectId),
			lastActivityAt: lastActivity.get(projectId) ?? 0,
		}),
		restore: async (project, connection, signal) => {
			signal.throwIfAborted();
			const cached = currentSessions.get(project.id);
			if (!cached || !attached.has(project.id)) return;
			const request = {projectId: project.id, threadId: cached.thread.id};
			const active = activeLeases.get(project.id);
			if (active && active.threadId !== cached.thread.id) return;
			if (restoring.has(project.id))
				throw new IpcFailure('BUSY', 'The project is already resuming', true);
			const check = async () => {
				signal.throwIfAborted();
				if (disposed || !attached.has(project.id))
					throw new IpcFailure(
						'AGENT_UNAVAILABLE',
						'The thread workspace detached',
					);
				const thread = getThread(request);
				const owner = getProject(project.id);
				if (
					thread.nanocoderSessionId !== cached.thread.nanocoderSessionId ||
					!thread.nanocoderSessionId ||
					thread.sessionCwd !== cached.thread.sessionCwd ||
					thread.sessionCwd !== owner.sessionCwd ||
					owner.sessionCwd !== owner.canonicalRoot ||
					owner.canonicalRoot !== project.canonicalRoot ||
					owner.sessionCwd !== project.sessionCwd ||
					cached.connection.agent.root !== project.canonicalRoot ||
					connection.agent.root !== project.canonicalRoot ||
					(await canonicalPath(owner.canonicalRoot)) !== owner.canonicalRoot
				)
					throw new IpcFailure(
						'DENIED',
						'The project folder changed; open it again before resuming',
					);
				signal.throwIfAborted();
				const fresh = getThread(request);
				if (
					getProject(project.id).canonicalRoot !== owner.canonicalRoot ||
					getProject(project.id).sessionCwd !== owner.sessionCwd ||
					fresh.nanocoderSessionId !== thread.nanocoderSessionId ||
					fresh.sessionCwd !== thread.sessionCwd
				)
					throw new IpcFailure('DENIED', 'The thread session changed');
				return {...fresh, nanocoderSessionId: thread.nanocoderSessionId};
			};
			const binding = {connection, signal};
			recoveringConnections.set(project.id, binding);
			const restoreOwned = async (lease: ProjectOperationLease) => {
				let replay: ReturnType<typeof beginReplay> | undefined;
				binding.signal = AbortSignal.any([signal, lease.signal]);
				restoring.set(project.id, signal);
				try {
					options.validateBeforePrepare?.(
						lease,
						structuredClone(getThread(request)),
						'restore',
					);
					const thread = await check();
					const requestedMode = thread.mode;
					replay = beginReplay(thread, lease);
					const restored = await projectOperations.runOwnedStep(lease, () =>
						connection.resumeSession(
							thread.nanocoderSessionId,
							startingMode(thread, project),
						),
					);
					assertResumedIdentity(thread.nanocoderSessionId, restored.session);
					const fresh = await check();
					const acknowledged = updateThread(fresh, () => ({
						mode: restored.session.mode,
					}));
					await handoffSession(
						lease,
						acknowledged,
						connection,
						restored.session,
						'resume',
						requestedMode,
					);
					const current = await check();
					commitHistory(current, restored.history, lease, replay.epoch);
					finishReplay(current, replay, 'complete');
					const ready = updateThread(current, () => ({
						runState: 'ready',
						viewOnlyReason: null,
					}));
					remember(ready, connection);
				} catch (error) {
					if (replay) finishReplay(cached.thread, replay, 'failed');
					if (
						replay &&
						!binding.signal.aborted &&
						!(
							error instanceof IpcFailure &&
							['DENIED', 'BUSY', 'VALIDATION'].includes(error.code)
						)
					) {
						projectOperations.assertCurrent(lease);
						markResumeFailure(request, error);
					}
					throw error;
				} finally {
					if (restoring.get(project.id) === signal)
						restoring.delete(project.id);
				}
			};
			try {
				if (active)
					await projectOperations.runOwnedStep(active.lease, () =>
						restoreOwned(active.lease),
					);
				else
					await runProjectOperation(project.id, 'resume', restoreOwned, {
						threadId: cached.thread.id,
						signal,
					});
			} catch (error) {
				if (signal.aborted) throw signal.reason;
				throw error;
			} finally {
				if (recoveringConnections.get(project.id) === binding)
					recoveringConnections.delete(project.id);
			}
		},
		detach: async projects => {
			discoveries.clear();
			const tasks = [...operations.values()].flatMap(values => [...values]);
			const ids = new Set([
				...pending.keys(),
				...restoring.keys(),
				...operations.keys(),
			]);
			const candidates = new Set([
				...attached,
				...[...projects].map(project => project.id),
			]);
			attachment.abort(
				new IpcFailure('AGENT_UNAVAILABLE', 'The app renderer detached'),
			);
			attachment = new AbortController();
			for (const projectId of candidates) {
				lastActivity.set(projectId, (options.clock ?? systemClock).now());
				const state = options.supervisor.getState(projectId);
				if (
					state.activeThreadId !== null ||
					state.status === 'starting' ||
					state.status === 'stopping' ||
					state.restart.nextAttemptAt !== null
				)
					ids.add(projectId);
			}
			attached.clear();
			pending.clear();
			preparationAborts.clear();
			mutations.clear();
			restoring.clear();
			permissionIds.clear();
			for (const [threadId, state] of snapshots)
				snapshots.set(threadId, {
					...state,
					events: state.events.filter(
						event =>
							event.type !== 'permission' && event.type !== 'permission-closed',
					),
				});
			const stopped = [...ids].map(id => {
				const stop = Promise.resolve().then(() => options.supervisor.stop(id));
				projectOperations.invalidate(id, stop);
				return stop;
			});
			await Promise.allSettled([...stopped, ...tasks]);
			for (const {observer} of historyObservers.values()) observer.dispose();
			historyObservers.clear();
			liveTurns.clear();
			replays.clear();
		},
		settlePins: async () => {
			await Promise.all([...pinning]);
		},
		dispose: () => {
			disposed = true;
			discoveries.clear();
			projectOperations.dispose();
			attachment.abort(
				new IpcFailure('AGENT_UNAVAILABLE', 'The thread service stopped'),
			);
			unsubscribe();
			unsubscribeTitles();
			permissionIds.clear();
			for (const {observer} of historyObservers.values()) observer.dispose();
			historyObservers.clear();
			liveTurns.clear();
			replays.clear();
		},
		getRetentionWarnings: async () =>
			retentionWarningsFromStore(options.store, options.now?.() ?? new Date()),
		listThreads: async ({projectId, archiveState}) => {
			getProject(projectId);
			return options.store.threads
				.list(projectId, archiveState)
				.map(presentThread);
		},
		createThread: async ({projectId}) => {
			const project = getProject(projectId);
			const thread: ThreadInfo = {
				id: randomUUID(),
				projectId,
				nanocoderSessionId: null,
				title: 'new thread',
				archiveState: 'active',
				runState: 'new',
				lastActivityAt: now(),
				sessionCwd: project.sessionCwd,
				mode: project.defaultMode,
				viewOnlyReason: null,
			};
			saveThread(thread);
			select({projectId, threadId: thread.id});
			return presentThread(thread);
		},
		openThread: request =>
			operation(request.projectId, async scope => {
				const abort = new AbortController();
				const signal = AbortSignal.any([scope, abort.signal]);
				const thread = getThread(request);
				select(request);
				if (!thread.nanocoderSessionId)
					return structuredClone(snapshot(request));
				try {
					const project = await validateProject(thread);
					signal.throwIfAborted();
					const state = options.supervisor.getState(project.id);
					if (
						state.status === 'ready' &&
						prepared.get(thread.id) ===
							options.supervisor.getConnection(project.id) &&
						sessionReady(thread, options.supervisor.getConnection(project.id))
					)
						return structuredClone(snapshot(request));
					if (
						projectOperations.isBusy(project.id) ||
						pending.has(project.id) ||
						state.activeThreadId !== null
					)
						return structuredClone(snapshot(request));
					await runProjectOperation(
						project.id,
						'resume',
						async lease => {
							const ownedSignal = AbortSignal.any([signal, lease.signal]);
							options.validateBeforePrepare?.(
								lease,
								structuredClone(getThread(request)),
								'open',
							);
							pending.set(project.id, thread.id);
							preparationAborts.set(project.id, {
								threadId: thread.id,
								abort,
								turnStarted: false,
							});
							await options.supervisor.ensureProcess(project);
							ownedSignal.throwIfAborted();
							await validateProject(getThread(request));
							ownedSignal.throwIfAborted();
							await resume(
								getThread(request),
								options.supervisor.getConnection(project.id),
								project,
								ownedSignal,
								lease,
								thread.mode,
							);
						},
						{...request, signal},
					);
				} catch (error) {
					if (signal.aborted) return failure(signal.reason);
					if (
						error instanceof IpcFailure &&
						['DENIED', 'BUSY', 'VALIDATION'].includes(error.code)
					)
						return failure(error);
					markResumeFailure(request, error);
				} finally {
					finishPreparation(thread, abort, scope);
				}
				return structuredClone(snapshot(request));
			}),
		getThreadSnapshot: async request => structuredClone(snapshot(request)),
		renameThread: async request => {
			const patch = validate(threadTitlePatch, {
				...request,
				manuallySet: true,
			});
			const initial = getThread(request);
			if (initial.nanocoderSessionId === null)
				return runMetadataOperation(
					request.projectId,
					'rename-unsaved-thread',
					async lease => {
						assertMutable(getThread(request));
						projectOperations.assertMetadataCurrent(lease);
						return presentThread(
							publishThread(options.store.threads.setTitle(patch)),
						);
					},
					{threadId: request.threadId},
				);
			return runProjectOperation(
				request.projectId,
				'rename-thread',
				async lease => {
					const thread = getThread(request);
					assertMutable(thread);
					const sessionId = thread.nanocoderSessionId;
					if (!sessionId)
						throw new IpcFailure('DENIED', 'The thread session changed');
					const project = getProject(thread.projectId);
					const unchanged = () => {
						const current = getThread(request);
						const owner = getProject(thread.projectId);
						if (
							current.nanocoderSessionId !== sessionId ||
							current.sessionCwd !== thread.sessionCwd ||
							owner.canonicalRoot !== project.canonicalRoot ||
							owner.sessionCwd !== project.sessionCwd
						)
							throw new IpcFailure('DENIED', 'The thread session changed');
						return current;
					};
					mutations.add(thread.id);
					try {
						const owner = await projectOperations.runOwnedStep(lease, () =>
							validateProject(unchanged()),
						);
						await projectOperations.runOwnedStep(lease, () =>
							options.supervisor.ensureProcess(owner),
						);
						await projectOperations.runOwnedStep(lease, () =>
							validateProject(unchanged()),
						);
						const gate = options.supervisor.getCapabilityGates(owner.id)
							.features.rename;
						if (!gate.enabled) throw new IpcFailure('UNSUPPORTED', gate.reason);
						const connection = options.supervisor.getConnection(owner.id);
						projectOperations.bindConnection(lease, connection);
						const title = await projectOperations.runOwnedStep(lease, () =>
							connection.renameSession(sessionId, patch.title),
						);
						await projectOperations.runOwnedStep(lease, () =>
							validateProject(unchanged()),
						);
						return presentThread(
							publishThread(options.store.threads.setTitle({...patch, title})),
						);
					} catch (error) {
						return failure(error);
					} finally {
						mutations.delete(thread.id);
					}
				},
				{threadId: request.threadId},
			);
		},
		archiveThread: request =>
			runMetadataOperation(
				request.projectId,
				'archive-thread',
				async lease => {
					const previous = getThread(request);
					assertMutable(previous);
					projectOperations.assertMetadataCurrent(lease);
					const thread = {
						...previous,
						archiveState: request.archived ? 'archived' : 'active',
					} satisfies ThreadInfo;
					saveThread(thread);
					return presentThread(thread);
				},
				{threadId: request.threadId},
			),
		removeThread: request =>
			runMetadataOperation(
				request.projectId,
				'remove-thread',
				async lease => {
					assertMutable(getThread(request));
					removeMetadata(request, lease);
					return null;
				},
				{threadId: request.threadId},
			),
		deleteThreadHistory: request =>
			runConfirmationOperation(
				request.projectId,
				'delete-history',
				async pendingLease => {
					const thread = getThread(request);
					assertMutable(thread);
					const project = getProject(thread.projectId);
					const sessionId = thread.nanocoderSessionId;
					if (!sessionId)
						throw new IpcFailure(
							'UNSUPPORTED',
							'This thread has no Nanocoder history; remove its desktop row instead',
						);
					const unchanged = () => {
						const current = getThread(request);
						const owner = getProject(thread.projectId);
						if (
							current.nanocoderSessionId !== sessionId ||
							current.sessionCwd !== thread.sessionCwd ||
							current.title !== thread.title ||
							owner.canonicalRoot !== project.canonicalRoot ||
							owner.sessionCwd !== project.sessionCwd
						)
							throw new IpcFailure(
								'DENIED',
								'The thread changed; confirm its history deletion again',
							);
						return current;
					};
					mutations.add(thread.id);
					try {
						const confirmed = await projectOperations.runConfirmationStep(
							pendingLease,
							() =>
								Promise.resolve(
									options.confirmDeleteHistory?.(
										structuredClone({project, thread}),
									),
								),
						);
						if (confirmed !== true) return {status: 'cancelled' as const};
						unchanged();
						const lease = projectOperations.confirmExecution(pendingLease);
						const active = {lease, threadId: thread.id};
						activeLeases.set(thread.projectId, active);
						try {
							const owner = await projectOperations.runOwnedStep(lease, () =>
								validateProject(unchanged()),
							);
							await projectOperations.runOwnedStep(lease, () =>
								options.supervisor.ensureProcess(owner),
							);
							await projectOperations.runOwnedStep(lease, () =>
								validateProject(unchanged()),
							);
							const gate = options.supervisor.getCapabilityGates(owner.id)
								.features.delete;
							if (!gate.enabled)
								throw new IpcFailure('UNSUPPORTED', gate.reason);
							const connection = options.supervisor.getConnection(owner.id);
							projectOperations.bindConnection(lease, connection);
							await projectOperations.runOwnedStep(lease, () =>
								connection.deleteSession(sessionId),
							);
							unchanged();
							removeMetadata(request, lease);
							return {status: 'deleted' as const};
						} finally {
							if (activeLeases.get(thread.projectId) === active)
								activeLeases.delete(thread.projectId);
						}
					} catch (error) {
						return failure(error);
					} finally {
						mutations.delete(thread.id);
					}
				},
				{threadId: request.threadId},
			),
		promptThread: async request => {
			const scope = attachment.signal;
			const requestedMode = getThread(request).mode;
			let completed: TurnResult | undefined;
			return runProjectOperation(
				request.projectId,
				'prompt',
				async lease => {
					const abort = new AbortController();
					const signal = AbortSignal.any([scope, abort.signal, lease.signal]);
					let thread = getThread(request);
					const replay = replays.get(thread.projectId);
					if (replay?.threadId === thread.id && replay.phase !== 'complete')
						throw new IpcFailure('UNAVAILABLE', REPLAY_FAILURE_REASON);
					assertMutable(thread);
					options.validateBeforePrepare?.(
						lease,
						structuredClone(thread),
						'prompt',
					);
					if (thread.runState === 'view-only')
						throw new IpcFailure(
							'UNAVAILABLE',
							thread.viewOnlyReason ?? 'This thread cannot accept prompts',
						);
					if (thread.archiveState === 'archived')
						throw new IpcFailure(
							'DENIED',
							'Unarchive this thread before sending a prompt',
						);
					if (
						pending.has(thread.projectId) ||
						options.supervisor.getState(thread.projectId).activeThreadId !==
							null
					)
						throw new IpcFailure(
							'BUSY',
							'Nanocoder is already working on a turn',
							true,
						);
					let attached: ResolvedAttachments | undefined;
					if (request.attachments?.length) {
						if (!options.resolveAttachments)
							throw new IpcFailure(
								'UNSUPPORTED',
								'Attachments are not available',
							);
						attached = await options.resolveAttachments(
							getProject(thread.projectId),
							request.attachments,
						);
						signal.throwIfAborted();
					}
					pending.set(thread.projectId, thread.id);
					preparationAborts.set(thread.projectId, {
						threadId: thread.id,
						abort,
						turnStarted: false,
					});
					let started = false;
					const owns = (
						current: ThreadInfo | undefined,
					): current is ThreadInfo => {
						const owner = options.store.projects.get(thread.projectId);
						return (
							current?.nanocoderSessionId === thread.nanocoderSessionId &&
							current?.sessionCwd === thread.sessionCwd &&
							owner?.canonicalRoot === thread.sessionCwd &&
							owner.sessionCwd === thread.sessionCwd
						);
					};
					try {
						const project = await validateProject(thread);
						signal.throwIfAborted();
						await options.supervisor.ensureProcess(project);
						signal.throwIfAborted();
						await validateProject(getThread(request));
						signal.throwIfAborted();
						const connection = options.supervisor.getConnection(project.id);
						if (!thread.nanocoderSessionId) {
							projectOperations.assertCurrent(lease);
							const session = await connection.newSession(
								startingMode(thread, project),
							);
							signal.throwIfAborted();
							try {
								const sessionId = validate(
									nanocoderSessionIdSchema,
									session.id,
								);
								thread = updateThread(thread, () => ({
									nanocoderSessionId: sessionId,
									mode: session.mode,
								}));
								projectOperations.bindSession(lease, sessionId);
							} catch (error) {
								await options.supervisor
									.stop(project.id)
									.catch(() => undefined);
								if (error instanceof IpcFailure) throw error;
								throw new IpcFailure(
									'INTERNAL',
									'The session id could not be stored',
								);
							}
							await handoffSession(
								lease,
								thread,
								connection,
								session,
								'new',
								requestedMode,
							);
							remember(getThread(request), connection);
						} else if (
							prepared.get(thread.id) !== connection ||
							!sessionReady(thread, connection)
						) {
							await resume(
								thread,
								connection,
								project,
								signal,
								lease,
								requestedMode,
							);
							thread = getThread(request);
						}
						projectOperations.bindConnection(lease, connection);
						if (
							prompted.get(thread.id) !== connection &&
							options.beforeFirstPrompt
						) {
							const preparedSession = preparedSessions.get(thread.id);
							if (!preparedSession)
								throw new IpcFailure(
									'AGENT_UNAVAILABLE',
									'No prepared session is available',
								);
							await projectOperations.runOwnedStep(lease, async () => {
								await options.beforeFirstPrompt?.(
									sessionContext(
										lease,
										thread,
										connection,
										preparedSession.session,
										preparedSession.source,
										requestedMode,
									),
								);
							});
						}
						thread = getThread(request);
						await validateProject(getThread(request));
						signal.throwIfAborted();
						if (options.supervisor.getConnection(project.id) !== connection)
							throw new IpcFailure(
								'AGENT_UNAVAILABLE',
								'The project process changed before the prompt',
							);
						const sessionId = thread.nanocoderSessionId;
						if (!sessionId)
							throw new IpcFailure('AGENT_UNAVAILABLE', 'No session is ready');
						if (!sessionReady(thread, connection))
							throw new IpcFailure(
								'AGENT_UNAVAILABLE',
								'The session must be prepared again',
							);
						projectOperations.assertCurrent(lease);
						const historyScope = {
							projectId: thread.projectId,
							threadId: thread.id,
							sessionId,
						};
						const previous = options.store.threadHistory.read(historyScope);
						const observer = historyObservers.get(thread.id);
						liveTurns.set(thread.id, {
							lease,
							scope: historyScope,
							turnId: randomUUID(),
							history: previous,
							complete:
								previous?.complete ??
								preparedSessions.get(thread.id)?.source === 'new',
							accepted: false,
							observer:
								observer?.sessionId === sessionId
									? observer.observer
									: createThreadHistoryObserver({
											scope: historyScope,
											history: options.store.threadHistory,
											runs: options.store.agentRuns,
										}),
						});
						thread = updateThread(thread, current => ({
							title:
								current.title === 'new thread' &&
								options.store.threads.getTitleManuallySet(
									current.projectId,
									current.id,
								) === false
									? titleFrom(request.text) || current.title
									: current.title,
							runState: 'running',
							lastActivityAt: now(),
						}));
						remember(thread, connection);
						signal.throwIfAborted();
						const preparation = preparationAborts.get(thread.projectId);
						if (preparation?.abort === abort) preparation.turnStarted = true;
						started = true;
						prompted.set(thread.id, connection);
						append(thread, [
							{
								type: 'user',
								text: request.text,
								...(attached?.summary.length
									? {attachmentSummary: attached.summary}
									: {}),
							},
						]);
						const result = await options.supervisor.prompt(
							project.id,
							sessionId,
							request.text,
							attached?.blocks,
						);
						const liveFailure = liveTurns.get(thread.id)?.failure;
						if (liveFailure) throw liveFailure;
						const current = getThread(request);
						if (!owns(current))
							throw new IpcFailure(
								'AGENT_UNAVAILABLE',
								'The thread session changed before the turn finished',
							);
						if (
							result.metadata &&
							!signal.aborted &&
							result.stopReason !== 'cancelled'
						)
							append(current, [{type: 'metadata', metadata: result.metadata}]);
						if (!signal.aborted) {
							const terminal: IpcResult<TurnResult> = {
								ok: true,
								value: {stopReason: result.stopReason},
							};
							if (result.stopReason === 'cancelled')
								await projectOperations.runCancellationStep(lease, async () => {
									append(current, [], terminal, true, lease);
								});
							else append(current, [], terminal);
						}
						updateThread(current, () => ({
							runState:
								liveTurns.get(thread.id)?.outcome === 'failed'
									? 'failed'
									: result.stopReason === 'cancelled' ||
											liveTurns.get(thread.id)?.outcome === 'cancelled'
										? 'interrupted'
										: 'ready',
							lastActivityAt: now(),
						}));
						if (liveTurns.get(thread.id)?.outcome !== 'failed')
							void keepSession(
								current,
								() => options.supervisor.getConnection(project.id),
								sessionId,
							);
						completed = {stopReason: result.stopReason};
						return {stopReason: result.stopReason};
					} catch (error) {
						if (
							!started &&
							!scope.aborted &&
							signal.reason instanceof PreparationCancelled
						) {
							updateThread(thread, () => ({
								runState: 'interrupted',
								lastActivityAt: now(),
							}));
							completed = {stopReason: 'cancelled'};
							return {stopReason: 'cancelled' as const};
						}
						if (started && !disposed) {
							const current = options.store.threads.get(
								thread.projectId,
								thread.id,
							);
							if (owns(current)) {
								if (!signal.aborted) {
									const safe = requestFailure(error);
									const terminal: IpcResult<TurnResult> = {
										ok: false,
										error: {
											code: safe.code,
											message: safe.message,
											retryable: safe.retryable,
										},
									};
									try {
										append(current, [], terminal);
									} catch {
										append(current, [], terminal, false);
									}
								}
								updateThread(current, () => ({
									runState: 'failed',
									lastActivityAt: now(),
								}));
							}
						}
						return failure(error);
					} finally {
						const live = liveTurns.get(thread.id);
						if (live?.lease === lease) {
							if (historyObservers.get(thread.id)?.observer !== live.observer)
								live.observer.dispose();
							liveTurns.delete(thread.id);
						}
						finishPreparation(thread, abort, scope);
					}
				},
				{threadId: request.threadId},
			).catch(error => {
				if (
					completed &&
					(completed.stopReason === 'cancelled' || scope.aborted)
				)
					return completed;
				return failure(error);
			});
		},
		cancelThread: async request => {
			const thread = getThread(request);
			const owner = activeLeases.get(thread.projectId);
			if (owner?.threadId !== thread.id || owner.lease.kind !== 'prompt')
				return null;
			const sessionId = thread.nanocoderSessionId;
			const active = options.supervisor.getState(
				thread.projectId,
			).activeThreadId;
			try {
				if (sessionId && active === sessionId) {
					await projectOperations.runCancellationStep(owner.lease, () =>
						options.supervisor.cancel(thread.projectId, sessionId),
					);
				} else if (
					active === null &&
					pending.get(thread.projectId) === thread.id
				) {
					const preparation = preparationAborts.get(thread.projectId);
					if (preparation?.threadId === thread.id && !preparation.turnStarted) {
						await projectOperations.runCancellationStep(
							owner.lease,
							async () => {
								preparation.abort.abort(new PreparationCancelled());
								await options.supervisor.stop(thread.projectId);
							},
						);
					}
				}
			} catch (error) {
				return failure(error);
			}
			return null;
		},
		setThreadMode: unavailable,
		answerThreadPermission: async request => {
			const thread = getThread(request);
			const replay = replays.get(thread.projectId);
			if (replay?.threadId === thread.id && replay.phase !== 'complete')
				throw new IpcFailure('DENIED', REPLAY_FAILURE_REASON);
			const active = activeLeases.get(thread.projectId);
			const sessionId = thread.nanocoderSessionId;
			const denied = () =>
				new IpcFailure(
					'DENIED',
					'This permission request is not waiting for this thread',
				);
			if (
				active?.threadId !== thread.id ||
				active.lease.kind !== 'prompt' ||
				!sessionId ||
				options.supervisor.getState(thread.projectId).activeThreadId !==
					sessionId
			)
				throw denied();
			return projectOperations.runOwnedStep(active.lease, async () => {
				const owner = await validateProject(thread);
				projectOperations.assertCurrent(active.lease);
				const current = getThread(request);
				const project = getProject(thread.projectId);
				if (
					activeLeases.get(thread.projectId) !== active ||
					!project.trusted ||
					current.nanocoderSessionId !== sessionId ||
					current.sessionCwd !== thread.sessionCwd ||
					project.canonicalRoot !== owner.canonicalRoot ||
					project.sessionCwd !== owner.sessionCwd ||
					options.supervisor.getState(thread.projectId).activeThreadId !==
						sessionId ||
					!options.supervisor.answerPermission(
						thread.projectId,
						sessionId,
						request.requestId,
						request.optionId,
					)
				)
					throw denied();
				return null;
			});
		},
		discoverSessions: async ({projectId}) => {
			const project = getProject(projectId);
			return operation(projectId, async signal => {
				discoveries.delete(projectId);
				let discovery: DiscoverySnapshot | undefined;
				try {
					if (
						project.sessionCwd !== project.canonicalRoot ||
						options.supervisor.getState(projectId).status !== 'ready' ||
						!options.supervisor.getCapabilityGates(projectId).features.list
							.enabled
					)
						return [];
					const connection = options.supervisor.getConnection(projectId);
					if (
						!connection.listSessions ||
						connection.agent.root !== project.canonicalRoot
					)
						return [];
					discovery = {
						connection,
						canonicalRoot: project.canonicalRoot,
						sessionCwd: project.sessionCwd,
						signal,
						candidates: new Map(),
					};
					discoveries.set(projectId, discovery);
					const response = await untilAborted(
						connection.listSessions(),
						signal,
					);
					const candidates = await untilAborted(
						sessionDiscovery(response, project.canonicalRoot),
						signal,
					);
					if (!currentDiscovery(projectId, discovery)) return [];
					const visible: DiscoveredSession[] = [];
					for (const candidate of candidates) {
						const owner = options.store.threads.getBySessionId(
							candidate.session.id,
						);
						if (owner && owner.projectId !== projectId) continue;
						discovery.candidates.set(candidate.session.id, candidate);
						if (!owner) visible.push(candidate.session);
					}
					return structuredClone(visible);
				} catch {
					if (discovery && discoveries.get(projectId) === discovery)
						discoveries.delete(projectId);
					return [];
				}
			}).catch(() => []);
		},
		importSession: async ({projectId, sessionId: input}) => {
			const sessionId = validate(nanocoderSessionIdSchema, input);
			getProject(projectId);
			return runMetadataOperation(projectId, 'import-session', async lease => {
				const existingOwner = () => {
					const existing = options.store.threads.getBySessionId(sessionId);
					if (existing && existing.projectId !== projectId)
						throw new IpcFailure(
							'DENIED',
							'This saved session belongs to another project',
						);
					return existing;
				};
				existingOwner();
				const discovery = discoveries.get(projectId);
				if (!discovery || !currentDiscovery(projectId, discovery))
					throw new IpcFailure(
						'UNAVAILABLE',
						'Refresh saved sessions before importing',
					);
				const candidate = discovery.candidates.get(sessionId);
				if (!candidate)
					throw new IpcFailure(
						'DENIED',
						'This saved session is not available for this project',
					);
				let root: string;
				let cwd: string;
				try {
					[root, cwd] = await Promise.all([
						canonicalPath(discovery.canonicalRoot),
						canonicalPath(candidate.reportedCwd),
					]);
				} catch {
					if (discoveries.get(projectId) === discovery)
						discoveries.delete(projectId);
					throw new IpcFailure(
						'DENIED',
						'The saved session folder is no longer available',
					);
				}
				if (root !== discovery.canonicalRoot || cwd !== root) {
					if (discoveries.get(projectId) === discovery)
						discoveries.delete(projectId);
					throw new IpcFailure(
						'OUTSIDE_ROOT',
						'The saved session folder changed',
					);
				}
				projectOperations.assertMetadataCurrent(lease);
				if (
					!currentDiscovery(projectId, discovery) ||
					discovery.candidates.get(sessionId) !== candidate
				)
					throw new IpcFailure(
						'UNAVAILABLE',
						'Refresh saved sessions before importing',
					);
				const existing = existingOwner();
				if (existing) return structuredClone(existing);
				const project = getProject(projectId);
				return saveThread({
					id: randomUUID(),
					projectId,
					nanocoderSessionId: sessionId,
					title:
						titleFrom(candidate.session.title, SESSION_TITLE_LIMIT) ||
						'new thread',
					archiveState: 'active',
					runState: 'ready',
					lastActivityAt: candidate.session.lastActivityAt ?? now(),
					sessionCwd: root,
					mode: project.defaultMode,
					viewOnlyReason: null,
				});
			});
		},
	};
}
