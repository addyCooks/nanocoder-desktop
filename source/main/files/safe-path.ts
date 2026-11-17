import type {BigIntStats, Stats} from 'node:fs';
import {constants} from 'node:fs';
import {type FileHandle, lstat, open} from 'node:fs/promises';
import path from 'node:path';
import {FILE_LIMITS} from '@/main/files/limits';
import {IpcFailure} from '@/main/ipc/handle-request';
import {canonicalPath, isInside} from '@/main/paths';

// Device names Windows reserves in every folder, with or without an extension.
const RESERVED =
	/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN = /[<>:"|?*\\\u0000-\u001f]/u;

const invalid = (message = 'That path is not valid inside a project') =>
	new IpcFailure('VALIDATION', message);

// Names Windows cannot open: forbidden characters, device names, and a trailing dot or
// space, which it drops. A folder can still hold them when they were made through a \\?\ path.
export function windowsRefusesName(name: string): boolean {
	return (
		WINDOWS_FORBIDDEN.test(name) ||
		RESERVED.test(name) ||
		name.endsWith('.') ||
		name.endsWith(' ')
	);
}

// Requests carry a path relative to the project root, always written with '/'.
// The empty string is the root itself. Nothing here touches the filesystem.
export function relativeSegments(
	input: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (typeof input !== 'string' || input.includes('\u0000')) throw invalid();
	if (Buffer.byteLength(input, 'utf8') > FILE_LIMITS.pathBytes)
		throw new IpcFailure('LIMIT', 'That path is too long');
	if (input === '') return [];
	if (input.startsWith('/') || input.endsWith('/')) throw invalid();
	const segments = input.split('/');
	for (const segment of segments) {
		if (segment === '' || segment === '.' || segment === '..') throw invalid();
		if (Buffer.byteLength(segment, 'utf8') > FILE_LIMITS.segmentBytes)
			throw new IpcFailure('LIMIT', 'A name in that path is too long');
		if (platform !== 'win32') continue;
		// Drive-relative, UNC and \\?\ forms, alternate data streams, reserved
		// device names and names Windows silently rewrites.
		if (windowsRefusesName(segment))
			throw invalid('Windows cannot open a file or folder with this name');
	}
	return segments;
}

const nfc = (value: string) => value.normalize('NFC');

// Both sides come from native realpath, which settles case aliases on
// case-insensitive volumes; Unicode forms are settled here.
export function contains(root: string, target: string): boolean {
	return isInside(nfc(target), [nfc(root)]);
}

export interface ResolvedPath {
	// The real, canonical path.
	real: string;
	// The validated relative path, '/'-separated.
	relative: string;
	segments: string[];
}

export async function resolveInside(
	root: string,
	input: string,
	platform: NodeJS.Platform = process.platform,
): Promise<ResolvedPath> {
	const segments = relativeSegments(input, platform);
	const joined = segments.length ? path.join(root, ...segments) : root;
	let real: string;
	try {
		real = await canonicalPath(joined);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR')
			throw new IpcFailure('NOT_FOUND', 'That file is no longer there');
		if (code === 'EACCES' || code === 'EPERM')
			throw new IpcFailure('DENIED', 'That file cannot be read');
		throw new IpcFailure('UNAVAILABLE', 'That file could not be resolved');
	}
	if (!contains(root, real))
		throw new IpcFailure('OUTSIDE_ROOT', 'That path leaves the project folder');
	return {real, relative: segments.join('/'), segments};
}

// ACP sends absolute paths. Check them against the root as text first, so a
// path elsewhere on disk is refused without touching the filesystem, then run
// the same resolution as every other path (ACP-11, SEC-20).
export function relativeFromAbsolute(
	root: string,
	absolute: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const flavour = platform === 'win32' ? path.win32 : path.posix;
	if (
		typeof absolute !== 'string' ||
		absolute.includes('\u0000') ||
		!flavour.isAbsolute(absolute)
	)
		throw invalid('The path must be absolute');
	const normal = flavour.normalize(absolute);
	if (!isInside(nfc(normal), [nfc(root)], platform))
		throw new IpcFailure('OUTSIDE_ROOT', 'That path leaves the project folder');
	return flavour
		.relative(root, normal)
		.split(flavour.sep)
		.filter(Boolean)
		.join('/');
}

function sameFile(a: Stats | BigIntStats, b: Stats | BigIntStats): boolean {
	// Some filesystems report no inode; the real-path check already ran.
	if (!a.ino || !b.ino) return true;
	return a.dev === b.dev && a.ino === b.ino;
}

// Opens a resolved file and confirms it is the file that was checked, so a
// component swapped for a link after resolution is caught (security.md step 6).
export async function openVerified(real: string): Promise<FileHandle> {
	const before = await lstat(real);
	if (before.isSymbolicLink())
		throw new IpcFailure('OUTSIDE_ROOT', 'That path changed while opening');
	const handle = await open(
		real,
		constants.O_RDONLY |
			(constants.O_NOFOLLOW ?? 0) |
			(constants.O_NONBLOCK ?? 0),
	);
	try {
		if (!sameFile(before, await handle.stat()))
			throw new IpcFailure('DENIED', 'That file changed while opening');
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}
