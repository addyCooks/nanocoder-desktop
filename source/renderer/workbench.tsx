import * as React from 'react';
import {FilePreview} from '@/renderer/file-preview';
import {FileTree} from '@/renderer/file-tree';
import {keyHint} from '@/renderer/overlay-model';
import {ReviewPanel} from '@/renderer/review-panel';
import {Button} from '@/renderer/ui';
import type {useFiles} from '@/renderer/use-files';
import type {useReview} from '@/renderer/use-review';
import type {PromptAttachment} from '@/shared/ipc';

export type WorkbenchTab = 'files' | 'review' | 'browser';

const TABS: Array<{id: WorkbenchTab; label: string}> = [
	{id: 'files', label: 'files'},
	{id: 'review', label: 'review'},
	{id: 'browser', label: 'browser'},
];

export interface WorkbenchProps {
	tab: WorkbenchTab;
	onTab(tab: WorkbenchTab): void;
	files: ReturnType<typeof useFiles>;
	review: ReturnType<typeof useReview>;
	// Why attaching to the chat is unavailable right now, or null.
	attachReason: string | null;
	onAttachFile(path: string): void;
	onComment(comment: Extract<PromptAttachment, {kind: 'review-comment'}>): void;
	// Resolve to a plain message when the editor or file manager could not be used.
	onOpenEditor(path: string, line?: number): Promise<string | null>;
	onReveal(path: string): Promise<string | null>;
	browser: React.ReactNode;
}

export function Workbench({
	tab,
	onTab,
	files,
	review,
	attachReason,
	onAttachFile,
	onComment,
	onOpenEditor,
	onReveal,
	browser,
}: WorkbenchProps): React.ReactElement {
	const [message, setMessage] = React.useState<string | null>(null);
	const tabs = React.useRef(new Map<WorkbenchTab, HTMLElement>());
	const moveTab = (event: React.KeyboardEvent, current: WorkbenchTab) => {
		const at = TABS.findIndex(item => item.id === current);
		const next =
			event.key === 'ArrowRight'
				? TABS[(at + 1) % TABS.length]
				: event.key === 'ArrowLeft'
					? TABS[(at + TABS.length - 1) % TABS.length]
					: event.key === 'Home'
						? TABS[0]
						: event.key === 'End'
							? TABS[TABS.length - 1]
							: undefined;
		if (!next) return;
		event.preventDefault();
		onTab(next.id);
		tabs.current.get(next.id)?.focus();
	};
	const editor = async (path: string, line?: number) =>
		setMessage(await onOpenEditor(path, line));
	const reveal = async (path: string) => setMessage(await onReveal(path));
	return (
		<div className="workbench">
			<div className="workbench-bar">
				<div
					className="workbench-tabs"
					role="tablist"
					aria-label="project panels"
				>
					{TABS.map(item => (
						<button
							key={item.id}
							ref={node => {
								if (node) tabs.current.set(item.id, node);
								else tabs.current.delete(item.id);
							}}
							type="button"
							role="tab"
							id={`workbench-tab-${item.id}`}
							aria-selected={tab === item.id}
							aria-controls={`workbench-panel-${item.id}`}
							tabIndex={tab === item.id ? 0 : -1}
							className="workbench-tab"
							onClick={() => onTab(item.id)}
							onKeyDown={event => moveTab(event, item.id)}
						>
							{item.label}
						</button>
					))}
				</div>
				{tab !== 'browser' && (
					<Button
						onClick={() => {
							files.refresh();
							review.refresh();
						}}
						title="list the open folders and the changes again"
					>
						refresh
					</Button>
				)}
			</div>
			{files.state.watch === 'limited' && (
				<p className="files-hint" role="status">
					this system ran out of file watches, so changes outside the app do not
					appear on their own. use refresh to update.
				</p>
			)}
			{message && (
				<p className="files-hint" role="status">
					{message}
				</p>
			)}
			<div
				role="tabpanel"
				id="workbench-panel-files"
				aria-labelledby="workbench-tab-files"
				hidden={tab !== 'files'}
				className="workbench-panel"
			>
				{tab === 'files' && (
					<>
						<p className="files-hint">
							{keyHint(
								'↑↓ move · → expand · ← collapse · ↵ open · ⇧↵ attach to chat',
							)}
						</p>
						{files.state.directories['']?.status === 'loading' &&
							!files.state.directories[''].listing && (
								<p role="status">reading the project…</p>
							)}
						{files.state.directories['']?.status === 'error' &&
							!files.state.directories[''].listing && (
								<p role="alert">{files.state.directories[''].error}</p>
							)}
						<FileTree
							rows={files.rows}
							selected={files.state.selected}
							attachable={attachReason === null}
							onToggle={files.toggle}
							onOpen={files.open}
							onFocus={files.focus}
							onAttach={onAttachFile}
						/>
						{files.state.preview && (
							<FilePreview
								preview={files.state.preview}
								attachReason={attachReason}
								message={null}
								onAttach={onAttachFile}
								onOpenEditor={path => void editor(path)}
								onReveal={path => void reveal(path)}
								onClose={files.closePreview}
							/>
						)}
					</>
				)}
			</div>
			<div
				role="tabpanel"
				id="workbench-panel-review"
				aria-labelledby="workbench-tab-review"
				hidden={tab !== 'review'}
				className="workbench-panel workbench-panel--review"
			>
				{tab === 'review' && (
					<ReviewPanel
						state={review.state}
						interactions={review.interactions}
						onInteraction={review.setInteraction}
						commentReason={attachReason}
						onFilter={review.setFilter}
						onView={review.setView}
						onShow={review.show}
						onClear={review.clear}
						onRefresh={review.refresh}
						onComment={onComment}
						onOpenEditor={(path, line) => void editor(path, line)}
					/>
				)}
			</div>
			<div
				role="tabpanel"
				id="workbench-panel-browser"
				aria-labelledby="workbench-tab-browser"
				hidden={tab !== 'browser'}
				className="workbench-panel workbench-panel--browser"
			>
				{tab === 'browser' && browser}
			</div>
		</div>
	);
}
