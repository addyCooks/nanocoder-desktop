import {realpathSync, statSync} from 'node:fs';
import path from 'node:path';
import {IpcFailure} from '@/main/ipc/handle-request';
import type {
	ProjectRepository,
	SqlDatabase,
	SqlValue,
	ThreadRepository,
} from '@/main/store/contracts';
import {
	nanocoderSessionIdSchema,
	projectSchema,
	threadSchema,
	threadTitlePatch,
	threadTitleTarget,
	validate,
} from '@/main/store/validation';
import type {ProjectInfo, ThreadInfo} from '@/shared/ipc';

function availability(
	root: string,
	folder = false,
): ProjectInfo['availability'] {
	try {
		// A project root that became a file is a changed folder, not an available one.
		if (folder && !statSync(root).isDirectory()) return 'changed';
		return realpathSync.native(root) === root ? 'available' : 'changed';
	} catch {
		return 'missing';
	}
}

function projectFrom(row: Record<string, SqlValue>): ProjectInfo {
	return validate(projectSchema, {
		id: row.id,
		canonicalRoot: row.canonical_root,
		sessionCwd: row.session_cwd,
		displayName: row.display_name,
		trusted: row.trusted === 1,
		defaultMode: row.default_mode,
		lastOpenedAt: row.last_opened_at,
		createdAt: row.created_at,
		availability: availability(String(row.canonical_root), true),
	});
}

function threadFrom(row: Record<string, SqlValue>): ThreadInfo {
	return validate(threadSchema, {
		id: row.id,
		projectId: row.project_id,
		nanocoderSessionId: row.nanocoder_session_id,
		title: row.title,
		archiveState: row.archive_state,
		runState: row.run_state,
		lastActivityAt: row.last_activity_at,
		sessionCwd: row.session_cwd,
		mode: row.mode,
		viewOnlyReason: row.view_only_reason,
	});
}

function requireCanonical(filename: string): void {
	if (availability(filename) === 'available') return;
	throw new IpcFailure(
		'DENIED',
		'The metadata path must be canonical and available',
	);
}

