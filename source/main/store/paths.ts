import {randomUUID} from 'node:crypto';
import {
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
} from 'node:fs';
import path from 'node:path';
import {IpcFailure} from '@/main/ipc/handle-request';

const suffixes = ['', '-wal', '-shm', '-journal'];

function checkFile(filename: string): boolean {
	try {
		const info = lstatSync(filename);
		if (!info.isFile() || info.nlink !== 1) {
			throw new IpcFailure(
				'DENIED',
				'The database path must be a regular file',
			);
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

export function prepareDatabasePath(filename: string): {
	filename: string;
	existed: boolean;
} {
	if (!path.isAbsolute(filename) || filename.includes('\0')) {
		throw new IpcFailure('VALIDATION', 'The database path must be absolute');
	}
	const parent = path.dirname(filename);
	mkdirSync(parent, {recursive: true, mode: 0o700});
	const canonical = path.join(
		realpathSync.native(parent),
		path.basename(filename),
	);
	let existed = false;
	for (const suffix of suffixes) {
		const present = checkFile(canonical + suffix);
		if (!suffix) existed = present;
	}
	if (!existed) closeSync(openSync(canonical, 'wx', 0o600));
	return {filename: canonical, existed};
}

export function reserveBackupPath(filename: string): string {
	const destination = `${filename}.backup-${randomUUID()}`;
	closeSync(openSync(destination, 'wx', 0o600));
	return destination;
}

// Returns the folder the files were moved into.
export function quarantineDatabase(filename: string): string {
	const directory = `${filename}.corrupt-${randomUUID()}`;
	mkdirSync(directory, {mode: 0o700});
	for (const suffix of suffixes) {
		if (checkFile(filename + suffix)) {
			renameSync(
				filename + suffix,
				path.join(directory, path.basename(filename) + suffix),
			);
		}
	}
	return directory;
}
