import * as React from 'react';
import {Button} from '@/renderer/ui';
import type {
	BrowserBounds,
	BrowserDownload,
	BrowserNavigation,
	BrowserProfileList,
	BrowserSnapshot,
} from '@/shared/browser';

export interface BrowserPanelProps {
	projectName: string;
	snapshot: BrowserSnapshot | null;
	publicSites: boolean;
	nanocoderBrowser: boolean;
	sites: string[];
	profiles: BrowserProfileList | null;
	loading: boolean;
	pending: boolean;
	error: string | null;
	suspended: boolean;
	onOpen(input: string): Promise<boolean>;
	onNavigate(action: BrowserNavigation): void;
	onBounds(bounds: BrowserBounds | null): void;
	onPublicSites(enabled: boolean): void;
	onNanocoderBrowser(enabled: boolean): void;
	onAgentPaused(paused: boolean): void;
	onInterruptAgent(): void;
	onForgetSite(origin: string): void;
	onAllowAndOpen(url: string): void;
	onProfile(profile: string): void;
	onCreateProfile(name: string): Promise<boolean>;
	onDeleteProfile(id: string): void;
	onClearData(profile: string): void;
	onOpenExternal(): void;
	attachReason: string | null;
	onSendToChat(url: string): void;
}

const ACTIVITY_WORDS = {
	running: 'running',
	done: 'done',
	refused: 'refused',
	interrupted: 'stopped by you',
} as const;

const SECURITY = {
	local: {glyph: '●', word: 'local', tone: 'ok'},
	secure: {glyph: '●', word: 'secure', tone: 'ok'},
	insecure: {glyph: '▲', word: 'not secure', tone: 'warn'},
} as const;

function downloadText(download: BrowserDownload): string {
	if (download.state === 'asking') return 'choose where to save it';
	if (download.state === 'progress')
		return download.total > 0
			? `${Math.min(100, Math.round((download.received / download.total) * 100))}%`
			: 'saving';
	if (download.state === 'done') return 'saved';
	return download.state === 'cancelled' ? 'cancelled' : 'failed';
}

function profileLabel(
	current: string,
	profiles: BrowserProfileList | null,
): string {
	if (current === 'project') return "this project's own profile";
	if (current === 'default') return 'the shared default profile';
	if (current === 'incognito') return 'incognito';
	return `the ${profiles?.profiles.find(entry => entry.id === current)?.name ?? 'named'} profile`;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return 'that address';
	}
}

function useViewportBounds(
	node: React.RefObject<HTMLDivElement | null>,
	active: boolean,
	onBounds: (bounds: BrowserBounds | null) => void,
): void {
	React.useEffect(() => {
		const element = node.current;
		if (!element || !active) {
			onBounds(null);
			return;
		}
		let frame = 0;
		const report = () => {
			frame = 0;
			const rect = element.getBoundingClientRect();
			onBounds(
				rect.width >= 1 && rect.height >= 1
					? {
							x: Math.max(0, Math.round(rect.left)),
							y: Math.max(0, Math.round(rect.top)),
							width: Math.round(rect.width),
							height: Math.round(rect.height),
						}
					: null,
			);
		};
		const schedule = () => {
			if (frame === 0) frame = requestAnimationFrame(report);
		};
		const observer = new ResizeObserver(schedule);
		observer.observe(element);
		observer.observe(document.body);
		window.addEventListener('resize', schedule);
		schedule();
		return () => {
			if (frame !== 0) cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener('resize', schedule);
			onBounds(null);
		};
	}, [node, active, onBounds]);
}