export function repositories(database: SqlDatabase): {
	projects: ProjectRepository;
	threads: ThreadRepository;
} {
	const projects: ProjectRepository = {
		list: () =>
			database
				.prepare(
					'SELECT * FROM project ORDER BY julianday(last_opened_at) DESC, id',
				)
				.all()
				.map(projectFrom),
		get: id => {
			const row = database
				.prepare('SELECT * FROM project WHERE id = ?')
				.get(id);
			return row && projectFrom(row);
		},
		save: input => {
			const project = validate(projectSchema, input);
			const existing = projects.get(project.id);
			if (
				!existing ||
				existing.canonicalRoot !== project.canonicalRoot ||
				existing.sessionCwd !== project.sessionCwd ||
				(!existing.trusted && project.trusted)
			) {
				requireCanonical(project.canonicalRoot);
			}
			if (project.sessionCwd !== project.canonicalRoot) {
				throw new IpcFailure(
					'OUTSIDE_ROOT',
					'The project session must use its root',
				);
			}
			database
				.prepare(`
				INSERT INTO project (
					id, canonical_root, session_cwd, display_name, trusted, default_mode,
					last_opened_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					canonical_root = excluded.canonical_root, session_cwd = excluded.session_cwd,
					display_name = excluded.display_name, trusted = excluded.trusted,
					default_mode = excluded.default_mode, last_opened_at = excluded.last_opened_at
			`)
				.run(
					project.id,
					project.canonicalRoot,
					project.sessionCwd,
					project.displayName,
					Number(project.trusted),
					project.defaultMode,
					project.lastOpenedAt,
					project.createdAt,
				);
		},
		remove: id => {
			database.prepare('DELETE FROM project WHERE id = ?').run(id);
		},
	};
	const threads: ThreadRepository = {
		getBySessionId: sessionId => {
			const id = validate(nanocoderSessionIdSchema, sessionId);
			const row = database
				.prepare('SELECT * FROM thread WHERE nanocoder_session_id = ?')
				.get(id);
			return row && threadFrom(row);
		},
		setTitle: input => {
			const patch = validate(threadTitlePatch, input);
			database
				.prepare(`
				UPDATE thread SET title = ?, title_manually_set = ?
				WHERE project_id = ? AND id = ?
					AND (title_manually_set = 0 OR ? = 1)
			`)
				.run(
					patch.title,
					Number(patch.manuallySet),
					patch.projectId,
					patch.threadId,
					Number(patch.manuallySet),
				);
			const thread = threads.get(patch.projectId, patch.threadId);
			if (!thread) throw new IpcFailure('NOT_FOUND', 'Thread not found');
			return thread;
		},
		getTitleManuallySet: (projectId, threadId) => {
			validate(threadTitleTarget, {projectId, threadId});
			const row = database
				.prepare(
					'SELECT title_manually_set FROM thread WHERE project_id = ? AND id = ?',
				)
				.get(projectId, threadId);
			if (!row) return undefined;
			if (row.title_manually_set === 1) return true;
			if (row.title_manually_set === 0) return false;
			throw new IpcFailure(
				'STORE_CORRUPT',
				'The thread title metadata is invalid',
			);
		},
		list: (projectId, archiveState) =>
			database
				.prepare(`
			SELECT * FROM thread WHERE project_id = ? AND archive_state = ?
			ORDER BY julianday(last_activity_at) DESC, id
		`)
				.all(projectId, archiveState)
				.map(threadFrom),
		get: (projectId, threadId) => {
			const row = database
				.prepare('SELECT * FROM thread WHERE project_id = ? AND id = ?')
				.get(projectId, threadId);
			return row && threadFrom(row);
		},
		save: input => {
			const thread = validate(threadSchema, input);
			const project = projects.get(thread.projectId);
			if (!project) throw new IpcFailure('NOT_FOUND', 'Project not found');
			const existing = database
				.prepare('SELECT project_id, session_cwd FROM thread WHERE id = ?')
				.get(thread.id);
			if (existing && existing.project_id !== thread.projectId) {
				throw new IpcFailure('DENIED', 'A thread cannot move between projects');
			}
			if (!existing || existing.session_cwd !== thread.sessionCwd) {
				requireCanonical(thread.sessionCwd);
				const relative = path.relative(
					project.canonicalRoot,
					thread.sessionCwd,
				);
				if (
					relative === '..' ||
					relative.startsWith(`..${path.sep}`) ||
					path.isAbsolute(relative)
				) {
					throw new IpcFailure(
						'OUTSIDE_ROOT',
						'The thread session is outside its project',
					);
				}
			}
			database
				.prepare(`
				INSERT INTO thread (
					id, project_id, nanocoder_session_id, title, archive_state, run_state,
					last_activity_at, session_cwd, mode, view_only_reason
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					nanocoder_session_id = excluded.nanocoder_session_id, title = excluded.title,
					archive_state = excluded.archive_state, run_state = excluded.run_state,
					last_activity_at = excluded.last_activity_at, session_cwd = excluded.session_cwd,
					mode = excluded.mode, view_only_reason = excluded.view_only_reason
			`)
				.run(
					thread.id,
					thread.projectId,
					thread.nanocoderSessionId,
					thread.title,
					thread.archiveState,
					thread.runState,
					thread.lastActivityAt,
					thread.sessionCwd,
					thread.mode === 'yolo' ? project.defaultMode : thread.mode,
					thread.viewOnlyReason,
				);
		},
		remove: (projectId, threadId) => {
			database
				.prepare('DELETE FROM thread WHERE project_id = ? AND id = ?')
				.run(projectId, threadId);
		},
		setSessionPinned: (projectId, threadId, pinned) => {
			validate(threadTitleTarget, {projectId, threadId});
			const changed = database
				.prepare(
					'UPDATE thread SET session_pinned = ? WHERE project_id = ? AND id = ? AND nanocoder_session_id IS NOT NULL',
				)
				.run(Number(pinned === true), projectId, threadId);
			if (Number(changed.changes) === 0)
				throw new IpcFailure('NOT_FOUND', 'Thread not found');
		},
		getSessionPinned: (projectId, threadId) => {
			validate(threadTitleTarget, {projectId, threadId});
			const row = database
				.prepare(
					'SELECT session_pinned FROM thread WHERE project_id = ? AND id = ?',
				)
				.get(projectId, threadId);
			return row ? row.session_pinned === 1 : undefined;
		},
		listUnpinnedSessions: () =>
			database
				.prepare(`
			SELECT project_id, id, title, last_activity_at FROM thread
			WHERE nanocoder_session_id IS NOT NULL AND session_pinned = 0
				AND archive_state = 'active' AND run_state != 'view-only'
			ORDER BY julianday(last_activity_at), id
			LIMIT 5000
		`)
				.all()
				.map(row => ({
					projectId: String(row.project_id),
					threadId: String(row.id),
					title: String(row.title),
					lastActivityAt: String(row.last_activity_at),
				})),
	};
	return {projects, threads};
}
