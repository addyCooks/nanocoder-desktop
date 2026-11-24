import type {ProjectsChangedEvent} from '@/shared/project-events';
import type {RetentionWarnings} from '@/shared/retention';

export type ErrorCode =
	| 'VALIDATION'
	| 'NOT_FOUND'
	| 'OUTSIDE_ROOT'
	| 'LIMIT'
	| 'UNSUPPORTED'
	| 'UNAVAILABLE'
	| 'STORE_CORRUPT'
	| 'STORE_TOO_NEW'
	| 'AGENT_UNAVAILABLE'
	| 'BUSY'
	| 'DENIED'
	| 'INTERNAL';

export interface IpcError {
	code: ErrorCode;
	message: string;
	retryable: boolean;
}

export type IpcResult<T> = {ok: true; value: T} | {ok: false; error: IpcError};

// The longest message the main process accepts. The composer refuses a longer draft
// before it is sent, so the limit is not met as an "Invalid request" that fails the turn.
export const MAX_PROMPT_LENGTH = 100_000;

export const CHANNELS = {
	getAppInfo: 'app:get-info',
	getNanocoderRuntime: 'nanocoder:get-runtime',
	connectNanocoder: 'nanocoder:connect',
	getSettings: 'store:get-settings',
	updateSettings: 'store:update-settings',
	getUiState: 'store:get-ui-state',
	updateUiState: 'store:update-ui-state',
	listProjects: 'projects:list',
	addProject: 'projects:add',
	openProject: 'projects:open',
	locateProject: 'projects:locate',
	removeProject: 'projects:remove',
	setProjectDefaultMode: 'projects:set-default-mode',
	getProjectControls: 'projects:get-controls',
	setProjectConfigOption: 'projects:set-config-option',
	getSupervisorState: 'supervisor:get-state',
	startProject: 'supervisor:start',
	stopProject: 'supervisor:stop',
	restartProject: 'supervisor:restart',
	getCapabilityGates: 'supervisor:get-capability-gates',
	getDiagnostics: 'supervisor:get-diagnostics',
	exportDiagnostics: 'supervisor:export-diagnostics',
	listThreads: 'threads:list',
	getRetentionWarnings: 'threads:get-retention-warnings',
	createThread: 'threads:create',
	openThread: 'threads:open',
	getThreadSnapshot: 'threads:get-snapshot',
	renameThread: 'threads:rename',
	archiveThread: 'threads:archive',
	removeThread: 'threads:remove',
	deleteThreadHistory: 'threads:delete-history',
	promptThread: 'threads:prompt',
	cancelThread: 'threads:cancel',
	setThreadMode: 'threads:set-mode',
	answerThreadPermission: 'threads:answer-permission',
	discoverSessions: 'threads:discover',
	importSession: 'threads:import',
	// Pushed from main to the renderer.
	projectEvent: 'projects:event',
} as const;

export interface AppInfo {
	name: string;
	version: string;
	// The folder the saved data was moved to when it could not be read, on a start that began empty.
	recoveredDatabase?: string;
}

export interface NanocoderRuntime {
	nodePath: string;
	nodeVersion: string;
	cliPath: string;
	version: string;
	source: 'override' | 'bundled' | 'path';
}

export interface AgentCapabilities {
	loadSession: boolean;
	sessions: {close: boolean; delete: boolean; list: boolean; resume: boolean};
	prompt: {image: boolean; audio: boolean; embeddedContext: boolean};
	mcp: {http: boolean; sse: boolean};
	perSessionModel: boolean;
	// The limits Nanocoder reported for its saved sessions, or null when it did not (DEC-45).
	retention: {days: number; maxSessions: number} | null;
}

export interface ConnectedAgent {
	root: string;
	protocolVersion: number;
	name: string | null;
	version: string | null;
	capabilities: AgentCapabilities;
}

export type NanocoderMode =
	| 'normal'
	| 'auto-accept'
	| 'yolo'
	| 'plan'
	| 'architect';

export interface SessionInfo {
	id: string;
	mode: NanocoderMode;
}

export type ConnectResult =
	| {status: 'connected'; agent: ConnectedAgent}
	| {status: 'untrusted'; message: string}
	| {status: 'cancelled'};

export type PermissionOptionKind =
	| 'allow_once'
	| 'allow_always'
	| 'reject_once'
	| 'reject_always';

// Nanocoder's own options, passed on unchanged (ACP-10).
export interface PermissionOptionInfo {
	id: string;
	name: string;
	kind: PermissionOptionKind;
}

