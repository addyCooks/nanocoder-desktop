import type {LucideIcon} from 'lucide-react';
import {
	Archive,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	Ellipsis,
	FileText,
	Folder,
	Import,
	Info,
	Keyboard,
	Plus,
	RotateCw,
	X,
} from 'lucide-react';
import * as React from 'react';

export const icons = {
	archive: Archive,
	back: ArrowLeft,
	close: X,
	collapse: ChevronDown,
	expand: ChevronRight,
	file: FileText,
	folder: Folder,
	forward: ArrowRight,
	import: Import,
	info: Info,
	keyboard: Keyboard,
	more: Ellipsis,
	plus: Plus,
	reload: RotateCw,
	send: ArrowUp,
} satisfies Record<string, LucideIcon>;

export function Icon({
	name,
	size = 16,
}: {
	name: keyof typeof icons;
	size?: number;
}) {
	return React.createElement(icons[name], {
		className: 'ui-icon',
		size,
		strokeWidth: 1.75,
		'aria-hidden': true,
		focusable: false,
	});
}
