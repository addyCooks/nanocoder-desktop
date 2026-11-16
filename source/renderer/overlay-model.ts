export interface PaletteAction {
	id: string;
	label: string;
	glyph: string;
	shortcut?: string;
	keywords?: string;
	opensDialog?: boolean;
	disabledReason?: string;
	run(): void;
}

export type ThreadDialog =
	| {kind: 'thread-menu'; threadId: string}
	| {kind: 'rename'; threadId: string}
	| {kind: 'archive'; threadId: string}
	| {kind: 'remove'; threadId: string}
	| {kind: 'new-thread'}
	| {kind: 'other-thread'; threadId: string};

export const workspaceDialogLabels = {
	projects: 'your projects',
	runtime: 'runtime details',
	capabilities: 'capabilities, with reasons',
	archives: 'archived threads',
	diagnostics: 'review captured diagnostics',
} as const;

export type WorkspaceDialog = keyof typeof workspaceDialogLabels;

export type DialogRequest = WorkspaceDialog | ThreadDialog;

export type OverlayRequest = 'palette' | 'shortcuts' | DialogRequest;

export interface DialogApi {
	open(request: OverlayRequest): void;
	close(): void;
}

export function dialogLabel(request: OverlayRequest): string {
	if (request === 'palette') return 'command palette';
	if (request === 'shortcuts') return 'keyboard shortcuts';
	if (typeof request === 'string') return workspaceDialogLabels[request];
	switch (request.kind) {
		case 'thread-menu':
			return 'thread actions';
		case 'rename':
			return 'rename thread';
		case 'archive':
			return 'archive thread';
		case 'remove':
			return 'remove from desktop';
		case 'new-thread':
			return 'new thread';
		case 'other-thread':
			return 'another thread is running';
	}
}

export function commandModifier(platform: string) {
	return platform.startsWith('Mac') ? '⌘' : 'Ctrl+';
}

function currentPlatform() {
	return typeof navigator === 'undefined' ? '' : (navigator.platform ?? '');
}

export function keyHint(text: string, platform = currentPlatform()) {
	if (platform.startsWith('Mac')) return text;
	return text.replaceAll('⇧', 'Shift+').replaceAll(/[↵⏎]/g, 'Enter');
}

export function filterActions(actions: PaletteAction[], query: string) {
	const text = query.trim().toLocaleLowerCase();
	if (!text) return actions;
	const words = text.split(/\s+/);
	return actions
		.map((action, index) => {
			const label = action.label.toLocaleLowerCase();
			const searchable =
				`${label} ${action.keywords ?? ''}`.toLocaleLowerCase();
			const rank =
				label === text
					? 0
					: label.startsWith(text)
						? 1
						: words.every(word => label.includes(word))
							? 2
							: 3;
			return {
				action,
				index,
				rank,
				matches: words.every(word => searchable.includes(word)),
			};
		})
		.filter(item => item.matches)
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map(item => item.action);
}

export function moveSelection(index: number, delta: number, length: number) {
	if (!length) return -1;
	if (index < 0 || index >= length) return 0;
	return (index + delta + length) % length;
}

export function runAction(action: PaletteAction | undefined) {
	if (!action || action.disabledReason) return false;
	action.run();
	return true;
}

export interface FocusTarget {
	isConnected: boolean;
	disabled?: boolean;
	focus(): void;
}

export function focusReturn(target: FocusTarget | null, fallback: FocusTarget) {
	return () => {
		if (target?.isConnected && !target.disabled) target.focus();
		else if (fallback.isConnected && !fallback.disabled) fallback.focus();
	};
}

export interface Toast {
	id: number;
	message: string;
	exiting: boolean;
}

export interface Clock {
	schedule(callback: () => void, delay: number): () => void;
}

export function toastQueue(
	clock: Clock,
	changed: (toast: Toast | null) => void,
) {
	const pending: Toast[] = [];
	let sequence = 0;
	let active = false;
	let disposed = false;
	let cancel: (() => void) | undefined;
	const next = () => {
		const toast = pending.shift();
		active = !!toast;
		if (!toast) {
			changed(null);
			return;
		}
		changed(toast);
		cancel = clock.schedule(() => {
			changed({...toast, exiting: true});
			cancel = clock.schedule(next, 180);
		}, 2400);
	};
	return {
		push(message: string) {
			if (disposed) return;
			pending.push({id: ++sequence, message, exiting: false});
			if (!active) next();
		},
		dispose() {
			disposed = true;
			cancel?.();
			pending.length = 0;
		},
	};
}

export const importedToast =
	'thread metadata imported. selection and draft unchanged.';

// Shows the import notice only after a metadata import succeeds (E-52).
export function notifyImported(
	importSession: (sessionId: string) => Promise<boolean>,
	notify: (message: string) => void,
): (sessionId: string) => Promise<boolean> {
	return async sessionId => {
		const imported = await importSession(sessionId);
		if (imported) notify(importedToast);
		return imported;
	};
}

export interface OverlayHooks {
	canClose(request: OverlayRequest): boolean;
	hide(): void;
	onClosed(request: OverlayRequest): void;
}

// The open and close rules behind the overlay provider. A refused open or close keeps the current dialog.
export function overlayRules(hooks: OverlayHooks) {
	let current: OverlayRequest | null = null;
	const closeNow = () => {
		const request = current;
		if (request === null) return;
		hooks.hide();
		current = null;
		hooks.onClosed(request);
	};
	return {
		current: () => current,
		open(request: OverlayRequest): boolean {
			const replaced = current;
			if (replaced !== null && replaced !== request) {
				if (!hooks.canClose(replaced)) return false;
				hooks.onClosed(replaced);
			}
			current = request;
			return true;
		},
		close(): boolean {
			if (current !== null && !hooks.canClose(current)) return false;
			closeNow();
			return true;
		},
		closeIf(request: OverlayRequest): boolean {
			if (current !== request) return false;
			closeNow();
			return true;
		},
	};
}
