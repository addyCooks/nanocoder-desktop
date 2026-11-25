import * as React from 'react';

export interface DropdownOption {
	value: string;
	label: string;
}

export interface DropdownProps {
	value: string;
	options: readonly DropdownOption[];
	onChange(value: string): void;
	disabled?: boolean;
	className?: string;
	placement?: 'up' | 'down';
	'aria-label': string;
	'aria-describedby'?: string;
}

export function nextIndex(
	current: number,
	key: string,
	count: number,
): number | null {
	if (count === 0) return null;
	switch (key) {
		case 'ArrowDown':
			return Math.min(count - 1, current + 1);
		case 'ArrowUp':
			return Math.max(0, current - 1);
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}

// The option a typed prefix points at, like a native select: the search runs on from the
// current option and wraps, and one letter typed again moves to the next option with it.
export function typeAheadIndex(
	labels: readonly string[],
	current: number,
	typed: string,
): number | null {
	const text = typed.toLowerCase();
	if (!text) return null;
	const repeated = [...text].every(character => character === text[0]);
	const query = repeated ? text.slice(0, 1) : text;
	const start = repeated ? current + 1 : current;
	for (let step = 0; step < labels.length; step++) {
		const index = (start + step) % labels.length;
		if (labels[index].toLowerCase().startsWith(query)) return index;
	}
	return null;
}

// Letters typed within this long of each other make one search.
const typeAheadMs = 800;

export interface ListPlacement {
	left: number;
	minWidth: number;
	maxHeight: number;
	top?: number;
	bottom?: number;
}

const gap = 6;
const edge = 8;
const preferredHeight = 280;

export function placeList(
	trigger: {left: number; top: number; bottom: number; width: number},
	viewport: {width: number; height: number},
	preferred: 'up' | 'down',
): ListPlacement {
	const above = trigger.top - gap - edge;
	const below = viewport.height - trigger.bottom - gap - edge;
	const up =
		preferred === 'up'
			? above >= Math.min(preferredHeight, below)
			: below < Math.min(preferredHeight, above);
	const left = Math.max(
		edge,
		Math.min(trigger.left, viewport.width - trigger.width - edge),
	);
	const room = Math.max(80, Math.min(preferredHeight, up ? above : below));
	return up
		? {
				left,
				minWidth: trigger.width,
				maxHeight: room,
				bottom: viewport.height - trigger.top + gap,
			}
		: {
				left,
				minWidth: trigger.width,
				maxHeight: room,
				top: trigger.bottom + gap,
			};
}

export function Dropdown(props: DropdownProps) {
	const [open, setOpen] = React.useState(false);
	const [placement, setPlacement] = React.useState<ListPlacement | null>(null);
	const trigger = React.useRef<HTMLButtonElement>(null);
	const typed = React.useRef({text: '', at: 0});
	const selected = Math.max(
		0,
		props.options.findIndex(option => option.value === props.value),
	);
	const [active, setActive] = React.useState(selected);
	const root = React.useRef<HTMLDivElement>(null);
	const id = React.useId();
	const listId = `${id}-list`;
	const optionId = (index: number) => `${id}-option-${index}`;
	const current = props.options.find(option => option.value === props.value);

	React.useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const dismiss = (event: Event) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const hide = () => setOpen(false);
		document.addEventListener('mousedown', close);
		document.addEventListener('scroll', dismiss, true);
		globalThis.addEventListener('resize', hide);
		return () => {
			document.removeEventListener('mousedown', close);
			document.removeEventListener('scroll', dismiss, true);
			globalThis.removeEventListener('resize', hide);
		};
	}, [open]);

	React.useEffect(() => {
		if (props.disabled) setOpen(false);
	}, [props.disabled]);

	const show = () => {
		const rect = trigger.current?.getBoundingClientRect();
		if (rect)
			setPlacement(
				placeList(
					rect,
					{width: globalThis.innerWidth, height: globalThis.innerHeight},
					props.placement ?? 'down',
				),
			);
		setActive(selected);
		setOpen(true);
	};
	const choose = (index: number) => {
		const option = props.options[index];
		setOpen(false);
		if (option && option.value !== props.value) props.onChange(option.value);
	};

	return (
		<div
			ref={root}
			className={`dropdown ${props.className ?? ''}`}
			data-open={open || undefined}
			data-placement={props.placement ?? 'down'}
		>
			<button
				ref={trigger}
				type="button"
				role="combobox"
				className="dropdown-trigger"
				aria-label={props['aria-label']}
				aria-describedby={props['aria-describedby']}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={listId}
				aria-activedescendant={open ? optionId(active) : undefined}
				data-value={props.value}
				disabled={props.disabled}
				onClick={() => (open ? setOpen(false) : show())}
				onBlur={() => setOpen(false)}
				onKeyDown={event => {
					if (
						event.key.length === 1 &&
						event.key !== ' ' &&
						!event.ctrlKey &&
						!event.metaKey &&
						!event.altKey
					) {
						const now = Date.now();
						const text =
							(now - typed.current.at < typeAheadMs ? typed.current.text : '') +
							event.key;
						typed.current = {text, at: now};
						const match = typeAheadIndex(
							props.options.map(option => option.label),
							open ? active : selected,
							text,
						);
						if (match !== null) {
							event.preventDefault();
							if (!open) show();
							setActive(match);
						}
						return;
					}
					// Any other key ends the search, so letters typed after Enter start a new one.
					typed.current.text = '';
					if (!open) {
						if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
							event.preventDefault();
							show();
						}
						return;
					}
					if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						setOpen(false);
						return;
					}
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						choose(active);
						return;
					}
					const next = nextIndex(active, event.key, props.options.length);
					if (next !== null) {
						event.preventDefault();
						setActive(next);
					}
				}}
			>
				<span className="dropdown-value">{current?.label ?? props.value}</span>
			</button>
			<ul
				id={listId}
				role="listbox"
				className="dropdown-list"
				aria-label={props['aria-label']}
				hidden={!open}
				style={open && placement ? placement : undefined}
			>
				{props.options.map((option, index) => (
					<li
						key={option.value}
						id={optionId(index)}
						role="option"
						className="dropdown-option"
						aria-selected={option.value === props.value}
						data-value={option.value}
						data-active={index === active || undefined}
						onMouseDown={event => event.preventDefault()}
						onMouseEnter={() => setActive(index)}
						onClick={() => choose(index)}
					>
						{option.label}
					</li>
				))}
			</ul>
		</div>
	);
}
