import {randomUUID} from 'node:crypto';
import {IpcFailure} from '@/main/ipc/handle-request';
import type {NanocoderConnection} from '@/main/nanocoder/acp-client';
import {canonicalPath} from '@/main/paths';
import type {
	createProjectOperations,
	ProjectOperationLease,
} from '@/main/threads/project-operations';
import {CONFIG_UNCERTAINTY_REASON} from '@/shared/control-reasons';
import type {
	ModelScope,
	ProjectControls,
	ProjectInfo,
	SessionInfo,
	ThreadInfo,
	WorkspaceRequests,
} from '@/shared/ipc';

export interface ControlSessionContext {
	lease: ProjectOperationLease;
	thread: ThreadInfo;
	connection: NanocoderConnection;
	session: SessionInfo;
	source: 'new' | 'resume';
}

interface ProjectControlOptions {
	operations: ReturnType<typeof createProjectOperations>;
	runProjectOperation: ReturnType<
		typeof createProjectOperations
	>['runProjectOperation'];
	getProject(projectId: string): ProjectInfo | undefined;
	getThread(projectId: string, threadId: string): ThreadInfo | undefined;
	getConnection(projectId: string): object | undefined;
	publishControls(controls: ProjectControls): void;
	canonicalise?(path: string): Promise<string>;
}

type PreparedSession = Omit<ControlSessionContext, 'lease'>;
interface OfferState {
	revision: string;
	sessions: Map<string, PreparedSession>;
	activeThreadId: string | null;
	selectedThreadId: string | null;
	configOptions: ProjectControls['configOptions'];
	modelScope: ModelScope;
	fingerprint: string;
	reason: string | null;
}

const missingOffers =
	'available after the first message: Nanocoder supplies model options after a session exists';
const uncertainReason = CONFIG_UNCERTAINTY_REASON;
const changed = () =>
	new IpcFailure('DENIED', 'The model options changed; choose again');