export function BrowserPanel({
	projectName,
	snapshot,
	publicSites,
	nanocoderBrowser,
	sites,
	profiles,
	loading,
	pending,
	error,
	suspended,
	onOpen,
	onNavigate,
	onBounds,
	onPublicSites,
	onNanocoderBrowser,
	onAgentPaused,
	onInterruptAgent,
	onForgetSite,
	onAllowAndOpen,
	onProfile,
	onCreateProfile,
	onDeleteProfile,
	onClearData,
	onOpenExternal,
	attachReason,
	onSendToChat,
}: BrowserPanelProps): React.ReactElement {
	const nanocoderNote = React.useId();
	const viewport = React.useRef<HTMLDivElement>(null);
	const address = React.useRef<HTMLInputElement>(null);
	const [draft, setDraft] = React.useState<string | null>(null);
	const [dismissed, setDismissed] = React.useState<number | null>(null);
	const [confirming, setConfirming] = React.useState<'clear' | 'remove' | null>(
		null,
	);
	const [newName, setNewName] = React.useState('');
	const current = profiles?.current ?? 'project';
	const named = profiles?.profiles.some(entry => entry.id === current) ?? false;
	useViewportBounds(viewport, !suspended, onBounds);
	const shownUrl = snapshot?.url ?? null;
	React.useEffect(() => {
		if (shownUrl !== undefined && document.activeElement !== address.current)
			setDraft(null);
	}, [shownUrl]);
	const open = snapshot !== null && snapshot.status !== 'closed';
	const busy = snapshot?.status === 'loading';
	const blocked =
		snapshot?.blocked && snapshot.blocked.id !== dismissed
			? snapshot.blocked
			: null;
	const security = snapshot?.security ? SECURITY[snapshot.security] : null;
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setDismissed(null);
		const input = draft ?? snapshot?.url ?? '';
		if (await onOpen(input)) setDraft(null);
	};
	return (
		<div className="browser-panel">
			<form
				className="browser-toolbar"
				onSubmit={event => void submit(event)}
				aria-label={`browser for ${projectName}`}
			>
				<Button
					aria-label="back"
					title="back"
					disabled={!snapshot?.canGoBack}
					onClick={() => onNavigate('back')}
				>
					←
				</Button>
				<Button
					aria-label="forward"
					title="forward"
					disabled={!snapshot?.canGoForward}
					onClick={() => onNavigate('forward')}
				>
					→
				</Button>
				<Button
					aria-label={busy ? 'stop loading' : 'reload'}
					title={busy ? 'stop loading' : 'reload'}
					disabled={!open}
					onClick={() => onNavigate(busy ? 'stop' : 'reload')}
				>
					{busy ? '✕' : '↻'}
				</Button>
				<input
					className="browser-address"
					type="text"
					aria-label="address"
					placeholder="localhost:5173"
					spellCheck={false}
					autoComplete="off"
					ref={address}
					value={draft ?? snapshot?.url ?? ''}
					onChange={event => setDraft(event.target.value)}
					onKeyDown={event => {
						if (event.key === 'Escape') setDraft(null);
					}}
					disabled={loading}
				/>
				<Button type="submit" disabled={pending || loading}>
					go
				</Button>
			</form>
			<div className="browser-meta">
				<span className="browser-origin" role="status">
					{security && snapshot?.origin ? (
						<>
							<span
								className={`browser-security browser-security--${security.tone}`}
							>
								<span aria-hidden="true">{security.glyph}</span> {security.word}
							</span>{' '}
							<span>{snapshot.origin}</span>
						</>
					) : (
						'no page open'
					)}
					{busy && ' · loading…'}
				</span>
				<label
					className="browser-public"
					title="lets this browser open public websites. localhost always works."
				>
					<input
						type="checkbox"
						checked={publicSites}
						onChange={event => onPublicSites(event.target.checked)}
					/>{' '}
					allow public sites
				</label>
				<label
					className="browser-public"
					title="turns on the browser tool built into Nanocoder. it is separate from this panel and has its own approvals."
				>
					<input
						type="checkbox"
						checked={nanocoderBrowser}
						aria-describedby={nanocoderBrowser ? nanocoderNote : undefined}
						onChange={event => onNanocoderBrowser(event.target.checked)}
					/>{' '}
					nanocoder's own browser
				</label>
			</div>
			{nanocoderBrowser && (
				<p id={nanocoderNote} className="browser-notice">
					nanocoder's own browser is on. it does not follow these settings, can
					reach public sites, and asks with nanocoder's own approvals. the
					change applies to chats started or reopened after it.
				</p>
			)}
			<div className="browser-profile">
				<label>
					profile{' '}
					<select
						aria-label="browser profile"
						value={current}
						disabled={!profiles || pending}
						onChange={event => {
							setConfirming(null);
							onProfile(event.target.value);
						}}
					>
						<option value="project">this project's own</option>
						<option value="default">shared default</option>
						{profiles?.profiles.map(entry => (
							<option key={entry.id} value={entry.id}>
								{entry.name}
							</option>
						))}
						<option value="incognito">incognito, not saved</option>
					</select>
				</label>
				<Button
					title={
						attachReason ??
						'add this page address and title to your next message'
					}
					disabled={
						snapshot?.status !== 'ready' ||
						!snapshot.url ||
						attachReason !== null
					}
					onClick={() => snapshot?.url && onSendToChat(snapshot.url)}
				>
					send page to chat
				</Button>
				<Button
					title="open this page in your system browser"
					disabled={!open || !snapshot?.url}
					onClick={onOpenExternal}
				>
					open in system browser
				</Button>
			</div>
			<details className="browser-manage">
				<summary>manage profiles and data</summary>
				<form
					className="browser-manage-row"
					aria-label="new browser profile"
					onSubmit={event => {
						event.preventDefault();
						void onCreateProfile(newName).then(done => {
							if (done) setNewName('');
						});
					}}
				>
					<input
						className="browser-address"
						aria-label="new profile name"
						placeholder="new profile name"
						maxLength={40}
						value={newName}
						onChange={event => setNewName(event.target.value)}
					/>
					<Button type="submit" disabled={newName.trim() === '' || pending}>
						add profile
					</Button>
				</form>
				{confirming ? (
					<div className="browser-manage-row" role="alert">
						<span>
							{confirming === 'clear'
								? `clear cookies, sign-ins and site data for ${profileLabel(current, profiles)}? this cannot be undone.`
								: `remove ${profileLabel(current, profiles)} and its data? projects using it go back to their own profile.`}
						</span>
						<Button
							onClick={() => {
								if (confirming === 'clear') onClearData(current);
								else onDeleteProfile(current);
								setConfirming(null);
							}}
						>
							{confirming === 'clear' ? 'yes, clear it' : 'yes, remove it'}
						</Button>
						<Button onClick={() => setConfirming(null)}>keep it</Button>
					</div>
				) : (
					<div className="browser-manage-row">
						<Button onClick={() => setConfirming('clear')} disabled={!profiles}>
							clear data for this profile
						</Button>
						{named && (
							<Button onClick={() => setConfirming('remove')}>
								remove this profile
							</Button>
						)}
					</div>
				)}
			</details>
			{snapshot && (
				<section className="browser-agent" aria-label="agent in the browser">
					<div className="browser-manage-row">
						<span role="status">
							{snapshot.agent.paused
								? 'agent control paused'
								: snapshot.agent.busy
									? 'agent is acting…'
									: 'agent control on'}
						</span>
						{snapshot.agent.busy && !snapshot.agent.paused && (
							<Button onClick={onInterruptAgent}>stop agent action</Button>
						)}
						<Button onClick={() => onAgentPaused(!snapshot.agent.paused)}>
							{snapshot.agent.paused
								? 'let the agent continue'
								: 'take control'}
						</Button>
					</div>
					{snapshot.agent.activity.length > 0 && (
						<details className="browser-manage">
							<summary>
								agent activity ({snapshot.agent.activity.length})
							</summary>
							<ol className="browser-downloads" aria-label="agent activity">
								{snapshot.agent.activity.map(entry => (
									<li key={entry.id}>
										<span className="browser-download-name">{entry.text}</span>{' '}
										<span>· {ACTIVITY_WORDS[entry.outcome]}</span>
									</li>
								))}
							</ol>
						</details>
					)}
					{sites.length > 0 && (
						<details className="browser-manage">
							<summary>always allowed sites ({sites.length})</summary>
							<ul
								className="browser-downloads"
								aria-label="always allowed sites"
							>
								{sites.map(origin => (
									<li key={origin} className="browser-manage-row">
										<span className="browser-download-name">{origin}</span>
										<Button
											onClick={() => onForgetSite(origin)}
											aria-label={`forget ${origin}`}
										>
											forget
										</Button>
									</li>
								))}
							</ul>
						</details>
					)}
				</section>
			)}
			{snapshot && snapshot.downloads.length > 0 && (
				<ul className="browser-downloads" aria-label="downloads">
					{snapshot.downloads.map(download => (
						<li key={download.id}>
							<span className="browser-download-name">{download.name}</span>{' '}
							<span>{downloadText(download)}</span>
						</li>
					))}
				</ul>
			)}
			{blocked && (
				<div className="browser-notice" role="alert">
					{blocked.reason === 'public-off' ? (
						<>
							<p>
								{hostOf(blocked.url)} is a public site, and public sites are
								off. only localhost pages open.
							</p>
							<div className="browser-notice-actions">
								<Button onClick={() => onAllowAndOpen(blocked.url)}>
									turn on public sites and open it
								</Button>
								<Button onClick={() => setDismissed(blocked.id)}>
									stay on localhost
								</Button>
							</div>
						</>
					) : blocked.reason === 'popup' ? (
						<>
							<p>
								a page tried to open a new window. it was blocked, so nothing
								else opened.
							</p>
							<div className="browser-notice-actions">
								<Button onClick={() => setDismissed(blocked.id)}>
									dismiss
								</Button>
							</div>
						</>
					) : (
						<>
							<p>only http and https pages open here.</p>
							<div className="browser-notice-actions">
								<Button onClick={() => setDismissed(blocked.id)}>
									dismiss
								</Button>
							</div>
						</>
					)}
				</div>
			)}
			{!snapshot?.blocked && error && (
				<p className="browser-notice" role="alert">
					{error}
				</p>
			)}
			{!snapshot?.blocked && !error && snapshot?.status === 'failed' && (
				<p className="browser-notice" role="alert">
					{snapshot.reason ?? 'the page could not load'}
				</p>
			)}
			<div
				ref={viewport}
				className="browser-viewport"
				role="region"
				aria-label="web page"
			>
				{!open && (
					<p className="browser-empty">
						enter an address to preview a page. localhost opens by default.
					</p>
				)}
			</div>
		</div>
	);
}
