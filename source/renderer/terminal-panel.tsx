import * as React from 'react';
import {Icon} from '@/renderer/icons';
import type {TerminalAction} from '@/renderer/terminal-controller';
import {terminalFocusLease} from '@/renderer/terminal-focus';
import {type TerminalHandle, TerminalView} from '@/renderer/terminal-view';
import {Button} from '@/renderer/ui';
import {latestLocalUrl} from '@/shared/local-url';
import type {TerminalSnapshot} from '@/shared/terminal';

export function TerminalPanel({
	snapshot,
	pending,
	loading,
	error,
	disabledReason,
	projectName,
	onAction,
	onData,
	onResize,
	onClose,
	onOpenUrl,
}: {
	snapshot: TerminalSnapshot | null;
	pending: boolean;
	loading: boolean;
	error: string | null;
	disabledReason: string | null;
	projectName: string;
	onAction(action: TerminalAction): Promise<boolean>;
	onData(data: string): void;
	onResize(cols: number, rows: number): void;
	onClose(): void;
	onOpenUrl(url: string): void;
}) {
	const view = React.useRef<TerminalHandle>(null);
	const returnFocus = React.useRef<HTMLButtonElement>(null);
	const [screenReader, setScreenReader] = React.useState(false);
	const [viewFailed, setViewFailed] = React.useState(false);
	const running = snapshot?.status === 'running';
	const busy = pending || loading || snapshot?.status === 'starting';
	const serverUrl = React.useMemo(
		() => latestLocalUrl(snapshot?.output ?? ''),
		[snapshot?.output],
	);
	const status = snapshot?.status ?? (loading ? 'loading' : 'unavailable');
	const run = async (action: TerminalAction, target: HTMLButtonElement) => {
		const focus = terminalFocusLease(document, target);
		try {
			if (
				(await onAction(action)) &&
				(action === 'start' || action === 'restart') &&
				focus.canReturn()
			)
				view.current?.focus();
		} finally {
			focus.dispose();
		}
	};
	return (
		<section className="terminal-panel" aria-label="your project terminal">
			<header className="terminal-toolbar">
				<Button
					ref={returnFocus}
					aria-label="focus your terminal"
					onClick={() => view.current?.focus()}
				>
					terminal
				</Button>
				<span className="terminal-state" role="status">
					{running ? '●' : status === 'failed' ? '✕' : '○'} {status}
					{snapshot?.exitCode !== null && snapshot?.exitCode !== undefined
						? ` (${snapshot.exitCode})`
						: ''}
				</span>
				<div className="terminal-actions">
					{serverUrl && (
						<Button
							title={`open ${serverUrl} in the browser`}
							onClick={() => onOpenUrl(serverUrl)}
						>
							open {new URL(serverUrl).host} in the browser
						</Button>
					)}
					{!running && (
						<Button
							disabled={busy || !!disabledReason || !snapshot}
							onClick={event => {
								void run(
									status === 'exited' || status === 'failed'
										? 'restart'
										: 'start',
									event.currentTarget,
								);
							}}
						>
							{status === 'exited' || status === 'failed'
								? 'retry terminal'
								: 'start terminal'}
						</Button>
					)}
					{running && (
						<Button
							disabled={busy || !!disabledReason}
							onClick={event => {
								void run('restart', event.currentTarget);
							}}
						>
							restart
						</Button>
					)}
					<Button
						disabled={busy || !snapshot}
						onClick={() => {
							void onAction('clear');
						}}
					>
						clear
					</Button>
					<Button
						disabled={pending || loading || !snapshot || status === 'stopped'}
						onClick={() => {
							void onAction('stop');
						}}
					>
						stop
					</Button>
					<Button
						className="close-button"
						aria-label="close terminal panel"
						onClick={onClose}
					>
						<Icon name="close" size={16} />
					</Button>
				</div>
			</header>
			<div className="terminal-session">
				<p className="terminal-identity">
					your terminal · {projectName} ·{' '}
					{snapshot?.shell ?? 'shell starts on request'} · one PTY
				</p>
				{(error || snapshot?.reason || disabledReason || viewFailed) && (
					<p className="terminal-error" role="alert">
						{error ??
							snapshot?.reason ??
							disabledReason ??
							'The terminal view could not be loaded. Stop the terminal before retrying.'}
					</p>
				)}
				{status === 'stopped' && !snapshot?.output && !disabledReason && (
					<p className="terminal-hint">
						no shell is running. choose start terminal to open one in{' '}
						{projectName}.
					</p>
				)}
				{snapshot?.truncated && (
					<p className="terminal-hint">
						older output discarded from the bounded buffer
					</p>
				)}
				<TerminalView
					ref={view}
					output={snapshot?.output ?? ''}
					running={running && !pending && !disabledReason && !viewFailed}
					screenReader={screenReader}
					onData={onData}
					onResize={onResize}
					onExit={() => returnFocus.current?.focus()}
					onFailure={() => setViewFailed(true)}
					onOpenUrl={onOpenUrl}
				/>
			</div>
			<footer className="terminal-help">
				<p id="terminal-help">
					ctrl+shift+tab leaves terminal focus · bounded in-memory scrollback
				</p>
				<Button
					aria-pressed={screenReader}
					onClick={() => setScreenReader(value => !value)}
				>
					screen-reader mode {screenReader ? 'on' : 'off'}
				</Button>
			</footer>
		</section>
	);
}
