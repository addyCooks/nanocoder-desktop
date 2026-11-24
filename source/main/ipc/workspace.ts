import {z} from 'zod';
import {IpcFailure} from '@/main/ipc/handle-request';
import type {registerHandler as registerIpcHandler} from '@/main/ipc/register';
import type {WorkspaceServices} from '@/main/ipc/workspace-services';
import {
	defaultMode,
	mode,
	nanocoderSessionIdSchema,
	settingsPatch,
	uiPatch,
} from '@/main/store/validation';
import {
	CHANNELS,
	MAX_PROMPT_LENGTH,
	type WorkspaceMethod,
	type WorkspaceRequests,
	type WorkspaceValues,
} from '@/shared/ipc';

const id = z.uuid();
const project = {projectId: id};
const thread = {...project, threadId: id};
const empty = z.strictObject({});
const projectRequest = z.strictObject(project);
const threadRequest = z.strictObject(thread);

const relativePath = z.string().min(1).max(4096);
const attachmentSchema = z.discriminatedUnion('kind', [
	z.strictObject({kind: z.literal('file'), path: relativePath}),
	z.strictObject({
		kind: z.literal('browser-page'),
		url: z.string().min(1).max(2_048),
	}),
	z
		.strictObject({
			kind: z.literal('review-comment'),
			path: relativePath,
			startLine: z.number().int().min(1).max(10_000_000),
			endLine: z.number().int().min(1).max(10_000_000),
			side: z.enum(['staged', 'unstaged']),
			comment: z.string().trim().min(1).max(4_000),
			excerpt: z.string().max(20_000),
		})
		.refine(
			value =>
				value.endLine >= value.startLine &&
				value.endLine - value.startLine <= 2_000,
		),
]);

const workspaceSchemas: {
	[K in WorkspaceMethod]: z.ZodType<WorkspaceRequests[K]>;
} = {
	getSettings: empty,
	updateSettings: z.strictObject({patch: settingsPatch}),
	getUiState: empty,
	updateUiState: z.strictObject({patch: uiPatch}),
	listProjects: empty,
	addProject: empty,
	openProject: projectRequest,
	locateProject: projectRequest,
	removeProject: projectRequest,
	setProjectDefaultMode: z.strictObject({...project, mode: defaultMode}),
	getProjectControls: projectRequest,
	setProjectConfigOption: z.strictObject({
		...project,
		revision: id,
		configId: z.enum(['provider', 'model']),
		value: z
			.string()
			.min(1)
			.max(512)
			.regex(/^[^\u0000-\u001f\u007f]+$/u),
	}),
	getSupervisorState: projectRequest,
	startProject: projectRequest,
	stopProject: projectRequest,
	restartProject: projectRequest,
	getCapabilityGates: projectRequest,
	getDiagnostics: projectRequest,
	exportDiagnostics: z.strictObject({...project, snapshotId: id}),
	listThreads: z.strictObject({
		...project,
		archiveState: z.enum(['active', 'archived']),
	}),
	getRetentionWarnings: empty,
	createThread: projectRequest,
	openThread: threadRequest,
	getThreadSnapshot: threadRequest,
	renameThread: z.strictObject({
		...thread,
		title: z.string().trim().min(1).max(500),
	}),
	archiveThread: z.strictObject({...thread, archived: z.boolean()}),
	removeThread: threadRequest,
	deleteThreadHistory: threadRequest,
	promptThread: z.strictObject({
		...thread,
		text: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
		attachments: z.array(attachmentSchema).max(20).optional(),
	}),
	cancelThread: threadRequest,
	setThreadMode: z.strictObject({...thread, mode}),
	answerThreadPermission: z.strictObject({
		...thread,
		requestId: z.string().min(1).max(200),
		optionId: z.string().min(1).max(200),
	}),
	discoverSessions: projectRequest,
	importSession: z.strictObject({
		...project,
		sessionId: nanocoderSessionIdSchema,
	}),
};

