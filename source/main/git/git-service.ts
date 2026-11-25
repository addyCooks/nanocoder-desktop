import {refuseGitFolder} from '@/main/files/file-service';
import {FILE_LIMITS} from '@/main/files/limits';
import {authorisedRoot} from '@/main/files/project-access';
import {relativeSegments, resolveInside} from '@/main/files/safe-path';
import {type GitInstall, type GitLookup, locateGit} from '@/main/git/locate';
import {type GitRunner, runGit} from '@/main/git/run';
import {type ParsedEntry, parseStatus} from '@/main/git/status-parser';
import {IpcFailure} from '@/main/ipc/handle-request';
import type {ProjectInfo} from '@/shared/ipc';
import type {
	ReviewDiff,
	ReviewEntry,
	ReviewMark,
	TurnCommit,
} from '@/shared/review';

export const GIT_LIMITS = {
	statusMilliseconds: 5_000,
	statusBytes: 64 * 1_048_576,
	listedChanges: 5_000,
	diffBytes: 1_048_576,
	diffMilliseconds: 5_000,
	commits: 50,
} as const;

export type GitStatus =
	| {available: false; reason: string}
	| {
			available: true;
			git: GitInstall;
			head: string | null;
			branch: string | null;
			entries: Omit<ReviewEntry, 'touched'>[];
			ignored: string[];
			notShown: number;
	  };

export interface GitServiceOptions {
	project(projectId: string): ProjectInfo | undefined;
	roots(): readonly string[];
	run?: GitRunner;
	locate?(): Promise<GitLookup>;
	// Content of an untracked file, which Git cannot diff (GIT-04).
	readUntracked?(
		project: ProjectInfo,
		path: string,
	): Promise<{kind: 'text'; text: string} | {kind: 'other'; reason: string}>;
	// Without a working watch the cache expires on its own.
	watchState?(projectId: string): 'active' | 'limited';
	now?(): number;
}

interface Cached {
	status: GitStatus;
	at: number;
}

// 'The Git folder is owned by someone else': Git's own refusal, not ours to override.
const OWNERSHIP = /dubious ownership|unsafe repository/iu;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/gu;

export class GitService {
	private readonly cache = new Map<string, Cached>();
	private readonly pending = new Map<string, Promise<GitStatus>>();
	private lookup: {at: number; value: GitLookup} | undefined;

	constructor(private readonly options: GitServiceOptions) {}

