import * as React from 'react';
import {Icon} from '@/renderer/icons';
import {dayAge, shortRoot} from '@/renderer/recency';
import {Button, Card, Divider} from '@/renderer/ui';
import type {IpcResult, NanocoderRuntime, ProjectInfo} from '@/shared/ipc';

export interface WelcomePageProps {
	logoSrc: string;
	projects: readonly ProjectInfo[];
	busy: boolean;
	connecting: boolean;
	runtime: IpcResult<NanocoderRuntime> | null;
	// Where the saved data was moved to when it could not be read.
	recoveredFrom?: string;
	onConnect(): void;
	onOpen(projectId: string): void;
	onLocate(projectId: string): void;
	onRuntime(): void;
}

export function WelcomePage({
	logoSrc,
	projects,
	busy,
	connecting,
	runtime,
	recoveredFrom,
	onConnect,
	onOpen,
	onLocate,
	onRuntime,
}: WelcomePageProps): React.ReactElement {
	const now = new Date();
	return (
		<section className="workspace-welcome" aria-label="get started">
			<img
				className="welcome-logo"
				src={logoSrc}
				alt=""
				width={68}
				height={68}
			/>
			<p className="workspace-eyebrow">local-first workspace / pre-v0.1</p>
			<h2>what are you working on?</h2>
			<p className="welcome-lead">
				open a project folder to start a Nanocoder thread. you’ll review what
				can run before you trust the folder.
			</p>
			{recoveredFrom && (
				<Card role="status" className="nc-recovery nc-failure-notice">
					<p className="nc-failure-title">your saved data could not be read</p>
					<p>
						projects, threads and settings were set aside in {recoveredFrom},
						and the desktop started empty. open a project folder again, then
						import its saved sessions to get its threads back.
					</p>
				</Card>
			)}
			{runtime?.ok && (
				<Button className="welcome-open" onClick={onConnect} disabled={busy}>
					<Icon name="folder" />
					{connecting ? 'starting Nanocoder' : 'open a project folder'}
				</Button>
			)}
			{projects.length > 0 && (
				<section
					className="welcome-recents"
					aria-label="recent folders on welcome"
				>
					<h3>recent projects</h3>
					<ul className="welcome-recent-list">
						{projects.map(project => {
							const available = project.availability === 'available';
							const age = available ? dayAge(project.lastOpenedAt, now) : null;
							return (
								<li key={project.id}>
									<Button
										className="welcome-recent"
										aria-label={`${available ? 'open' : 'locate'} recent project ${project.displayName}`}
										disabled={busy}
										onClick={() =>
											available ? onOpen(project.id) : onLocate(project.id)
										}
									>
										<span className="welcome-recent-glyph" aria-hidden="true">
											⌑
										</span>
										<span className="welcome-recent-text">
											<span className="welcome-recent-name">
												{project.displayName}
											</span>
											<small title={project.canonicalRoot}>
												{shortRoot(project.canonicalRoot)}
											</small>
										</span>
										<span className="welcome-recent-end" aria-hidden="true">
											{available ? (
												<>
													{age && (
														<span className="welcome-recent-age">{age}</span>
													)}
													<span>↗</span>
												</>
											) : (
												'locate'
											)}
										</span>
									</Button>
								</li>
							);
						})}
					</ul>
				</section>
			)}
			<div className="welcome-runtime">
				<Divider />
				<Button className="welcome-runtime-toggle" onClick={onRuntime}>
					runtime and setup details
				</Button>
			</div>
		</section>
	);
}