export interface PermissionRequestInfo {
	id: string;
	title: string;
	options: PermissionOptionInfo[];
	source?: import('@/shared/subagents').SubagentPermissionSource;
	// Display only: set by main when the request has Nanocoder's ask_user shape.
	question?: true;
}

export interface StreamCommand {
	name: string;
	description: string;
	inputHint?: string;
}

export interface StreamUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	thoughtTokens?: number;
	cachedReadTokens?: number;
	cachedWriteTokens?: number;
	cost?: number;
}

export interface StreamMetadata {
	usage?: StreamUsage;
	durationMs?: number;
	outcome?: 'completed' | 'cancelled' | 'failed';
	artifacts?: {
		kind: 'implementation_plan' | 'task' | 'walkthrough';
		path: string;
	}[];
}

export interface StreamToolDetails {
	content?: string[];
	locations?: {path: string; line?: number}[];
	input?: string;
	output?: string;
}

export type StreamPlan =
	| {
			kind: 'items';
			entries: {content: string; priority: string; status: string}[];
	  }
	| {kind: 'markdown'; text: string}
	| {kind: 'file'; uri: string};

export interface StreamConfigOption {
	id: string;
	name: string;
	value: string | boolean;
}

export type TurnEvent = (
	| {type: 'user'; text: string; messageId?: string}
	| {type: 'text'; text: string; messageId?: string}
	| {type: 'thought'; text: string; messageId?: string}
	| {type: 'commands'; commands: StreamCommand[]}
	| {type: 'metadata'; metadata: StreamMetadata}
	| {type: 'plan'; id: string | null; content: StreamPlan | null}
	| {type: 'mode'; id: string}
	| {type: 'config'; options: StreamConfigOption[]}
	| {
			type: 'context';
			used: number;
			size: number;
			cost?: {amount: number; currency: string};
	  }
	| {type: 'notice'; severity: string; title: string; description?: string}
	| {
			type: 'compaction';
			id: string;
			status: string;
			summary?: string | null;
			error?: string | null;
	  }
	| {type: 'compaction-chunk'; id: string; text: string}
	| {
			type: 'subagent';
			id: string;
			title?: string | null;
			description?: string | null;
			state?: string | null;
	  }
	| {
			type: 'session-message';
			id: string;
			sender?: string;
			recipient?: string;
			text?: string;
			append: boolean;
	  }
	| {
			type: 'tool';
			id: string;
			title?: string;
			status?: string;
			toolKind?: string;
			details?: StreamToolDetails;
			delegation?: import('@/shared/subagents').SubagentDisplay;
			approvalOnly?: true;
			history?: {
				outcome: 'unknown' | 'completed' | 'failed' | 'interrupted';
			};
	  }
	| {type: 'permission'; request: PermissionRequestInfo}
	| {type: 'permission-closed'; id: string}
) & {metadata?: StreamMetadata};

export type StopReason =
	| 'end_turn'
	| 'max_tokens'
	| 'max_turn_requests'
	| 'refusal'
	| 'cancelled';

export interface TurnResult {
	stopReason: StopReason;
}

export type DefaultMode = Exclude<NanocoderMode, 'yolo'>;

export interface DesktopSettings {
	publicBrowsingEnabled: boolean;
	defaultMode: DefaultMode;
	editor: 'system' | 'code' | 'cursor' | 'zed';
	nanocoderOverridePath: string | null;
	theme: 'dark' | 'light' | 'system';
	// Main-only: profiles are created and assigned through the browser calls.
	browserProfiles: Array<{id: string; name: string}>;
	browserAssignments: Record<string, string>;
	// Lets Nanocoder's own browser tool run in desktop sessions (BRW-18).
	nanocoderBrowserEnabled: boolean;
	// Main-only: sites are added only by the user's answer to the agent's question (DEC-50).
	browserAllowedSites: string[];
}

// Runtime paths are chosen in main, not supplied by a renderer.
export type SettingsPatch = Partial<
	Omit<
		DesktopSettings,
		| 'nanocoderOverridePath'
		| 'browserProfiles'
		| 'browserAssignments'
		| 'browserAllowedSites'
	>
>;

export interface UiState {
	window: {
		width: number;
		height: number;
		x: number | null;
		y: number | null;
		maximised: boolean;
	};
	activeProjectId: string | null;
	activeThreadId: string | null;
	openThreadIds: string[];
	inspector: 'files' | 'review' | 'browser' | null;
	bottomPanel: 'terminal' | 'browser' | null;
}

export type UiStatePatch = Partial<UiState>;