function available<T>(service: T | undefined): T {
	if (service === undefined) {
		throw new IpcFailure('UNAVAILABLE', 'This feature is not available yet');
	}
	return service;
}

export function registerWorkspaceHandlers(
	registerHandler: typeof registerIpcHandler,
	allowedOrigins: readonly string[],
	services: WorkspaceServices = {},
): void {
	const trustedProject = (projectId: string) => {
		const chosen = available(services.store).projects.get(projectId);
		if (!chosen) throw new IpcFailure('NOT_FOUND', 'Project not found');
		if (!chosen.trusted) {
			throw new IpcFailure('DENIED', 'Trust this project before starting it');
		}
		return chosen;
	};
	const handlers: {
		[K in WorkspaceMethod]: (
			request: WorkspaceRequests[K],
		) => WorkspaceValues[K] | Promise<WorkspaceValues[K]>;
	} = {
		getSettings: () => available(services.store).getSettings(),
		updateSettings: ({patch}) =>
			available(services.store).updateSettings(patch),
		getUiState: () => available(services.store).getUiState(),
		updateUiState: ({patch}) => available(services.store).updateUiState(patch),
		listProjects: () => available(services.store).projects.list(),
		addProject: request => available(services.projects).addProject(request),
		openProject: request => available(services.projects).openProject(request),
		locateProject: request =>
			available(services.projects).locateProject(request),
		removeProject: request =>
			available(services.projects).removeProject(request),
		setProjectDefaultMode: request =>
			available(services.projects).setProjectDefaultMode(request),
		getProjectControls: request =>
			available(services.controls).getProjectControls(request),
		setProjectConfigOption: request =>
			available(services.controls).setProjectConfigOption(request),
		getSupervisorState: ({projectId}) =>
			available(services.supervisor).getState(projectId),
		startProject: ({projectId}) => {
			const supervisor = available(services.supervisor);
			return supervisor.ensureProcess(trustedProject(projectId));
		},
		stopProject: ({projectId}) =>
			services.stopProject
				? services.stopProject(projectId)
				: available(services.supervisor).stop(projectId),
		restartProject: ({projectId}) => {
			if (services.restartProject) return services.restartProject(projectId);
			const supervisor = available(services.supervisor);
			return supervisor.restart(trustedProject(projectId));
		},
		getCapabilityGates: ({projectId}) =>
			available(services.supervisor).getCapabilityGates(projectId),
		getDiagnostics: ({projectId}) =>
			available(services.supervisor).getDiagnostics(projectId),
		exportDiagnostics: request =>
			available(services.diagnostics).exportDiagnostics(request),
		listThreads: request => available(services.threads).listThreads(request),
		getRetentionWarnings: request =>
			available(services.threads).getRetentionWarnings(request),
		createThread: request => available(services.threads).createThread(request),
		openThread: request => available(services.threads).openThread(request),
		getThreadSnapshot: request =>
			available(services.threads).getThreadSnapshot(request),
		renameThread: request => available(services.threads).renameThread(request),
		archiveThread: request =>
			available(services.threads).archiveThread(request),
		removeThread: request => available(services.threads).removeThread(request),
		deleteThreadHistory: request =>
			available(services.threads).deleteThreadHistory(request),
		promptThread: request => available(services.threads).promptThread(request),
		cancelThread: request => available(services.threads).cancelThread(request),
		setThreadMode: request =>
			available(services.threads).setThreadMode(request),
		answerThreadPermission: request =>
			available(services.threads).answerThreadPermission(request),
		discoverSessions: request =>
			available(services.threads).discoverSessions(request),
		importSession: request =>
			available(services.threads).importSession(request),
	};
	const register = <K extends WorkspaceMethod>(method: K) =>
		registerHandler(
			CHANNELS[method],
			workspaceSchemas[method],
			handlers[method],
			allowedOrigins,
		);
	for (const method of Object.keys(handlers) as WorkspaceMethod[]) {
		register(method);
	}
}
