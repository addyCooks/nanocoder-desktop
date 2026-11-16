import * as React from 'react';
import {Icon} from '@/renderer/icons';
import {recencyLabel} from '@/renderer/recency';
import {Button} from '@/renderer/ui';
import type {DiscoveredSession} from '@/shared/ipc';

export interface SessionImportListProps {
	projectId: string | null;
	projectName?: string;
	active: boolean;
	focusRequest?: number;
	sessions: readonly DiscoveredSession[];
	loading: boolean;
	importing: string | null;
	error: string | null;
	disabledReason?: string;
	backLabel?: string;
	onBack?(): void;
	onRefresh(): Promise<boolean>;
	onImport(sessionId: string): Promise<boolean>;
}

export function SessionImportList(
	props: SessionImportListProps,
): React.ReactElement | null {
	const region = React.useRef<HTMLElement>(null);
	const refresh = React.useRef<HTMLButtonElement>(null);
	const returnFocus = React.useRef<{projectId: string | null} | null>(null);
	const reasonId = React.useId();
	const reason = props.loading
		? 'loading saved session metadata'
		: props.importing !== null
			? 'waiting for the metadata import'
			: props.disabledReason;
	React.useLayoutEffect(() => {
		const pending = returnFocus.current;
		if (!pending) return;
		if (pending.projectId !== props.projectId) {
			returnFocus.current = null;
			return;
		}
		if (props.importing !== null) return;
		returnFocus.current = null;
		const active = document.activeElement;
		if (active === document.body || region.current?.contains(active)) {
			refresh.current?.focus();
		}
	});
	const focusRequest = props.focusRequest ?? 0;
	React.useLayoutEffect(() => {
		if (focusRequest === 0) return;
		const first = region.current?.querySelector<HTMLButtonElement>(
			'.session-import-card button:not(:disabled)',
		);
		(first ?? refresh.current)?.focus();
	}, [focusRequest]);
	if (!props.active) return null;
	return (
		<section
			ref={region}
			className="session-import-page"
			aria-label="import saved sessions"
		>
			<div className="session-import-header">
				<h2 className="session-import-heading">bring a saved session here</h2>
			</div>
			<p className="session-import-intro">
				sessions found for this exact project root. importing adds a desktop
				thread only. open the thread separately to resume it.
			</p>
			<div className="session-import-notice">
				<p>
					<span aria-hidden="true">○ </span>no agent will start
				</p>
				<p>
					your selected thread and draft stay unchanged. no messages or files
					are copied into desktop storage.
				</p>
			</div>
			{props.error && (
				<p role="alert" className="session-import-note">
					{props.error}
				</p>
			)}
			{!props.loading && props.sessions.length === 0 && (
				<p className="session-import-note">
					no sessions offered for import; this is a best-effort list
				</p>
			)}
			<ul className="session-import-list">
				{props.sessions.map(session => {
					const when = session.lastActivityAt
						? recencyLabel(session.lastActivityAt, new Date())
						: null;
					return (
						<li key={session.id} className="session-import-card">
							<div className="session-import-body">
								<h3 className="session-import-title">{session.title}</h3>
								<p className="session-import-meta">
									{props.projectName && `${props.projectName} · `}
									{session.lastActivityAt && when ? (
										<time dateTime={session.lastActivityAt}>{when}</time>
									) : (
										'last active unavailable'
									)}
								</p>
								<p className="session-import-meta">
									same project root · saved by Nanocoder
								</p>
							</div>
							<Button
								aria-label={`import saved session: ${session.title}`}
								aria-describedby={reason ? reasonId : undefined}
								disabled={Boolean(reason)}
								onClick={() => {
									returnFocus.current = {projectId: props.projectId};
									void props.onImport(session.id);
								}}
							>
								import
							</Button>
						</li>
					);
				})}
			</ul>
			<div className="session-import-actions">
				<Button
					ref={refresh}
					aria-describedby={reason ? reasonId : undefined}
					disabled={Boolean(reason)}
					onClick={() => {
						void props.onRefresh();
					}}
				>
					refresh offers
				</Button>
				{props.onBack && (
					<Button className="session-import-back" onClick={props.onBack}>
						<Icon name="back" />
						{props.backLabel ?? 'back to selected thread'}
					</Button>
				)}
			</div>
			<p className="session-import-note session-import-footnote">
				import is unavailable while a project turn runs.
			</p>
			{reason && (
				<p id={reasonId} role="status" className="session-import-note">
					{reason}
				</p>
			)}
		</section>
	);
}
