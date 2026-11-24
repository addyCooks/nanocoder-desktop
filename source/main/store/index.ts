import {realpathSync, statSync} from 'node:fs';
import {IpcFailure} from '@/main/ipc/handle-request';
import {agentRunRepository} from '@/main/store/agent-runs';
import type {
	DesktopStore,
	DesktopStoreFactory,
	SqlDatabase,
	StoreOptions,
} from '@/main/store/contracts';
import {
	migrate,
	migrations,
	schemaVersion,
	transaction,
} from '@/main/store/migrations';
import {
	prepareDatabasePath,
	quarantineDatabase,
	reserveBackupPath,
} from '@/main/store/paths';
import {repositories} from '@/main/store/repositories';
import {threadHistoryRepository} from '@/main/store/thread-execution-identities';
import {
	retentionLimitsSchema,
	settingsSchema,
	uiPatch,
	uiSchema,
	validate,
} from '@/main/store/validation';
import type {DesktopSettings, UiState} from '@/shared/ipc';

const defaultSettings: DesktopSettings = {
	publicBrowsingEnabled: false,
	defaultMode: 'normal',
	editor: 'system',
	nanocoderOverridePath: null,
	theme: 'dark',
	browserProfiles: [],
	browserAssignments: {},
	// Off by default, so desktop sessions have one browser, under the desktop's rules (DEC-48).
	nanocoderBrowserEnabled: false,
	browserAllowedSites: [],
};
const defaultUiState: UiState = {
	window: {width: 1020, height: 720, x: null, y: null, maximised: false},
	activeProjectId: null,
	activeThreadId: null,
	openThreadIds: [],
	inspector: null,
	bottomPanel: null,
};

function parseJson(value: unknown): unknown {
	try {
		if (typeof value === 'string') return JSON.parse(value);
	} catch {}
	throw new IpcFailure('STORE_CORRUPT', 'The desktop metadata is invalid');
}

function createStore(
	database: SqlDatabase,
	recoveredFrom?: string,
): DesktopStore {
	const getSettings = (): DesktopSettings => {
		const settings: Record<string, unknown> = {...defaultSettings};
		for (const row of database
			.prepare('SELECT key, value FROM setting')
			.all()) {
			settings[String(row.key)] = parseJson(row.value);
		}
		return validate(settingsSchema, settings);
	};
	const getUiState = (): UiState => {
		const row = database
			.prepare('SELECT value FROM ui_state WHERE id = 1')
			.get();
		return validate(
			uiSchema,
			row ? parseJson(row.value) : structuredClone(defaultUiState),
		);
	};
	let closed = false;
	return {
		...repositories(database),
		recoveredFrom,
		threadHistory: threadHistoryRepository(database),
		agentRuns: agentRunRepository(database),
		retention: {
			get: () => {
				const row = database
					.prepare(
						'SELECT retention_days, max_sessions FROM nanocoder_retention WHERE id = 1',
					)
					.get();
				return row
					? {
							days: Number(row.retention_days),
							maxSessions: Number(row.max_sessions),
						}
					: undefined;
			},
			set: limits => {
				const valid = validate(retentionLimitsSchema, limits);
				database
					.prepare(`
					INSERT INTO nanocoder_retention (id, retention_days, max_sessions) VALUES (1, ?, ?)
					ON CONFLICT(id) DO UPDATE SET
						retention_days = excluded.retention_days, max_sessions = excluded.max_sessions
				`)
					.run(valid.days, valid.maxSessions);
			},
		},
		getSettings,
		updateSettings: patch =>
			transaction(database, () => {
				const previous = getSettings();
				const settings = validate(settingsSchema, {...previous, ...patch});
				if (
					settings.nanocoderOverridePath !== null &&
					settings.nanocoderOverridePath !== previous.nanocoderOverridePath
				) {
					try {
						settings.nanocoderOverridePath = realpathSync.native(
							settings.nanocoderOverridePath,
						);
						if (!statSync(settings.nanocoderOverridePath).isFile())
							throw new Error();
					} catch {
						throw new IpcFailure(
							'VALIDATION',
							'Choose an available Nanocoder file',
						);
					}
				}
				const statement = database.prepare(
					'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
				);
				for (const [key, value] of Object.entries(settings)) {
					statement.run(key, JSON.stringify(value));
				}
				return settings;
			}),
		getUiState,
		updateUiState: patch =>
			transaction(database, () => {
				const parsed = validate(uiPatch, patch);
				const state = validate(uiSchema, {...getUiState(), ...parsed});
				database
					.prepare(
						'INSERT INTO ui_state (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
					)
					.run(JSON.stringify(state));
				return state;
			}),
		close: () => {
			if (closed) return;
			database.close();
			closed = true;
		},
	};
}

async function openStore(options: StoreOptions): Promise<DesktopStore> {
	let database: SqlDatabase | undefined;
	try {
		let {filename, existed} = prepareDatabasePath(options.databasePath);
		let version: number;
		let recoveredFrom: string | undefined;
		try {
			database = options.driver.open(filename);
			const opened = database;
			version = transaction(
				opened,
				() => {
					const current = schemaVersion(opened);
					const result = opened.prepare('PRAGMA integrity_check').all();
					if (result.length !== 1 || result[0].integrity_check !== 'ok') {
						throw new IpcFailure(
							'STORE_CORRUPT',
							'The database integrity check failed',
						);
					}
					return current;
				},
				'read',
			);
		} catch (error) {
			if (!(error instanceof IpcFailure) || error.code !== 'STORE_CORRUPT')
				throw error;
			database?.close();
			database = undefined;
			recoveredFrom = quarantineDatabase(filename);
			({filename, existed} = prepareDatabasePath(filename));
			database = options.driver.open(filename);
			version = 0;
		}
		if (version < migrations.length) {
			if (existed) {
				await options.driver.backup(database, reserveBackupPath(filename));
			}
			migrate(database);
		}
		database.exec('PRAGMA foreign_keys = ON');
		database.exec('PRAGMA journal_mode = WAL');
		database
			.prepare(
				"UPDATE thread SET run_state = 'interrupted' WHERE run_state IN ('running', 'waiting-approval')",
			)
			.run();
		return createStore(database, recoveredFrom);
	} catch (error) {
		database?.close();
		if (error instanceof IpcFailure) throw error;
		throw new IpcFailure(
			'INTERNAL',
			'The desktop database could not be opened',
		);
	}
}

export const desktopStoreFactory: DesktopStoreFactory = {open: openStore};
