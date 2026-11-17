import type {Dirent} from 'node:fs';
import {lstat, opendir, stat} from 'node:fs/promises';
import path from 'node:path';
import {decodeText} from '@/main/files/encoding';
import {FILE_LIMITS} from '@/main/files/limits';
import {authorisedRoot} from '@/main/files/project-access';
import {
	contains,
	openVerified,
	type ResolvedPath,
	relativeSegments,
	resolveInside,
	windowsRefusesName,
} from '@/main/files/safe-path';
import {IpcFailure} from '@/main/ipc/handle-request';
import {canonicalPath} from '@/main/paths';
import type {
	FileEntry,
	FileListing,
	FilePreview,
	PreviewReason,
} from '@/shared/files';
import type {ProjectInfo} from '@/shared/ipc';
import type {ReviewMark} from '@/shared/review';

// One locale for every platform, so the order never differs between machines.
const collator = new Intl.Collator('en', {
	numeric: true,
	sensitivity: 'accent',
});
const compare = (a: string, b: string) =>
	collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

export interface FileServiceOptions {
	project(projectId: string): ProjectInfo | undefined;
	// Git marks for the entries of one directory, when Git is available (FILE-03).
	marks?(
		project: ProjectInfo,
		directory: string,
	): Promise<ReadonlyMap<string, ReviewMark>> | ReadonlyMap<string, ReviewMark>;
	// A directory of this project was listed: start (or keep) watching it.
	opened?(projectId: string, root: string): void;
	watch?(projectId: string): 'active' | 'limited';
	now?(): number;
}

export interface Located {
	root: string;
	project: ProjectInfo;
	resolved: ResolvedPath;
}

// Git's own folder is never browsed: not listed, not previewed.
export function refuseGitFolder(segments: readonly string[]): void {
	if (segments.some(segment => segment.toLowerCase() === '.git'))
		throw new IpcFailure('DENIED', 'The .git folder is not browsable');
}

export class FileService {
	constructor(private readonly options: FileServiceOptions) {}

	async locate(projectId: string, input: string): Promise<Located> {
		const project = this.options.project(projectId);
		const root = await authorisedRoot(project);
		refuseGitFolder(relativeSegments(input));
		const resolved = await resolveInside(root, input);
		// A link can lead into .git without naming it.
		refuseGitFolder(
			path.relative(root, resolved.real).split(path.sep).filter(Boolean),
		);
		return {root, project: project as ProjectInfo, resolved};
	}

	// For a path that may no longer exist, such as a comment on a deleted file:
	// the project must be trusted and unchanged, the path must be valid and not
	// in .git, and the deepest part that still exists must stay inside the root.
	async checkPath(projectId: string, input: string): Promise<void> {
		const root = await authorisedRoot(this.options.project(projectId));
		const segments = relativeSegments(input);
		refuseGitFolder(segments);
		for (let length = segments.length; length >= 0; length--) {
			try {
				const found = await resolveInside(
					root,
					segments.slice(0, length).join('/'),
				);
				refuseGitFolder(
					path.relative(root, found.real).split(path.sep).filter(Boolean),
				);
				return;
			} catch (error) {
				if (error instanceof IpcFailure && error.code === 'NOT_FOUND') continue;
				throw error;
			}
		}
	}

