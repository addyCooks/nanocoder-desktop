import test from 'ava';
import {
	DIFF_ROW_HEIGHT,
	diffRowKey,
	diffWindow,
	MAX_DIFF_ROWS,
	mountedDiffRows,
	scrollTopForRow,
} from '@/renderer/diff-virtual';

test('GIT-04 the virtual window mounts only viewport rows and bounded overscan', t => {
	t.deepEqual(diffWindow(MAX_DIFF_ROWS, 0, 208), {
		start: 0,
		end: 18,
		totalHeight: MAX_DIFF_ROWS * DIFF_ROW_HEIGHT,
	});
	t.deepEqual(diffWindow(MAX_DIFF_ROWS, 50_000, 208), {
		start: 2_395,
		end: 2_422,
		totalHeight: MAX_DIFF_ROWS * DIFF_ROW_HEIGHT,
	});
});

test('GIT-04 pinned keyboard rows stay bounded and in full-model DOM order', t => {
	t.deepEqual(
		mountedDiffRows({start: 20, end: 23}, 5, 24),
		[5, 20, 21, 22, 24],
	);
	t.deepEqual(mountedDiffRows({start: 20, end: 23}, 21, 21), [20, 21, 22]);
});

test('GIT-04 the last virtual window includes the last capped row and nothing beyond it', t => {
	const lastTop = (MAX_DIFF_ROWS - 10) * DIFF_ROW_HEIGHT;
	const window = diffWindow(MAX_DIFF_ROWS, lastTop, 10 * DIFF_ROW_HEIGHT);
	t.is(window.start, MAX_DIFF_ROWS - 18);
	t.is(window.end, MAX_DIFF_ROWS);
	t.is(window.totalHeight, MAX_DIFF_ROWS * DIFF_ROW_HEIGHT);
	t.deepEqual(diffWindow(3, 0, 500), {
		start: 0,
		end: 3,
		totalHeight: 3 * DIFF_ROW_HEIGHT,
	});
});

test('GIT-07 scrolling to a row keeps a visible row put and brings an offscreen row into view', t => {
	const height = 10 * DIFF_ROW_HEIGHT;
	t.is(scrollTopForRow(4, 0, height, MAX_DIFF_ROWS), 0);
	t.is(scrollTopForRow(20, 0, height, MAX_DIFF_ROWS), 11 * DIFF_ROW_HEIGHT);
	t.is(
		scrollTopForRow(4, 50 * DIFF_ROW_HEIGHT, height, MAX_DIFF_ROWS),
		4 * DIFF_ROW_HEIGHT,
	);
	t.is(
		scrollTopForRow(MAX_DIFF_ROWS - 1, 0, height, MAX_DIFF_ROWS),
		(MAX_DIFF_ROWS - 10) * DIFF_ROW_HEIGHT,
	);
	t.is(scrollTopForRow(MAX_DIFF_ROWS, 0, height, MAX_DIFF_ROWS), 0);
});

test('GIT-07 row keys use stable full-model coordinates as the viewport moves', t => {
	const before = diffWindow(MAX_DIFF_ROWS, 0, 208);
	const after = diffWindow(MAX_DIFF_ROWS, 50_000, 208);
	const shared = before.start;
	t.is(diffRowKey(shared), 'diff-row-0');
	t.is(diffRowKey(after.start), `diff-row-${after.start}`);
	t.not(diffRowKey(after.start), diffRowKey(after.start + 1));
});
