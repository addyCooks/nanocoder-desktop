import test from 'ava';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Dropdown, nextIndex, placeList} from '@/renderer/dropdown';

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
