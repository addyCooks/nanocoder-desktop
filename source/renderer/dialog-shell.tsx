import * as React from 'react';
import {Icon} from '@/renderer/icons';

export interface DialogShellProps {
	title: string;
	closeLabel: string;
	onClose(): void;
	className?: string;
	footer?: React.ReactNode;
	children: React.ReactNode;
}

export function DialogShell({
	title,
	closeLabel,
	onClose,
	className,
	footer,
	children,
}: DialogShellProps) {
	return (
		<div className={className ? `dialog-shell ${className}` : 'dialog-shell'}>
			<div className="dialog-head">
				<h2>{title}</h2>
				<button
					type="button"
					className="dialog-close"
					aria-label={closeLabel}
					onClick={onClose}
				>
					<Icon name="close" />
				</button>
			</div>
			<div className="dialog-body">{children}</div>
			{footer && <div className="dialog-foot">{footer}</div>}
		</div>
	);
}
