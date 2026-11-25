import type {PaletteAction, PaletteThread} from '@/renderer/overlay-model';
import {threadActionReason} from '@/renderer/thread-actions';
import type {ThreadInfo} from '@/shared/ipc';

interface ThreadControls {
	projectId: string | null;
	projectName?: string;
	newShortcut?: string;
	thread: ThreadInfo | null;
	pending: boolean;
	projectBusy?: boolean;
	renameDisabledReason?: string;
	onNew(): void;
	onRename(threadId: string): void;
	onArchive(threadId: string, archived: boolean): void;
}

export function importPalette(controls: {
	ready: boolean;
	onImport(): void;
}): PaletteAction[] {
	return [
		{
			id: 'session-import',
			label: 'import saved sessions',
			glyph: '↳',
			keywords: 'resume history saved metadata',
			disabledReason: controls.ready
				? undefined
				: 'select a project and wait for Nanocoder to be ready',
			run: controls.onImport,
		},
	];
}

export function threadSearchPalette(controls: {
	projectId: string | null;
	threads: readonly ThreadInfo[];
	activeThreadId: string | null;
	pending: boolean;
	onOpen(threadId: string): void;
}): PaletteThread[] {
	if (!controls.projectId) return [];
	return controls.threads
		.filter(thread => thread.projectId === controls.projectId)
		.map(thread => ({
			id: `thread-open-${thread.id}`,
			label: thread.title,
			glyph: thread.archiveState === 'archived' ? '░' : '○',
			archived: thread.archiveState === 'archived',
			current: thread.id === controls.activeThreadId,
			disabledReason: controls.pending
				? 'another thread request is pending'
				: undefined,
			run: () => controls.onOpen(thread.id),
		}));
}

export function threadPalette(controls: ThreadControls): PaletteAction[] {
	const selected =
		controls.thread?.projectId === controls.projectId ? controls.thread : null;
	const busy = controls.pending
		? 'another thread request is pending'
		: undefined;
	const reason = threadActionReason(
		selected,
		controls.pending,
		controls.projectBusy ?? false,
	);
	const archived = selected?.archiveState !== 'archived';
	return [
		{
			id: 'thread-new',
			label: controls.projectName
				? `new thread in ${controls.projectName}`
				: 'new thread',
			glyph: '＋',
			keywords: 'new chat session',
			shortcut: controls.newShortcut,
			opensDialog: true,
			disabledReason:
				busy ?? (controls.projectId ? undefined : 'select a project first'),
			run: () => {
				if (controls.projectId) controls.onNew();
			},
		},
		{
			id: 'thread-rename',
			label: 'rename thread',
			glyph: '▸',
			keywords: 'name chat session',
			opensDialog: true,
			disabledReason: reason ?? controls.renameDisabledReason,
			run: () => {
				if (selected) controls.onRename(selected.id);
			},
		},
		{
			id: 'thread-archive',
			label: archived ? 'archive thread' : 'unarchive thread',
			glyph: '░',
			keywords: 'history chat session',
			opensDialog: archived,
			disabledReason: reason,
			run: () => {
				if (selected) controls.onArchive(selected.id, archived);
			},
		},
	];
}
