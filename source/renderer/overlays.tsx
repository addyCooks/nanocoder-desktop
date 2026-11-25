import * as React from 'react';
import {
	createContext,
	type Ref,
	useCallback,
	useContext,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {DialogShell} from '@/renderer/dialog-shell';
import {Icon} from '@/renderer/icons';
import {
	commandModifier,
	type DialogApi,
	type DialogRequest,
	dialogLabel,
	filterPalette,
	focusReturn,
	keyHint,
	moveSelection,
	type OverlayRequest,
	overlayRules,
	type PaletteAction,
	type PaletteThread,
	runAction,
	type Toast,
	toastQueue,
} from '@/renderer/overlay-model';
import {Button} from '@/renderer/ui';

export interface OverlayHandle {
	// The opener is the element focus returns to after the last dialog closes.
	open(request: OverlayRequest, opener?: HTMLElement | null): void;
	close(): void;
	closeIf(request: OverlayRequest): void;
	notify(message: string): void;
}

const OverlayContext = createContext<{
	open(request: OverlayRequest): void;
	shortcut: string;
	theme: 'dark' | 'light';
	toggleTheme(): void;
} | null>(null);

export function ThemeButton() {
	const overlays = useContext(OverlayContext);
	if (!overlays) return null;
	const next = overlays.theme === 'dark' ? 'light' : 'dark';
	return (
		<Button
			className="theme-toggle"
			aria-label={`switch to ${next} theme`}
			title={`switch to ${next} theme`}
			onClick={overlays.toggleTheme}
		>
			<Icon name={next === 'light' ? 'sun' : 'moon'} size={16} />
		</Button>
	);
}

export function PaletteButton() {
	const overlays = useContext(OverlayContext);
	if (!overlays) return null;
	return (
		<Button
			aria-label="command palette"
			aria-haspopup="dialog"
			onClick={() => overlays.open('palette')}
		>
			<kbd>{overlays.shortcut}</kbd>
		</Button>
	);
}

function Notifications({
	active,
	toast,
	error,
	pendingApprovalCount = 0,
}: {
	active: boolean;
	toast: Toast | null;
	error: string;
	pendingApprovalCount?: number;
}) {
	return (
		<div
			className="toast-region"
			role="status"
			aria-label="notification"
			aria-live={active ? 'polite' : 'off'}
			aria-hidden={!active}
			aria-atomic="true"
		>
			<span className="overlay-approval-announcement">
				{active && pendingApprovalCount > 0
					? `approval required · ${pendingApprovalCount} waiting`
					: ''}
			</span>
			{active && error && <p className="overlay-error">{error}</p>}
			{active && toast && (
				<div
					key={toast.id}
					className="overlay-toast"
					data-exiting={toast.exiting}
				>
					{toast.message}
				</div>
			)}
		</div>
	);
}

function ShortcutRow({label, keys}: {label: string; keys: React.ReactNode}) {
	return (
		<div>
			<dt>{label}</dt>
			<dd>{keys}</dd>
		</div>
	);
}

export function OverlayProvider({
	ref,
	actions,
	threads = [],
	pendingApprovalCount = 0,
	canClose = () => true,
	onClosed,
	onOpenChange,
	renderDialog,
	children,
}: {
	ref?: Ref<OverlayHandle>;
	actions: PaletteAction[];
	threads?: PaletteThread[];
	pendingApprovalCount?: number;
	// A dismissal or replacement is refused when this returns false; the dialog stays open.
	canClose?(request: OverlayRequest): boolean;
	onClosed?(request: OverlayRequest): void;
	onOpenChange?(open: boolean): void;
	renderDialog(request: DialogRequest, api: DialogApi): React.ReactNode;
	children: React.ReactNode;
}) {
	const [current, setCurrent] = useState<OverlayRequest | null>(null);
	const [query, setQuery] = useState('');
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [toast, setToast] = useState<Toast | null>(null);
	const [themeError, setThemeError] = useState('');
	const [activeTheme, setActiveTheme] = useState<'dark' | 'light'>('dark');
	const dialog = useRef<HTMLDialogElement>(null);
	const latestHooks = useRef({canClose, onClosed, onOpenChange});
	const returnFocus = useRef<(() => void) | null>(null);
	const closingFocus = useRef<Element | null>(null);
	const notifications = useRef<ReturnType<typeof toastQueue> | null>(null);
	const themeChanged = useRef(false);
	const latestActions = useRef(actions);
	const [rules] = useState(() =>
		overlayRules({
			canClose: request => latestHooks.current.canClose(request),
			hide() {
				dialog.current?.close();
				const active = document.activeElement;
				closingFocus.current = active;
				// Do not expose native-restored editor focus before close has settled.
				if (
					active instanceof HTMLTextAreaElement ||
					(active instanceof HTMLInputElement &&
						active.selectionStart !== null) ||
					(active instanceof HTMLElement && active.isContentEditable)
				)
					active.blur();
			},
			onClosed: request => latestHooks.current.onClosed?.(request),
		}),
	);
	const mac = navigator.platform.startsWith('Mac');
	const shortcut = `${commandModifier(navigator.platform)}K`;
	const opened = current !== null;

	useEffect(() => {
		const queue = toastQueue(
			{
				schedule(callback, delay) {
					const timer = window.setTimeout(callback, delay);
					return () => window.clearTimeout(timer);
				},
			},
			setToast,
		);
		notifications.current = queue;
		return () => queue.dispose();
	}, []);

	useEffect(() => {
		let live = true;
		void window.desktop.getSettings({}).then(result => {
			if (!live || themeChanged.current || !result.ok) return;
			const theme = result.value.theme;
			const resolved =
				theme === 'system'
					? window.matchMedia('(prefers-color-scheme: light)').matches
						? 'light'
						: 'dark'
					: theme;
			document.documentElement.dataset.theme = resolved;
			setActiveTheme(resolved);
		});
		return () => {
			live = false;
		};
	}, []);

	useEffect(() => {
		if (current === 'palette')
			setActiveTheme(
				document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
			);
	}, [current]);

	const notify = useCallback((message: string) => {
		notifications.current?.push(message);
	}, []);

	// Only the first opener is kept, so a dialog that replaces another still returns focus to the original.
	const open = useCallback(
		(request: OverlayRequest, opener?: HTMLElement | null) => {
			if (!rules.open(request)) return;
			if (!dialog.current?.open) {
				const target = opener === undefined ? document.activeElement : opener;
				returnFocus.current = focusReturn(
					target instanceof HTMLElement ? target : null,
					document.querySelector<HTMLButtonElement>(
						'[aria-label="command palette"]',
					) ?? document.body,
				);
			}
			setQuery('');
			setSelectedId(null);
			setCurrent(request);
		},
		[rules],
	);

	const close = useCallback(() => {
		if (rules.close()) setCurrent(null);
	}, [rules]);

	const closeIf = useCallback(
		(request: OverlayRequest) => {
			if (rules.closeIf(request)) setCurrent(null);
		},
		[rules],
	);

	const api = useMemo<DialogApi>(() => ({open, close}), [open, close]);
	const toggleTheme = useRef(() => {});
	const context = useMemo(
		() => ({
			open,
			shortcut,
			theme: activeTheme,
			toggleTheme: () => toggleTheme.current(),
		}),
		[open, shortcut, activeTheme],
	);
	useImperativeHandle(ref, () => ({open, close, closeIf, notify}), [
		open,
		close,
		closeIf,
		notify,
	]);

	useLayoutEffect(() => {
		latestActions.current = actions;
		latestHooks.current = {canClose, onClosed, onOpenChange};
	});

	useLayoutEffect(() => {
		if (opened && !dialog.current?.open) dialog.current?.showModal();
	}, [opened]);

	useLayoutEffect(() => {
		latestHooks.current.onOpenChange?.(opened);
	}, [opened]);

	useLayoutEffect(() => {
		if (current === null) return;
		const target =
			dialog.current?.querySelector<HTMLElement>('[data-autofocus]') ??
			dialog.current?.querySelector<HTMLElement>('button');
		target?.focus();
	}, [current]);

	const runNewThread = useCallback(() => {
		const action = latestActions.current.find(item => item.id === 'thread-new');
		if (!action) return;
		if (action.disabledReason) notify(action.disabledReason);
		else runAction(action);
	}, [notify]);

	useEffect(() => {
		const keydown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
				return;
			if (event.key === 'Escape' && dialog.current?.open) {
				event.preventDefault();
				close();
				return;
			}
			const target = event.target;
			const typing =
				target instanceof HTMLElement &&
				(target.isContentEditable ||
					!!target.closest('input, textarea, select, [role="textbox"]'));
			const modifier = mac ? event.metaKey : event.ctrlKey;
			const key = event.key.toLowerCase();
			if (modifier && !event.altKey && !event.shiftKey && key === 'k') {
				event.preventDefault();
				open('palette');
			} else if (modifier && !event.altKey && !event.shiftKey && key === 'n') {
				event.preventDefault();
				if (!dialog.current?.open) runNewThread();
			} else if (
				event.key === '?' &&
				!typing &&
				!event.metaKey &&
				!event.ctrlKey &&
				!event.altKey
			) {
				event.preventDefault();
				open('shortcuts');
			}
		};
		document.addEventListener('keydown', keydown);
		return () => document.removeEventListener('keydown', keydown);
	}, [close, mac, open, runNewThread]);

	const changeTheme = async (theme: 'dark' | 'light') => {
		themeChanged.current = true;
		setThemeError('');
		const result = await window.desktop.updateSettings({patch: {theme}});
		if (!result.ok) {
			setThemeError('theme could not be saved. try again.');
			notifications.current?.push('theme could not be saved. try again.');
			return;
		}
		document.documentElement.dataset.theme = theme;
		setActiveTheme(theme);
		notifications.current?.push(`switched to ${theme} theme`);
	};
	toggleTheme.current = () => {
		void changeTheme(activeTheme === 'dark' ? 'light' : 'dark');
	};
	const commands: PaletteAction[] = [
		...actions,
		{
			id: `theme-${activeTheme === 'dark' ? 'light' : 'dark'}`,
			label: `switch to ${activeTheme === 'dark' ? 'light' : 'dark'} theme`,
			glyph: '◐',
			keywords: 'appearance colour',
			run: () => {
				void changeTheme(activeTheme === 'dark' ? 'light' : 'dark');
			},
		},
		{
			id: 'shortcuts',
			label: 'keyboard shortcuts',
			glyph: '?',
			shortcut: '?',
			opensDialog: true,
			run: () => open('shortcuts'),
		},
	];
	const groups = filterPalette(commands, threads, query);
	const filtered = groups.flatMap(group => group.results);
	const resultKey = (result: (typeof filtered)[number]) =>
		`${result.kind}-${result.id}`;
	const selectedIndex = selectedId
		? filtered.findIndex(result => resultKey(result) === selectedId)
		: -1;
	const index = moveSelection(selectedIndex, 0, filtered.length);
	const activeResultId = filtered[index] ? resultKey(filtered[index]) : null;
	useLayoutEffect(() => {
		if (current === 'palette' && selectedId !== activeResultId)
			setSelectedId(activeResultId);
	}, [current, selectedId, activeResultId]);
	useLayoutEffect(() => {
		if (current === 'palette' && activeResultId)
			document
				.getElementById(`palette-option-${activeResultId}`)
				?.scrollIntoView({block: 'nearest'});
	}, [current, activeResultId]);
	const execute = (action: PaletteAction | undefined) => {
		if (!action || action.disabledReason) return;
		runAction(action);
		if (!action.opensDialog) closeIf('palette');
	};
	const modifier = commandModifier(navigator.platform);

	return (
		<OverlayContext value={context}>
			{children}
			<dialog
				ref={dialog}
				className="overlay-dialog"
				aria-label={current ? dialogLabel(current) : 'command palette'}
				onClose={() => {
					if (dialog.current?.open) return;
					const restore = returnFocus.current;
					returnFocus.current = null;
					const active = document.activeElement;
					if (
						active !== document.body &&
						active !== closingFocus.current &&
						!dialog.current?.contains(active)
					)
						return;
					restore?.();
				}}
				onCancel={event => {
					event.preventDefault();
					close();
				}}
				onClick={event => {
					if (event.target === dialog.current) close();
				}}
				onKeyDown={event => {
					if (
						event.nativeEvent.isComposing ||
						event.nativeEvent.keyCode === 229
					)
						return;
					if (event.key === 'Escape') {
						event.preventDefault();
						close();
					}
				}}
			>
				{current === 'palette' && (
					<DialogShell
						title="command palette"
						closeLabel="close command palette"
						onClose={close}
						className="dialog-shell--palette"
					>
						<div className="palette-search">
							<input
								data-autofocus
								role="combobox"
								aria-label="find a thread or action"
								aria-expanded={filtered.length > 0}
								aria-autocomplete="list"
								aria-controls={filtered.length ? 'palette-results' : undefined}
								aria-activedescendant={
									activeResultId
										? `palette-option-${activeResultId}`
										: undefined
								}
								value={query}
								placeholder="find a thread or action…"
								onChange={event => {
									setQuery(event.target.value);
									setSelectedId(null);
								}}
								onKeyDown={event => {
									if (
										event.nativeEvent.isComposing ||
										event.nativeEvent.keyCode === 229
									)
										return;
									if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
										event.preventDefault();
										const next = moveSelection(
											index,
											event.key === 'ArrowDown' ? 1 : -1,
											filtered.length,
										);
										setSelectedId(
											filtered[next] ? resultKey(filtered[next]) : null,
										);
									} else if (event.key === 'Enter') {
										event.preventDefault();
										execute(filtered[index]);
									}
								}}
							/>
						</div>
						{filtered.length ? (
							<div
								id="palette-results"
								role="listbox"
								aria-label="matching threads and actions"
								className="palette-results"
							>
								{groups.map(group => (
									<div
										key={group.id}
										role={query.trim() ? 'group' : undefined}
										aria-labelledby={
											query.trim() ? `palette-group-${group.id}` : undefined
										}
										className="palette-group"
									>
										{query.trim() && (
											<div
												id={`palette-group-${group.id}`}
												role="presentation"
												className="palette-group-heading"
											>
												{group.label}
											</div>
										)}
										{group.results.map(result => {
											return (
												<div
													key={resultKey(result)}
													id={`palette-option-${resultKey(result)}`}
													role="option"
													tabIndex={-1}
													aria-selected={resultKey(result) === activeResultId}
													aria-current={
														result.kind === 'thread' && result.current
															? 'true'
															: undefined
													}
													aria-disabled={!!result.disabledReason}
													className="palette-option"
													onPointerMove={() => setSelectedId(resultKey(result))}
													onMouseDown={event => event.preventDefault()}
													onClick={() => execute(result)}
													onKeyDown={event => {
														if (event.key === 'Enter') execute(result);
													}}
												>
													<span aria-hidden="true">{result.glyph}</span>
													<span className="palette-label">
														{result.label}
														{result.kind === 'thread' && result.current && (
															<span className="palette-current">
																{' '}
																· current thread
															</span>
														)}
														{result.disabledReason && (
															<span className="palette-reason">
																{' '}
																· unavailable: {result.disabledReason}
															</span>
														)}
													</span>
													{result.shortcut && <kbd>{result.shortcut}</kbd>}
												</div>
											);
										})}
									</div>
								))}
							</div>
						) : (
							<p className="palette-empty" role="status">
								no threads or actions found. try a different search.
							</p>
						)}
						<p className="overlay-hint">
							{keyHint('↑↓ move · ↵ choose · esc close')}
						</p>
					</DialogShell>
				)}
				{current === 'shortcuts' && (
					<DialogShell
						title="keyboard shortcuts"
						closeLabel="close keyboard shortcuts"
						onClose={close}
						footer={<Button onClick={close}>close</Button>}
					>
						<p className="dialog-note">
							actions remain available as labelled buttons.
						</p>
						<dl className="shortcut-list">
							<ShortcutRow
								label="command palette"
								keys={<kbd>{shortcut}</kbd>}
							/>
							<ShortcutRow
								label="new thread"
								keys={<kbd>{`${modifier}N`}</kbd>}
							/>
							<ShortcutRow label="send message" keys={<kbd>Enter</kbd>} />
							<ShortcutRow
								label="insert a newline"
								keys={<kbd>Shift+Enter</kbd>}
							/>
							<ShortcutRow
								label="close a menu or dialog"
								keys={<kbd>Esc</kbd>}
							/>
							<ShortcutRow
								label="approval, while its request has focus"
								keys={<kbd>1-9 (offered options only)</kbd>}
							/>
						</dl>
					</DialogShell>
				)}
				{current !== null &&
					current !== 'palette' &&
					current !== 'shortcuts' &&
					renderDialog(current, api)}
				<div data-stream-announcement-host="modal" />
				<Notifications
					active={opened}
					toast={toast}
					error={themeError}
					pendingApprovalCount={pendingApprovalCount}
				/>
			</dialog>
			<Notifications active={!opened} toast={toast} error={themeError} />
		</OverlayContext>
	);
}
