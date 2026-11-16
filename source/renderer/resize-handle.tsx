import * as React from 'react';

export function clampSize(value: number, min: number, max: number): number {
	return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}

export function keyStep(key: string, axis: 'x' | 'y'): number | null {
	const grow = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
	const shrink = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
	if (key === grow) return 16;
	if (key === shrink) return -16;
	return null;
}

export interface ResizeHandleProps {
	label: string;
	axis: 'x' | 'y';
	// 1 when dragging right or down grows the panel, -1 when it shrinks it.
	direction: 1 | -1;
	size: number;
	min: number;
	max: number;
	className?: string;
	onResize(size: number): void;
	onReset(): void;
}

export function ResizeHandle(props: ResizeHandleProps) {
	const start = React.useRef<{pointer: number; size: number} | null>(null);
	const [dragging, setDragging] = React.useState(false);
	const resize = (size: number) =>
		props.onResize(clampSize(size, props.min, props.max));
	return (
		<div
			role="separator"
			tabIndex={0}
			aria-label={props.label}
			aria-orientation={props.axis === 'x' ? 'vertical' : 'horizontal'}
			aria-valuenow={props.size}
			aria-valuemin={props.min}
			aria-valuemax={Math.max(props.min, Math.round(props.max))}
			className={`resize-handle resize-handle--${props.axis} ${props.className ?? ''}`}
			data-dragging={dragging || undefined}
			onPointerDown={event => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				start.current = {
					pointer: props.axis === 'x' ? event.clientX : event.clientY,
					size: props.size,
				};
				setDragging(true);
			}}
			onPointerMove={event => {
				if (!start.current) return;
				const pointer = props.axis === 'x' ? event.clientX : event.clientY;
				resize(
					start.current.size +
						(pointer - start.current.pointer) * props.direction,
				);
			}}
			onPointerUp={() => {
				start.current = null;
				setDragging(false);
			}}
			onPointerCancel={() => {
				start.current = null;
				setDragging(false);
			}}
			onDoubleClick={props.onReset}
			onKeyDown={event => {
				if (event.key === 'Home' || event.key === 'End') {
					event.preventDefault();
					resize(event.key === 'Home' ? props.min : props.max);
					return;
				}
				if (event.key === 'Enter') {
					event.preventDefault();
					props.onReset();
					return;
				}
				const step = keyStep(event.key, props.axis);
				if (step === null) return;
				event.preventDefault();
				resize(props.size + step * props.direction);
			}}
		/>
	);
}

const storageKey = 'nanocoder-desktop.panel-sizes';

export interface PanelSizes {
	rail?: number;
	workbench?: number;
	bottom?: number;
}

export function parsePanelSizes(raw: string | null): PanelSizes {
	if (!raw) return {};
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== 'object') return {};
		const sizes: PanelSizes = {};
		for (const key of ['rail', 'workbench', 'bottom'] as const) {
			const size = (value as Record<string, unknown>)[key];
			if (typeof size === 'number' && Number.isFinite(size) && size > 0)
				sizes[key] = Math.round(size);
		}
		return sizes;
	} catch {
		return {};
	}
}

function readSizes(): PanelSizes {
	try {
		return parsePanelSizes(globalThis.localStorage?.getItem(storageKey));
	} catch {
		return {};
	}
}

export function usePanelSizes() {
	const [sizes, setSizes] = React.useState<PanelSizes>(readSizes);
	const update = React.useCallback(
		(key: keyof PanelSizes, size: number | undefined) => {
			setSizes(previous => {
				const next = {...previous, [key]: size};
				try {
					globalThis.localStorage?.setItem(storageKey, JSON.stringify(next));
				} catch {}
				return next;
			});
		},
		[],
	);
	return [sizes, update] as const;
}
