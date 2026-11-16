import * as React from 'react';
import {
	type EntryRow,
	type TreeAction,
	type TreeRow,
	treeKey,
} from '@/renderer/files-controller';
import {Icon} from '@/renderer/icons';
import {displayName} from '@/shared/files';
import type {ReviewMark} from '@/shared/review';

const MARKS: Record<ReviewMark, {glyph: string; label: string}> = {
	modified: {glyph: 'M', label: 'modified'},
	added: {glyph: 'A', label: 'added'},
	deleted: {glyph: 'D', label: 'deleted'},
	renamed: {glyph: 'R', label: 'renamed'},
	untracked: {glyph: 'U', label: 'untracked'},
	conflicted: {glyph: '!', label: 'has a conflict'},
	ignored: {glyph: '', label: 'ignored by Git'},
};

export function formatSize(bytes: number | null): string {
	if (bytes === null) return '';
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
	return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function glyph(row: EntryRow) {
	if (row.expandable)
		return <Icon name={row.expanded ? 'collapse' : 'expand'} size={14} />;
	return row.kind === 'file' ? <Icon name="file" size={14} /> : null;
}

export function FileTree({
	rows,
	selected,
	attachable,
	onToggle,
	onOpen,
	onFocus,
	onAttach,
}: {
	rows: readonly TreeRow[];
	selected: string | null;
	attachable: boolean;
	onToggle(path: string): void;
	onOpen(path: string): void;
	onFocus(path: string): void;
	onAttach(path: string): void;
}): React.ReactElement {
	const nodes = React.useRef(new Map<string, HTMLElement>());
	const pending = React.useRef<string | null>(null);
	const first = rows.find((row): row is EntryRow => row.type === 'entry');
	const tabbable =
		selected && rows.some(row => row.type === 'entry' && row.path === selected)
			? selected
			: first?.path;
	React.useEffect(() => {
		if (!pending.current) return;
		nodes.current.get(pending.current)?.focus();
		pending.current = null;
	});
	const run = (action: TreeAction | null): boolean => {
		if (!action) return false;
		if (action.type === 'focus') {
			pending.current = action.path;
			onFocus(action.path);
		} else if (action.type === 'toggle') onToggle(action.path);
		else if (action.type === 'open') onOpen(action.path);
		else if (attachable) onAttach(action.path);
		return true;
	};
	return (
		<ul
			className="file-tree"
			role="tree"
			aria-label="project files"
			onKeyDown={event => {
				if (
					event.altKey ||
					event.ctrlKey ||
					event.metaKey ||
					!(event.target as HTMLElement).matches('[role="treeitem"]')
				)
					return;
				const path = (event.target as HTMLElement).dataset.path ?? null;
				if (run(treeKey(rows, path, event.key, event.shiftKey)))
					event.preventDefault();
			}}
		>
			{rows.map(row => {
				if (row.type === 'notice')
					return (
						<li
							key={row.path}
							role="treeitem"
							aria-disabled="true"
							aria-level={row.depth + 1}
							className="file-notice"
							style={{paddingInlineStart: `${row.depth * 14 + 26}px`}}
						>
							{row.text}
						</li>
					);
				const mark = row.mark ? MARKS[row.mark] : null;
				return (
					<li
						key={row.path}
						ref={node => {
							if (node) nodes.current.set(row.path, node);
							else nodes.current.delete(row.path);
						}}
						role="treeitem"
						data-path={row.path}
						aria-level={row.depth + 1}
						aria-posinset={row.index}
						aria-setsize={row.count}
						aria-expanded={row.expandable ? row.expanded : undefined}
						aria-selected={row.path === selected}
						aria-busy={row.busy || undefined}
						tabIndex={row.path === tabbable ? 0 : -1}
						className={[
							'file-row',
							row.path === selected ? 'file-row--selected' : '',
							row.ignored ? 'file-row--ignored' : '',
							row.link === 'outside' ? 'file-row--outside' : '',
						]
							.filter(Boolean)
							.join(' ')}
						style={{paddingInlineStart: `${row.depth * 14 + 8}px`}}
						onClick={() => {
							onFocus(row.path);
							if (row.expandable) onToggle(row.path);
							else if (row.kind === 'file') onOpen(row.path);
						}}
					>
						<span className="file-glyph" aria-hidden="true">
							{glyph(row)}
						</span>
						<span className="file-name">{displayName(row.name)}</span>
						{row.link === 'outside' && (
							<span className="file-flag">outside project</span>
						)}
						{row.link === 'inside' && <span className="file-flag">link</span>}
						{row.unreadable && <span className="file-flag">unreadable</span>}
						{mark && (
							<span className="file-mark" data-mark={row.mark}>
								<span aria-hidden="true">{mark.glyph}</span>
								<span className="sr-only">, {mark.label}</span>
							</span>
						)}
						{row.size !== null && row.kind === 'file' && (
							<span className="file-size">{formatSize(row.size)}</span>
						)}
					</li>
				);
			})}
		</ul>
	);
}