	private run(): GitRunner {
		return this.options.run ?? runGit;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	async git(): Promise<GitLookup> {
		const cached = this.lookup;
		// A failed lookup is retried soon, so installing Git needs no restart.
		if (cached && (cached.value.ok || this.now() - cached.at < 30_000))
			return cached.value;
		const value = await (
			this.options.locate ??
			(() => locateGit({roots: this.options.roots, run: this.run()}))
		)();
		this.lookup = {at: this.now(), value};
		return value;
	}

	invalidate(projectId: string): void {
		this.cache.delete(projectId);
	}

	async status(projectId: string): Promise<GitStatus> {
		const project = this.options.project(projectId);
		const root = await authorisedRoot(project);
		const cached = this.cache.get(projectId);
		const limited = this.options.watchState?.(projectId) === 'limited';
		if (cached && (!limited || this.now() - cached.at < 3_000))
			return cached.status;
		const running = this.pending.get(projectId);
		if (running) return running;
		const work = this.scan(root).then(
			status => {
				this.cache.set(projectId, {status, at: this.now()});
				this.pending.delete(projectId);
				return status;
			},
			error => {
				this.pending.delete(projectId);
				throw error;
			},
		);
		this.pending.set(projectId, work);
		return work;
	}

	private async scan(root: string): Promise<GitStatus> {
		const found = await this.git();
		if (!found.ok) return {available: false, reason: found.reason};
		const run = {
			git: found.git.path,
			cwd: root,
			timeoutMs: GIT_LIMITS.statusMilliseconds,
			maxBytes: GIT_LIMITS.statusBytes,
		};
		const inside = await this.run()(run, [
			'rev-parse',
			'--is-inside-work-tree',
			'--show-prefix',
		]);
		if (inside.code !== 0) {
			return {
				available: false,
				reason: OWNERSHIP.test(inside.stderr)
					? "Git does not trust this folder's owner, so review is unavailable"
					: 'This folder is not a Git repository, so review is unavailable',
			};
		}
		const [flag, prefix = ''] = inside.stdout.toString('utf8').split('\n');
		if (flag !== 'true')
			return {
				available: false,
				reason:
					'This folder is not inside a Git work tree, so review is unavailable',
			};
		const output = await this.run()(run, [
			'status',
			'--porcelain=v2',
			'-z',
			'--branch',
			'--untracked-files=all',
			'--ignored=matching',
			...(prefix ? ['--', '.'] : []),
		]).catch((error: unknown) => {
			if (error instanceof IpcFailure && error.code === 'LIMIT')
				throw new IpcFailure(
					'LIMIT',
					'The repository is too large to scan',
					true,
				);
			throw error;
		});
		if (output.code !== 0)
			return {
				available: false,
				reason: OWNERSHIP.test(output.stderr)
					? "Git does not trust this folder's owner, so review is unavailable"
					: 'Git could not read the repository status',
			};
		const parsed = parseStatus(output.stdout);
		const inPrefix = (path: string) => !prefix || path.startsWith(prefix);
		const strip = (path: string) => (prefix ? path.slice(prefix.length) : path);
		const all = parsed.entries
			.filter(entry => inPrefix(entry.path))
			.map(
				(entry: ParsedEntry): Omit<ReviewEntry, 'touched'> => ({
					...entry,
					path: strip(entry.path),
					oldPath:
						entry.oldPath && inPrefix(entry.oldPath)
							? strip(entry.oldPath)
							: entry.oldPath,
				}),
			)
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		return {
			available: true,
			git: found.git,
			head: parsed.head,
			branch: parsed.branch,
			entries: all.slice(0, GIT_LIMITS.listedChanges),
			ignored: parsed.ignored.filter(inPrefix).map(strip),
			notShown: Math.max(0, all.length - GIT_LIMITS.listedChanges),
		};
	}

	// Marks for the entries of one directory: a changed file shows its own state,
	// a folder shows that something inside it changed, ignored paths say so.
	async marks(
		project: ProjectInfo,
		directory: string,
	): Promise<Map<string, ReviewMark>> {
		const result = new Map<string, ReviewMark>();
		const status = await this.status(project.id);
		if (!status.available) return result;
		const base = directory ? `${directory}/` : '';
		for (const ignored of status.ignored) {
			const clean = ignored.replace(/\/$/u, '');
			if (base.startsWith(`${clean}/`)) {
				// The whole folder is ignored: everything inside it is too.
				return new EverythingIgnored();
			}
			if (!clean.startsWith(base)) continue;
			const name = clean.slice(base.length).split('/')[0];
			if (name && !clean.slice(base.length).includes('/'))
				result.set(name, 'ignored');
		}
		for (const entry of status.entries) {
			if (!entry.path.startsWith(base)) continue;
			const rest = entry.path.slice(base.length);
			const [name, ...deeper] = rest.split('/');
			const mark = entryMark(entry);
			if (deeper.length) {
				if (!result.has(name)) result.set(name, 'modified');
			} else result.set(name, mark);
		}
		return result;
	}

	async head(projectId: string): Promise<string | null> {
		const root = await authorisedRoot(this.options.project(projectId));
		const found = await this.git();
		if (!found.ok) return null;
		const result = await this.run()(
			{git: found.git.path, cwd: root, timeoutMs: 5_000, maxBytes: 4_096},
			['rev-parse', '--verify', '-q', 'HEAD'],
		).catch(() => undefined);
		const hash = result?.stdout.toString('utf8').trim();
		return result?.code === 0 && hash && /^[0-9a-f]{40,64}$/u.test(hash)
			? hash
			: null;
	}

	async commits(
		projectId: string,
		before: string | null,
		after: string | null,
	): Promise<TurnCommit[]> {
		if (!after || before === after) return [];
		const root = await authorisedRoot(this.options.project(projectId));
		const found = await this.git();
		if (!found.ok) return [];
		const result = await this.run()(
			{git: found.git.path, cwd: root, timeoutMs: 5_000, maxBytes: 1_048_576},
			[
				'log',
				`-n${GIT_LIMITS.commits}`,
				'--format=%H%x00%s',
				'-z',
				before ? `${before}..${after}` : after,
				'--',
			],
		).catch(() => undefined);
		if (!result || result.code !== 0) return [];
		const fields = result.stdout
			.toString('utf8')
			.split('\u0000')
			.filter(Boolean);
		const commits: TurnCommit[] = [];
		for (let index = 0; index + 1 < fields.length; index += 2)
			commits.push({hash: fields[index].trim(), subject: fields[index + 1]});
		return commits;
	}

	async diff(
		projectId: string,
		input: string,
		staged: boolean,
	): Promise<ReviewDiff> {
		const project = this.options.project(projectId);
		const root = await authorisedRoot(project);
		relativeSegments(input);
		if (!input) throw new IpcFailure('VALIDATION', 'Choose a file to compare');
		const status = await this.status(projectId);
		if (!status.available) throw new IpcFailure('UNAVAILABLE', status.reason);
		const entries = status.entries.filter(
			candidate => candidate.path === input,
		);
		const entry =
			entries.find(candidate =>
				staged
					? candidate.staged !== 'none'
					: candidate.unstaged !== 'none' ||
						candidate.untracked ||
						candidate.conflicted,
			) ?? entries[0];
		if (!entry)
			return {
				path: input,
				staged,
				kind: 'none',
				reason: 'This file has no changes.',
			};
		if (entry.untracked && !staged)
			return this.untracked(project as ProjectInfo, input);
		const paths =
			entry.oldPath && entry.oldPath !== input
				? [entry.oldPath, input]
				: [input];
		const result = await this.run()(
			{
				git: status.git.path,
				cwd: root,
				timeoutMs: GIT_LIMITS.diffMilliseconds,
				maxBytes: GIT_LIMITS.diffBytes,
			},
			[
				'diff',
				...(staged ? ['--cached'] : []),
				'--no-ext-diff',
				'--no-textconv',
				'--no-color',
				'-M',
				'--',
				...paths,
			],
		).catch((error: unknown) => {
			if (error instanceof IpcFailure && error.code === 'LIMIT') return error;
			throw error;
		});
		if (result instanceof IpcFailure)
			return {
				path: input,
				staged,
				kind: 'too-large',
				reason:
					'This diff is larger than 1 MiB. Open the file in an editor to review it.',
			};
		if (result.code !== 0)
			throw new IpcFailure('UNAVAILABLE', 'Git could not produce this diff');
		const diff = result.stdout.toString('utf8').replace(ANSI, '');
		if (!diff.trim())
			return {
				path: input,
				staged,
				kind: 'none',
				reason: 'This side has no changes.',
			};
		if (
			/^Binary files .* differ$/mu.test(diff) ||
			/^GIT binary patch$/mu.test(diff)
		)
			return {
				path: input,
				staged,
				kind: 'binary',
				reason: 'This is a binary file, so there is no text diff.',
			};
		return {path: input, staged, kind: 'text', diff, ...countLines(diff)};
	}

	// Compares one file as it is now with text held in memory (GIT-09). The before-image goes to Git on
	// standard input and is never written anywhere; Git still produces the diff (GIT-04).
	async compare(
		projectId: string,
		input: string,
		before: string | null,
	): Promise<ReviewDiff> {
		const project = this.options.project(projectId);
		const root = await authorisedRoot(project);
		const segments = relativeSegments(input);
		if (segments.length === 0)
			throw new IpcFailure('VALIDATION', 'Choose a file to compare');
		refuseGitFolder(segments);
		const found = await this.git();
		if (!found.ok) throw new IpcFailure('UNAVAILABLE', found.reason);
		let current: string | null = null;
		try {
			current = (await resolveInside(root, input)).real;
		} catch (error) {
			if (!(error instanceof IpcFailure) || error.code !== 'NOT_FOUND')
				throw error;
		}
		if (before !== null && Buffer.byteLength(before) > FILE_LIMITS.previewBytes)
			return {
				path: input,
				staged: false,
				kind: 'too-large',
				reason:
					"This file's earlier version is larger than 1 MiB. Open the file in an editor to review it.",
			};
		if (before?.includes('\u0000'))
			return {
				path: input,
				staged: false,
				kind: 'binary',
				reason: 'This is a binary file, so there is no text diff.',
			};
		const label = segments.join('/');
		const result = await this.run()(
			{
				git: found.git.path,
				cwd: root,
				timeoutMs: GIT_LIMITS.diffMilliseconds,
				maxBytes: GIT_LIMITS.diffBytes,
				...(before === null ? {} : {input: before}),
			},
			[
				'diff',
				'--no-index',
				'--no-ext-diff',
				'--no-textconv',
				'--no-color',
				'--',
				before === null ? '/dev/null' : '-',
				current ?? '/dev/null',
			],
		).catch((error: unknown) => {
			if (error instanceof IpcFailure && error.code === 'LIMIT') return error;
			throw error;
		});
		if (result instanceof IpcFailure)
			return {
				path: input,
				staged: false,
				kind: 'too-large',
				reason:
					'This diff is larger than 1 MiB. Open the file in an editor to review it.',
			};
		if (result.code !== 0 && result.code !== 1)
			throw new IpcFailure('UNAVAILABLE', 'Git could not produce this diff');
		const raw = result.stdout.toString('utf8').replace(ANSI, '');
		if (!raw.trim())
			return {
				path: input,
				staged: false,
				kind: 'none',
				reason: 'The agent left this file as it was.',
			};
		if (
			/^Binary files .* differ$/mu.test(raw) ||
			/^GIT binary patch$/mu.test(raw)
		)
			return {
				path: input,
				staged: false,
				kind: 'binary',
				reason: 'This is a binary file, so there is no text diff.',
			};
		const diff = projectHeaders(raw, label, before === null, current === null);
		return {
			path: input,
			staged: false,
			kind: 'text',
			diff,
			...countLines(diff),
		};
	}

	private async untracked(
		project: ProjectInfo,
		input: string,
	): Promise<ReviewDiff> {
		const content = await this.options.readUntracked?.(project, input);
		if (!content || content.kind !== 'text')
			return {
				path: input,
				staged: false,
				kind: content ? 'binary' : 'none',
				reason: content?.reason ?? 'This new file cannot be shown.',
			};
		const lines = content.text.split(/(?<=\n)/u).filter(line => line !== '');
		const body = lines
			.map(line => `+${line.endsWith('\n') ? line.slice(0, -1) : line}`)
			.join('\n');
		const diff = `--- /dev/null\n+++ b/${input}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
		return {
			path: input,
			staged: false,
			kind: 'text',
			diff,
			added: lines.length,
			removed: 0,
		};
	}
}

class EverythingIgnored extends Map<string, ReviewMark> {
	override get(): ReviewMark {
		return 'ignored';
	}
}

function entryMark(entry: Omit<ReviewEntry, 'touched'>): ReviewMark {
	if (entry.conflicted) return 'conflicted';
	if (entry.untracked) return 'untracked';
	if (entry.staged === 'deleted' || entry.unstaged === 'deleted')
		return 'deleted';
	if (entry.staged === 'renamed') return 'renamed';
	if (entry.staged === 'added' && entry.unstaged === 'none') return 'added';
	return 'modified';
}

// Git names the in-memory side `-` and the other by its absolute path; the review shows the project path.
function projectHeaders(
	raw: string,
	label: string,
	created: boolean,
	deleted: boolean,
): string {
	const lines = raw.split('\n');
	const first = lines.findIndex(line => line.startsWith('@@'));
	const head = (first === -1 ? lines : lines.slice(0, first)).flatMap(line => {
		if (line.startsWith('diff --git '))
			return [`diff --git a/${label} b/${label}`];
		if (line.startsWith('index ')) return [];
		if (line.startsWith('--- '))
			return [created ? '--- /dev/null' : `--- a/${label}`];
		if (line.startsWith('+++ '))
			return [deleted ? '+++ /dev/null' : `+++ b/${label}`];
		return [line];
	});
	return [...head, ...(first === -1 ? [] : lines.slice(first))].join('\n');
}

function countLines(diff: string): {added: number; removed: number} {
	let added = 0;
	let removed = 0;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) added++;
		else if (line.startsWith('-') && !line.startsWith('---')) removed++;
	}
	return {added, removed};
}