	async list(request: {projectId: string; path: string}): Promise<FileListing> {
		const {root, project, resolved} = await this.locate(
			request.projectId,
			request.path,
		);
		this.options.opened?.(request.projectId, root);
		const now = this.options.now ?? Date.now;
		const started = now();
		const directory = await opendir(resolved.real).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOTDIR')
					throw new IpcFailure('VALIDATION', 'That path is not a folder');
				if (error.code === 'EACCES' || error.code === 'EPERM')
					throw new IpcFailure('DENIED', 'That folder cannot be read');
				throw new IpcFailure('UNAVAILABLE', 'That folder could not be listed');
			},
		);
		const names: Dirent[] = [];
		let scanned = 0;
		let incomplete = false;
		for await (const entry of directory) {
			if (entry.name.toLowerCase() === '.git') continue;
			if (++scanned > FILE_LIMITS.scanEntries) {
				incomplete = true;
				break;
			}
			names.push(entry);
			if (now() - started > FILE_LIMITS.listMilliseconds)
				throw new IpcFailure('LIMIT', 'That folder took too long to list');
		}
		if (incomplete) await directory.close().catch(() => undefined);
		names.sort(
			(a, b) =>
				Number(b.isDirectory()) - Number(a.isDirectory()) ||
				compare(a.name, b.name),
		);
		const kept = names.slice(0, FILE_LIMITS.listEntries);
		const marks = await Promise.resolve(
			this.options.marks?.(project, resolved.relative),
		).catch(() => undefined);
		const entries: FileEntry[] = [];
		for (let index = 0; index < kept.length; index += 64) {
			const chunk = kept.slice(index, index + 64);
			entries.push(
				...(await Promise.all(
					chunk.map(item => classify(root, resolved.real, item, marks)),
				)),
			);
		}
		entries.sort(
			(a, b) =>
				Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
				compare(a.name, b.name),
		);
		return {
			path: resolved.relative,
			entries,
			notShown: Math.max(0, names.length - kept.length),
			incomplete,
			watch: this.options.watch?.(request.projectId) ?? 'active',
		};
	}

	async preview(request: {
		projectId: string;
		path: string;
	}): Promise<FilePreview> {
		let located: Located;
		try {
			located = await this.locate(request.projectId, request.path);
		} catch (error) {
			if (error instanceof IpcFailure && error.code === 'OUTSIDE_ROOT')
				return metadata(
					{
						path: request.path,
						name: request.path.split('/').at(-1) ?? '',
						size: 0,
						modified: 0,
					},
					'outside-project',
					'This link leads outside the project, so it is not opened.',
				);
			throw error;
		}
		return this.read(located.resolved);
	}

	private async read(resolved: ResolvedPath): Promise<FilePreview> {
		const name = resolved.segments.at(-1) ?? '';
		const base = {path: resolved.relative, name, size: 0, modified: 0};
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(resolved.real);
		} catch {
			return metadata(base, 'unreadable', 'The file could not be read.');
		}
		const known = {...base, size: info.size, modified: info.mtimeMs};
		if (!info.isFile())
			return metadata(known, 'not-a-file', 'This is not a regular file.');
		if (info.size > FILE_LIMITS.previewBytes)
			return metadata(
				known,
				'too-large',
				`Files over ${FILE_LIMITS.previewBytes / 1_048_576} MiB are not previewed.`,
			);
		let bytes: Buffer;
		try {
			const handle = await openVerified(resolved.real);
			try {
				const buffer = Buffer.alloc(FILE_LIMITS.previewBytes + 1);
				const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
				bytes = buffer.subarray(0, bytesRead);
			} finally {
				await handle.close();
			}
		} catch (error) {
			return metadata(
				known,
				'unreadable',
				error instanceof IpcFailure
					? error.message
					: 'The file could not be read. It may be locked by another program.',
			);
		}
		if (bytes.length > FILE_LIMITS.previewBytes)
			return metadata(known, 'too-large', 'The file grew while it was read.');
		const decoded = decodeText(bytes);
		if (decoded.kind === 'binary')
			return metadata(known, 'binary', 'This file looks binary.');
		if (decoded.kind === 'unsupported')
			return metadata(known, 'unsupported-encoding', decoded.detail);
		return {
			...known,
			kind: 'text',
			text: decoded.text,
			encoding: decoded.encoding,
			highlight: bytes.length <= FILE_LIMITS.highlightBytes,
		};
	}
}

function metadata(
	base: {path: string; name: string; size: number; modified: number},
	reason: PreviewReason,
	detail: string,
): FilePreview {
	return {...base, kind: 'metadata', reason, detail};
}

async function classify(
	root: string,
	directory: string,
	item: Dirent,
	marks: ReadonlyMap<string, ReviewMark> | undefined,
): Promise<FileEntry> {
	const full = path.join(directory, item.name);
	const mark = marks?.get(item.name) ?? null;
	const entry: FileEntry = {
		name: item.name,
		kind: 'other',
		link: 'none',
		size: null,
		// Opening such a name is refused, so the tree says so instead of offering it.
		unreadable: process.platform === 'win32' && windowsRefusesName(item.name),
		ignored: mark === 'ignored',
		mark,
	};
	try {
		const info = await lstat(full);
		if (info.isSymbolicLink()) {
			const real = await canonicalPath(full);
			if (!contains(root, real)) {
				// Listed so the user can see it, but never followed (FILE-10).
				entry.link = 'outside';
				return entry;
			}
			entry.link = 'inside';
			const target = await stat(real);
			entry.kind = target.isDirectory()
				? 'directory'
				: target.isFile()
					? 'file'
					: 'other';
			entry.size = target.isFile() ? target.size : null;
			return entry;
		}
		entry.kind = info.isDirectory()
			? 'directory'
			: info.isFile()
				? 'file'
				: 'other';
		entry.size = info.isFile() ? info.size : null;
	} catch {
		entry.unreadable = true;
	}
	return entry;
}
