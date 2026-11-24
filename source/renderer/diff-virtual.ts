export const MAX_DIFF_ROWS = 5_000;
export const DIFF_ROW_HEIGHT = 20.8;
const DIFF_OVERSCAN = 8;

interface DiffWindow {
	start: number;
	end: number;
	totalHeight: number;
}

export function mountedDiffRows(
	window: Pick<DiffWindow, 'start' | 'end'>,
	...pinned: Array<number | null | undefined>
): number[] {
	const indices = new Set(
		Array.from(
			{length: Math.max(0, window.end - window.start)},
			(_, offset) => window.start + offset,
		),
	);
	for (const index of pinned)
		if (
			index !== null &&
			index !== undefined &&
			index >= 0 &&
			index < MAX_DIFF_ROWS
		)
			indices.add(index);
	return [...indices].sort((a, b) => a - b);
}

export function diffWindow(
	rowCount: number,
	scrollTop: number,
	viewportHeight: number,
): DiffWindow {
	const count = Math.min(Math.max(0, rowCount), MAX_DIFF_ROWS);
	const top = Math.max(0, scrollTop);
	const height = Math.max(0, viewportHeight);
	const first = Math.floor(top / DIFF_ROW_HEIGHT);
	return {
		start: Math.max(0, first - DIFF_OVERSCAN),
		end: Math.min(
			count,
			Math.ceil((top + height) / DIFF_ROW_HEIGHT) + DIFF_OVERSCAN,
		),
		totalHeight: count * DIFF_ROW_HEIGHT,
	};
}

// The same minimal-scroll rule serves keyboard navigation and future find results.
export function scrollTopForRow(
	rowIndex: number,
	currentTop: number,
	viewportHeight: number,
	rowCount: number,
): number {
	const count = Math.min(Math.max(0, rowCount), MAX_DIFF_ROWS);
	if (rowIndex < 0 || rowIndex >= count) return currentTop;
	const rowTop = rowIndex * DIFF_ROW_HEIGHT;
	const rowBottom = rowTop + DIFF_ROW_HEIGHT;
	const maxTop = Math.max(0, count * DIFF_ROW_HEIGHT - viewportHeight);
	if (rowTop < currentTop) return Math.min(rowTop, maxTop);
	if (rowBottom > currentTop + viewportHeight)
		return Math.min(rowBottom - viewportHeight, maxTop);
	return Math.min(currentTop, maxTop);
}

export function diffRowKey(rowIndex: number): string {
	return `diff-row-${rowIndex}`;
}
