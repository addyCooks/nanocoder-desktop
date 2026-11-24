import type {AgentRunRepository} from '@/main/store/agent-runs';
import type {ThreadHistoryRepository} from '@/main/store/thread-execution-identities';
import type {
	DesktopSettings,
	ProjectInfo,
	ThreadInfo,
	UiState,
	UiStatePatch,
} from '@/shared/ipc';

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface SqlStatement {
	run(...values: SqlValue[]): {changes: number | bigint};
	get(...values: SqlValue[]): Record<string, SqlValue> | undefined;
	all(...values: SqlValue[]): Record<string, SqlValue>[];
}

// No node:sqlite or better-sqlite3 types cross this seam (DEC-04).
export interface SqlDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqlStatement;
	close(): void;
}

export interface SqlDriver {
	open(absolutePath: string): SqlDatabase;
	backup(database: SqlDatabase, absolutePath: string): Promise<void>;
}

export interface StoreOptions {
	databasePath: string;
	driver: SqlDriver;
}

export interface ProjectRepository {
	list(): ProjectInfo[];
	get(id: string): ProjectInfo | undefined;
	save(project: ProjectInfo): void;
	remove(id: string): void;
}

export interface ThreadRepository {
	list(
		projectId: string,
		archiveState: ThreadInfo['archiveState'],
	): ThreadInfo[];
	get(projectId: string, threadId: string): ThreadInfo | undefined;
	getBySessionId(sessionId: string): ThreadInfo | undefined;
	getTitleManuallySet(projectId: string, threadId: string): boolean | undefined;
	setTitle(input: {
		projectId: string;
		threadId: string;
		title: string;
		manuallySet: boolean;
	}): ThreadInfo;
	save(thread: ThreadInfo): void;
	remove(projectId: string, threadId: string): void;
	setSessionPinned(projectId: string, threadId: string, pinned: boolean): void;
	getSessionPinned(projectId: string, threadId: string): boolean | undefined;
	listUnpinnedSessions(): ThreadRetentionRow[];
}

// What the retention warning needs of a thread whose saved session Nanocoder may delete (CHAT-23).
export interface ThreadRetentionRow {
	projectId: string;
	threadId: string;
	title: string;
	lastActivityAt: string;
}

// The limits Nanocoder last reported for its session store (DEC-45).
export interface RetentionLimits {
	days: number;
	maxSessions: number;
}

export interface RetentionRepository {
	get(): RetentionLimits | undefined;
	set(limits: RetentionLimits): void;
}

export interface DesktopStore {
	getSettings(): DesktopSettings;
	updateSettings(patch: Partial<DesktopSettings>): DesktopSettings;
	getUiState(): UiState;
	updateUiState(patch: UiStatePatch): UiState;
	projects: ProjectRepository;
	threads: ThreadRepository;
	threadHistory: ThreadHistoryRepository;
	agentRuns: AgentRunRepository;
	retention: RetentionRepository;
	// Set when the database could not be read and was moved aside, so the user can be told.
	recoveredFrom?: string;
	close(): void;
}

export interface DesktopStoreFactory {
	open(options: StoreOptions): Promise<DesktopStore>;
}