export function createProjectControls(options: ProjectControlOptions) {
	const states = new Map<string, OfferState>();
	const subscriptions = new Map<
		NanocoderConnection,
		{projectId: string; unsubscribe(): void}
	>();
	const uncertainConnections = new WeakSet<object>();
	const operations = options.operations;
	let disposed = false;
	const project = (projectId: string) => {
		if (disposed)
			throw new IpcFailure('AGENT_UNAVAILABLE', 'Project controls stopped');
		const owner = options.getProject(projectId);
		if (!owner) throw new IpcFailure('NOT_FOUND', 'Project not found');
		return owner;
	};
	const stateFor = (projectId: string) => {
		project(projectId);
		let state = states.get(projectId);
		if (!state) {
			state = {
				revision: randomUUID(),
				sessions: new Map(),
				activeThreadId: null,
				selectedThreadId: null,
				configOptions: [],
				modelScope: 'project',
				fingerprint: '',
				reason: missingOffers,
			};
			states.set(projectId, state);
		}
		return state;
	};
	const eligible = (owner: ProjectInfo, source: PreparedSession) => {
		const row = options.getThread(owner.id, source.thread.id);
		return !!(
			owner.trusted &&
			owner.availability === 'available' &&
			owner.canonicalRoot === owner.sessionCwd &&
			row?.projectId === owner.id &&
			row.sessionCwd === owner.canonicalRoot &&
			row.nanocoderSessionId === source.session.id &&
			source.thread.sessionCwd === owner.canonicalRoot &&
			source.connection.agent.root === owner.canonicalRoot &&
			options.getConnection(owner.id) === source.connection
		);
	};
	const refresh = (projectId: string, force = false) => {
		const owner = project(projectId);
		const state = stateFor(projectId);
		for (const [id, source] of state.sessions) {
			if (!eligible(owner, source)) state.sessions.delete(id);
		}
		const perSession = [...state.sessions.values()].some(
			source => source.connection.agent.capabilities?.perSessionModel,
		);
		const followed = state.selectedThreadId ?? state.activeThreadId;
		const previous =
			state.activeThreadId && state.sessions.get(state.activeThreadId);
		if (!force && operations.isBusy(projectId) && previous) return state;
		let active: PreparedSession | undefined;
		let offers: ReturnType<NanocoderConnection['getSessionOffers']>;
		// Per-session model state: only the thread in view can supply the options it shows.
		const sources = perSession
			? [followed && state.sessions.get(followed)].filter(
					(source): source is PreparedSession => !!source,
				)
			: [...state.sessions.values()];
		if (previous && !perSession) sources.unshift(previous);
		for (const source of sources) {
			const current = source.connection.getSessionOffers(source.session.id);
			if (current) {
				active = source;
				offers = current;
				break;
			}
		}
		const uncertain = active && uncertainConnections.has(active.connection);
		const configOptions = uncertain ? [] : (offers?.configOptions ?? []);
		const reason = uncertain
			? uncertainReason
			: configOptions.length
				? null
				: active
					? 'this Nanocoder offered no model options to choose from'
					: perSession
						? missingOffers
						: (state.reason ?? missingOffers);
		const modelScope: ModelScope = perSession ? 'thread' : 'project';
		const fingerprint = JSON.stringify([
			modelScope,
			active?.thread.id,
			active?.session.id,
			offers?.offeredModes,
			configOptions,
			reason,
		]);
		if (state.fingerprint !== fingerprint) {
			state.fingerprint = fingerprint;
			state.revision = randomUUID();
			state.activeThreadId = active?.thread.id ?? null;
			state.configOptions = structuredClone(configOptions);
			state.modelScope = modelScope;
			state.reason = reason;
		}
		return state;
	};
	const snapshot = (projectId: string, ignoreBusy = false): ProjectControls => {
		const state = refresh(projectId);
		const reason =
			!ignoreBusy && operations.isBusy(projectId)
				? 'stop the running turn first'
				: state.reason;
		return {
			projectId,
			revision: state.revision,
			configOptions: structuredClone(state.configOptions),
			modelScope: state.modelScope,
			threadId: state.activeThreadId,
			modelGate: reason
				? {enabled: false, reason}
				: {enabled: true, reason: null},
		};
	};
	const publish = (projectId: string) =>
		options.publishControls(snapshot(projectId, true));
	const observeConnection = (
		projectId: string,
		connection: NanocoderConnection,
	) => {
		if (subscriptions.has(connection) || !connection.observeConfigOptions)
			return;
		const unsubscribe = connection.observeConfigOptions({
			isCurrentSession: sessionId => {
				const owner = options.getProject(projectId);
				return !!(
					!disposed &&
					owner &&
					!uncertainConnections.has(connection) &&
					[...(states.get(projectId)?.sessions.values() ?? [])].some(
						source =>
							source.connection === connection &&
							source.session.id === sessionId &&
							eligible(owner, source),
					)
				);
			},
			onChange: () => {
				if (disposed || !states.has(projectId)) return;
				const revision = states.get(projectId)?.revision;
				if (refresh(projectId, true).revision !== revision) publish(projectId);
			},
		});
		subscriptions.set(connection, {projectId, unsubscribe});
	};
	const invalidate = (
		projectId: string,
		reason = 'model options changed; wait for a prepared session',
	) => {
		for (const [connection, subscription] of subscriptions) {
			if (subscription.projectId !== projectId) continue;
			subscription.unsubscribe();
			subscriptions.delete(connection);
		}
		const state = states.get(projectId);
		if (!state) return;
		state.sessions.clear();
		state.activeThreadId = null;
		state.selectedThreadId = null;
		state.configOptions = [];
		state.modelScope = 'project';
		state.reason = reason;
		state.fingerprint = '';
		state.revision = randomUUID();
		if (!disposed && options.getProject(projectId)) publish(projectId);
	};
	const bind = (lease: ProjectOperationLease, source: PreparedSession) => {
		operations.assertCurrent(lease);
		operations.bindThread(lease, source.thread.id);
		operations.bindConnection(lease, source.connection);
		operations.bindSession(lease, source.session.id);
		operations.assertCurrent(lease);
	};
	const assertRequest = (
		request: WorkspaceRequests['setProjectConfigOption'],
	) => {
		const state = refresh(request.projectId, true);
		const option = state.configOptions.find(
			option => option.id === request.configId,
		);
		const source =
			state.activeThreadId && state.sessions.get(state.activeThreadId);
		if (
			request.revision !== state.revision ||
			state.reason ||
			!source ||
			!option?.options.some(option => option.value === request.value)
		)
			throw changed();
		return source;
	};
	return {
		onSessionPrepared(context: ControlSessionContext) {
			const {lease, thread, connection, session, source} = context;
			if (
				thread.projectId !== lease.projectId ||
				thread.nanocoderSessionId !== session.id
			)
				throw changed();
			const prepared = {
				thread: structuredClone(thread),
				connection,
				session: structuredClone(session),
				source,
			};
			bind(lease, prepared);
			if (!eligible(project(lease.projectId), prepared)) throw changed();
			const state = stateFor(lease.projectId);
			state.sessions.set(thread.id, prepared);
			observeConnection(lease.projectId, connection);
			state.activeThreadId = thread.id;
			state.fingerprint = '';
			state.revision = randomUUID();
			refresh(lease.projectId, true);
			publish(lease.projectId);
		},
		getProjectControls({
			projectId,
		}: WorkspaceRequests['getProjectControls']): ProjectControls {
			return snapshot(projectId);
		},
		setProjectConfigOption: (
			request: WorkspaceRequests['setProjectConfigOption'],
		): Promise<ProjectControls> => {
			return options.runProjectOperation(
				request.projectId,
				'config',
				async lease => {
					const source = assertRequest(request);
					bind(lease, source);
					let root: string;
					try {
						root = await operations.runOwnedStep(lease, () =>
							(options.canonicalise ?? canonicalPath)(lease.canonicalRoot),
						);
					} catch (error) {
						if (error instanceof IpcFailure) throw error;
						throw new IpcFailure(
							'DENIED',
							'The project root changed; locate and trust it again',
						);
					}
					if (root !== lease.canonicalRoot) throw changed();
					if (assertRequest(request).connection !== source.connection)
						throw changed();
					operations.assertCurrent(lease);
					try {
						await operations.runOwnedStep(lease, () =>
							source.connection.setConfigOption(
								source.session.id,
								request.configId,
								request.value,
							),
						);
						operations.assertCurrent(lease);
						refresh(request.projectId, true);
						const confirmed = snapshot(request.projectId, true);
						publish(request.projectId);
						return confirmed;
					} catch (error) {
						uncertainConnections.add(source.connection);
						if (
							!disposed &&
							options.getConnection(request.projectId) === source.connection &&
							options.getProject(request.projectId)?.canonicalRoot ===
								lease.canonicalRoot
						)
							invalidate(request.projectId, uncertainReason);
						if (error instanceof IpcFailure) throw error;
						throw new IpcFailure(
							'AGENT_UNAVAILABLE',
							`Nanocoder did not confirm the model change; ${uncertainReason}`,
						);
					}
				},
			);
		},
		invalidate,
		selectThread(projectId: string, threadId: string) {
			const state = states.get(projectId);
			if (disposed || !state || state.selectedThreadId === threadId) return;
			state.selectedThreadId = threadId;
			const revision = state.revision;
			if (refresh(projectId, true).revision !== revision) publish(projectId);
		},
		invalidateThread(projectId: string, threadId: string) {
			const state = states.get(projectId);
			if (!state?.sessions.delete(threadId)) return;
			state.fingerprint = '';
			state.revision = randomUUID();
			if (!disposed && options.getProject(projectId)) publish(projectId);
		},
		assertPromptAllowed(
			context: Pick<ControlSessionContext, 'lease' | 'connection'>,
		) {
			operations.assertCurrent(context.lease);
			if (uncertainConnections.has(context.connection))
				throw new IpcFailure('AGENT_UNAVAILABLE', uncertainReason);
		},
		getOwnedSession(projectId: string, threadId: string) {
			const owner = project(projectId);
			const source = stateFor(projectId).sessions.get(threadId);
			const row = options.getThread(projectId, threadId);
			if (
				!source ||
				!row ||
				!eligible(owner, source) ||
				!source.connection.getSessionOffers(source.session.id)
			)
				return undefined;
			return {
				...source,
				thread: structuredClone(row),
			};
		},
		dispose() {
			disposed = true;
			for (const subscription of subscriptions.values())
				subscription.unsubscribe();
			subscriptions.clear();
			states.clear();
		},
	};
}
