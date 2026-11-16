import * as React from 'react';
import {Icon} from '@/renderer/icons';
import {retentionLabel} from '@/renderer/retention-notice';
import {
	compactAge,
	threadAppearance,
	threadGroups,
} from '@/renderer/thread-rail-model';
import {Button} from '@/renderer/ui';
import type {ThreadInfo} from '@/shared/ipc';
import type {RetentionWarning} from '@/shared/retention';

interface ThreadRailProps {
	projectId: string | null;
	threads: readonly ThreadInfo[];
	activeThreadId: string | null;
	pending: boolean;
	now: Date;
	importCount: number | null;
	retention?: {hint: string; byThread: ReadonlyMap<string, RetentionWarning>};
	newThreadShortcut?: string;
	onNew(projectId: string): void;
	onOpen(threadId: string): void;
	onOpenArchives(opener: HTMLElement): void;
	onOpenImport(): void;
}

export function ThreadRail(props: ThreadRailProps): React.ReactElement {
	const groups = threadGroups(props.projectId, props.threads, props.now);
	const archived = groups.find(group => group.id === 'archived')?.threads ?? [];
	const active = groups.filter(
		group => group.id !== 'archived' && group.threads.length > 0,
	);
	const newReason = props.pending
		? 'another thread request is pending'
		: props.projectId
			? undefined
			: 'select a project first';
	const row = (thread: ThreadInfo) => {
		const status = threadAppearance(thread);
		const selected = thread.id === props.activeThreadId;
		const risk = props.retention?.byThread.get(thread.id);
		const riskLabel = risk ? retentionLabel(risk) : null;
		const age = (
			<time
				className="thread-age"
				dateTime={thread.lastActivityAt}
				title={new Date(thread.lastActivityAt).toLocaleString()}
			>
				{compactAge(thread.lastActivityAt, props.now)}
			</time>
		);
		return (
			<li
				key={thread.id}
				className="thread-row"
				data-thread-id={thread.id}
				data-selected={selected}
			>
				<button
					type="button"
					className="thread-open"
					aria-label={`${thread.title} · ${status.label}${riskLabel ? `, ${riskLabel}` : ''}`}
					aria-current={selected ? 'true' : undefined}
					title={`${thread.title} · ${status.label}${thread.viewOnlyReason ? `: ${thread.viewOnlyReason}` : ''}${riskLabel ? `\n${riskLabel}. ${props.retention?.hint}` : ''}`}
					disabled={props.pending}
					onClick={() => props.onOpen(thread.id)}
				>
					<span className="thread-copy">
						<span className="thread-title">{thread.title}</span>
						{riskLabel && <span className="thread-retention">{riskLabel}</span>}
						{selected && (
							<span className="thread-state-label">
								{status.label} · {age}
							</span>
						)}
					</span>
					{!selected && age}
				</button>
			</li>
		);
	};
	return (
		<section className="thread-rail" aria-label="project threads">
			<Button
				aria-label="new thread"
				title={newReason}
				disabled={Boolean(newReason)}
				className="thread-new"
				keyHint={props.newThreadShortcut}
				onClick={() => {
					if (props.projectId) props.onNew(props.projectId);
				}}
			>
				<Icon name="plus" />
				new thread
			</Button>
			{newReason && <p className="thread-rail-note">{newReason}</p>}
			{props.projectId && groups.every(group => group.threads.length === 0) && (
				<p className="thread-rail-note">no threads yet</p>
			)}
			{active.map(group => (
				<section
					key={group.id}
					className="thread-group"
					aria-label={`${group.id} threads`}
				>
					<h3 className="thread-group-heading">
						<span>{group.id}</span>
						<span className="thread-group-count">{group.threads.length}</span>
					</h3>
					<ol className="thread-list">{group.threads.map(row)}</ol>
				</section>
			))}
			{props.projectId && (
				<button
					type="button"
					className="sidebar-link"
					aria-haspopup="dialog"
					onClick={event => props.onOpenArchives(event.currentTarget)}
				>
					<Icon name="archive" />
					<span className="sidebar-link-label">archived</span>
					<span className="sidebar-link-count">{archived.length}</span>
				</button>
			)}
			{props.projectId && props.importCount !== null && (
				<button
					type="button"
					className="sidebar-link"
					onClick={props.onOpenImport}
				>
					<Icon name="import" />
					<span className="sidebar-link-label">import sessions</span>
					<span className="sidebar-link-count">{props.importCount}</span>
				</button>
			)}
		</section>
	);
}
