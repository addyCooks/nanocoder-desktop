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
	FolderTree,
	Import,
	Info,
	Keyboard,
	Moon,
	Plus,
	RotateCw,
	Sun,
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
	files: FolderTree,
	forward: ArrowRight,
	import: Import,
	info: Info,
	keyboard: Keyboard,
	moon: Moon,
	more: Ellipsis,
	plus: Plus,
	reload: RotateCw,
	send: ArrowUp,
	sun: Sun,
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
