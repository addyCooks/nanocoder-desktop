import test from 'ava';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {
	Dropdown,
	nextIndex,
	placeList,
	typeAheadIndex,
} from '@/renderer/dropdown';

const options = [
	{value: 'normal', label: 'normal'},
	{value: 'plan', label: '<plan>'},
];

test('a closed dropdown is a labelled combobox showing the current label', t => {
	const html = renderToStaticMarkup(
		createElement(Dropdown, {
			value: 'plan',
			options,
			onChange() {},
			'aria-label': 'mode for this thread',
		}),
	);
	t.regex(
		html,
		/<button type="button" role="combobox"[^>]*aria-label="mode for this thread"[^>]*aria-expanded="false"[^>]*data-value="plan"/,
	);
	t.true(html.includes('<span class="dropdown-value">&lt;plan&gt;</span>'));
	t.regex(html, /<ul[^>]*role="listbox"[^>]*hidden=""/);
	t.regex(html, /role="option"[^>]*aria-selected="true"[^>]*data-value="plan"/);
	t.false(html.includes('<select'));
});

test('a disabled dropdown cannot open', t => {
	const html = renderToStaticMarkup(
		createElement(Dropdown, {
			value: 'missing',
			options,
			disabled: true,
			onChange() {},
			'aria-label': 'mode',
		}),
	);
	t.regex(html, /role="combobox"[^>]*disabled=""/);
	t.true(html.includes('<span class="dropdown-value">missing</span>'));
});

test('arrow, home and end keys stay within the options', t => {
	t.is(nextIndex(0, 'ArrowUp', 3), 0);
	t.is(nextIndex(0, 'ArrowDown', 3), 1);
	t.is(nextIndex(2, 'ArrowDown', 3), 2);
	t.is(nextIndex(1, 'Home', 3), 0);
	t.is(nextIndex(0, 'End', 3), 2);
	t.is(nextIndex(0, 'a', 3), null);
	t.is(nextIndex(0, 'ArrowDown', 0), null);
});

test('typing finds the option that starts with the letters, wrapping and ignoring case (R2-03)', t => {
	const labels = ['normal', 'auto-accept', 'yolo', 'plan', 'architect'];
	t.is(typeAheadIndex(labels, 0, 'p'), 3);
	t.is(typeAheadIndex(labels, 0, 'P'), 3);
	// One letter moves to the next option with it, then wraps, and typing it again cycles.
	t.is(typeAheadIndex(labels, 0, 'a'), 1);
	t.is(typeAheadIndex(labels, 1, 'a'), 4);
	t.is(typeAheadIndex(labels, 4, 'a'), 1);
	t.is(typeAheadIndex(labels, 1, 'aa'), 4);
	// Several different letters refine the search from the current option.
	t.is(typeAheadIndex(labels, 1, 'ar'), 4);
	t.is(typeAheadIndex(labels, 4, 'au'), 1);
	t.is(typeAheadIndex(labels, 0, 'n'), 0);
	t.is(typeAheadIndex(labels, 0, 'z'), null);
	t.is(typeAheadIndex(labels, 0, ''), null);
	t.is(typeAheadIndex([], 0, 'a'), null);
});

test('the list opens where it fits and stays inside the window', t => {
	const viewport = {width: 1000, height: 800};
	const low = {left: 400, top: 700, bottom: 734, width: 160};
	const up = placeList(low, viewport, 'up');
	t.is(up.bottom, 106);
	t.is(up.top, undefined);
	t.is(up.maxHeight, 280);
	t.is(up.minWidth, 160);

	const high = {left: 400, top: 60, bottom: 94, width: 160};
	const flipped = placeList(high, viewport, 'up');
	t.is(flipped.top, 100);
	t.is(flipped.bottom, undefined);

	const edgeRight = placeList(
		{left: 950, top: 100, bottom: 134, width: 160},
		viewport,
		'down',
	);
	t.is(edgeRight.left, 832);
});
