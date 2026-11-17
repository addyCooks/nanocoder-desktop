import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

export const fakeRuntime = {
	nodePath: realpathSync.native(process.execPath),
	cliPath: path.join(import.meta.dirname, 'fake-nanocoder.mjs'),
};

const projects: string[] = [];

export function fakeProject(mode?: string): string {
	const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nd-acp-')));
	projects.push(dir);
	if (mode) writeFileSync(path.join(dir, '.fake-nanocoder'), mode);
	return dir;
}

export function removeFakeProjects(): void {
	for (const dir of projects.splice(0)) {
		rmSync(dir, {recursive: true, force: true});
	}
}

// The fake logs its start-up environment and each request to stderr as JSON lines.
export function fakeEvents(
	lines: readonly string[],
): Array<Record<string, unknown>> {
	return lines.flatMap(line => {
		try {
			const value: unknown = JSON.parse(line);
			return typeof value === 'object' && value !== null
				? [value as Record<string, unknown>]
				: [];
		} catch {
			return [];
		}
	});
}
