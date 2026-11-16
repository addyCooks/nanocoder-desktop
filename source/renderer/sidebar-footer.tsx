import * as React from 'react';
import {Icon} from '@/renderer/icons';
import type {AcpBadge} from '@/renderer/supervisor-state';
import {Button} from '@/renderer/ui';

export type FooterAcpState = AcpBadge | {status: 'acp-starting'} | null;

interface SidebarFooterProps {
	acp: FooterAcpState;
	nanocoderVersion: string | null;
	notice?: string;
	desktopVersion: string;
	runtimeError?: string;
	onCheckRuntime?(): void;
	onOpenRuntime?(opener: HTMLElement): void;
	onOpenShortcuts?(opener: HTMLElement): void;
}

function acpLine(acp: FooterAcpState): {
	tone: 'success' | 'error' | 'muted';
	glyph: string;
	text: string;
} {
	if (acp?.status === 'acp-ready')
		return {tone: 'success', glyph: '✓', text: 'acp · ready'};
	if (acp?.status === 'acp-exited')
		return {
			tone: 'error',
			glyph: '×',
			text: `acp · exited${acp.exitCode === undefined ? '' : ` (${acp.exitCode})`}`,
		};
	if (acp?.status === 'acp-starting')
		return {tone: 'muted', glyph: '○', text: 'acp · starting'};
	return {tone: 'muted', glyph: '○', text: 'acp · not started'};
}

export function SidebarFooter({
	acp,
	nanocoderVersion,
	notice,
	desktopVersion,
	runtimeError,
	onCheckRuntime,
	onOpenRuntime,
	onOpenShortcuts,
}: SidebarFooterProps): React.ReactElement {
	const line = acpLine(acp);
	return (
		<div className="sidebar-footer">
			<div className="footer-runtime">
				<p className={`footer-acp footer-acp--${line.tone}`}>
					<span className="footer-acp-dot" aria-hidden="true">
						●
					</span>{' '}
					<span aria-hidden="true">{line.glyph} </span>
					{line.text}
				</p>
				{onOpenRuntime && (
					<Button
						className="footer-icon-button"
						aria-label="runtime details"
						aria-haspopup="dialog"
						title="runtime details"
						onClick={event => onOpenRuntime?.(event.currentTarget)}
					>
						<Icon name="info" />
					</Button>
				)}
				{onOpenShortcuts && (
					<Button
						className="footer-icon-button"
						aria-label="keyboard shortcuts"
						aria-haspopup="dialog"
						title="keyboard shortcuts"
						onClick={event => onOpenShortcuts?.(event.currentTarget)}
					>
						<Icon name="keyboard" />
					</Button>
				)}
			</div>
			{runtimeError && (
				<div className="footer-alert">
					<p role="alert">{runtimeError}</p>
					{onCheckRuntime && (
						<Button className="footer-text-button" onClick={onCheckRuntime}>
							check again
						</Button>
					)}
				</div>
			)}
			<p className="footer-versions">
				<span>
					Nanocoder {nanocoderVersion ?? 'not connected'}
					{notice ? ` · ${notice}` : ''}
				</span>
				<span>desktop {desktopVersion}</span>
			</p>
		</div>
	);
}