export interface ProjectInfo {
	id: string;
	canonicalRoot: string;
	sessionCwd: string;
	displayName: string;
	trusted: boolean;
	defaultMode: DefaultMode;
	lastOpenedAt: string;
	createdAt: string;
	availability: 'available' | 'missing' | 'changed';
}

export type ProjectChoiceResult =
	| {status: 'selected'; project: ProjectInfo}
	| {status: 'cancelled'};

export type ProjectOpenResult =
	| {status: 'opened'; project: ProjectInfo; supervisor: SupervisorState}
	| {status: 'untrusted'; message: string}
	| {status: 'cancelled'};

export type CapabilityGate =
	| {enabled: true; reason: null}
	| {enabled: false; reason: string};

export interface ProjectConfigSelect {
	id: 'provider' | 'model';
	name: string;
	currentValue: string;
	options: Array<{name: string; value: string}>;
}

// What a model change reaches: this thread's session only, or every thread in the project's process (ACP-14).
export type ModelScope = 'thread' | 'project';

export interface ProjectControls {
	projectId: string;
	revision: string;
	configOptions: ProjectConfigSelect[];
	modelGate: CapabilityGate;
	modelScope: ModelScope;
	// The thread whose session the options describe; null while none does (ACP-14).
	threadId: string | null;
}

export type FeatureId =
	| 'resume'
	| 'close'
	| 'delete'
	| 'list'
	| 'rename'
	| 'timeline'
	| 'pinSession'
	| 'agentChanges'
	| 'browserControl'
	| 'nanocoderBrowserOff'
	| 'subagentTree';

export type VersionPolicyResult =
	| {status: 'supported' | 'bundled'; version: string; reason: null}
	| {status: 'untested'; version: string; reason: string}
	| {status: 'refused'; version: string | null; reason: string};

export interface CapabilityGates {
	projectId: string;
	versionPolicy: VersionPolicyResult;
	features: Record<FeatureId, CapabilityGate>;
}

export interface SupervisorState {
	projectId: string;
	status:
		| 'stopped'
		| 'starting'
		| 'ready'
		| 'stopping'
		| 'failed'
		| 'untrusted'
		| 'unsupported';
	reason: string | null;
	runtime: NanocoderRuntime | null;
	agent: ConnectedAgent | null;
	gates: CapabilityGates | null;
	activeThreadId: string | null;
	exit: {code: number | null; signal: string | null} | null;
	restart: {attempt: number; limit: number; nextAttemptAt: string | null};
}

// A bounded, redacted in-memory view, never a log or an automatic export.
export interface DiagnosticsSnapshot {
	id: string;
	projectId: string;
	lines: string[];
	truncated: boolean;
}

// What a project needs from the user, for the rail marker and notifications (CHAT-22).
export type ProjectActivityStatus =
	| 'idle'
	| 'running'
	| 'needs-approval'
	| 'finished'
	| 'failed';

export type ThreadRunState =
	| 'new'
	| 'ready'
	| 'running'
	| 'waiting-approval'
	| 'interrupted'
	| 'failed'
	| 'view-only';

export interface ThreadInfo {
	id: string;
	projectId: string;
	nanocoderSessionId: string | null;
	title: string;
	archiveState: 'active' | 'archived';
	runState: ThreadRunState;
	lastActivityAt: string;
	sessionCwd: string;
	mode: NanocoderMode;
	viewOnlyReason: string | null;
}

export interface ThreadSnapshot {
	thread: ThreadInfo;
	sequence: number;
	replaying: boolean;
	replayEpoch?: string;
	events: TurnEvent[];
	result?: IpcResult<TurnResult>;
}

export interface ThreadReplay {
	epoch: string;
	phase: 'begin' | 'complete' | 'failed';
}

export interface DiscoveredSession {
	id: string;
	title: string;
	sessionCwd: string;
	lastActivityAt: string | null;
}

// Context sent with the next prompt only. It is read in main, passed on, and
// never stored (CHAT-16).
export type PromptAttachment =
	| {kind: 'file'; path: string}
	// Main reads the real address and title; this only names the page that was shown.
	| {kind: 'browser-page'; url: string}
	| {
			kind: 'review-comment';
			path: string;
			startLine: number;
			endLine: number;
			side: 'staged' | 'unstaged';
			comment: string;
			excerpt: string;
	  };

export interface ProjectRequest {
	projectId: string;
}

export interface ThreadRequest extends ProjectRequest {
	threadId: string;
}

export interface WorkspaceRequests {
	getSettings: Record<string, never>;
	updateSettings: {patch: SettingsPatch};
	getUiState: Record<string, never>;
	updateUiState: {patch: UiStatePatch};
	listProjects: Record<string, never>;
	addProject: Record<string, never>;
	openProject: ProjectRequest;
	locateProject: ProjectRequest;
	removeProject: ProjectRequest;
	setProjectDefaultMode: ProjectRequest & {mode: DefaultMode};
	getProjectControls: ProjectRequest;
	setProjectConfigOption: ProjectRequest & {
		revision: string;
		configId: 'provider' | 'model';
		value: string;
	};
	getSupervisorState: ProjectRequest;
	startProject: ProjectRequest;
	stopProject: ProjectRequest;
	restartProject: ProjectRequest;
	getCapabilityGates: ProjectRequest;
	getDiagnostics: ProjectRequest;
	exportDiagnostics: ProjectRequest & {snapshotId: string};
	listThreads: ProjectRequest & {archiveState: 'active' | 'archived'};
	getRetentionWarnings: Record<string, never>;
	createThread: ProjectRequest;
	openThread: ThreadRequest;
	getThreadSnapshot: ThreadRequest;
	renameThread: ThreadRequest & {title: string};
	archiveThread: ThreadRequest & {archived: boolean};
	removeThread: ThreadRequest;
	deleteThreadHistory: ThreadRequest;
	promptThread: ThreadRequest & {
		text: string;
		attachments?: PromptAttachment[];
	};
	cancelThread: ThreadRequest;
	setThreadMode: ThreadRequest & {mode: NanocoderMode};
	answerThreadPermission: ThreadRequest & {requestId: string; optionId: string};
	discoverSessions: ProjectRequest;
	importSession: ProjectRequest & {sessionId: string};
}

export interface WorkspaceValues {
	getSettings: DesktopSettings;
	updateSettings: DesktopSettings;
	getUiState: UiState;
	updateUiState: UiState;
	listProjects: ProjectInfo[];
	addProject: ProjectChoiceResult;
	openProject: ProjectOpenResult;
	locateProject: ProjectChoiceResult;
	removeProject: null;
	setProjectDefaultMode: ProjectInfo;
	getProjectControls: ProjectControls;
	setProjectConfigOption: ProjectControls;
	getSupervisorState: SupervisorState;
	startProject: SupervisorState;
	stopProject: SupervisorState;
	restartProject: SupervisorState;
	getCapabilityGates: CapabilityGates;
	getDiagnostics: DiagnosticsSnapshot;
	exportDiagnostics: {status: 'exported' | 'cancelled'};
	listThreads: ThreadInfo[];
	getRetentionWarnings: RetentionWarnings;
	createThread: ThreadInfo;
	openThread: ThreadSnapshot;
	getThreadSnapshot: ThreadSnapshot;
	renameThread: ThreadInfo;
	archiveThread: ThreadInfo;
	removeThread: null;
	deleteThreadHistory: {status: 'deleted' | 'cancelled'};
	promptThread: TurnResult;
	cancelThread: null;
	setThreadMode: ThreadInfo;
	answerThreadPermission: null;
	discoverSessions: DiscoveredSession[];
	importSession: ThreadInfo;
}

export type WorkspaceMethod = keyof WorkspaceRequests;

// Project sequences cover state changes; thread sequences cover transient chat only.
export type ProjectEvent =
	| ProjectsChangedEvent
	| {
			type: 'project-controls';
			projectId: string;
			sequence: number;
			controls: ProjectControls;
	  }
	| {
			type: 'project';
			projectId: string;
			sequence: number;
			project: ProjectInfo;
	  }
	| {type: 'project-removed'; projectId: string; sequence: number}
	| {
			type: 'thread-removed';
			projectId: string;
			threadId: string;
			sequence: number;
	  }
	| {
			type: 'supervisor';
			projectId: string;
			sequence: number;
			state: SupervisorState;
	  }
	| {
			type: 'capabilities';
			projectId: string;
			sequence: number;
			gates: CapabilityGates;
	  }
	| {type: 'thread'; projectId: string; sequence: number; thread: ThreadInfo}
	| {
			type: 'project-activity';
			projectId: string;
			sequence: number;
			status: ProjectActivityStatus;
	  }
	// Main asks the window to open a project, for example after a notification click.
	| {type: 'project-requested'; projectId: string; sequence: number}
	| {
			type: 'turn';
			projectId: string;
			threadId: string;
			sequence: number;
			events: TurnEvent[];
			result?: IpcResult<TurnResult>;
			replay?: ThreadReplay;
	  };
